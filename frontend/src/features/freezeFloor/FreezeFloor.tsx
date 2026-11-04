import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import {
  Camera,
  Video,
  Upload,
  Crosshair,
  Ruler,
  ScanLine,
  Undo2,
  Redo2,
  Save,
  Download,
  Plus,
  Trash2,
  X,
  LoaderCircle,
} from "lucide-react";
import { FloorScene } from "./FloorScene";
import {
  align,
  LANDMARKS,
  measure,
  project,
  inCourt,
  findContactAt,
  sameMeasurementLocation,
  findExistingMeasurement,
  measurementPointSupported,
} from "./geometry.ts";
import {
  id,
  nextContactLabel,
  newProject,
  type FloorProject,
  type Point,
  type StoredProject,
  type Anchor,
  type Contact,
  validResponse,
} from "./types.ts";
import { normalizeImage } from "./images.ts";
import {
  deleteProject,
  getProject,
  listProjects,
  ProjectConflictError,
  projectRevision,
  saveProject,
  type UnavailableProject,
} from "./storage.ts";
import { analyzePhoto } from "./inference.ts";
import { mergeContactProposals } from "./contactProposals.ts";
import { hasProjectChanges } from "./projectChanges.ts";
import { UnsavedPhotoDialog } from "./UnsavedPhotoDialog";
import { SAMPLES, type Sample } from "./samples.ts";
import {
  VIDEO_SAMPLES,
  readSampleVideo,
  type VideoSample,
} from "./videoSamples.ts";
import { VideoFramePicker } from "./VideoFramePicker";
import { validateVideoFile, videoTime, type CapturedFrame } from "./video.ts";
import "./freeze-floor.css";
type Mode = "inspect" | "measure" | "anchor" | "contact";
type History = {
  past: FloorProject[];
  present: FloorProject;
  future: FloorProject[];
};
type PhotoReplacement = { run: () => void | Promise<void>; name: string };
function Numeric({
  label,
  value,
  min,
  max,
  step = 1,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value)),
    cancelled = useRef(false);
  const errorId = useId(),
    n = Number(draft),
    invalid = !draft.trim() || !Number.isFinite(n) || n < min || n > max;
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label>
      {label}
      <input
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false;
            setDraft(String(value));
            return;
          }
          if (!invalid && n !== value) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            cancelled.current = true;
            setDraft(String(value));
            e.currentTarget.blur();
          }
        }}
      />
      {invalid ? (
        <span id={errorId} className="ff-coordinate-error" aria-live="polite">
          Enter a value from {min} to {max} px
        </span>
      ) : null}
    </label>
  );
}
const message = (e: unknown) =>
  e instanceof Error
    ? e.message
    : "Operation could not finish · Your current photo remains available";
const clamp = (v: number) => Math.max(0, Math.min(1, v));
export default function FreezeFloor({ active }: { active: boolean }) {
  const [history, setHistory] = useState<History | null>(null),
    [image, setImage] = useState<Blob | null>(null),
    [imageUrl, setImageUrl] = useState("");
  const [mode, setMode] = useState<Mode>("inspect"),
    [check, setCheck] = useState(false),
    [coverage, setCoverage] = useState(false),
    [chooser, setChooser] = useState(false),
    [videoChooser, setVideoChooser] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [hovered, setHovered] = useState<string | null>(null),
    [cursor, setCursor] = useState<Point | null>(null),
    [pending, setPending] = useState<{
      image: Point;
      contactId?: string;
    } | null>(null),
    [measurementFeedback, setMeasurementFeedback] = useState<
      { kind: "same" } | { kind: "existing"; id: string } | null
    >(null),
    [landmark, setLandmark] = useState("lane-left-base");
  const [library, setLibrary] = useState<StoredProject[]>([]),
    [unavailableProjects, setUnavailableProjects] = useState<UnavailableProject[]>(
      [],
    ),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [baselineKind, setBaselineKind] = useState<"sample" | "unsaved" | "saved">("unsaved"),
    [saving, setSaving] = useState(false),
    [exporting, setExporting] = useState(false),
    [inspector, setInspector] = useState(false);
  const [replacement, setReplacement] = useState<PhotoReplacement | null>(null);
  const replacementRef = useRef<PhotoReplacement | null>(null);
  const [videoSource, setVideoSource] = useState<{
    file: File;
    key: string;
    sample?: VideoSample;
  } | null>(null);
  const videoSourceRef = useRef(videoSource),
    videoInput = useRef<HTMLInputElement>(null);
  videoSourceRef.current = videoSource;
  const current = useRef<FloorProject | null>(null),
    revision = useRef(0),
    storedVersion = useRef<{ revision: string | null; project: FloorProject | null }>({
      revision: null, project: null,
    }),
    controller = useRef<AbortController | null>(null),
    loadToken = useRef(0),
    libraryRequest = useRef(0),
    activeRef = useRef(active),
    fileInput = useRef<HTMLInputElement>(null),
    chooserButton = useRef<HTMLButtonElement>(null),
    videoChooserButton = useRef<HTMLButtonElement>(null),
    mounted = useRef(true);
  const libraryChannel = useRef<BroadcastChannel | null>(null);
  const gesture = useRef<{
    before: FloorProject;
    kind: "anchor" | "contact";
    id: string;
    moved: boolean;
    latest?: FloorProject;
    start: Point;
    view: "photo" | "court";
  } | null>(null);
  const p = history?.present ?? null;
  const changed = hasProjectChanges(p, storedVersion.current.project);
  const saved = baselineKind === "saved" && !changed;
  const saveStatus = saved
    ? "Saved on this device"
    : baselineKind === "sample" && !changed
      ? "Sample unchanged"
      : "Unsaved project";
  useEffect(() => {
    if (!changed) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [changed]);
  current.current = p;
  activeRef.current = active;
  const alignment = useMemo(
    () => (p ? align(p.anchors, p.reviewed, p) : null),
    [p?.anchors, p?.reviewed, p?.width, p?.height],
  );
  const [dragProject, setDragProject] = useState<FloorProject | null>(null),
    display = dragProject ?? p;
  const displayAlignment = useMemo(
    () => (display ? align(display.anchors, display.reviewed, display) : null),
    [display?.anchors, display?.reviewed, display?.width, display?.height],
  );
  function stop() {
    controller.current?.abort();
    controller.current = null;
    setBusy("");
  }
  function cancelReplacement() {
    replacementRef.current = null;
    setReplacement(null);
  }
  function requestReplacement(name: string, run: PhotoReplacement["run"]) {
    if (!activeRef.current || replacementRef.current) return;
    if (!hasProjectChanges(current.current, storedVersion.current.project)) {
      void run();
      return;
    }
    stop();
    setError("");
    const request = { name, run };
    replacementRef.current = request;
    setReplacement(request);
  }
  async function confirmReplacement(saveFirst: boolean) {
    const request = replacementRef.current;
    if (!request || (saveFirst && saving)) return;
    if (saveFirst && !(await save())) return;
    if (replacementRef.current !== request || !mounted.current || !activeRef.current)
      return;
    cancelReplacement();
    void request.run();
  }
  function beginImageLoad() {
    stop();
    const token = ++loadToken.current;
    const c = new AbortController();
    controller.current = c;
    return {
      c,
      isCurrent: () =>
        !c.signal.aborted &&
        controller.current === c &&
        token === loadToken.current &&
        mounted.current,
    };
  }
  function commit(next: FloorProject) {
    const before = current.current;
    if (before && !hasProjectChanges(next, before)) return;
    stop();
    setMeasurementFeedback(null);
    revision.current++;
    if (
      pending?.contactId &&
      !next.contacts.some((c) => c.id === pending.contactId)
    )
      setPending(null);
    if (
      selected &&
      ![...next.anchors, ...next.contacts].some((v) => v.id === selected)
    )
      setSelected(null);
    setHistory((h) =>
      h
        ? { past: [...h.past, h.present].slice(-50), present: next, future: [] }
        : null,
    );
  }
  function update(fn: (p: FloorProject) => FloorProject) {
    if (current.current) commit(fn(current.current));
  }
  function undo() {
    stop();
    setMeasurementFeedback(null);
    setDragProject(null);
    gesture.current = null;
    revision.current++;
    setHistory((h) =>
      h && h.past.length
        ? {
            past: h.past.slice(0, -1),
            present: h.past.at(-1)!,
            future: [h.present, ...h.future].slice(0, 50),
          }
        : h,
    );
    setPending(null);
  }
  function redo() {
    stop();
    setMeasurementFeedback(null);
    setDragProject(null);
    gesture.current = null;
    revision.current++;
    setHistory((h) =>
      h && h.future.length
        ? {
            past: [...h.past, h.present].slice(-50),
            present: h.future[0],
            future: h.future.slice(1),
          }
        : h,
    );
    setPending(null);
  }
  useEffect(() => {
    if (
      p &&
      selected &&
      ![...p.anchors, ...p.contacts].some((v) => v.id === selected)
    )
      setSelected(null);
  }, [p, selected]);
  async function refresh() {
    const request = ++libraryRequest.current;
    try {
      const v = await listProjects();
      if (mounted.current && request === libraryRequest.current) {
        setLibrary(v.projects);
        setUnavailableProjects(v.unavailable);
      }
    } catch (e) {
      if (mounted.current && request === libraryRequest.current)
        setNotice(message(e));
    }
  }
  function announceLibraryChange() {
    try {
      libraryChannel.current?.postMessage({ type: "library-changed", version: 1 });
    } catch {
      // The completed storage transaction remains authoritative if broadcasting is unavailable
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    let channel: BroadcastChannel | null = null,
      receive: ((event: MessageEvent<unknown>) => void) | null = null;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel("arc-freeze-floor-library-v1");
        libraryChannel.current = channel;
        receive = (event) => {
          const data = event.data;
          if (
            data &&
            typeof data === "object" &&
            (data as { type?: unknown }).type === "library-changed" &&
            (data as { version?: unknown }).version === 1
          )
            void refresh();
        };
        channel.addEventListener("message", receive);
      }
    } catch {
      if (channel && receive) channel.removeEventListener("message", receive);
      channel?.close();
      channel = null;
      receive = null;
      libraryChannel.current = null;
    }
    return () => {
      mounted.current = false;
      replacementRef.current = null;
      if (channel && receive) channel.removeEventListener("message", receive);
      channel?.close();
      if (libraryChannel.current === channel) libraryChannel.current = null;
      libraryRequest.current++;
      controller.current?.abort();
      controller.current = null;
      loadToken.current++;
    };
  }, []);
  useEffect(() => {
    if (!image) {
      setImageUrl("");
      return;
    }
    const url = URL.createObjectURL(image);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  useEffect(() => {
    if (!active) {
      stop();
      cancelReplacement();
      setPending(null);
      setMeasurementFeedback(null);
      setCursor(null);
      setDragProject(null);
      gesture.current = null;
    }
    const hidden = () => {
      if (document.hidden) {
        stop();
        cancelReplacement();
        setDragProject(null);
        gesture.current = null;
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [active]);
  useEffect(() => {
    void loadSample(SAMPLES[0]);
    return () => {
      loadToken.current++;
    };
  }, []);
  function install(
    project: FloorProject,
    blob: Blob,
    savedRevision: string | null = null,
    sample = false,
  ) {
    stop();
    revision.current++;
    setHistory({ past: [], present: project, future: [] });
    current.current = project;
    storedVersion.current = { revision: savedRevision, project };
    setImage(blob);
    setSelected(null);
    setPending(null);
    setMeasurementFeedback(null);
    setCursor(null);
    setDragProject(null);
    gesture.current = null;
    setMode("inspect");
    setBaselineKind(savedRevision !== null ? "saved" : sample ? "sample" : "unsaved");
    setChooser(false);
    setVideoChooser(false);
    setError("");
    setCheck(false);
  }
  async function loadSample(sample: Sample) {
    setVideoChooser(false);
    setVideoSource(null);
    const { c, isCurrent } = beginImageLoad();
    setBusy("Opening photograph");
    setError("");
    try {
      const r = await fetch(
        `${import.meta.env.BASE_URL}freeze-floor/${sample.file}`,
        { signal: c.signal },
      );
      if (!isCurrent()) return;
      if (!r.ok)
        throw Error("Sample photograph could not load · Upload your own image");
      const blob = await r.blob();
      if (!isCurrent()) return;
      const normalized = await normalizeImage(blob, {
        signal: c.signal,
        isCurrent,
      });
      if (!isCurrent()) return;
      const next = {
        ...newProject(normalized.width, normalized.height, sample.name),
        anchors: structuredClone(sample.anchors),
        contacts: structuredClone(sample.contacts),
        attribution: sample.attribution,
        reviewed: sample.anchors.length >= 4,
      };
      controller.current = null;
      install(next, normalized.blob, null, true);
      setNotice(sample.note);
    } catch (e) {
      if (isCurrent()) setError(message(e));
    } finally {
      if (controller.current === c) {
        controller.current = null;
        setBusy("");
      }
    }
  }
  async function openSaved(selected: StoredProject) {
    setVideoChooser(false);
    setVideoSource(null);
    const { c, isCurrent } = beginImageLoad();
    setBusy("Checking saved image");
    try {
      // Save-before-open may have just replaced this library card's revision
      const s = await getProject(selected.project.id);
      if (!isCurrent()) return;
      if (!s)
        throw Error("Saved project is unavailable · Your current photograph remains open");
      controller.current = null;
      install(s.project, s.image, projectRevision(s));
      setNotice("Opened private saved project");
    } catch (e) {
      if (isCurrent()) setError(message(e));
    } finally {
      if (controller.current === c) {
        controller.current = null;
        setBusy("");
      }
    }
  }
  async function upload(file: File) {
    setVideoChooser(false);
    setVideoSource(null);
    const { c, isCurrent } = beginImageLoad();
    setBusy("Checking image dimensions and orientation");
    setError("");
    try {
      const n = await normalizeImage(file, { signal: c.signal, isCurrent });
      if (!isCurrent()) return;
      const next = newProject(
        n.width,
        n.height,
        file.name.replace(/\.[^.]+$/, "") || "My photo",
      );
      controller.current = null;
      install(next, n.blob);
      setNotice(
        "Your image stays on this device · Automatic landmarks need your review",
      );
      if (activeRef.current && !document.hidden)
        void runInference(next, n.blob);
    } catch (e) {
      if (isCurrent()) setError(message(e));
    } finally {
      if (controller.current === c) {
        controller.current = null;
        setBusy("");
      }
    }
  }
  async function loadVideoSample(sample: VideoSample) {
    stop();
    const token = ++loadToken.current;
    const c = new AbortController();
    controller.current = c;
    setBusy("Opening example video");
    setError("");
    try {
      const file = await readSampleVideo(
        sample,
        import.meta.env.BASE_URL,
        c.signal,
      );
      if (
        c.signal.aborted ||
        token !== loadToken.current ||
        !mounted.current ||
        !activeRef.current ||
        document.hidden
      )
        return;
      chooseVideo(file, sample);
      setNotice(sample.note);
    } catch (e) {
      if (
        !c.signal.aborted &&
        controller.current === c &&
        token === loadToken.current
      )
        setError(message(e));
    } finally {
      if (controller.current === c) {
        controller.current = null;
        setBusy("");
      }
    }
  }
  function chooseVideo(file: File, sample?: VideoSample) {
    try {
      validateVideoFile(file);
      stop();
      loadToken.current++;
      setError("");
      setVideoSource({ file, key: id(), sample });
      setVideoChooser(false);
      setChooser(false);
      setNotice(
        "Choose a clear floor moment · Video preview stays on this device",
      );
    } catch (e) {
      setError(message(e));
    }
  }
  function useVideoFrame(frame: CapturedFrame, sourceKey: string) {
    const source = videoSourceRef.current;
    if (
      !source ||
      source.key !== sourceKey ||
      !activeRef.current ||
      document.hidden
    )
      return;
    const next: FloorProject = {
      ...newProject(
        frame.width,
        frame.height,
        `${source.sample?.name ?? source.file.name.replace(/\.[^.]+$/, "")} · ${videoTime(frame.seconds)}`,
      ),
      videoFrame: { seconds: frame.seconds, duration: frame.duration },
      ...(source.sample ? { attribution: source.sample.attribution } : {}),
    };
    requestReplacement(next.name, () => {
      if (videoSourceRef.current?.key !== sourceKey) return;
      loadToken.current++;
      install(next, frame.blob);
      setNotice(
        "New video still · Prior anchors and contacts are not reused · Review this frame’s alignment",
      );
      void runInference(next, frame.blob);
    });
  }
  async function runInference(projectValue = current.current, blob = image) {
    if (!projectValue || !blob || !activeRef.current || document.hidden) return;
    stop();
    setError("");
    const c = new AbortController();
    controller.current = c;
    const rev = revision.current;
    setBusy("Starting private image analysis");
    try {
      const result = await analyzePhoto(
        blob,
        projectValue.imageId,
        rev,
        c.signal,
        (s) => {
          if (controller.current === c) setBusy(s);
        },
      );
      if (
        c.signal.aborted ||
        current.current?.imageId !== projectValue.imageId ||
        revision.current !== rev
      )
        return;
      if (
        !validResponse(result) ||
        result.type !== "result" ||
        result.imageId !== projectValue.imageId ||
        result.revision !== rev
      )
        throw new Error(
          "Image worker returned invalid predictions · No project changes were applied",
        );
      const existing = new Set(projectValue.anchors.map((a) => a.landmark));
      const additions = result.anchors
        .filter((a) => !existing.has(a.landmark))
        .slice(0, 64 - projectValue.anchors.length);
      const merged = mergeContactProposals(
        projectValue.contacts,
        result.contacts,
        projectValue,
      );
      const next = {
        ...projectValue,
        anchors: [...projectValue.anchors, ...additions],
        contacts: merged.contacts,
        reviewed: additions.length ? false : projectValue.reviewed,
      };
      controller.current = null;
      setBusy("");
      commit(next);
      setCheck(true);
      setInspector(true);
      setNotice(
        [...result.warnings, ...merged.warnings].join(" · ") +
          ` · ${result.provider === "wasm" ? "CPU processing" : "WebGPU processing"}`,
      );
    } catch (e) {
      if (!c.signal.aborted && controller.current === c) setError(message(e));
    } finally {
      if (controller.current === c) {
        controller.current = null;
        setBusy("");
      }
    }
  }
  function pointFrom(
    e: PointerEvent<SVGSVGElement>,
    view: "photo" | "court",
  ): Point | null {
    const svg = e.currentTarget,
      ctm = svg.getScreenCTM();
    if (!ctm || !p) return null;
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    if (view === "photo") {
      const v = { x: q.x / p.width, y: q.y / p.height };
      return v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1 ? v : null;
    }
    const v = { x: q.x - 2, y: q.y - 2 };
    if (!inCourt(v) || !alignment?.h) return null;
    const r = project(alignment.h, v);
    return r && r.x >= 0 && r.x <= 1 && r.y >= 0 && r.y <= 1 ? r : null;
  }
  function hitAt(v: Point, view: "photo" | "court") {
    return p && alignment ? findContactAt(p, alignment, v, view) : null;
  }
  function placePoint(v: Point, view: "photo" | "court") {
    if (!p) return;
    if (mode === "anchor") {
      if (view !== "photo") return;
      if (p.anchors.length >= 64) {
        setError("A photo supports up to 64 anchors");
        return;
      }
      if (p.anchors.some((a) => a.landmark === landmark && a.enabled)) {
        setError(
          "That landmark already has an active anchor · Move it or choose another landmark",
        );
        return;
      }
      const anchor: Anchor = {
        id: id(),
        landmark,
        image: v,
        enabled: true,
        origin: "manual",
        confidence: 1,
      };
      update((p) => ({
        ...p,
        anchors: [...p.anchors, anchor],
        reviewed: false,
      }));
      setSelected(anchor.id);
      setMode("inspect");
      return;
    }
    if (mode === "contact") {
      if (p.contacts.length >= 40) {
        setError("Remove a contact before adding another · Limit 40");
        return;
      }
      const c: Contact = {
        id: id(),
        label: nextContactLabel(p.contacts),
        image: v,
        status: "uncertain",
      };
      update((p) => ({ ...p, contacts: [...p.contacts, c] }));
      setSelected(c.id);
      setMode("inspect");
      setInspector(true);
      return;
    }
    if (mode === "measure") {
      setError("");
      setMeasurementFeedback(null);
      const contact = hitAt(v, view);
      const endpoint = contact
        ? { image: contact.image, contactId: contact.id }
        : { image: v };
      if (!pending) {
        setPending(endpoint);
        return;
      }
      if (sameMeasurementLocation(p, pending, endpoint)) {
        setMeasurementFeedback({ kind: "same" });
        return;
      }
      const existing = findExistingMeasurement(p, pending, endpoint);
      if (existing) {
        setMeasurementFeedback({ kind: "existing", id: existing.id });
        setPending(null);
        return;
      }
      if (p.measurements.length >= 20) {
        setError("Remove a distance before adding another · Limit 20");
        return;
      }
      update((p) => ({
        ...p,
        measurements: [
          ...p.measurements,
          { id: id(), a: pending, b: endpoint },
        ],
      }));
      setPending(null);
      return;
    }
  }
  function down(e: PointerEvent<SVGSVGElement>, view: "photo" | "court") {
    if (e.button !== 0 || !p) return;
    const v = pointFrom(e, view);
    if (!v) return;
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    setCursor(v);
    if (mode !== "inspect") {
      placePoint(v, view);
      return;
    }
    const anchor =
      check && view === "photo"
        ? p.anchors.find(
            (a) =>
              Math.hypot(
                (a.image.x - v.x) * p.width,
                (a.image.y - v.y) * p.height,
              ) <
              Math.max(p.width, p.height) * 0.016,
          )
        : undefined;
    const contact = anchor ? null : hitAt(v, view);
    if (anchor || contact) {
      stop();
      revision.current++;
      const target = anchor ?? contact!;
      setSelected(target.id);
      setInspector(true);
      gesture.current = {
        before: p,
        kind: anchor ? "anchor" : "contact",
        id: target.id,
        moved: false,
        start: v,
        view,
      };
    } else setSelected(null);
  }
  function move(e: PointerEvent<SVGSVGElement>, view: "photo" | "court") {
    const v = pointFrom(e, view);
    if (!v) return;
    const hit = hitAt(v, view);
    setCursor(hit?.image ?? v);
    setHovered(hit?.id ?? null);
    const g = gesture.current;
    if (!g || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const dx = v.x - g.start.x,
      dy = v.y - g.start.y;
    if (!g.moved && Math.hypot(dx * p!.width, dy * p!.height) < 3) return;
    g.moved = true;
    const list = g.kind === "anchor" ? "anchors" : "contacts",
      next = {
        ...g.before,
        [list]: g.before[list].map((a) =>
          a.id === g.id
            ? {
                ...a,
                image: { x: clamp(a.image.x + dx), y: clamp(a.image.y + dy) },
              }
            : a,
        ),
        reviewed: g.kind === "anchor" ? false : g.before.reviewed,
      };
    g.latest = next;
    setDragProject(next);
  }
  function up() {
    const g = gesture.current;
    if (g?.moved && g.latest) commit(g.latest);
    gesture.current = null;
    setDragProject(null);
  }
  function cancelGesture() {
    gesture.current = null;
    setDragProject(null);
    setPending(null);
    setMeasurementFeedback(null);
    if (mode === "contact" || mode === "anchor") setMode("inspect");
  }
  function key(e: KeyboardEvent<SVGSVGElement>, view: "photo" | "court") {
    if (e.key === "Escape") {
      cancelGesture();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (!p) return;
    const selectedAnchor = p.anchors.find((a) => a.id === selected);
    const selectedContact = p.contacts.find((c) => c.id === selected);
    // Overhead interaction needs a usable projection, just like pointer input.
    if (view === "court" && (!alignment?.h || !alignment.inverse)) return;
    if ((e.key === "Enter" || e.key === " ") && mode !== "inspect") {
      e.preventDefault();
      const v =
        cursor ??
        selectedContact?.image ??
        (view === "court"
          ? project(alignment!.h!, { x: 25, y: 23.5 })
          : { x: 0.5, y: 0.5 });
      if (!v || v.x < 0 || v.x > 1 || v.y < 0 || v.y > 1) return;
      if (view === "court") {
        const floor = project(alignment!.inverse!, v);
        if (!floor || !inCourt(floor)) return;
      }
      setCursor(v);
      placePoint(v, view);
      return;
    }
    const delta: { [key: string]: Point } = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    if (!delta[e.key]) return;
    e.preventDefault();
    if (
      view === "court" &&
      (mode === "anchor" || (mode === "inspect" && selectedAnchor))
    )
      return;
    const d = delta[e.key],
      factor = e.shiftKey ? 10 : 1;
    const target =
      mode === "inspect" ? (selectedAnchor ?? selectedContact) : undefined;
    const v =
      target?.image ??
      cursor ??
      (view === "court"
        ? project(alignment!.h!, { x: 25, y: 23.5 })
        : { x: 0.5, y: 0.5 });
    if (!v) return;
    let next: Point | null;
    if (view === "court") {
      const floor = project(alignment!.inverse!, v);
      if (!floor) return;
      next = project(alignment!.h!, {
        x: Math.max(0, Math.min(50, floor.x + d.x * factor * 0.1)),
        y: Math.max(0, Math.min(47, floor.y + d.y * factor * 0.1)),
      });
      if (!next || next.x < 0 || next.x > 1 || next.y < 0 || next.y > 1) return;
    } else {
      next = {
        x: clamp(v.x + (d.x * factor) / p.width),
        y: clamp(v.y + (d.y * factor) / p.height),
      };
    }
    setCursor(next);
    if (!target) return;
    const point = next;
    update((p) => ({
      ...p,
      anchors: p.anchors.map((a) =>
        a.id === target.id ? { ...a, image: point } : a,
      ),
      contacts: p.contacts.map((c) =>
        c.id === target.id ? { ...c, image: point } : c,
      ),
      reviewed: selectedAnchor ? false : p.reviewed,
    }));
  }
  async function save() {
    if (!p || !image || saving) return false;
    setSaving(true);
    setError("");
    const value = { ...p, updatedAt: new Date().toISOString() },
      rev = revision.current,
      baseline = storedVersion.current;
    try {
      const nextRevision = await saveProject(
        { project: value, image },
        baseline.revision,
      );
      announceLibraryChange();
      // Later edits still descend from this save, but reopening a source does not
      if (storedVersion.current === baseline) {
        baseline.revision = nextRevision;
        baseline.project = value;
        setBaselineKind("saved");
      }
      if (current.current?.id === value.id && revision.current === rev) {
        setNotice("Saved on this device");
      }
      await refresh();
      return storedVersion.current === baseline && revision.current === rev;
    } catch (e) {
      if (
        current.current?.id === value.id &&
        storedVersion.current === baseline &&
        (revision.current === rev || e instanceof ProjectConflictError)
      ) {
        setError(message(e));
        if (e instanceof ProjectConflictError) setBaselineKind("unsaved");
      }
      if (e instanceof ProjectConflictError) await refresh();
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function download() {
    if (!p || !image) return;
    const imageId = p.imageId;
    setExporting(true);
    setError("");
    try {
      const { exportPng } = await import("./export.tsx");
      await exportPng(p, image, check, coverage);
    } catch (e) {
      if (current.current?.imageId === imageId) setError(message(e));
    } finally {
      setExporting(false);
    }
  }
  const selectedAnchor = display?.anchors.find((a) => a.id === selected),
    selectedContact = display?.contacts.find((c) => c.id === selected);
  const aiming = cursor ?? selectedAnchor?.image ?? selectedContact?.image;
  const largestMismatch = displayAlignment?.mismatches[0];
  const pendingImage = pending?.contactId
    ? display?.contacts.find((c) => c.id === pending.contactId)?.image
    : pending?.image;
  const pendingOutside =
    display && displayAlignment && pending &&
    measurementPointSupported(display, displayAlignment, pending) === false;
  const existingDistance =
    mode === "measure" && measurementFeedback?.kind === "existing"
      ? p?.measurements.findIndex((m) => m.id === measurementFeedback.id) ?? -1
      : -1;
  const highlightedMeasurement =
    existingDistance >= 0 ? p!.measurements[existingDistance].id : null;
  const scene = (view: "photo" | "court") =>
    display && displayAlignment ? (
      <FloorScene
        project={display}
        alignment={displayAlignment}
        imageUrl={imageUrl}
        view={view}
        check={check}
        measurementCoverage={coverage}
        selected={selected}
        hovered={hovered}
        cursor={cursor}
        pending={pendingImage}
        highlightedMeasurement={highlightedMeasurement}
        editing
        onPointerDown={(e) => down(e, view)}
        onPointerMove={(e) => move(e, view)}
        onPointerUp={up}
        onPointerCancel={cancelGesture}
        onPointerLeave={() => {
          if (!gesture.current) {
            setCursor(null);
            setHovered(null);
          }
        }}
        onKeyDown={(e) => key(e, view)}
      />
    ) : null;
  return (
    <main className="freeze-floor" aria-labelledby="freeze-floor-title">
      <header className="ff-heading">
        <div>
          <span className="ff-eyebrow">A different perspective</span>
          <h1 id="freeze-floor-title">Freeze Floor</h1>
          <p>See court spacing beyond the camera angle</p>
        </div>
        <span className="ff-local">Private · On your device</span>
      </header>
      <div className="ff-toolbar">
        <button
          ref={chooserButton}
          aria-expanded={chooser}
          aria-controls="ff-chooser"
          onClick={() => {
            if (videoChooser) stop();
            setChooser((v) => !v);
            setVideoChooser(false);
            void refresh();
          }}
        >
          <Camera size={17} />
          Choose photo
        </button>
        <button
          className="ff-primary"
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={17} />
          Upload image
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) requestReplacement(f.name, () => upload(f));
          }}
          aria-label="Upload basketball image"
        />
        <button
          ref={videoChooserButton}
          aria-expanded={videoChooser}
          aria-controls="ff-video-chooser"
          onClick={() => {
            if (videoChooser) stop();
            setVideoChooser((v) => !v);
            setChooser(false);
          }}
        >
          <Video size={17} /> Example videos
        </button>
        <button onClick={() => videoInput.current?.click()}>
          <Video size={17} />
          Upload video
        </button>
        <input
          ref={videoInput}
          type="file"
          accept="video/mp4,video/webm,video/quicktime,video/x-m4v,.mp4,.m4v,.mov,.webm"
          hidden
          aria-label="Upload basketball video"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) chooseVideo(file);
          }}
        />
        <button
          aria-pressed={check}
          disabled={!p}
          onClick={() => {
            setCheck((v) => !v);
            setInspector(true);
          }}
        >
          <Crosshair size={17} />
          Check the alignment
        </button>
        <div className="ff-units" role="group" aria-label="Distance units">
          <span>Units</span>
          {(["ft", "m"] as const).map((u) => (
            <button
              key={u}
              aria-pressed={p?.units === u}
              disabled={!p}
              onClick={() => update((p) => ({ ...p, units: u }))}
            >
              {u}
            </button>
          ))}
        </div>
        <div className="ff-actions">
          <button
            disabled={!p || saving || !!dragProject}
            onClick={() => void save()}
          >
            <Save size={16} />
            {saving ? "Saving…" : saved ? "Saved" : "Save project"}
          </button>
          <button
            disabled={!p || exporting || !!dragProject}
            onClick={() => void download()}
          >
            <Download size={16} />
            {exporting ? "Preparing…" : "Download PNG"}
          </button>
        </div>
      </div>
      {videoSource || videoChooser || chooser ? (
        <div className="ff-media-panels">
          {videoSource ? (
            <VideoFramePicker
              key={videoSource.key}
              file={videoSource.file}
              active={active && !videoChooser && !chooser && !replacement}
              sample={videoSource.sample}
              onCapture={(frame) => useVideoFrame(frame, videoSource.key)}
              onClose={() => setVideoSource(null)}
            />
          ) : null}
          {videoChooser ? (
            <section
              className="ff-chooser"
              id="ff-video-chooser"
              aria-label="Choose an example video"
            >
              <div className="ff-section-head">
                <h2>Example videos</h2>
                <button
                  aria-label="Close video examples"
                  onClick={() => {
                    stop();
                    setVideoChooser(false);
                    videoChooserButton.current?.focus();
                  }}
                >
                  <X size={17} />
                </button>
              </div>
              <p className="ff-help">
                Choose a clip, then freeze a clear floor moment · Examples need
                alignment review · No model runs until you use a frame
              </p>
              <div className="ff-samples ff-video-samples">
                {VIDEO_SAMPLES.map((sample) => (
                  <button
                    key={sample.id}
                    onClick={() => void loadVideoSample(sample)}
                  >
                    <img
                      src={`${import.meta.env.BASE_URL}freeze-floor/videos/${sample.poster}`}
                      alt=""
                      loading="lazy"
                    />
                    <strong>{sample.name}</strong>
                    <small>{sample.summary}</small>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {chooser ? (
            <section
              className="ff-chooser"
              id="ff-chooser"
              aria-label="Choose a photograph or saved project"
            >
              <div className="ff-section-head">
                <h2>Choose photo</h2>
                <button
                  aria-label="Close photo chooser"
                  onClick={() => {
                    setChooser(false);
                    chooserButton.current?.focus();
                  }}
                >
                  <X size={17} />
                </button>
              </div>
              <div className="ff-samples">
                {SAMPLES.map((s) => (
                  <button key={s.id} onClick={() => requestReplacement(s.name, () => loadSample(s))}>
                    <img
                      src={`${import.meta.env.BASE_URL}freeze-floor/${s.file}`}
                      alt=""
                    />
                    <strong>{s.name}</strong>
                    <small>
                      {s.id === "closeup"
                        ? "Insufficient floor evidence"
                        : "Reviewed manual alignment"}
                    </small>
                  </button>
                ))}
              </div>
              <h3>
                Saved on this browser origin ·{" "}
                {library.length + unavailableProjects.length}/20
              </h3>
              <p className="ff-help">
                Hosted and downloaded libraries are separate · No image is uploaded
              </p>
              {unavailableProjects.length ? (
                <div
                  className="ff-library-warning"
                  role="status"
                  aria-label="Unavailable saved projects"
                >
                  <strong>
                    {unavailableProjects.length} saved project
                    {unavailableProjects.length === 1 ? "" : "s"} unavailable
                  </strong>
                  <p>
                    These entries could not be validated · Their stored data is
                    preserved for recovery
                  </p>
                  <ul>
                    {unavailableProjects.map((entry, index) => (
                      <li key={index}>
                        {entry.name || "Unnamed project"} · Storage key{" "}
                        <code>{String(entry.key)}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {library.length ? (
                <div className="ff-library">
                  {library.map((s) => (
                    <div key={s.project.id}>
                      <button onClick={() => requestReplacement(s.project.name, () => openSaved(s))}>
                        {s.project.name}
                      </button>
                      <button
                        onClick={async () => {
                          const name = window.prompt(
                            "Rename saved project",
                            s.project.name,
                          );
                          if (!name?.trim()) return;
                          const rev = revision.current,
                            baseline = storedVersion.current,
                            expected = projectRevision(s);
                          try {
                            const nextRevision = await saveProject(
                              {
                                ...s,
                                project: {
                                  ...s.project,
                                  name: name.trim().slice(0, 80),
                                  updatedAt: new Date().toISOString(),
                                },
                              },
                              expected,
                            );
                            announceLibraryChange();
                            if (
                              current.current?.id === s.project.id &&
                              storedVersion.current === baseline &&
                              baseline.revision === expected
                            ) {
                              baseline.revision = nextRevision;
                              baseline.project = { ...s.project, name: name.trim().slice(0, 80) };
                              setBaselineKind("saved");
                              if (revision.current === rev) {
                                update((p) => ({
                                  ...p,
                                  name: name.trim().slice(0, 80),
                                }));
                              }
                            }
                            await refresh();
                          } catch (e) {
                            setError(message(e));
                            if (e instanceof ProjectConflictError) await refresh();
                          }
                        }}
                      >
                        Rename
                      </button>
                      <button
                        aria-label={`Delete ${s.project.name}`}
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Delete “${s.project.name}” from this device?`,
                            )
                          )
                            return;
                          setError("");
                          try {
                            await deleteProject(s.project.id, projectRevision(s));
                            announceLibraryChange();
                            if (current.current?.id === s.project.id)
                              setBaselineKind("unsaved");
                            await refresh();
                          } catch (e) {
                            setError(message(e));
                            if (e instanceof ProjectConflictError) await refresh();
                          }
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="ff-help">
                  {unavailableProjects.length
                    ? "No saved projects are currently available · Unavailable entries remain stored"
                    : "Save your first project to keep its image, contacts, and measurements together"}
                </p>
              )}
            </section>
          ) : null}
        </div>
      ) : null}
      {replacement ? (
        <UnsavedPhotoDialog
          target={replacement.name}
          saving={saving}
          error={error}
          onSave={() => void confirmReplacement(true)}
          onDiscard={() => void confirmReplacement(false)}
          onCancel={cancelReplacement}
        />
      ) : null}
      {error && !replacement ? (
        <div className="ff-error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      ) : null}
      {busy ? (
        <div className="ff-progress" role="status">
          <LoaderCircle size={16} className="ff-spin" />
          {busy}
          {controller.current ? (
            <button
              onClick={() => {
                stop();
                setNotice(
                  "Automatic processing cancelled · Manual correction is available",
                );
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
      {p && alignment ? (
        <>
          <div className="ff-status" role="status">
            <span className={`ff-status-label ff-${alignment.status}`}>
              {alignment.status === "ready"
                ? "✓ Alignment ready"
                : alignment.status === "review"
                  ? "△ Check alignment"
                  : "○ Insufficient court evidence"}
            </span>
            <span>{alignment.reason}</span>
          </div>
          <div className="ff-split">
            <section className="ff-panel">
              <h2>
                Photograph{" "}
                <span>
                  {p.width} × {p.height}
                  {p.videoFrame
                    ? ` · Video still ${videoTime(p.videoFrame.seconds)}`
                    : ""}
                </span>
              </h2>
              <div className="ff-stage ff-photo">
                {scene("photo")}
                {aiming && imageUrl && active ? (
                  <div
                    className="ff-magnifier"
                    aria-label="Magnified aiming view"
                  >
                    <svg
                      viewBox={`${aiming.x * p.width - p.width * 0.065} ${aiming.y * p.height - p.width * 0.065} ${p.width * 0.13} ${p.width * 0.13}`}
                    >
                      <image
                        href={imageUrl}
                        width={p.width}
                        height={p.height}
                      />
                      <path
                        d={`M${aiming.x * p.width - 10} ${aiming.y * p.height}h20M${aiming.x * p.width} ${aiming.y * p.height - 10}v20`}
                        stroke="#f27b43"
                        strokeWidth={2}
                      />
                    </svg>
                  </div>
                ) : null}
              </div>
            </section>
            <section className="ff-panel">
              <h2>
                Overhead court <span>NBA · 50 × 47 ft</span>
              </h2>
              <div className="ff-stage">{scene("court")}</div>
            </section>
          </div>
          <div className="ff-controls">
            <div role="group" aria-label="Interaction mode">
              <button
                aria-pressed={mode === "inspect"}
                onClick={() => {
                  setMode("inspect");
                  setPending(null);
                  setMeasurementFeedback(null);
                }}
              >
                <ScanLine size={16} />
                Inspect
              </button>
              <button
                aria-pressed={mode === "measure"}
                onClick={() => {
                  setMode("measure");
                  setPending(null);
                  setMeasurementFeedback(null);
                }}
              >
                <Ruler size={16} />
                Measure distance
              </button>
            </div>
            <div className="ff-region-toggles">
              <label>
                <input
                  type="checkbox"
                  checked={coverage}
                  onChange={(e) => setCoverage(e.target.checked)}
                />
                Measurement coverage
              </label>
              {(
                [
                  ["paint", "Paint"],
                  ["corners", "Corner areas"],
                  ["restricted", "Restricted area"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={p.regions[key]}
                    onChange={(e) =>
                      update((p) => ({
                        ...p,
                        regions: { ...p.regions, [key]: e.target.checked },
                      }))
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="ff-history">
              <button
                aria-label="Undo floor edit"
                disabled={!history?.past.length}
                onClick={undo}
              >
                <Undo2 size={17} />
              </button>
              <button
                aria-label="Redo floor edit"
                disabled={!history?.future.length}
                onClick={redo}
              >
                <Redo2 size={17} />
              </button>
            </div>
          </div>
          <div
            className="ff-details"
            role="region"
            aria-label="Project details and corrections"
            tabIndex={0}
          >
            {coverage ? (
              <p className="ff-coverage-key" role="status">
                {displayAlignment?.h &&
                displayAlignment.inverse &&
                displayAlignment.hull.length >= 3
                  ? "Dashed blue outline · Region supported by accepted landmarks"
                  : "Measurement coverage unavailable · Add well-spread floor landmarks"}
              </p>
            ) : null}
            <div className="ff-caption">
              <p>
                {mode === "measure"
                  ? pending
                    ? "Select the second grounded floor point · Escape cancels"
                    : "Select two grounded floor points in either view"
                  : mode === "anchor"
                    ? "Click the named landmark on the photograph · Escape cancels"
                    : mode === "contact"
                      ? "Click a visible floor-contact point · Confirm grounding in the inspector"
                      : "Inspect a player or a floor point · Free-space cursors are floor projections"}
                <br />
                <span>
                  Hidden or airborne feet remain uncertain · Arrow keys move 1
                  photo pixel or 0.1 ft on the court · Shift moves 10× · Enter
                  places a point
                </span>
              </p>
              <span role="status" aria-label="Project save status">{saveStatus}</span>
            </div>
            {mode === "measure" && pendingOutside ? (
              <p className="ff-measurement-feedback" role="status">
                Outside supported region · Escape cancels the first endpoint
              </p>
            ) : null}
            {mode === "measure" &&
            (measurementFeedback?.kind === "same" || existingDistance >= 0) ? (
              <p className="ff-measurement-feedback" role="status">
                {measurementFeedback?.kind === "same"
                  ? "Choose a different player or floor point for the second endpoint"
                  : `Distance ${existingDistance + 1} already exists · Highlighted in both views`}
              </p>
            ) : null}
            {p.measurements.length ? (
              <section className="ff-measurements" aria-label="Distances">
                {p.measurements.map((m, i) => {
                  const r = measure(p, alignment, m.a, m.b);
                  const outside = [m.a, m.b].some((v) =>
                    measurementPointSupported(p, alignment, v) === false,
                  );
                  return (
                    <div
                      key={m.id}
                      data-highlighted={m.id === highlightedMeasurement}
                    >
                      <Ruler size={16} />
                      <span>
                        <strong>
                          Distance {i + 1} ·{" "}
                          {r.value !== undefined
                            ? `Approx ${r.value.toFixed(1)} ${p.units}`
                            : "Withheld"}
                        </strong>
                        <small>
                          {r.value !== undefined
                            ? `Estimated range ${r.low!.toFixed(1)}–${r.high!.toFixed(1)} ${p.units} · Sensitivity estimate, not a confidence interval`
                            : outside && r.reason !== "Outside supported region"
                              ? `Outside supported region · ${r.reason}`
                              : r.reason}
                        </small>
                      </span>
                      <button
                        aria-label={`Delete distance ${i + 1}`}
                        onClick={() =>
                          update((p) => ({
                            ...p,
                            measurements: p.measurements.filter(
                              (x) => x.id !== m.id,
                            ),
                          }))
                        }
                      >
                        <X size={15} />
                      </button>
                    </div>
                  );
                })}
              </section>
            ) : null}
            <details
              className="ff-inspector"
              open={inspector}
              onToggle={(e) => setInspector(e.currentTarget.open)}
            >
              <summary>
                Correct alignment & player contacts{" "}
                <span>
                  {p.anchors.length} landmarks · {p.contacts.length} contacts
                </span>
              </summary>
              <div className="ff-inspector-grid">
                <section>
                  <h3>Floor landmarks</h3>
                  <p className="ff-help">
                    Use floor-line intersections, never the raised hoop or
                    backboard · Spread anchors around the area you want to measure
                  </p>
                  <div className="ff-row">
                    <button disabled={!!busy} onClick={() => void runInference()}>
                      Retry automatic proposals
                    </button>
                    <span className="ff-help">
                      Experimental · Review required
                    </span>
                  </div>
                  <div className="ff-row">
                    <select
                      aria-label="Landmark to add"
                      value={landmark}
                      onChange={(e) => setLandmark(e.target.value)}
                    >
                      {LANDMARKS.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        setCheck(true);
                        setMode("anchor");
                      }}
                    >
                      <Plus size={15} />
                      Add anchor
                    </button>
                  </div>
                  <button
                    className="ff-largest-mismatch"
                    disabled={!largestMismatch}
                    onClick={() => {
                      if (!largestMismatch) return;
                      setSelected(largestMismatch.id);
                      setCheck(true);
                      setMode("inspect");
                      setPending(null);
                      setMeasurementFeedback(null);
                      setCursor(
                        p.anchors.find((a) => a.id === largestMismatch.id)?.image ??
                          null,
                      );
                    }}
                  >
                    Select largest mismatch
                    {largestMismatch
                      ? ` · L${p.anchors.findIndex((a) => a.id === largestMismatch.id) + 1} · ${Math.round(largestMismatch.pixels)} px`
                      : " · Unavailable"}
                  </button>
                  <p className="ff-help">
                    Mismatch compares each landmark with this fit · It does not
                    confirm correct court placement
                  </p>
                  <div className="ff-items">
                    {p.anchors.map((a, i) => {
                      const mismatch = displayAlignment?.mismatches.find(
                        (m) => m.id === a.id,
                      );
                      return (
                        <div
                          key={a.id}
                          className={selected === a.id ? "ff-item-selected" : ""}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Include landmark ${i + 1}`}
                            checked={a.enabled}
                            onChange={(e) =>
                              update((p) => ({
                                ...p,
                                anchors: p.anchors.map((x) =>
                                  x.id === a.id
                                    ? { ...x, enabled: e.target.checked }
                                    : x,
                                ),
                                reviewed: false,
                              }))
                            }
                          />
                          <button
                            onClick={() => {
                              setSelected(a.id);
                              setCheck(true);
                            }}
                            title={
                              LANDMARKS.find((l) => l.id === a.landmark)?.label
                            }
                          >
                            <span className="ff-landmark-label">
                              <span>
                                L{i + 1} ·{" "}
                                {LANDMARKS.find((l) => l.id === a.landmark)?.label}
                              </span>
                              <small>
                                Fit mismatch:{" "}
                                {mismatch
                                  ? `${Math.round(mismatch.pixels)} px`
                                  : "unavailable"}
                              </small>
                            </span>
                          </button>
                          <button
                            aria-label={`Delete landmark ${i + 1}`}
                            onClick={() =>
                              update((p) => ({
                                ...p,
                                anchors: p.anchors.filter((x) => x.id !== a.id),
                                reviewed: false,
                              }))
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {selectedAnchor ? (
                    <>
                      <label>
                        Selected landmark
                        <select
                          aria-label="Reassign landmark"
                          value={selectedAnchor.landmark}
                          onChange={(e) =>
                            update((p) => ({
                              ...p,
                              anchors: p.anchors.map((a) =>
                                a.id === selectedAnchor.id
                                  ? { ...a, landmark: e.target.value }
                                  : a,
                              ),
                              reviewed: false,
                            }))
                          }
                        >
                          {LANDMARKS.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="ff-coordinate-fields">
                        {(["x", "y"] as const).map((key) => (
                          <Numeric
                            key={`${selectedAnchor.id}-${key}`}
                            label={`Landmark ${key.toUpperCase()} (px)`}
                            value={
                              Math.round(
                                selectedAnchor.image[key] *
                                  (key === "x" ? p.width : p.height) *
                                  10,
                              ) / 10
                            }
                            min={0}
                            max={key === "x" ? p.width : p.height}
                            step={0.1}
                            onCommit={(n) =>
                              update((p) => ({
                                ...p,
                                anchors: p.anchors.map((a) =>
                                  a.id === selectedAnchor.id
                                    ? {
                                        ...a,
                                        image: {
                                          ...a.image,
                                          [key]:
                                            n /
                                            (key === "x" ? p.width : p.height),
                                        },
                                      }
                                    : a,
                                ),
                                reviewed: false,
                              }))
                            }
                          />
                        ))}
                      </div>
                    </>
                  ) : null}
                  <button
                    className="ff-review"
                    disabled={
                      !alignment.h || alignment.rejected.length > 0 || !check
                    }
                    onClick={() => {
                      update((p) => ({ ...p, reviewed: true }));
                      setNotice(
                        "Overlay review recorded · Measurements are estimates within the anchored area",
                      );
                    }}
                  >
                    I checked the floor-line overlay
                  </button>
                </section>
                <section>
                  <h3>Player contacts</h3>
                  <p className="ff-help">
                    Ankles are proposals, not proof of grounding · Drag contacts
                    to visible shoe-floor positions and remove spectators
                  </p>
                  <button onClick={() => setMode("contact")}>
                    <Plus size={15} />
                    Add player contact
                  </button>
                  <div className="ff-items">
                    {p.contacts.map((c) => (
                      <div
                        key={c.id}
                        className={selected === c.id ? "ff-item-selected" : ""}
                      >
                        <button
                          onClick={() => {
                            setSelected(c.id);
                            setCursor(c.image);
                          }}
                        >
                          Player {c.label}
                        </button>
                        {c.status === "uncertain" &&
                        c.proposalAnkleKeypointCount ? (
                          <span className="ff-contact-evidence" role="note">
                            Model · {c.proposalAnkleKeypointCount} ankle keypoint
                            {c.proposalAnkleKeypointCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {c.status === "uncertain" &&
                        c.proposalAnkleOutsideBoxWithinMargin ? (
                          <span
                            className="ff-contact-edge"
                            role="note"
                            title="At least one ankle point landed just outside the detected person box but within the 5% allowance · Check the contact position"
                          >
                            Ankle just outside box · review position
                          </span>
                        ) : null}
                        {c.boxImageEdges?.length || c.boxTouchesImageEdge ? (
                          <span
                            className="ff-contact-edge"
                            role="note"
                            title={
                              c.boxImageEdges?.includes("bottom")
                                ? "The detected box reaches the bottom photo edge · Check whether the shoes are cropped"
                                : "The detected box reaches a photo edge · Check whether the feet are visible"
                            }
                          >
                            Photo edge{c.boxImageEdges?.length === 1 ? "" : "s"} · {c.boxImageEdges?.length
                              ? c.boxImageEdges.join(", ")
                              : "side unavailable"}
                            {c.boxImageEdges?.includes("bottom")
                              ? " · shoes may be cropped"
                              : " · review feet"}
                          </span>
                        ) : null}
                        <select
                          aria-label={`Player ${c.label} contact status`}
                          value={c.status}
                          onChange={(e) =>
                            update((p) => ({
                              ...p,
                              contacts: p.contacts.map((x) =>
                                x.id === c.id
                                  ? {
                                      ...x,
                                      status: e.target.value as Contact["status"],
                                    }
                                  : x,
                              ),
                            }))
                          }
                        >
                          {["uncertain", "grounded", "hidden", "airborne"].map(
                            (s) => (
                              <option key={s}>{s}</option>
                            ),
                          )}
                        </select>
                        <button
                          aria-label={`Remove player ${c.label}`}
                          onClick={() =>
                            update((p) => ({
                              ...p,
                              contacts: p.contacts.filter((x) => x.id !== c.id),
                              measurements: p.measurements.filter(
                                (m) =>
                                  m.a.contactId !== c.id &&
                                  m.b.contactId !== c.id,
                              ),
                            }))
                          }
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {selectedContact ? (
                    <>
                      {selectedContact.proposalAnkles?.length ? (
                        <p className="ff-contact-evidence-note" role="note">
                          {selectedContact.proposalAnkles.length === 2
                            ? "Cyan rings show the detected ankles · The orange proposal averages their horizontal position and uses the lower point as its floor position"
                            : "The cyan ring shows the detected ankle · The orange proposal uses that point"}
                        </p>
                      ) : null}
                      <div className="ff-coordinate-fields">
                        {(["x", "y"] as const).map((key) => (
                          <Numeric
                            key={`${selectedContact.id}-${key}`}
                            label={`Contact ${key.toUpperCase()} (px)`}
                            value={
                              Math.round(
                                selectedContact.image[key] *
                                  (key === "x" ? p.width : p.height) *
                                  10,
                              ) / 10
                            }
                            min={0}
                            max={key === "x" ? p.width : p.height}
                            step={0.1}
                            onCommit={(n) =>
                              update((p) => ({
                                ...p,
                                contacts: p.contacts.map((c) =>
                                  c.id === selectedContact.id
                                    ? {
                                        ...c,
                                        image: {
                                          ...c.image,
                                          [key]:
                                            n / (key === "x" ? p.width : p.height),
                                        },
                                      }
                                    : c,
                                ),
                              }))
                            }
                          />
                        ))}
                      </div>
                    </>
                  ) : null}
                  <label>
                    Project name
                    <input
                      aria-label="Project name"
                      value={p.name}
                      maxLength={80}
                      onChange={(e) => {
                        if (e.target.value.trim())
                          update((p) => ({ ...p, name: e.target.value }));
                      }}
                    />
                  </label>
                </section>
              </div>
            </details>
            {notice ? (
              <p className="ff-notice" role="status">
                {notice}
              </p>
            ) : null}
            {p.attribution ? (
              <p className="ff-attribution">
                Photo:{" "}
                <a href={p.attribution.url} target="_blank" rel="noreferrer">
                  {p.attribution.title}
                </a>{" "}
                · {p.attribution.creator} · {p.attribution.license}
              </p>
            ) : null}
            <details className="ff-help-box">
              <summary>How to read Freeze Floor</summary>
              <p>
                Choose an NBA half-court image, or upload a video and freeze a
                clear moment · Review automatic landmarks or place at least four
                floor anchors · Check the line overlay before measuring
              </p>
              <p>
                Confirm visible feet in the contact inspector · Numeric distances
                are limited to the area enclosed by your accepted anchors · The
                range estimates sensitivity to image-point placement, not full
                camera or lens error
              </p>
              <p>
                Automatic alignment is experimental and has not passed the
                required 60-photo accuracy benchmark · The supplied wide views use
                manually reviewed alignments · Close-ups and hidden floor markings
                may not support measurement
              </p>
              <p>
                Images stay on your device · Save commits the normalized image and
                corrections together in this browser origin · Download PNG remains
                available when storage fails
              </p>
            </details>
          </div>
        </>
      ) : !busy ? (
        <button onClick={() => void loadSample(SAMPLES[0])}>
          Open sample photograph
        </button>
      ) : null}
    </main>
  );
}
