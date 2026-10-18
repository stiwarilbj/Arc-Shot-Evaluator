import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeName, type Clip, type PersonalClip } from "./domain";
import { videoBlob, saveClip } from "./storage";
import { ClipVideo, useBlobUrl } from "./JumperLab";
import VideoEditPanel, { type EditOutput } from "./VideoEditPanel";
export default function EditClipCopy({
  clip,
  active,
  onClose,
  onSaved,
}: {
  clip: Clip;
  active: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [base, setBase] = useState<Blob | null>(null),
    [initial, setInitial] = useState<
      { highlight: Blob; clean: Blob; duration: number } | undefined
    >(),
    [output, setOutput] = useState<EditOutput | null>(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [reviewed, setReviewed] = useState(false),
    [quiz, setQuiz] = useState(clip.quiz),
    [name, setName] = useState(clip.player.name),
    [saved, setSaved] = useState(false),
    [saving, setSaving] = useState(false);
  const identity = useRef(crypto.randomUUID()),
    lock = useRef(false),
    signature = useRef("");
  const url = useBlobUrl(output?.highlight ?? null);
  useEffect(() => {
    let cancelled = false;
    setError("");
    setBase(null);
    void (async () => {
      if (!clip.presentation?.startsWith("silhouette") && !clip.quiz)
        throw Error(
          "This legacy highlight contains original player colors. Upload it in Create and mask it before editing a silhouette copy.",
        );
      const base = await videoBlob(
        clip.id,
        clip.project ? "base" : clip.quiz ? "quiz" : "highlight",
      );
      const highlight = clip.project
        ? await videoBlob(clip.id, "highlight")
        : base;
      const clean =
        clip.project && clip.quiz ? await videoBlob(clip.id, "quiz") : base;
      if (!cancelled) {
        setInitial({ highlight, clean, duration: clip.duration });
        setBase(base);
      }
    })().catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [clip, retry]);
  const accept = useCallback((value: EditOutput) => {
    const key = JSON.stringify(value.project);
    if (signature.current !== key || value.stale || value.rendering) {
      setReviewed(false);
      setSaved(false);
      identity.current = crypto.randomUUID();
    }
    signature.current = key;
    setOutput(value);
  }, []);
  async function save() {
    if (
      lock.current ||
      !base ||
      !output ||
      output.stale ||
      output.rendering ||
      !reviewed ||
      saved ||
      (quiz && !name.trim())
    )
      return;
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      const value: PersonalClip = {
        version: 1,
        id: identity.current,
        player: {
          ...clip.player,
          id:
            normalizeName(name) === normalizeName(clip.player.name)
              ? clip.player.id
              : identity.current,
          name: name.trim() || "Selected player",
          aliases:
            normalizeName(name) === normalizeName(clip.player.name)
              ? [...clip.player.aliases]
              : [],
        },
        createdAt: new Date().toISOString(),
        duration: output.duration,
        mime:
          output.highlight.type === "video/mp4" ? "video/mp4" : "video/webm",
        presentation: "silhouette-edited-v1",
        project: output.project,
        base,
        highlight: output.highlight,
        quiz,
        ...(quiz ? { quizVideo: output.clean, reveal: output.clean } : {}),
      };
      await saveClip(value);
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(`${String(e)} Your download remains available.`);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <section aria-label="Edit saved copy">
      <div className="jumper-toolbar">
        <h2>Edit a copy · {clip.player.name}</h2>
        <button disabled={saving || output?.rendering} onClick={onClose}>
          Return to upload editor
        </button>
      </div>
      <p>Your saved original stays unchanged. Saving creates a new clip.</p>
      {base ? (
        <>
          <VideoEditPanel
            key={`${clip.id}:${retry}`}
            base={base}
            baseDuration={
              (clip.project?.baseFrames ?? Math.round(clip.duration * 30)) / 30
            }
            palette={
              clip.project
                ? clip.project.baseProfile === "palette"
                : clip.presentation === "silhouette-palette-v1"
            }
            initialProject={clip.project}
            initialVideos={initial}
            initialCleanAvailable={!clip.project || clip.quiz}
            active={active}
            disabled={saving}
            reviewed={reviewed}
            onChange={accept}
          />
          <section className="jumper-panel">
            <h3>Final-motion review</h3>
            {url ? (
              <ClipVideo
                src={url}
                label="Edited copy finished video"
                active={active}
              />
            ) : null}
            <label className="jumper-check">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={!output || output.stale || output.rendering || saving}
                onChange={(e) => setReviewed(e.target.checked)}
              />{" "}
              I reviewed the full finished motion and masking.
            </label>
            <label>
              Player label
              <input
                value={name}
                disabled={saving || saved}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="jumper-check">
              <input
                type="checkbox"
                checked={quiz}
                disabled={saving || saved}
                onChange={(e) => setQuiz(e.target.checked)}
              />{" "}
              Use the clean copy in my guessing game
            </label>
            <div className="jumper-toolbar">
              <button
                className="button button-primary"
                disabled={
                  saving ||
                  saved ||
                  !reviewed ||
                  !output ||
                  output.stale ||
                  output.rendering ||
                  (quiz && !name.trim())
                }
                onClick={save}
              >
                {saved ? "Copy saved" : saving ? "Saving…" : "Save edited copy"}
              </button>
              {url ? (
                <a
                  className="button button-outline"
                  href={url}
                  download={`jumper-${identity.current}.${output?.highlight.type === "video/mp4" ? "mp4" : "webm"}`}
                >
                  Download
                </a>
              ) : null}
            </div>
          </section>
        </>
      ) : !error ? (
        <p role="status">Loading masked base…</p>
      ) : null}
      {error ? (
        <p className="jumper-notice" role="alert">
          {error} <button onClick={() => setRetry((v) => v + 1)}>Retry</button>
        </p>
      ) : null}
    </section>
  );
}
