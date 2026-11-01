import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Copy, Download, FolderPlus, Plus, Search, Trash2, Upload, X } from "lucide-react";
import type { CourtPoint, PlaybookArrow, PlaybookDraft } from "./types.ts";
import { buildPocketInsertion, createPocketFromSelection, freshPocketCopy, inspectPocketCapture, STARTER_POCKET_ACTIONS, validatePocketAction, type PocketActionDocument, type PocketTransform } from "./pocketActions.ts";
import { createPocketAction, deletePocketAction, listPocketActions, subscribePocketActions, updatePocketAction } from "./pocketStorage.ts";
import { authoredStateBeforeSequence, bindAuthoredActions } from "./simulation.ts";

export type PocketPlacementRequest = {
  pocket: PocketActionDocument;
  assignments: Record<string, number>;
  transform: PocketTransform;
  beforeSequence: number | null;
  includeConnectionPass: boolean;
  insertShared: boolean;
};

const actionLabel = (kind: PlaybookArrow["kind"]) => ({ movement: "Movement", pass: "Pass", screen: "Screen", "slip-screen": "Slip screen", handoff: "Handoff", "pick-roll": "Pick and roll", "pick-pop": "Pick and pop", "off-ball-screen": "Off-ball screen", "pin-down": "Pin-down", "backdoor-cut": "Backdoor cut" })[kind];

export function PocketActionsPanel({ source, selectedIds, selectionMode, onSelectionModeChange, onSelectionChange, onInsert, onPreview, onBeginPlacement, onError, sharedBoundarySequence }: {
  source: PlaybookDraft;
  selectedIds: string[];
  selectionMode: boolean;
  onSelectionModeChange: (value: boolean) => void;
  onSelectionChange: (value: string[]) => void;
  onInsert: (request: PocketPlacementRequest) => boolean;
  onPreview: (arrows: PlaybookArrow[], ballHandlerId: number | null) => void;
  onBeginPlacement: () => void;
  onError: (message: string | null) => void;
  sharedBoundarySequence: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"starter" | "personal">("starter");
  const [pockets, setPockets] = useState<PocketActionDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [removeConnections, setRemoveConnections] = useState(false);
  const [capturePreview, setCapturePreview] = useState<PocketActionDocument | null>(null);
  const [renaming, setRenaming] = useState<PocketActionDocument | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [placement, setPlacement] = useState<PocketActionDocument | null>(null);
  const [assignments, setAssignments] = useState<Record<string, number>>({});
  const [anchor, setAnchor] = useState<CourtPoint>({ x: 50, y: 50 });
  const [rotation, setRotation] = useState(0);
  const [mirrored, setMirrored] = useState(false);
  const [beforeSequence, setBeforeSequence] = useState<number | null>(null);
  const [includeConnectionPass, setIncludeConnectionPass] = useState(false);
  const [insertShared, setInsertShared] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importRef, setImportRef] = useState<HTMLInputElement | null>(null);
  const bindings = useMemo(() => bindAuthoredActions(source), [source]);
  const selectionKey = selectedIds.slice().sort().join("|");
  const selected = useMemo(() => source.arrows.filter((arrow) => selectedIds.includes(arrow.id)), [source.arrows, selectedIds]);
  const issues = useMemo(() => inspectPocketCapture(source.arrows, selectedIds), [source.arrows, selectedIds]);
  const personalPockets = pockets.filter((pocket) => !pocket.starter);
  const visiblePockets = (tab === "starter" ? STARTER_POCKET_ACTIONS : personalPockets).filter((pocket) => !search.trim() || `${pocket.name} ${pocket.summary ?? ""} ${pocket.roles.map((role) => role.label).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  const stateAtBoundary = useMemo(() => authoredStateBeforeSequence(source, beforeSequence), [source, beforeSequence]);
  const baseStart = useMemo(() => {
    const selectedGroup = beforeSequence == null ? [] : bindings.filter((binding) => binding.sequence === beforeSequence);
    return beforeSequence == null
      ? Math.max(0, ...bindings.map((binding) => binding.startTime + binding.durationMs))
      : selectedGroup.length ? Math.min(...selectedGroup.map((binding) => binding.startTime)) : Math.max(0, ...bindings.map((binding) => binding.startTime + binding.durationMs));
  }, [beforeSequence, bindings]);

  async function refresh() {
    setLoading(true);
    try { setPockets(await listPocketActions()); onError(null); }
    catch (error) { onError(error instanceof Error ? error.message : "Pocket library could not be opened"); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    if (!open) return;
    void refresh();
    return subscribePocketActions(() => { void refresh(); });
  // Library refresh only runs when the drawer is opened or storage changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { setCapturePreview(null); }, [selectionKey, source]);
  useEffect(() => {
    if (!placement) { onPreview([], null); return; }
    const missingAssignment = placement.roles.some((role) => !assignments[role.id]);
    if (missingAssignment) { onPreview([], null); return; }
    try {
      const preview = previewRequest();
      onPreview(preview, stateAtBoundary.ballHandlerId);
      onError(null);
    } catch (error) {
      onPreview([], null);
      onError(error instanceof Error ? error.message : "Pocket placement could not be previewed");
    }
    // previewRequest uses the complete placement draft and the authored boundary state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement, assignments, anchor.x, anchor.y, rotation, mirrored, beforeSequence, includeConnectionPass, source, baseStart]);

  function previewRequest() {
    if (!placement) return [];
    const insertion = buildInsertion(placement);
    return insertion.arrows.filter((arrow) => !source.arrows.some((existing) => existing.id === arrow.id));
  }
  function buildInsertion(pocket: PocketActionDocument) {
    const captureBoundary = beforeSequence;
    return buildPocketInsertion({ source, pocket, assignments, transform: { anchor, rotation, mirrored }, beforeSequence: captureBoundary, currentPositions: stateAtBoundary.players, currentBallHandlerId: stateAtBoundary.ballHandlerId, includeConnectionPass, baseStartAtMs: baseStart });
  }
  function beginPlacement(pocket: PocketActionDocument, courtAnchor?: CourtPoint) {
    const defaults = Object.fromEntries(pocket.roles.map((role) => [role.id, 0]));
    setAssignments(defaults);
    setAnchor(courtAnchor ? { ...courtAnchor } : { ...pocket.roles[0].entry });
    setRotation(0); setMirrored(false); setBeforeSequence(null); setIncludeConnectionPass(false); setInsertShared(false);
    setPlacement(pocket);
    onBeginPlacement();
    if (!source.players.length) onError("Add offensive players before placing a pocket action");
    else onError(null);
  }
  useEffect(() => {
    const handleDrop = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: unknown; anchor?: unknown }>).detail;
      if (typeof detail?.id !== "string" || !detail.anchor || typeof detail.anchor !== "object") return;
      const pocket = [...STARTER_POCKET_ACTIONS, ...pockets].find((item) => item.id === detail.id);
      if (!pocket) return;
      const point = detail.anchor as CourtPoint;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      beginPlacement(pocket, point);
    };
    window.addEventListener("arc-pocket-action-drop", handleDrop);
    return () => window.removeEventListener("arc-pocket-action-drop", handleDrop);
  }, [pockets, source]);
  function reviewSelected() {
    if (!selected.length) { onError("Select one or more actions before saving a pocket"); return; }
    if (issues.length && !removeConnections) { onError(issues[0].message); return; }
    try {
      setCapturePreview(createPocketFromSelection(source, selectedIds, "Untitled combination", removeConnections));
      onError(null);
    } catch (error) { onError(error instanceof Error ? error.message : "Pocket action could not be prepared"); }
  }
  async function saveSelected() {
    if (!capturePreview) return;
    if (!capturePreview.name.trim() || capturePreview.roles.some((role) => !role.label.trim())) { onError("Add a name and labels for every role before saving"); return; }
    try {
      const saved = await createPocketAction({ ...capturePreview, name: capturePreview.name.trim(), updatedAt: new Date().toISOString() });
      setPockets((current) => [...current.filter((item) => item.id !== saved.id), saved]);
      setCapturePreview(null); setRemoveConnections(false); onSelectionChange([]); onSelectionModeChange(false); setTab("personal"); onError(null);
    } catch (error) { onError(error instanceof Error ? error.message : "Pocket action could not be saved"); }
  }
  async function renamePocket(pocket: PocketActionDocument) {
    const name = renameValue.trim();
    if (!name) return;
    try {
      const saved = await updatePocketAction({ ...pocket, name, updatedAt: new Date().toISOString() }, pocket.revision);
      setPockets((current) => current.map((item) => item.id === saved.id ? saved : item)); setRenaming(null); onError(null);
    } catch (error) { onError(error instanceof Error ? error.message : "Pocket action could not be renamed"); }
  }
  async function duplicatePocket(pocket: PocketActionDocument) {
    try {
      const copy = freshPocketCopy(pocket);
      const saved = await createPocketAction(copy);
      setPockets((current) => [...current, saved]); onError(null);
    } catch (error) { onError(error instanceof Error ? error.message : "Pocket action could not be copied"); }
  }
  async function removePocket(pocket: PocketActionDocument) {
    if (!window.confirm(`Delete ${pocket.name}?`)) return;
    try { await deletePocketAction(pocket.id); setPockets((current) => current.filter((item) => item.id !== pocket.id)); onError(null); }
    catch (error) { onError(error instanceof Error ? error.message : "Pocket action could not be deleted"); }
  }
  function exportPocket(pocket: PocketActionDocument) {
    const blob = new Blob([JSON.stringify(pocket, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchorEl = document.createElement("a"); anchorEl.href = url; anchorEl.download = `${pocket.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "pocket-action"}.json`; anchorEl.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importPocket(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
    if (!file) return;
    if (file.size > 256 * 1024) { onError("Pocket JSON must be smaller than 256 KiB"); return; }
    setImportBusy(true);
    try {
      const value: unknown = JSON.parse(await file.text());
      validatePocketAction(value);
      const fresh = freshPocketCopy(value);
      const saved = await createPocketAction(savedDocument(fresh));
      setPockets((current) => [...current, saved]); setTab("personal"); onError(null);
    } catch (error) { onError(error instanceof Error ? error.message : "Pocket file could not be imported"); }
    finally { setImportBusy(false); }
  }
  function commitPlacement() {
    if (!placement) return;
    try {
      const insertion = buildInsertion(placement);
      if (insertion.arrows.length > 30) throw Error("This combination and its setup moves would exceed the 30-action limit");
      if (!onInsert({ pocket: placement, assignments, transform: { anchor, rotation, mirrored }, beforeSequence, includeConnectionPass, insertShared })) return;
      setPlacement(null); onPreview([], null); onError(null);
    } catch (error) { onError(error instanceof Error ? error.message : "Pocket action could not be inserted"); }
  }

  return <section className={`pocket-actions-drawer ${open ? "is-open" : ""}`} aria-label="Pocket actions">
    <button type="button" className="pocket-drawer-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><FolderPlus size={16} /><span>Pocket actions</span><small>{personalPockets.length} saved</small></button>
    {open ? <div className="pocket-drawer-content">
      <div className="pocket-drawer-heading"><strong>Build from a combination</strong><button type="button" className="icon-button" aria-label="Close Pocket actions" onClick={() => { setOpen(false); setPlacement(null); onPreview([], null); }}><X size={14} /></button></div>
      <button type="button" className={`pocket-select-mode ${selectionMode ? "is-active" : ""}`} aria-pressed={selectionMode} onClick={() => { onSelectionModeChange(!selectionMode); if (selectionMode) onSelectionChange([]); }}>{selectionMode ? "Done selecting" : "Select combination"}</button>
      {selectionMode ? <div className="pocket-capture-box">
        <strong>{selected.length} action{selected.length === 1 ? "" : "s"} selected</strong>
        {selected.length ? <div className="pocket-capture-actions">{selected.map((arrow) => { const binding = bindings.find((item) => item.arrow.id === arrow.id); const participants = [...new Set([binding?.actorId, binding?.recipientId, binding?.partnerId, arrow.cutter_id, arrow.screener_id].filter((id): id is number => id != null))]; return <p key={arrow.id}>Move {arrow.sequence ?? "?"} · {actionLabel(arrow.kind)}{participants.length ? ` · Player ${participants.join(", ")}` : ""}</p>; })}</div> : <p>Tap routes on the court, use Shift-click, or check moves below</p>}
        {issues.length ? <label className="pocket-confirm-remove"><input type="checkbox" checked={removeConnections} onChange={(event) => setRemoveConnections(event.currentTarget.checked)} />Remove outside actions and waits from the pocket copy</label> : null}
        {issues.length && !removeConnections ? <small>{issues[0].message}</small> : null}
        {capturePreview ? <div className="pocket-name-preview">
          <label className="pocket-name-field"><span>Name this pocket action</span><input maxLength={60} value={capturePreview.name} onChange={(event) => { const name = event.currentTarget.value; setCapturePreview((current) => current ? { ...current, name } : current); }} autoFocus /></label>
          <strong>Editable role labels</strong>
          {capturePreview.roles.map((role, index) => <label className="pocket-name-field" key={role.id}><span>Role {index + 1}</span><input maxLength={40} value={role.label} onChange={(event) => { const label = event.currentTarget.value; setCapturePreview((current) => current ? { ...current, roles: current.roles.map((candidate) => candidate.id === role.id ? { ...candidate, label } : candidate) } : current); }} /></label>)}
          <div><button type="button" onClick={() => setCapturePreview(null)}>Back to selection</button><button type="button" className="button button-primary" disabled={!capturePreview.name.trim() || capturePreview.roles.some((role) => !role.label.trim())} onClick={() => void saveSelected()}><Plus size={14} />Save pocket</button></div>
        </div> : <button type="button" className="button button-primary" disabled={!selected.length || issues.length > 0 && !removeConnections} onClick={reviewSelected}><Plus size={14} />Save as pocket action</button>}
      </div> : null}
      <div className="pocket-library-tabs" role="tablist" aria-label="Pocket library"><button role="tab" aria-selected={tab === "starter"} className={tab === "starter" ? "is-active" : ""} onClick={() => setTab("starter")}>Starter</button><button role="tab" aria-selected={tab === "personal"} className={tab === "personal" ? "is-active" : ""} onClick={() => setTab("personal")}>My pockets</button></div>
      <label className="pocket-search"><Search size={13} /><input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search combinations" aria-label="Search pocket actions" /></label>
      <div className="pocket-library-list">
        {loading ? <p className="pocket-empty">Loading pockets</p> : visiblePockets.map((pocket) => <article className="pocket-card" key={pocket.id}>
          <button type="button" className="pocket-place" draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-arc-pocket-action", pocket.id); }} onClick={() => beginPlacement(pocket)} title="Drag onto the court or choose Place on court"><PocketMiniPreview pocket={pocket} /><span><strong>{pocket.name}</strong><small>{pocket.summary ?? `${pocket.roles.length} roles · ${pocket.actions.length} actions`}</small><small>{pocket.roles.length} players · {pocket.actions.length} moves</small></span></button>
          <div className="pocket-card-actions"><button type="button" onClick={() => beginPlacement(pocket)}>Place on court</button>{pocket.starter ? <button type="button" aria-label={`Copy ${pocket.name}`} title="Copy to My pockets" onClick={() => void duplicatePocket(pocket)}><Copy size={13} /></button> : <><button type="button" aria-label={`Rename ${pocket.name}`} title="Rename" onClick={() => { setRenaming(pocket); setRenameValue(pocket.name); }}><span aria-hidden="true">✎</span></button><button type="button" aria-label={`Duplicate ${pocket.name}`} title="Duplicate" onClick={() => void duplicatePocket(pocket)}><Copy size={13} /></button><button type="button" aria-label={`Export ${pocket.name}`} title="Export JSON" onClick={() => exportPocket(pocket)}><Download size={13} /></button><button type="button" aria-label={`Delete ${pocket.name}`} title="Delete" onClick={() => void removePocket(pocket)}><Trash2 size={13} /></button></>}</div>
        </article>)}
        {!loading && !visiblePockets.length ? <div className="pocket-empty">{tab === "personal" ? "Save a selected combination to start your pocket library" : "No starter combinations match that search"}</div> : null}
      </div>
      <div className="pocket-library-footer"><button type="button" onClick={() => importRef?.click()} disabled={importBusy}><Upload size={13} />{importBusy ? "Importing" : "Import JSON"}</button><input ref={setImportRef} type="file" accept="application/json,.json" className="pocket-file-input" onChange={(event) => void importPocket(event)} /><button type="button" onClick={() => void refresh()}>Refresh</button></div>
    </div> : null}
    {renaming ? <div className="pocket-subdialog"><label><span>Rename pocket</span><input maxLength={60} value={renameValue} onChange={(event) => setRenameValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") void renamePocket(renaming); if (event.key === "Escape") setRenaming(null); }} autoFocus /></label><div><button type="button" onClick={() => setRenaming(null)}>Cancel</button><button type="button" onClick={() => void renamePocket(renaming)}>Save name</button></div></div> : null}
      {placement ? <div className="pocket-placement-modal-backdrop" role="presentation"><section className="pocket-placement-modal" role="dialog" aria-modal="true" aria-label={`Place ${placement.name}`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPlacement(null); onPreview([], null); } }}>
      <header><div><span className="section-kicker">Place combination</span><h2>{placement.name}</h2></div><button type="button" className="icon-button" aria-label="Cancel placement" onClick={() => { setPlacement(null); onPreview([], null); }}><X size={15} /></button></header>
      <p>Assign every role to a different offensive player · Existing starting markers stay where they are</p>
      <div className="pocket-role-assignments">{placement.roles.map((role) => <label key={role.id}><span>{role.label}</span><select aria-label={`${role.label} player`} value={assignments[role.id] ?? 0} onChange={(event) => { const playerId = Number(event.currentTarget.value); setAssignments((current) => ({ ...current, [role.id]: playerId })); }}><option value={0}>Choose player</option>{source.players.map((player) => <option key={player.id} value={player.id}>Player {player.id}</option>)}</select></label>)}</div>
      <div className="pocket-placement-controls"><label><span>Insert at</span><select aria-label="Insertion boundary" value={beforeSequence ?? "end"} onChange={(event) => setBeforeSequence(event.currentTarget.value === "end" ? null : Number(event.currentTarget.value))}><option value="end">End of play</option>{[...new Set(source.arrows.map((arrow, index) => arrow.sequence ?? index + 1))].sort((a, b) => a - b).map((sequence) => <option key={sequence} value={sequence}>Before Move {sequence}</option>)}{[...new Set(source.arrows.map((arrow, index) => arrow.sequence ?? index + 1))].sort((a, b) => a - b).map((sequence) => <option key={`after-${sequence}`} value={sequence + 1}>After Move {sequence}</option>)}</select></label><label><span>Anchor X</span><input type="number" min="0" max="100" step="0.5" value={anchor.x} onChange={(event) => { const x = Number(event.currentTarget.value); setAnchor((point) => ({ ...point, x })); }} /></label><label><span>Anchor Y</span><input type="number" min="0" max="100" step="0.5" value={anchor.y} onChange={(event) => { const y = Number(event.currentTarget.value); setAnchor((point) => ({ ...point, y })); }} /></label><label><span>Rotation</span><input type="number" min="-360" max="360" step="15" value={rotation} onChange={(event) => setRotation(Number(event.currentTarget.value))} /></label><label className="pocket-mirror-check"><input type="checkbox" checked={mirrored} onChange={(event) => setMirrored(event.currentTarget.checked)} />Mirror</label></div>
      {placement.requiredBallRole ? <label className="pocket-confirm-remove"><input type="checkbox" checked={includeConnectionPass} onChange={(event) => setIncludeConnectionPass(event.currentTarget.checked)} />Confirm setup pass when Player {stateAtBoundary.ballHandlerId ?? "?"} does not match the assigned ball-handler role</label> : null}
      {sharedBoundarySequence !== null && beforeSequence === sharedBoundarySequence ? <label className="pocket-confirm-remove"><input type="checkbox" checked={insertShared} onChange={(event) => setInsertShared(event.currentTarget.checked)} />Insert into the shared opening for this and inheriting endings</label> : null}
      {sharedBoundarySequence !== null && beforeSequence !== null && beforeSequence < sharedBoundarySequence ? <small className="pocket-shared-note">This boundary is in the shared opening, so every ending inherits the insertion</small> : null}
      <div className="pocket-preview-summary"><strong>Placement preview</strong><span>{placement.actions.length} authored moves · {placement.roles.length} role slots · starts at {(baseStart / 1000).toFixed(1)}s</span><small>Proposed approach moves and any required possession pass appear as dashed routes on the court</small></div>
      <div className="pocket-placement-actions"><button type="button" className="button button-subtle" onClick={() => { setPlacement(null); onPreview([], null); }}>Cancel</button><button type="button" className="button button-primary" disabled={!source.players.length || placement.roles.some((role) => !assignments[role.id]) || placement.roles.some((role) => assignments[role.id] && Object.values(assignments).filter((id) => id === assignments[role.id]).length > 1)} onClick={commitPlacement}>Insert combination</button></div>
    </section></div> : null}
  </section>;
}

function savedDocument(document: PocketActionDocument) {
  const now = new Date().toISOString();
  return { ...document, createdAt: now, updatedAt: now, revision: crypto.randomUUID().replaceAll("-", "") };
}

function PocketMiniPreview({ pocket }: { pocket: PocketActionDocument }) {
  return <svg className="pocket-mini-preview" viewBox="0 0 100 100" aria-hidden="true"><rect x="1" y="1" width="98" height="98" rx="5" />{pocket.actions.map((action) => <path key={action.id} d={`M${action.arrow.start.x} ${action.arrow.start.y} Q${action.arrow.control?.x ?? (action.arrow.start.x + action.arrow.end.x) / 2} ${action.arrow.control?.y ?? (action.arrow.start.y + action.arrow.end.y) / 2} ${action.arrow.end.x} ${action.arrow.end.y}`} />)}{pocket.roles.map((role) => <circle key={role.id} cx={role.entry.x} cy={role.entry.y} r="3" />)}</svg>;
}
