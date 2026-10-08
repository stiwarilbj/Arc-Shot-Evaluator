import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("ingest", Path(__file__).parents[2] / "scripts/nba/ingest.py")
ingest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingest)

class IngestionTests(unittest.TestCase):
    def response(self, event=53, path_event=53):
        return {"resultSets": {"playlist": [{"gi": "0042400216", "ei": event, "dsc": "Brunson jumper"}], "Meta": {"videoUrls": [{"lurl": f"https://videos.nba.com/nba/pbp/media/2025/05/16/0042400216/{path_event}/uuid_1280x720.mp4"}]}}}
    def test_asset_join(self):
        self.assertIn(53, ingest.asset_map(self.response(), "0042400216"))
        with self.assertRaises(ValueError): ingest.asset_map(self.response(path_event=37), "0042400216")
        with self.assertRaises(ValueError): ingest.asset_map(self.response(), "0022300001")
        response=self.response();response["resultSets"]["Meta"]["videoUrls"]=[]
        with self.assertRaises(ValueError): ingest.asset_map(response, "0042400216")
    def test_schedule_ids_and_completed_status(self):
        data={"leagueSchedule":{"seasonYear":"2024-25","gameDates":[{"games":[
            {"gameId":"0042400216","gameCode":"20250516/BOSNYK","gameStatus":3},
            {"gameId":"0052400101","gameCode":"20250415/ATLORL","gameStatus":3},
            {"gameId":"0022400100","gameCode":"20250517/BOSNYK","gameStatus":1},
        ]}]}}
        games=ingest.parse_schedule(data,"2024-25")
        self.assertEqual(len(games),2);self.assertEqual(games[0]["phase"],"play-in")
        self.assertEqual(games[1]["gameId"],"0042400216");self.assertEqual(games[1]["date"],"2025-05-16")
        with self.assertRaises(ValueError):ingest.parse_schedule(data,"2023-24")
    def test_fetch_retry(self):
        response=unittest.mock.MagicMock();response.__enter__.return_value.read.return_value=b'official'
        with patch.object(ingest.urllib.request,'urlopen',side_effect=[TimeoutError('delayed'),response]) as request, patch.object(ingest.time,'sleep'):
            self.assertEqual(ingest.fetch('https://www.nba.com/'),b'official');self.assertEqual(request.call_count,2)
    def test_clock(self):
        self.assertEqual(ingest.clock_seconds("PT07M41.00S"),461)
        self.assertEqual(ingest.clock_seconds("PT00M04.25S"),4.25)
    def test_event_number_not_action_id(self):
        game={"homeTeam":{"teamTricode":"NYK","players":[{"personId":1628973,"firstName":"Jalen","familyName":"Brunson"}]},"awayTeam":{"teamTricode":"BOS","players":[]}}
        action={"actionNumber":53,"actionId":37,"personId":1628973,"description":"Brunson 17' Step Back Jump Shot (2 PTS)","actionType":"Made Shot","subType":"Step Back Jump shot","teamTricode":"NYK","period":1,"clock":"PT07M41.00S","videoAvailable":1,"isFieldGoal":1,"shotDistance":17,"shotValue":2,"shotResult":"Made"}
        meta={"gameId":"0042400216","season":"2024-25","date":"2025-05-16","phase":"playoffs"}
        rows,missing=ingest.normalize_game(meta,game,[action],ingest.asset_map(self.response(),meta["gameId"]))
        self.assertEqual(rows[0]["id"],"0042400216:53");self.assertEqual(missing,[])
        self.assertEqual(len(ingest.normalize_game(meta,game,[action,action],ingest.asset_map(self.response(),meta["gameId"]))[0]),1)
        self.assertIn("GameEventID=53",rows[0]["eventUrl"])
        self.assertEqual(rows[0]["participants"][0]["role"],"shooter")
        self.assertEqual(ingest.normalize_game(meta,game,[action],{})[1],[53])
    def test_empty_publication_preserves_prior_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'output').mkdir();(root/'output/manifest.json').write_text('previous')
            with self.assertRaises(ValueError):ingest.publish_index(root/'state',root/'output',{})
            self.assertEqual((root/'output/manifest.json').read_text(),'previous')
    def test_failed_run_preserves_index_and_resumes_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);state=root/'state';output=root/'output';output.mkdir();(output/'manifest.json').write_text('healthy')
            games=[{"gameId":"0022300001","season":"2023-24","date":"2023-11-01","phase":"regular"},{"gameId":"0022300002","season":"2023-24","date":"2023-11-02","phase":"regular"}]
            saved={"meta":games[0],"clips":[],"unresolved":[],"updatedAt":"2023-11-03T00:00:00Z"}
            argv=['ingest','--state',str(state),'--output',str(output),'--seasons','2023-24']
            with patch.object(ingest,'discover',return_value=games),patch.object(ingest,'ingest_game',side_effect=[saved,TimeoutError('NBA unavailable')]),patch('sys.argv',argv):
                with self.assertRaises(TimeoutError):ingest.main()
            self.assertTrue((state/'games/0022300001.json').exists());self.assertEqual((output/'manifest.json').read_text(),'healthy')
            with patch.object(ingest,'discover',return_value=games),patch.object(ingest,'ingest_game',return_value={**saved,'meta':games[1]}) as run,patch.object(ingest,'publish_index'),patch('sys.argv',argv):
                ingest.main();self.assertEqual(run.call_count,1);self.assertEqual(run.call_args.args[0]['gameId'],'0022300002')
    def test_atomic_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'games/game.json';ingest.atomic_json(path,{"event":53});self.assertEqual(json.loads(path.read_text()),{"event":53});self.assertFalse(path.with_suffix('.json.tmp').exists())
if __name__ == '__main__': unittest.main()
