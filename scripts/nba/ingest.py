"""Official NBA clip ingestion. Stdlib only; failures never replace published data."""
import argparse
import datetime as dt
import gzip
import hashlib
import html
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.nba.com/", "Origin": "https://www.nba.com"}
CATEGORIES = ("FGA", "FTA", "REB", "AST", "STL", "BLK", "TOV")


def fetch(url, retries=3):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as response:
                body = response.read()
            if not body:
                raise ValueError("Empty NBA response")
            return body
        except Exception:
            if attempt + 1 == retries:
                raise
            time.sleep(2 ** attempt)


def stats(endpoint, **params):
    return json.loads(fetch("https://stats.nba.com/stats/" + endpoint + "?" + urllib.parse.urlencode(params)))


def clock_seconds(clock):
    match = re.fullmatch(r"PT(?:(\d+)M)?([\d.]+)S", clock)
    if not match:
        raise ValueError("Unrecognized NBA clock: " + clock)
    return int(match[1] or 0) * 60 + float(match[2])


def asset_map(response, game_id):
    """NBA playlist ei is the event ID. Require matching asset paths, never array IDs."""
    result = response["resultSets"]
    playlist = result.get("playlist", [])
    videos = result.get("Meta", {}).get("videoUrls", [])
    if len(playlist) != len(videos):
        raise ValueError("NBA playlist/video length mismatch")
    clips = {}
    for event, video in zip(playlist, videos):
        event_id = int(event["ei"])
        if str(event["gi"]) != game_id:
            raise ValueError("Wrong game in NBA asset response")
        url = video.get("lurl") or video.get("murl") or video.get("surl")
        if not url:
            continue
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "videos.nba.com" or not parsed.path.endswith(".mp4"):
            raise ValueError("Non-NBA individual video asset")
        if f"/{game_id}/{event_id}/" not in parsed.path:
            raise ValueError("NBA asset/event mismatch")
        clips[event_id] = {"mp4": url, "thumbnail": video.get("lth") or video.get("mth") or video.get("sth"), "assetDescription": event["dsc"]}
    return clips


def game_page(game_id):
    body = fetch(f"https://www.nba.com/game/{game_id}/play-by-play").decode()
    match = re.search(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', body, re.S)
    if not match:
        raise ValueError("NBA game data absent")
    page = json.loads(html.unescape(match[1]))["props"]["pageProps"]
    if page["playByPlay"]["gameId"] != game_id:
        raise ValueError("Wrong NBA play-by-play game")
    return page["game"], page["playByPlay"]["actions"]


def batch_assets(game_id, season, phase, category, team_id):
    # Parameters match the official NBA Stats event page; omitted optional strings stay empty.
    empty = "AheadBehind CFID CFPARAMS ClutchTime Conference ContextFilter DateFrom DateTo Division GROUP_ID GameEventID GameSegment GroupID GroupMode Location OnOff OppPlayerID Outcome PlayerID1 PlayerID2 PlayerID3 PlayerID4 PlayerID5 PlayerPosition PointDiff Position RookieYear SeasonSegment ShotClockRange StarterBench VsConference VsDivision VsPlayerID1 VsPlayerID2 VsPlayerID3 VsPlayerID4 VsPlayerID5 VsTeamID".split()
    params = dict.fromkeys(empty, "")
    params.update(ContextMeasure=category, EndPeriod=0, EndRange=28800, GameID=game_id, GroupQuantity=5, LastNGames=0, LeagueID="00", Month=0, OpponentTeamID=0, PORound=0, Period=0, PlayerID=0, RangeType=0, Season=season, SeasonType="Playoffs" if phase == "playoffs" else "Regular Season", StartPeriod=0, StartRange=0, TeamID=team_id)
    return asset_map(stats("videodetailsasset", **params), game_id)


def parse_schedule(response, season):
    schedule = response["leagueSchedule"]
    if schedule["seasonYear"] != season:
        raise ValueError("NBA schedule returned the wrong season")
    games = {}
    for date in schedule["gameDates"]:
        for row in date["games"]:
            game_id = str(row["gameId"])
            if row["gameStatus"] != 3 or not game_id.startswith(("002", "004", "005")):
                continue
            # NBA's gameCode supplies the game's local calendar date, avoiding UTC date shifts.
            day = row["gameCode"].split("/")[0]
            game_date = dt.datetime.strptime(day, "%Y%m%d").date().isoformat()
            phase = "playoffs" if game_id.startswith("004") else "play-in" if game_id.startswith("005") else "regular"
            games[game_id] = {"gameId": game_id, "date": game_date, "season": season, "phase": phase}
    if not games and int(season[:4]) < dt.date.today().year:
        raise ValueError("NBA completed-game schedule returned no games: " + season)
    return sorted(games.values(), key=lambda x: (x["date"], x["gameId"]))


def discover(season):
    return parse_schedule(stats("scheduleleaguev2", LeagueID="00", Season=season), season)


def normalize_game(meta, game, actions, assets):
    roster = {}
    for side in ("homeTeam", "awayTeam"):
        team = game[side]
        for player in team.get("players", []):
            roster[int(player["personId"])] = {"id": int(player["personId"]), "name": (player.get("firstName", "") + " " + player.get("familyName", "")).strip(), "team": team["teamTricode"]}
    rows = []
    unresolved = []
    for action in actions:
        # Stats actionNumber, not actionId (which differs), is GameEventID.
        event_id = int(action["actionNumber"])
        asset = assets.get(event_id)
        if not asset:
            if action.get("videoAvailable"):
                unresolved.append(event_id)
            continue
        person = roster.get(int(action.get("personId") or 0))
        participants = []
        event_type = action.get("actionType", "").lower()
        role = {"made shot": "shooter", "missed shot": "shooter", "free throw": "shooter", "turnover": "turnover", "rebound": "rebounder", "foul": "fouler", "block": "blocker", "steal": "stealer", "assist": "assister"}.get(event_type, "actor")
        if person:
            participants.append({**person, "role": role})
        # Only explicit NBA AST/BLK/STL description evidence assigns secondary roles.
        description = action.get("description") or asset["assetDescription"]
        for participant in roster.values():
            surname = participant["name"].split()[-1]
            for label, recorded_role in (("AST", "assister"), ("BLK", "blocker"), ("STL", "stealer")):
                if re.search(r"\b" + re.escape(surname) + r"\s+\d+\s+" + label + r"\b", description, re.I):
                    # Ambiguous surnames are intentionally not assigned.
                    if sum(p["name"].split()[-1] == surname for p in roster.values()) == 1:
                        participants.append({**participant, "role": recorded_role})
        home, away = game["homeTeam"]["teamTricode"], game["awayTeam"]["teamTricode"]
        team = action.get("teamTricode") or (person or {}).get("team")
        opponent = away if team == home else home if team == away else None
        row = {"id": f'{meta["gameId"]}:{event_id}', "gameId": meta["gameId"], "eventId": event_id, "title": description, "description": description, "season": meta["season"], "phase": meta["phase"], "date": meta["date"], "home": home, "away": away, "team": team, "opponent": opponent, "participants": participants, "eventType": event_type, "subType": action.get("subType", "").lower(), "outcome": action.get("shotResult", "").lower() or event_type, "shotDistance": action.get("shotDistance") if action.get("isFieldGoal") else None, "shotValue": action.get("shotValue"), "period": action["period"], "clock": clock_seconds(action["clock"]), "scoreHome": action.get("scoreHome"), "scoreAway": action.get("scoreAway"), **asset}
        query = urllib.parse.urlencode({"GameID": meta["gameId"], "GameEventID": event_id, "Season": meta["season"], "flag": 1, "title": description})
        row["eventUrl"] = "https://www.nba.com/stats/events/?" + query
        # Deduplicate embeddings by recorded play wording, preserving the full original elsewhere.
        semantic = re.sub(r"\([^)]*\)", "", description)
        for participant in sorted(roster.values(), key=lambda p: -len(p["name"])):
            semantic = re.sub(r"\b" + re.escape(participant["name"].split()[-1]) + r"\b", "player", semantic, flags=re.I)
        semantic = re.sub(r"\d+(?:\.\d+)?'?", "", semantic)
        row["semanticText"] = " ".join(semantic.lower().split())
        rows.append(row)
    return rows, unresolved


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")))
    temporary.replace(path)


def ingest_game(meta):
    game, actions = game_page(meta["gameId"])
    assets = {}
    for category in CATEGORIES:
        for side in ("homeTeam", "awayTeam"):
            assets.update(batch_assets(meta["gameId"], meta["season"], meta["phase"], category, game[side]["teamId"]))
            time.sleep(.2)
    for action in actions:
        event_id = int(action["actionNumber"])
        if action.get("videoAvailable") and event_id not in assets:
            assets.update(asset_map(stats("videoeventsasset", GameID=meta["gameId"], GameEventID=event_id), meta["gameId"]))
            time.sleep(.2)
    rows, unresolved = normalize_game(meta, game, actions, assets)
    if not rows and any(a.get("videoAvailable") for a in actions):
        raise ValueError("Game advertised videos but returned no resolved clips")
    return {"meta": meta, "clips": rows, "unresolved": unresolved, "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat()}


def publish_index(state, destination, discovered):
    """Write staging directory only. Workflow promotes it after validation/embedding checks."""
    groups = {}
    players = {}
    coverage = {}
    for path in sorted((state / "games").glob("*.json")):
        saved = json.loads(path.read_text())
        meta = saved["meta"]
        key = meta["season"] + "/" + meta["date"][:7]
        groups.setdefault(key, []).extend(saved["clips"])
        count = coverage.setdefault(meta["season"], {"games": 0, "clips": 0, "unresolved": 0, "phases": {}})
        count["games"] += 1
        count["clips"] += len(saved["clips"])
        count["unresolved"] += len(saved["unresolved"])
        count["phases"][meta["phase"]] = count["phases"].get(meta["phase"], 0) + 1
        for clip in saved["clips"]:
            for player in clip["participants"]:
                players[player["id"]] = {"id": player["id"], "name": player["name"]}
    destination.mkdir(parents=True, exist_ok=True)
    shards = []
    for key, clips in groups.items():
        clips = list({clip["id"]: clip for clip in clips}.values())
        details = {}
        for clip in clips:
            details.setdefault(clip["gameId"], {})[clip["id"]] = clip
        for game_id, records in details.items():
            target = destination / "details" / (game_id + ".json.gz")
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(gzip.compress(json.dumps(records, separators=(",", ":")).encode(), mtime=0))
        summaries = [{k: v for k, v in clip.items() if k not in ("mp4", "assetDescription")} for clip in clips]
        payload = json.dumps(summaries, separators=(",", ":")).encode()
        data = gzip.compress(payload, mtime=0)
        digest = hashlib.sha256(data).hexdigest()
        filename = f"shards/{key.replace('/', '-')}-{digest[:12]}.json.gz"
        target = destination / filename
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(data)
        shards.append({"path": filename, "season": clips[0]["season"], "from": min(c["date"] for c in clips), "to": max(c["date"] for c in clips), "teams": sorted({t for c in clips for t in (c["home"], c["away"])}), "players": sorted({p["id"] for c in clips for p in c["participants"]}), "count": len(clips), "bytes": len(data), "sha256": digest})
    for season, total in discovered.items():
        count = coverage.setdefault(season, {"games": 0, "clips": 0, "unresolved": 0, "phases": {}})
        count["scheduledGames"] = total
        count["complete"] = total > 0 and count["games"] == total
    if not shards:
        raise ValueError("Refusing to publish an empty clip index")
    manifest = {"version": 2, "lastSuccessfulUpdate": dt.datetime.now(dt.timezone.utc).isoformat(), "coverage": coverage, "shards": shards, "players": sorted(players.values(), key=lambda p: p["name"]), "model": {"id": "Xenova/all-MiniLM-L6-v2", "dtype": "q8", "dimensions": 384}, "clips": sum(s["count"] for s in shards)}
    atomic_json(destination / "manifest.json", manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, default=Path("nba-state"))
    parser.add_argument("--output", type=Path, default=Path("nba-staging"))
    parser.add_argument("--max-games", type=int, default=60)
    parser.add_argument("--seasons", nargs="+")
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if args.probe:
        result = asset_map(stats("videoeventsasset", GameID="0042400216", GameEventID=53), "0042400216")
        assert 53 in result
        game_page("0042400216")
        discover("2023-24")
        assert 53 in batch_assets("0042400216", "2024-25", "playoffs", "FGA", 1610612752)
        print("Official NBA sources verified")
        return
    year = dt.date.today().year - (dt.date.today().month < 10)
    seasons = args.seasons or [f"{y}-{str(y+1)[-2:]}" for y in range(2023, year + 1)]
    discovered, candidates = {}, []
    today = dt.date.today()
    for season in seasons:
        games = discover(season)
        discovered[season] = len(games)
        for game in games:
            path = args.state / "games" / (game["gameId"] + ".json")
            retry_unresolved = False
            if path.exists():
                saved = json.loads(path.read_text())
                last_update = dt.date.fromisoformat(saved.get("updatedAt", "1970-01-01")[:10])
                retry_unresolved = bool(saved.get("unresolved")) and last_update <= today - dt.timedelta(days=7)
            if not path.exists() or retry_unresolved or dt.date.fromisoformat(game["date"]) >= today - dt.timedelta(days=7):
                candidates.append(game)
    # Missing completed games first, then recent corrections. Each game is a durable checkpoint.
    candidates.sort(key=lambda g: ((args.state / "games" / (g["gameId"] + ".json")).exists(), g["date"], g["gameId"]))
    for meta in candidates[:args.max_games]:
        saved = ingest_game(meta)
        atomic_json(args.state / "games" / (meta["gameId"] + ".json"), saved)
        print(meta["gameId"], len(saved["clips"]), "clips", len(saved["unresolved"]), "unresolved", flush=True)
    publish_index(args.state, args.output, discovered)


if __name__ == "__main__":
    main()
