import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Plus,
  Trash2,
  Video,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import {
  clip,
  matchPlayers,
  normalizeName,
  shuffled,
  stats,
  type Attempt,
  type Clip,
  type Player,
  type QuizClip,
} from "./domain";
import {
  deleteClip,
  getState,
  listClips,
  putState,
  readAttempts,
  saveAttempt,
  videoBlob,
} from "./storage";
import { publicCatalog } from "./catalog";
import type { PublicCatalog } from "./publicManifest";
import { LibraryBackup } from "./LibraryBackup";
import type { JumperView } from "../../app/workspaceLocation";
import "./jumper.css";
const Editor = lazy(() => import("./JumperEditor"));
const EditClipCopy = lazy(() => import("./EditClipCopy"));
export function useBlobUrl(blob: Blob | null) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!blob) {
      setUrl("");
      return;
    }
    const value = URL.createObjectURL(blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [blob]);
  return url;
}
export function ClipVideo({
  src,
  active,
  label,
  onReady,
  onFailure,
}: {
  src: string;
  active: boolean;
  label: string;
  onReady?: () => void;
  onFailure?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const pause = () => {
      if (!active || document.hidden) ref.current?.pause();
    };
    pause();
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, [active]);
  return (
    <video
      ref={ref}
      className="jumper-video"
      src={src || undefined}
      muted
      playsInline
      autoPlay={active}
      controls
      preload="metadata"
      aria-label={label}
      onLoadedData={onReady}
      onError={onFailure}
      onPlay={() => {
        if (!active || document.hidden) ref.current?.pause();
      }}
    />
  );
}
export default function JumperLab({
  active,
  tab,
  onTabChange,
}: {
  active: boolean;
  tab: JumperView;
  onTabChange: (tab: JumperView) => void;
}) {
  const [editingCopy, setEditingCopy] = useState<Clip | null>(null);
  const [opened, setOpened] = useState(tab === "create");
  useEffect(() => {
    if (tab === "create") setOpened(true);
  }, [tab]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [catalog, setCatalog] = useState<PublicCatalog>({
    kind: null,
    clips: [],
  });
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [historyRevision, setHistoryRevision] = useState(0);
  async function refresh() {
    try {
      const saved = await listClips();
      setClips(saved);
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not read clips",
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setCatalogError("");
    publicCatalog(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCatalogError(error.message);
      });
    return () => controller.abort();
  }, [catalogAttempt]);
  useEffect(() => {
    if (active) void refresh();
  }, [active, tab]);
  function change(next: typeof tab) {
    onTabChange(next);
    if (next === "create") setOpened(true);
  }
  return (
    <main className="jumper-workspace">
      <header className="jumper-heading">
        <div>
          <span className="jumper-eyebrow">THE SHOT IS THE CLUE</span>
          <h1>Guess the Jumper</h1>
          <p>Recognize the release. Make your own mystery clips.</p>
        </div>
        <span className="jumper-private">Device-local · No accounts</span>
      </header>
      <nav className="jumper-tabs" aria-label="Jumper Lab views">
        {(["guess", "create", "clips"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-current={tab === value ? "page" : undefined}
            className={tab === value ? "is-active" : ""}
            onClick={() => change(value)}
          >
            {value === "clips"
              ? "My Clips"
              : value === "guess"
                ? "Guess"
                : "Create"}
          </button>
        ))}
      </nav>
      {error ? (
        <div className="jumper-notice" role="alert">
          {error}{" "}
          <button type="button" onClick={refresh}>
            Retry library
          </button>
        </div>
      ) : null}
      {catalogError && tab === "guess" ? (
        <div role="alert" className="jumper-notice">
          {catalogError}{" "}
          <button
            type="button"
            onClick={() => setCatalogAttempt((value) => value + 1)}
          >
            Retry NBA collection
          </button>
        </div>
      ) : null}
      <section hidden={tab !== "guess"}>
        <Guess
          active={active && tab === "guess"}
          personal={clips.filter((value) => value.quiz)}
          nba={catalog.clips}
          nbaKind={catalog.kind}
          historyRevision={historyRevision}
          onCreate={() => change("create")}
        />
      </section>
      {opened || tab === "create" ? (
        <section hidden={tab !== "create"}>
          <Suspense fallback={<p role="status">Opening editor…</p>}>
            <div hidden={!!editingCopy}>
              <Editor
                active={active && tab === "create" && !editingCopy}
                onSaved={() => {
                  void refresh();
                }}
              />
            </div>
            {editingCopy ? (
              <EditClipCopy
                key={editingCopy.id}
                clip={editingCopy}
                active={active && tab === "create"}
                onClose={() => setEditingCopy(null)}
                onSaved={() => void refresh()}
              />
            ) : null}
          </Suspense>
        </section>
      ) : null}
      <section hidden={tab !== "clips"}>
        <Library
          clips={clips}
          loading={loading}
          active={active && tab === "clips"}
          onCreate={() => change("create")}
          onEdit={(value) => {
            setEditingCopy(value);
            change("create");
          }}
          onChange={refresh}
          onError={setError}
          onRestored={async () => {
            await refresh();
            setHistoryRevision((v) => v + 1);
          }}
        />
      </section>
    </main>
  );
}
function Guess({
  active,
  personal,
  nba,
  nbaKind,
  historyRevision,
  onCreate,
}: {
  active: boolean;
  personal: Clip[];
  nba: QuizClip[];
  nbaKind: PublicCatalog["kind"];
  historyRevision: number;
  onCreate: () => void;
}) {
  const [collection, setCollection] = useState<"personal" | "nba" | "combined">(
    "personal",
  );
  const [history, setHistory] = useState<Attempt[]>([]);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [round, setRound] = useState<{ id: string; clip: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<Player | null>(null);
  const [submitted, setSubmitted] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const roundRevision = useRef(0);
  const [sources, setSources] = useState<{
    quiz: string;
    reveal: string;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const [reload, setReload] = useState(0);
  const candidates = useMemo(
    () => [
      ...(collection !== "nba" ? personal : []),
      ...(collection !== "personal" ? nba : []),
    ],
    [personal, nba, collection],
  );
  const current = candidates.find((value) => value.id === round?.clip);
  const people = useMemo(
    () => candidates.map((value) => value.player),
    [candidates],
  );
  const suggestions = useMemo(
    () => matchPlayers(answer, people),
    [answer, people],
  );
  const totals = useMemo(() => stats(history), [history]);
  async function hydrate() {
    try {
      const saved = await readAttempts();
      setHistory(saved);
      if (round)
        setSubmitted(saved.find((value) => value.id === round.id) ?? null);
      setHydrated(true);
      setError("");
    } catch (error) {
      setError(
        `History could not be opened: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  useEffect(() => {
    void hydrate();
  }, [historyRevision]);
  const key = `shuffle:${collection}`;
  async function next() {
    if (lock.current) return;
    const revision = roundRevision.current;
    lock.current = true;
    setBusy(true);
    try {
      const ids = candidates.map((value) => value.id).sort();
      const signature = ids.join(",");
      const saved = await getState<{
        signature: string;
        remaining: string[];
        current?: { id: string; clip: string };
      }>(key);
      let remaining =
        saved?.signature === signature && Array.isArray(saved.remaining)
          ? saved.remaining.filter((id) => ids.includes(id))
          : [];
      if (!remaining.length) remaining = shuffled(ids);
      const id = remaining.shift();
      if (id) {
        const fresh = { id: crypto.randomUUID(), clip: id };
        await putState(key, { signature, remaining, current: fresh });
        if (revision !== roundRevision.current) return;
        setRound(fresh);
        setSubmitted(null);
        setAnswer("");
        setSelected(null);
      }
    } catch (error) {
      setError(String(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const identity = candidates
    .map((value) => value.id)
    .sort()
    .join(",");
  useEffect(() => {
    let cancelled = false;
    const revision = ++roundRevision.current;
    if (!hydrated || !identity) {
      setRound(null);
      return;
    }
    void (async () => {
      try {
        const saved = await getState<{
          signature: string;
          current?: { id: string; clip: string };
        }>(key);
        if (cancelled || revision !== roundRevision.current) return;
        if (
          saved?.signature === identity &&
          saved.current &&
          candidates.some((value) => value.id === saved.current!.clip)
        ) {
          setRound(saved.current);
          setSubmitted(
            history.find((value) => value.id === saved.current!.id) ?? null,
          );
        } else await next();
      } catch (error) {
        if (!cancelled) setError(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Collection identity, rather than playback time or history, selects a round.
  }, [key, identity, hydrated]);
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    setSources(null);
    setReady(false);
    setPlaybackError(false);
    if (current) {
      if ("highlight" in current || clip(current)) {
        void videoBlob(current.id, "quiz")
          .then((blob) => {
            if (cancelled) return;
            const url = URL.createObjectURL(blob);
            urls.push(url);
            setSources({ quiz: url, reveal: url });
          })
          .catch((error) => {
            if (!cancelled) setError(String(error));
          });
      } else
        setSources({
          quiz: current.quiz as string,
          reveal: (current as QuizClip).reveal,
        });
    }
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [current?.id, reload]);
  async function submit() {
    if (
      lock.current ||
      submitted ||
      !round ||
      !current ||
      !ready ||
      playbackError
    )
      return;
    const exact = suggestions.filter(
      (value) =>
        normalizeName(value.name) === normalizeName(answer) ||
        value.aliases.some(
          (alias) => normalizeName(alias) === normalizeName(answer),
        ),
    );
    const chosen = selected ?? (exact.length === 1 ? exact[0] : null);
    if (!chosen) {
      setError("Choose a player from the suggestions before submitting.");
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      const value: Attempt = {
        id: round.id,
        clipId: current.id,
        selected: chosen,
        correct: current.player,
        timestamp: new Date().toISOString(),
        outcome: chosen.id === current.player.id,
      };
      const recorded = await saveAttempt(value);
      setSubmitted(recorded);
      // The committed answer is already verified. A second storage read must
      // not turn a successful write into an apparent failure.
      setHistory((previous) => [
        ...previous.filter((item) => item.id !== recorded.id),
        recorded,
      ]);
      setError("");
    } catch (error) {
      setError(`Your answer was not recorded. Retry: ${String(error)}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="jumper-guess">
      <div className="jumper-stats" aria-label="Quiz statistics">
        {Object.entries(totals).map(([name, value]) => (
          <div key={name}>
            <strong>
              {value}
              {name === "accuracy" ? "%" : ""}
            </strong>
            <span>{name}</span>
          </div>
        ))}
      </div>
      <div className="jumper-toolbar">
        <label>
          Collection{" "}
          <select
            value={collection}
            disabled={busy}
            onChange={(event) => {
              roundRevision.current++;
              setCollection(event.target.value as typeof collection);
              setSubmitted(null);
              setRound(null);
            }}
          >
            {["personal", "nba", "combined"].map((value) => (
              <option
                key={value}
                value={value}
                disabled={
                  (value === "nba" && !nba.length) ||
                  (value === "combined" && (!nba.length || !personal.length))
                }
              >
                {value === "nba"
                  ? `NBA${nba.length ? "" : " · not available yet"}`
                  : value === "combined"
                    ? "Combined"
                    : "Personal"}
              </option>
            ))}
          </select>
        </label>
        <span>{candidates.length} playable clips</span>
        {nbaKind ? (
          <span>
            {nbaKind === "starter"
              ? "Starter collection"
              : "Complete collection"}{" "}
            · {nba.length} NBA clips ·{" "}
            {new Set(nba.map((clip) => clip.player.id)).size} players
          </span>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="jumper-notice">
          {error}{" "}
          {!hydrated ? (
            <button type="button" onClick={hydrate}>
              Retry history
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError("");
                void next();
              }}
            >
              Retry round
            </button>
          )}
        </div>
      ) : null}
      {!candidates.length ? (
        <div className="jumper-empty">
          <Video size={38} />
          <h2>Your first mystery starts here</h2>
          <p>
            Create a clip and choose “Use in my guessing game.”{" "}
            {nba.length
              ? "Or choose NBA from the collection menu to play the reviewed collection."
              : "The reviewed NBA collection is still being prepared."}
          </p>
          <button
            className="button button-primary"
            type="button"
            onClick={onCreate}
          >
            Create a clip <ArrowRight size={17} />
          </button>
        </div>
      ) : current && sources ? (
        <div className="jumper-guess-grid">
          <div className="jumper-panel">
            <ClipVideo
              key={`${round?.id}-${submitted ? "reveal" : "quiz"}-${reload}`}
              src={submitted ? sources.reveal : sources.quiz}
              active={active}
              label={submitted ? "Player reveal" : "Mystery jumpshot"}
              onReady={() => setReady(true)}
              onFailure={() => {
                setPlaybackError(true);
                setReady(false);
              }}
            />
            {playbackError ? (
              <p role="alert">
                Video could not play.{" "}
                <button
                  type="button"
                  onClick={() => setReload((value) => value + 1)}
                >
                  Retry playback
                </button>{" "}
                Your score is unchanged.
              </p>
            ) : null}
            <p className="jumper-caption">
              {submitted
                ? clip(current)
                  ? "Name revealed · your video stays masked"
                  : "Original player appearance · background stays hidden"
                : "Black silhouette: the shooter · Gray: other players"}
            </p>
          </div>
          <div className="jumper-panel jumper-answer">
            {submitted ? (
              <>
                <span className="jumper-eyebrow">
                  {submitted.outcome ? "YOU GOT IT" : "THE REVEAL"}
                </span>
                <h2>{current.player.name}</h2>
                {"provenance" in current && current.provenance ? (
                  <details>
                    <summary>Footage attribution</summary>
                    <p>{current.provenance.attribution}</p>
                    <p>{current.provenance.changes}</p>
                    <a
                      href={current.provenance.source_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Source
                    </a>
                    {" · "}
                    <a
                      href={current.provenance.permission_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {current.provenance.license}
                    </a>
                  </details>
                ) : null}
                <p>
                  {submitted.outcome
                    ? "Correct. You recognized the release."
                    : `You picked ${submitted.selected.name}. Watch the follow-through again.`}
                </p>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy}
                  onClick={next}
                >
                  Next jumper <ArrowRight size={16} />
                </button>
              </>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <span className="jumper-eyebrow">WATCH THE RELEASE</span>
                <h2>Who’s shooting?</h2>
                <label htmlFor="jumper-answer">Player name</label>
                <input
                  id="jumper-answer"
                  value={answer}
                  autoComplete="off"
                  maxLength={100}
                  disabled={busy}
                  onChange={(event) => {
                    setAnswer(event.target.value);
                    setSelected(null);
                  }}
                />
                <div
                  className="jumper-suggestions"
                  aria-label="Player suggestions"
                >
                  {suggestions.map((person) => (
                    <button
                      type="button"
                      key={person.id}
                      aria-pressed={selected?.id === person.id}
                      onClick={() => {
                        setSelected(person);
                        setAnswer(person.name);
                      }}
                    >
                      {person.name}
                    </button>
                  ))}
                </div>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={busy || !ready || !answer.trim() || !hydrated}
                >
                  Lock answer
                </button>
                <p className="jumper-caption">
                  One answer per round. Spelling suggestions help; you choose
                  the player.
                </p>
              </form>
            )}
          </div>
        </div>
      ) : (
        <p role="status">Loading your round…</p>
      )}
    </div>
  );
}
function Library({
  clips,
  loading,
  active,
  onCreate,
  onChange,
  onError,
  onRestored,
  onEdit,
}: {
  onEdit: (value: Clip) => void;
  clips: Clip[];
  loading: boolean;
  active: boolean;
  onCreate: () => void;
  onChange: () => Promise<void>;
  onError: (error: string) => void;
  onRestored: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<Clip | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [videoError, setVideoError] = useState("");
  const [reload, setReload] = useState(0);
  const url = useBlobUrl(blob);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setBlob(null);
    setVideoError("");
    if (selected)
      videoBlob(
        selected.id,
        selected.quiz && !selected.presentation?.startsWith("silhouette")
          ? "quiz"
          : "highlight",
      )
        .then((value) => {
          if (!cancelled) setBlob(value);
        })
        .catch((error) => {
          if (!cancelled) setVideoError(String(error));
        });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, reload]);
  async function remove(value: Clip) {
    if (busy) return;
    setBusy(true);
    try {
      await deleteClip(value.id);
      if (selected?.id === value.id) setSelected(null);
      await onChange();
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="jumper-toolbar">
        <p>
          Finished videos stay on this device. Browser data can be cleared; keep
          a library backup to protect your collection.
        </p>
        <button
          type="button"
          className="button button-outline"
          onClick={onCreate}
        >
          <Plus size={16} /> Create
        </button>
      </div>
      <LibraryBackup onRestored={onRestored} />
      {loading ? (
        <p role="status">Reading clips…</p>
      ) : clips.length ? (
        <div className="jumper-library">
          {clips.map((value) => (
            <article key={value.id} className="jumper-panel">
              <Video size={24} />
              <h3>{value.player.name}</h3>
              <p>
                {value.duration.toFixed(1)}s ·{" "}
                {value.quiz
                  ? "Quiz ready · masked"
                  : value.presentation?.startsWith("silhouette")
                    ? "Silhouette"
                    : "Legacy · original colors may remain"}{" "}
                · {new Date(value.createdAt).toLocaleDateString()}
              </p>
              <div className="jumper-toolbar">
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => setSelected(value)}
                >
                  Open clip
                </button>
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => onEdit(value)}
                >
                  Edit copy
                </button>
                <button
                  type="button"
                  className="jumper-icon"
                  aria-label={`Delete ${value.player.name} clip`}
                  disabled={busy}
                  onClick={() => remove(value)}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="jumper-empty">
          <h2>No saved clips yet</h2>
          <p>
            Upload a video, hide the background, and save your finished result
            here.
          </p>
          <button
            type="button"
            className="button button-primary"
            onClick={onCreate}
          >
            Create your first clip
          </button>
        </div>
      )}
      {selected ? (
        <section className="jumper-panel jumper-library-player">
          <div className="jumper-toolbar">
            <h2>{selected.player.name}</h2>
            <button type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          {url ? (
            <>
              {selected.presentation?.startsWith("silhouette") ||
              selected.quiz ? (
                <ClipVideo
                  src={url}
                  label={`${selected.player.name} silhouette`}
                  active={active}
                  onFailure={() =>
                    setVideoError("This saved video could not play.")
                  }
                />
              ) : (
                <p className="jumper-notice">
                  Legacy download · this older file may contain original player
                  colors. Create a new silhouette to anonymize it.
                </p>
              )}
              <a
                className="button button-outline"
                href={url}
                download={`jumper-${selected.id}.${selected.mime === "video/mp4" ? "mp4" : "webm"}`}
              >
                <Download size={16} /> Download
              </a>
            </>
          ) : !videoError ? (
            <p role="status">Opening video…</p>
          ) : null}
          {videoError ? (
            <p role="alert">
              {videoError}{" "}
              <button
                type="button"
                onClick={() => setReload((value) => value + 1)}
              >
                Retry video
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
