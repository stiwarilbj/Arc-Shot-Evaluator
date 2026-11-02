import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import {
  Camera,
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
import { align, LANDMARKS, measure, project, inCourt } from "./geometry.ts";
import {
  id,
  newProject,
  type FloorProject,
  type Point,
  type StoredProject,
  type Anchor,
  type Contact,
} from "./types.ts";
import { normalizeImage, readImageHeader } from "./images.ts";
import { deleteProject, listProjects, saveProject } from "./storage.ts";
import { analyzePhoto } from "./inference.ts";
import { SAMPLES, type Sample } from "./samples.ts";
import "./freeze-floor.css";
type Mode = "inspect" | "measure" | "anchor" | "contact";
type History = {
  past: FloorProject[];
  present: FloorProject;
  future: FloorProject[];
};
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
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label>
      {label}
      <input
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
          const n = Number(draft);
          if (draft.trim() && Number.isFinite(n) && n >= min && n <= max) {
            if (n !== value) onCommit(n);
          } else setDraft(String(value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            setDraft(String(value));
            e.currentTarget.blur();
          }
        }}
      />
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
    [chooser, setChooser] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [hovered, setHovered] = useState<string | null>(null),
    [cursor, setCursor] = useState<Point | null>(null),
    [pending, setPending] = useState<{
      image: Point;
      contactId?: string;
    } | null>(null),
    [landmark, setLandmark] = useState("lane-left-base");
  const [library, setLibrary] = useState<StoredProject[]>([]),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [saved, setSaved] = useState(false),
    [saving, setSaving] = useState(false),
    [exporting, setExporting] = useState(false),
    [inspector, setInspector] = useState(false);
  const current = useRef<FloorProject | null>(null),
    revision = useRef(0),
    controller = useRef<AbortController | null>(null),
    loadToken = useRef(0),
    activeRef = useRef(active),
    fileInput = useRef<HTMLInputElement>(null),
    chooserButton = useRef<HTMLButtonElement>(null),
    mounted = useRef(true);
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
  current.current = p;
  activeRef.current = active;
  const alignment = useMemo(
    () => (p ? align(p.anchors, p.reviewed) : null),
    [p?.anchors, p?.reviewed],
  );
  const [dragProject, setDragProject] = useState<FloorProject | null>(null),
    display = dragProject ?? p;
  const displayAlignment = useMemo(
    () => (display ? align(display.anchors, display.reviewed) : null),
    [display?.anchors, display?.reviewed],
  );
  function stop() {
    controller.current?.abort();
    controller.current = null;
    setBusy("");
  }
  function commit(next: FloorProject) {
    stop();
    revision.current++;
    setSaved(false);
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
    setDragProject(null);
    gesture.current = null;
    revision.current++;
    setSaved(false);
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
    revision.current++;
    setSaved(false);
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
  async function refresh() {
    try {
      const v = await listProjects();
      if (mounted.current) setLibrary(v);
    } catch (e) {
      if (mounted.current) setNotice(message(e));
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      controller.current?.abort();
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
      setPending(null);
      setCursor(null);
      setDragProject(null);
      gesture.current = null;
    }
    const hidden = () => {
      if (document.hidden) {
        stop();
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
  function install(project: FloorProject, blob: Blob, isSaved = false) {
    stop();
    revision.current++;
    setHistory({ past: [], present: project, future: [] });
    current.current = project;
    setImage(blob);
    setSelected(null);
    setPending(null);
    setCursor(null);
    setDragProject(null);
    gesture.current = null;
    setMode("inspect");
    setSaved(isSaved);
    setChooser(false);
    setError("");
    setCheck(false);
  }
  async function loadSample(sample: Sample) {
    stop();
    const token = ++loadToken.current;
    setBusy("Opening photograph");
    try {
      const r = await fetch(
        `${import.meta.env.BASE_URL}freeze-floor/${sample.file}`,
      );
      if (!r.ok)
        throw Error("Sample photograph could not load · Upload your own image");
      const normalized = await normalizeImage(await r.blob());
      if (token !== loadToken.current || !mounted.current) return;
      const next = {
        ...newProject(normalized.width, normalized.height, sample.name),
        anchors: structuredClone(sample.anchors),
        contacts: structuredClone(sample.contacts),
        attribution: sample.attribution,
        reviewed: sample.anchors.length >= 4,
      };
      install(next, normalized.blob);
      setNotice(sample.note);
    } catch (e) {
      if (token === loadToken.current) setError(message(e));
    } finally {
      if (token === loadToken.current) setBusy("");
    }
  }
  async function openSaved(s: StoredProject) {
    stop();
    const token = ++loadToken.current;
    setBusy("Checking saved image");
    try {
      const header = readImageHeader(
        new Uint8Array(await s.image.slice(0, 512 * 1024).arrayBuffer()),
      );
      if (
        header.width !== s.project.width ||
        header.height !== s.project.height
      )
        throw Error(
          "Saved image does not match its project · Original record was preserved",
        );
      const bitmap = await createImageBitmap(s.image);
      try {
        if (
          bitmap.width !== s.project.width ||
          bitmap.height !== s.project.height
        )
          throw Error("Saved image dimensions are inconsistent");
      } finally {
        bitmap.close();
      }
      if (token !== loadToken.current || !mounted.current) return;
      install(s.project, s.image, true);
      setNotice("Opened private saved project");
    } catch (e) {
      if (token === loadToken.current) setError(message(e));
    } finally {
      if (token === loadToken.current) setBusy("");
    }
  }
  async function upload(file: File) {
    stop();
    const token = ++loadToken.current;
    setBusy("Checking image dimensions and orientation");
    setError("");
    try {
      const n = await normalizeImage(file);
      if (token !== loadToken.current || !mounted.current) return;
      const next = newProject(
        n.width,
        n.height,
        file.name.replace(/\.[^.]+$/, "") || "My photo",
      );
      install(next, n.blob);
      setNotice(
        "Your image stays on this device · Automatic landmarks need your review",
      );
      if (activeRef.current && !document.hidden)
        void runInference(next, n.blob);
    } catch (e) {
      if (token === loadToken.current) setError(message(e));
    } finally {
      if (token === loadToken.current && !controller.current) setBusy("");
    }
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
      const existing = new Set(projectValue.anchors.map((a) => a.landmark));
      const additions = result.anchors
        .filter((a) => !existing.has(a.landmark))
        .slice(0, 64 - projectValue.anchors.length);
      const contacts = [...projectValue.contacts];
      for (const c of result.contacts) {
        if (
          contacts.length < 40 &&
          !contacts.some(
            (x) =>
              Math.hypot(x.image.x - c.image.x, x.image.y - c.image.y) < 0.035,
          )
        )
          contacts.push({
            ...c,
            label: String(
              Math.max(0, ...contacts.map((x) => Number(x.label) || 0)) + 1,
            ),
          });
      }
      const next = {
        ...projectValue,
        anchors: [...projectValue.anchors, ...additions],
        contacts,
        reviewed: additions.length ? false : projectValue.reviewed,
      };
      controller.current = null;
      commit(next);
      setCheck(true);
      setInspector(true);
      setNotice(
        result.warnings.join(" · ") +
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
    if (!p) return null;
    // Photo selection uses visible person boxes, so a body hover highlights the foot contact.
    const contacts = p.contacts.filter(
      (c) =>
        Math.hypot((c.image.x - v.x) * p.width, (c.image.y - v.y) * p.height) <
          Math.max(p.width, p.height) * 0.02 ||
        (view === "photo" &&
          c.box &&
          v.x >= c.box[0] &&
          v.x <= c.box[2] &&
          v.y >= c.box[1] &&
          v.y <= c.box[3]),
    );
    return (
      contacts.sort(
        (a, b) =>
          Math.hypot(a.image.x - v.x, a.image.y - v.y) -
          Math.hypot(b.image.x - v.x, b.image.y - v.y),
      )[0] ?? null
    );
  }
  function down(e: PointerEvent<SVGSVGElement>, view: "photo" | "court") {
    if (e.button !== 0 || !p) return;
    const v = pointFrom(e, view);
    if (!v) return;
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    setCursor(v);
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
        label: String(
          Math.max(0, ...p.contacts.map((c) => Number(c.label) || 0)) + 1,
        ),
        image: v,
        status: "uncertain",
      };
      update((p) => ({ ...p, contacts: [...p.contacts, c] }));
      setSelected(c.id);
      setMode("inspect");
      setInspector(true);
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
    if (mode === "measure") {
      const endpoint = contact
        ? { image: contact.image, contactId: contact.id }
        : { image: v };
      if (!pending) {
        setPending(endpoint);
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
    if (mode === "contact" || mode === "anchor") setMode("inspect");
  }
  function key(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === "Escape") {
      cancelGesture();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && mode !== "inspect" && p) {
      e.preventDefault();
      const v = cursor ?? { x: 0.5, y: 0.5 };
      if (
        mode === "anchor" &&
        p.anchors.length < 64 &&
        !p.anchors.some((a) => a.enabled && a.landmark === landmark)
      ) {
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
      } else if (mode === "contact" && p.contacts.length < 40) {
        const c: Contact = {
          id: id(),
          label: String(
            Math.max(0, ...p.contacts.map((c) => Number(c.label) || 0)) + 1,
          ),
          image: v,
          status: "uncertain",
        };
        update((p) => ({ ...p, contacts: [...p.contacts, c] }));
        setSelected(c.id);
        setMode("inspect");
      } else if (mode === "measure") {
        if (!pending) setPending({ image: v });
        else if (p.measurements.length < 20) {
          update((p) => ({
            ...p,
            measurements: [
              ...p.measurements,
              { id: id(), a: pending, b: { image: v } },
            ],
          }));
          setPending(null);
        }
      }
      return;
    }
    const delta: { [key: string]: Point } = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    if (!delta[e.key] || !p) return;
    e.preventDefault();
    const d = delta[e.key],
      factor = e.shiftKey ? 10 : 1;
    if (!selected || mode !== "inspect") {
      const v = cursor ?? { x: 0.5, y: 0.5 };
      setCursor({
        x: clamp(v.x + (d.x * factor) / p.width),
        y: clamp(v.y + (d.y * factor) / p.height),
      });
      return;
    }
    update((p) => ({
      ...p,
      anchors: p.anchors.map((a) =>
        a.id === selected
          ? {
              ...a,
              image: {
                x: clamp(a.image.x + (d.x * factor) / p.width),
                y: clamp(a.image.y + (d.y * factor) / p.height),
              },
            }
          : a,
      ),
      contacts: p.contacts.map((c) =>
        c.id === selected
          ? {
              ...c,
              image: {
                x: clamp(c.image.x + (d.x * factor) / p.width),
                y: clamp(c.image.y + (d.y * factor) / p.height),
              },
            }
          : c,
      ),
      reviewed: p.anchors.some((a) => a.id === selected) ? false : p.reviewed,
    }));
  }
  async function save() {
    if (!p || !image || saving) return;
    setSaving(true);
    setError("");
    const value = { ...p, updatedAt: new Date().toISOString() },
      rev = revision.current;
    try {
      await saveProject({ project: value, image });
      if (current.current?.imageId === p.imageId && revision.current === rev) {
        setSaved(true);
        setNotice("Saved on this device");
      }
      await refresh();
    } catch (e) {
      setError(message(e));
      setSaved(false);
    } finally {
      setSaving(false);
    }
  }
  async function download() {
    if (!p || !image) return;
    setExporting(true);
    setError("");
    try {
      const { exportPng } = await import("./export.tsx");
      await exportPng(p, image, check);
    } catch (e) {
      setError(message(e));
    } finally {
      setExporting(false);
    }
  }
  const selectedAnchor = display?.anchors.find((a) => a.id === selected),
    selectedContact = display?.contacts.find((c) => c.id === selected);
  const aiming = cursor ?? selectedAnchor?.image ?? selectedContact?.image;
  const scene = (view: "photo" | "court") =>
    display && displayAlignment ? (
      <FloorScene
        project={display}
        alignment={displayAlignment}
        imageUrl={imageUrl}
        view={view}
        check={check}
        selected={selected}
        hovered={hovered}
        cursor={cursor}
        pending={pending?.image}
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
        onKeyDown={key}
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
            setChooser((v) => !v);
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
            if (f) void upload(f);
          }}
          aria-label="Upload basketball image"
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
              <button key={s.id} onClick={() => void loadSample(s)}>
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
          <h3>Saved on this browser origin · {library.length}/20</h3>
          <p className="ff-help">
            Hosted and downloaded libraries are separate · No image is uploaded
          </p>
          {library.length ? (
            <div className="ff-library">
              {library.map((s) => (
                <div key={s.project.id}>
                  <button onClick={() => void openSaved(s)}>
                    {s.project.name}
                  </button>
                  <button
                    onClick={async () => {
                      const name = window.prompt(
                        "Rename saved project",
                        s.project.name,
                      );
                      if (!name?.trim()) return;
                      try {
                        await saveProject({
                          ...s,
                          project: {
                            ...s.project,
                            name: name.trim().slice(0, 80),
                            updatedAt: new Date().toISOString(),
                          },
                        });
                        if (p?.id === s.project.id) {
                          update((p) => ({
                            ...p,
                            name: name.trim().slice(0, 80),
                          }));
                          setSaved(false);
                        }
                        await refresh();
                      } catch (e) {
                        setError(message(e));
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
                      try {
                        await deleteProject(s.project.id);
                        if (p?.id === s.project.id) setSaved(false);
                        await refresh();
                      } catch (e) {
                        setError(message(e));
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
              Save your first project to keep its image, contacts, and
              measurements together
            </p>
          )}
        </section>
      ) : null}
      {error ? (
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
                }}
              >
                <Ruler size={16} />
                Measure distance
              </button>
            </div>
            <div className="ff-region-toggles">
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
                Hidden or airborne feet remain uncertain · Arrows aim or nudge ·
                Shift moves 10 pixels · Enter places a point
              </span>
            </p>
            <span>{saved ? "Saved on this device" : "Unsaved project"}</span>
          </div>
          {p.measurements.length ? (
            <section className="ff-measurements" aria-label="Distances">
              {p.measurements.map((m, i) => {
                const r = measure(p, alignment, m.a, m.b);
                return (
                  <div key={m.id}>
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
                <div className="ff-items">
                  {p.anchors.map((a, i) => (
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
                        L{i + 1} ·{" "}
                        {LANDMARKS.find((l) => l.id === a.landmark)?.label}
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
                  ))}
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
                          key={key}
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
                  <div className="ff-coordinate-fields">
                    {(["x", "y"] as const).map((key) => (
                      <Numeric
                        key={key}
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
              Choose an NBA half-court image with visible floor markings ·
              Review automatic landmarks or place at least four floor anchors ·
              Check the line overlay before measuring
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
        </>
      ) : !busy ? (
        <button onClick={() => void loadSample(SAMPLES[0])}>
          Open sample photograph
        </button>
      ) : null}
    </main>
  );
}
