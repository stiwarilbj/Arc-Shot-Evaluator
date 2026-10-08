import { loadClipDetails } from "./details";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, BookmarkPlus, Check, ChevronLeft, ChevronRight, Clapperboard, Download, ExternalLink, Filter, FolderOpen, Info, Plus, Search, Share2, Trash2, Upload, X } from "lucide-react";
import { createCollection, duplicateCollection, exportCollections, parseCollectionBackup, readCollections, writeCollections } from "./collections";
import { ArcSelect } from "../../components/ArcSelect";
import { FIELD_LABELS, makeFilterCondition, parsePlayPrompt, resolveAmbiguousCondition } from "./search";
import type { FilmCollection, PlayClip, PlayCondition, SearchField, SearchResult, ClipManifest, WorkerResponse } from "./types";
import "./playFinder.css";

const PAGE_SIZE = 20;
const EXAMPLES = ["Curry threes against Boston", "Brunson step-back jumpers in the 2025 playoffs", "fourth-quarter turnovers with fewer than five seconds remaining"];
const FILTER_FIELDS = Object.keys(FIELD_LABELS) as SearchField[];

interface PlayFinderProps { active: boolean }

export function PlayFinder({ active }: PlayFinderProps) {
  const [prompt, setPrompt] = useState("");
  const [conditions, setConditions] = useState<PlayCondition[]>([]);
  const [sort, setSort] = useState<"relevance" | "date">("relevance");
  const [page, setPage] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterField, setFilterField] = useState<SearchField>("player");
  const [filterValue, setFilterValue] = useState("");
  const [filterOperator, setFilterOperator] = useState<PlayCondition["operator"]>("equals");
  const [collectionDrawer, setCollectionDrawer] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [collections, setCollections] = useState<FilmCollection[]>(() => readCollections());
  const [collectionWriteFailed, setCollectionWriteFailed] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSubmittedPrompt = useRef("");

  const [allResults, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [manifest, setManifest] = useState<ClipManifest | null>(null);
  const [status, setStatus] = useState("Loading NBA clip index…");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [savedSelection, setSavedSelection] = useState<PlayClip | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pagedResults = allResults;
  const selectedClip = savedSelection ?? allResults.find((item) => item.clip.id === selectedClipId)?.clip ?? pagedResults[0]?.clip ?? null;
  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? collections[0] ?? null;
  const collectionClips = (selectedCollection?.clipIds ?? []).map((id) => ({ id, clip: selectedCollection?.snapshots?.[id] }));
  const missingConditions = conditions.filter((item) => item.status !== "ready");

  function runSearch(nextConditions: PlayCondition[], nextPage = 0, nextPrompt = lastSubmittedPrompt.current, nextSort = sort) {
    if (!workerRef.current || !manifest) return;
    const id = ++requestId.current;
    setError(""); setLoading(true); setSavedSelection(null); setPage(nextPage);
    workerRef.current.postMessage({id, type: "search", prompt: nextPrompt, conditions: nextConditions, sort: nextSort, page: nextPage, pageSize: PAGE_SIZE});
  }
  useEffect(() => {
    const worker = new Worker(new URL("./search.worker.ts", import.meta.url), {type: "module"});
    workerRef.current = worker;
    worker.onmessage = ({data}: MessageEvent<WorkerResponse>) => {
      if (data.type === "ready") {setManifest(data.manifest);setStatus("NBA index ready. Search or browse individual plays.");return;}
      if (data.id !== requestId.current) return;
      if (data.type === "status") setStatus(data.message);
      if (data.type === "error") {setError(data.message);setLoading(false);setStatus("Index search unavailable; saved clips remain accessible.");}
      if (data.type === "results") {setResults(data.results);setTotal(data.total);setLoading(false);setSelectedClipId(data.results[0]?.clip.id ?? null);setStatus(data.message ?? (data.mode === "semantic" ? "Semantic ranking · exact filters applied" : "Keyword ranking · exact filters applied"));}
    };
    worker.onerror = () => {setError("Search worker could not start. Reload to retry.");setLoading(false);};
    worker.postMessage({id: 0, type: "init", base: new URL(`${import.meta.env.BASE_URL}nba-index/`, window.location.origin).href});
    return () => {worker.postMessage({id: ++requestId.current, type: "dispose"});worker.terminate();workerRef.current=null;};
  }, []);
  useEffect(() => {if (!active) videoRef.current?.pause();}, [active]);

  useEffect(() => {
    if (!collectionDrawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCollectionDrawer(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [collectionDrawer]);

  function persist(next: FilmCollection[]) {
    setCollections(next);
    const result = writeCollections(next);
    setCollectionWriteFailed(!result.ok);
    setToast(result.ok ? "Collections saved in this browser" : `Could not save collections: ${result.error}`);
    return result.ok;
  }

  function submitSearch(nextConditions?: PlayCondition[]) {
    const queryConditions = nextConditions ?? (prompt === lastSubmittedPrompt.current ? conditions : parsePlayPrompt(prompt, manifest?.players));
    lastSubmittedPrompt.current = prompt;
    setConditions(queryConditions);
    setPage(0);
    setSubmitted(true);
    runSearch(queryConditions, 0, prompt);

  }

  function chooseExample(value: string) {
    setPrompt(value);
    lastSubmittedPrompt.current = value;
    const next = parsePlayPrompt(value, manifest?.players);
    setConditions(next); setSubmitted(true); runSearch(next, 0, value);
  }

  function removeCondition(id: string) {
    const next = conditions.filter((item) => item.id !== id);
    setConditions(next);
    setPage(0);
    setSubmitted(true);
    runSearch(next);
  }

  function addFilter() {
    if (!filterValue.trim()) return;
    const next = [...conditions, makeFilterCondition(filterField, filterValue, filterOperator)];
    setConditions(next);
    setPage(0);
    setSubmitted(true);
    setFilterValue("");
    runSearch(next);
  }

  function createNewCollection() {
    if (!newCollectionName.trim()) return;
    const nextCollection = createCollection(newCollectionName);
    const next = [...collections, nextCollection];
    persist(next);
    setSelectedCollectionId(nextCollection.id);
    setNewCollectionName("");
    setShowCreate(false);
  }

  function updateCollection(collectionId: string, update: (current: FilmCollection) => FilmCollection) {
    return persist(collections.map((item) => item.id === collectionId ? { ...update(item), updatedAt: new Date().toISOString() } : item));
  }

  async function addClipToCollection(collectionId: string, clip: PlayClip) {
    try {clip = await loadClipDetails(clip);} catch(error) {setToast(error instanceof Error ? error.message : "Could not save video snapshot");return;}
    const target = collections.find((item) => item.id === collectionId);
    if (!target) return;
    const saved = updateCollection(collectionId, (item) => ({ ...item, clipIds: item.clipIds.includes(clip.id) ? item.clipIds : [...item.clipIds, clip.id], snapshots: { ...item.snapshots, [clip.id]: clip } }));
    if (saved) setToast(target.clipIds.includes(clip.id) ? "Already in this collection" : `Added to ${target.name}`);
  }

  function retryCollectionSave() {
    const result = writeCollections(collections);
    setCollectionWriteFailed(!result.ok);
    setToast(result.ok ? "Collections saved in this browser" : `Could not save collections: ${result.error}`);
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(exportCollections(collections), null, 2)], { type: "application/json" });
    downloadBlob(blob, "arc-play-finder-collections.json");
    setToast("Collection backup exported");
  }

  async function importBackup(file?: File) {
    if (!file) return;
    try {
      const imported = parseCollectionBackup(await file.text());
      const merged = [...collections];
      for (const item of imported) {
        const index = merged.findIndex((candidate) => candidate.id === item.id);
        if (index >= 0) {
          const current = merged[index];
          merged[index] = {...current, clipIds: [...new Set([...current.clipIds, ...item.clipIds])], notesByClip: {...item.notesByClip, ...current.notesByClip}, snapshots: {...item.snapshots, ...current.snapshots}};
        } else merged.push(item);
      }
      if (persist(merged)) setToast(`Imported ${imported.length} collection${imported.length === 1 ? "" : "s"}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not import that backup");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function openCollectionClip(id: string) {
    const clip = selectedCollection?.snapshots?.[id];
    if (!clip) {
      setToast("This saved clip is unavailable in the current event index; its reference ID remains in this collection and exported backups");
      return;
    }
    setSelectedClipId(clip.id);
    setSavedSelection(clip);
    setCollectionDrawer(false);
  }

  function moveCollectionClip(collection: FilmCollection, index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= collection.clipIds.length) return;
    updateCollection(collection.id, (item) => {
      const clipIds = [...item.clipIds];
      [clipIds[index], clipIds[targetIndex]] = [clipIds[targetIndex], clipIds[index]];
      return { ...item, clipIds };
    });
  }

  return (
    <main className="play-finder-page">
      <section className="play-finder-hero">
        <div className="play-finder-heading">
          <div className="play-finder-brand"><span className="play-finder-mark"><Clapperboard size={19} /></span><span className="section-kicker">NBA film search</span></div>
          <h1>Find the play</h1>
          <p>Search individual NBA play-by-play clips by player, matchup, shot, and game situation</p>
        </div>
        <button className="button button-outline finder-collections-button" type="button" onClick={() => setCollectionDrawer(true)}><FolderOpen size={16} /> Collections <span className="finder-count">{collections.length}</span></button>
      </section>

      <form className="finder-search-panel" onSubmit={(event) => { event.preventDefault(); submitSearch(); }}>
        <div className="finder-search-line">
          <Search size={19} aria-hidden="true" />
          <input aria-label="Search NBA plays" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe a play or matchup…" />
          <button className="button button-primary" type="submit" disabled={!manifest}><Search size={15} /> Search</button>{loading ? <button type="button" className="button button-outline" onClick={() => {workerRef.current?.postMessage({id: ++requestId.current, type: "cancel"});setLoading(false);setStatus("Search cancelled");}}>Cancel</button> : null}
        </div>
        <div className="finder-search-actions">
          <button type="button" className={`button button-subtle ${filtersOpen ? "is-active" : ""}`} onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen}><Filter size={15} /> Filters {conditions.length > 0 ? <span className="finder-count">{conditions.length}</span> : null}</button>
          <span className="finder-hint">Prompts become editable search conditions</span>
        </div>
        <div className="finder-examples" aria-label="Example searches">
          <span>Try</span>
          {EXAMPLES.map((example) => <button key={example} type="button" disabled={!manifest} onClick={() => chooseExample(example)}>{example}</button>)}
        </div>
        {conditions.length > 0 ? <div className="finder-chips" aria-label="Search conditions">
          {conditions.map((item) => <span className={`finder-chip ${item.status !== "ready" ? `finder-chip-${item.status}` : ""}`} key={item.id}>
            {item.status === "ambiguous" ? <><span>{FIELD_LABELS[item.field]}:</span><ArcSelect ariaLabel={`Choose ${FIELD_LABELS[item.field]}`} className="arc-select--compact finder-chip-select" value="" placeholder="Choose a player" options={(item.candidates ?? []).map((candidate) => ({ value: candidate, label: candidate }))} onValueChange={(value) => {const next = conditions.map((condition) => condition.id === item.id ? resolveAmbiguousCondition(condition, value) : condition);setConditions(next);runSearch(next);}} /></> : <><span>{item.status === "unsupported" ? "Check:" : item.operator === "excludes" ? "Without:" : `${FIELD_LABELS[item.field]}:`}</span><strong>{formatConditionValue(item)}</strong></>}
            {item.status !== "ready" ? <span title={item.status === "unsupported" ? "This condition is not supported yet; remove it to search" : "Choose the intended player"}><Info size={13} aria-hidden="true" /></span> : null}
            <button type="button" onClick={() => removeCondition(item.id)} aria-label={`Remove ${FIELD_LABELS[item.field]} condition`}><X size={13} /></button>
          </span>)}
          {missingConditions.length > 0 ? <span className="finder-condition-alert" role="status">Resolve or remove highlighted conditions before searching</span> : null}
        </div> : null}
        {filtersOpen ? <div className="finder-filter-builder">
          <div className="finder-select-field"><span>Field</span><ArcSelect ariaLabel="Filter field" className="arc-select--full" value={filterField} options={FILTER_FIELDS.map((field) => ({ value: field, label: FIELD_LABELS[field] }))} onValueChange={(value) => setFilterField(value as SearchField)} /></div>
          <div className="finder-select-field"><span>Condition</span><ArcSelect ariaLabel="Filter condition" className="arc-select--full" value={filterOperator} options={[{ value: "equals", label: "Equals" }, { value: "excludes", label: "Excludes" }, { value: "includes", label: "Contains" }, { value: "lt", label: "Less than / before" }, { value: "gt", label: "Greater than / after" }, {value: "range", label: "Range (min..max)"}]} onValueChange={(value) => setFilterOperator(value as PlayCondition["operator"])} /></div>
          <div className="finder-select-field finder-filter-value"><span>Value</span><input aria-label="Filter value" value={filterValue} onChange={(event) => setFilterValue(event.target.value)} placeholder={filterPlaceholder(filterField)} /></div>
          <button className="button button-outline" type="button" disabled={!manifest} onClick={addFilter}><Plus size={14} /> Add condition</button>
          <p>Use NBA team codes, full player names, ISO dates, seconds for clocks, and min..max for ranges. Period 5 is the first overtime.</p>
        </div> : null}
      </form>

      <div className="finder-catalog-line"><span><strong>{total}</strong> individual-play matches</span><span role="status" aria-live="polite">{status}</span></div>
      {error ? <div className="finder-condition-alert" role="alert">{error} <button type="button" onClick={() => {setError("");workerRef.current?.postMessage({id: requestId.current,type:"init",base:new URL(`${import.meta.env.BASE_URL}nba-index/`,window.location.origin).href});}}>Retry index</button></div> : null}
      {manifest ? <details className="finder-coverage-details"><summary>Actual indexed coverage · {manifest.clips.toLocaleString()} clips</summary><span>Last successful update: {new Date(manifest.lastSuccessfulUpdate).toLocaleString()}</span>{Object.entries(manifest.coverage).map(([season, coverage]) => <span key={season}>{season}: {coverage.games}/{coverage.scheduledGames} completed games · {coverage.clips.toLocaleString()} clips · {coverage.unresolved} unresolved · {coverage.complete ? "Completed-game backfill finished" : "Partial coverage; backfill in progress"}</span>)}</details> : null}

      <section className="finder-results-layout" aria-label="Play Finder results">
        <div className="finder-results-column">
          <div className="finder-results-heading"><div><span className="section-kicker">Film results</span><h2>{submitted && conditions.length ? "Search results" : "NBA plays"}</h2></div><div className="finder-sort"><span>Sort</span><ArcSelect ariaLabel="Sort results" className="arc-select--compact finder-sort-select" value={sort} options={[{ value: "relevance", label: "Relevance" }, { value: "date", label: "Newest first" }]} onValueChange={(value) => { setSort(value as "relevance" | "date"); runSearch(conditions, 0, lastSubmittedPrompt.current, value as "relevance" | "date"); }} /></div></div>
          {allResults.length && !loading ? <>
            <div className="finder-result-list">
              {pagedResults.map((result) => <ResultCard key={result.clip.id} result={result} selected={selectedClip?.id === result.clip.id} onSelect={() => {setSavedSelection(null);setSelectedClipId(result.clip.id);}} />)}
            </div>
            {pageCount > 1 ? <div className="finder-pagination"><button className="icon-button" disabled={page === 0} onClick={() => runSearch(conditions, page - 1)} aria-label="Previous results"><ChevronLeft size={16} /></button><span>Page {page + 1} of {pageCount}</span><button className="icon-button" disabled={page + 1 >= pageCount} onClick={() => runSearch(conditions, page + 1)} aria-label="Next results"><ChevronRight size={16} /></button></div> : null}
          </> : <div className="finder-empty"><Search size={20} /><strong>{missingConditions.length ? "Search needs attention" : loading ? "Searching NBA plays…" : !submitted ? "Describe a play to start" : "No matching clips"}</strong><p>{missingConditions.length ? "Choose an ambiguous player or remove unsupported conditions, then search again" : "No indexed individual clip satisfies every condition. Check actual coverage or adjust your filters"}</p></div>}
          <div className="finder-coverage-note"><Info size={14} /><span>Only resolved individual NBA clips appear. Roles come from recorded play-by-play evidence; tactical coverage and defender matchups are unavailable.</span></div>
        </div>

        <div className="finder-detail-column">
          {selectedClip ? <ClipDetail clip={selectedClip} active={active} videoRef={videoRef} onSave={(collectionId, snapshot) => addClipToCollection(collectionId, snapshot)} onOpenCollections={() => setCollectionDrawer(true)} collections={collections} /> : <div className="finder-detail-empty"><Clapperboard size={22} /><span>Select a result to inspect the play</span></div>}
        </div>
      </section>

      {toast ? <div className="finder-toast" role="status"><span>{toast}</span>{collectionWriteFailed ? <button type="button" className="button button-outline" onClick={retryCollectionSave}>Retry save</button> : null}<button type="button" className="icon-button" aria-label="Dismiss message" onClick={() => setToast("")}><X size={13} /></button></div> : null}
      {collectionDrawer ? <div className="finder-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCollectionDrawer(false); }}>
        <aside className="finder-collection-drawer" role="dialog" aria-modal="true" aria-labelledby="finder-collections-title">
          <header><div><span className="section-kicker">Your browser library</span><h2 id="finder-collections-title">Film collections</h2></div><button className="icon-button" type="button" aria-label="Close collections" onClick={() => setCollectionDrawer(false)}><X size={16} /></button></header>
          <div className="finder-collection-actions"><button className="button button-outline" type="button" onClick={() => setShowCreate((show) => !show)}><Plus size={14} /> New collection</button><button className="button button-subtle" type="button" onClick={exportBackup}><Download size={14} /> Export</button><button className="button button-subtle" type="button" onClick={() => fileInputRef.current?.click()}><Upload size={14} /> Import</button><input ref={fileInputRef} type="file" accept="application/json,.json" className="visually-hidden" onChange={(event) => void importBackup(event.target.files?.[0])} /></div>
          {showCreate ? <form className="finder-create-form" onSubmit={(event) => { event.preventDefault(); createNewCollection(); }}><input autoFocus value={newCollectionName} onChange={(event) => setNewCollectionName(event.target.value)} placeholder="Collection name" aria-label="New collection name" /><button className="button button-primary" type="submit" disabled={!newCollectionName.trim()}>Create</button></form> : null}
          {collections.length ? <div className="finder-collections-layout">
            <nav className="finder-collection-list" aria-label="Saved collections">{collections.map((collection) => <button type="button" key={collection.id} className={selectedCollection?.id === collection.id ? "is-active" : ""} onClick={() => setSelectedCollectionId(collection.id)}><span>{collection.name}</span><small>{collection.clipIds.length} clips</small></button>)}</nav>
            {selectedCollection ? <section className="finder-collection-content"><header><div><h3>{selectedCollection.name}</h3><p>Created {formatDate(selectedCollection.createdAt.slice(0, 10))}</p></div><div className="finder-collection-tools"><button type="button" className="icon-button" aria-label="Rename collection" onClick={() => { const nextName = window.prompt("Rename collection", selectedCollection.name); if (nextName?.trim()) updateCollection(selectedCollection.id, (item) => ({ ...item, name: nextName.trim() })); }} title="Rename"><Share2 size={14} /></button><button type="button" className="icon-button" aria-label="Duplicate collection" onClick={() => { const copy = duplicateCollection(selectedCollection); persist([...collections, copy]); setSelectedCollectionId(copy.id); }} title="Duplicate"><BookmarkPlus size={14} /></button><button type="button" className="icon-button danger" aria-label="Delete collection" onClick={() => { if (window.confirm(`Delete “${selectedCollection.name}”?`)) { const next = collections.filter((item) => item.id !== selectedCollection.id); persist(next); setSelectedCollectionId(next[0]?.id ?? null); } }} title="Delete"><Trash2 size={14} /></button></div></header>
              {collectionClips.length ? <div className="finder-saved-clips">{collectionClips.map(({ id, clip }, index) => <article className="finder-saved-clip" key={`${selectedCollection.id}-${id}`}><div className="finder-saved-clip-top"><button type="button" className="finder-saved-clip-open" onClick={() => openCollectionClip(id)}>{clip ? clip.title : `Legacy / unavailable clip · ${id}`}</button><div><button className="icon-button" type="button" disabled={index === 0} aria-label="Move clip up" onClick={() => moveCollectionClip(selectedCollection, index, -1)}><ArrowUp size={13} /></button><button className="icon-button" type="button" disabled={index + 1 === collectionClips.length} aria-label="Move clip down" onClick={() => moveCollectionClip(selectedCollection, index, 1)}><ArrowDown size={13} /></button><button className="icon-button danger" type="button" aria-label="Remove clip from collection" onClick={() => updateCollection(selectedCollection.id, (item) => ({ ...item, clipIds: item.clipIds.filter((clipId) => clipId !== id) }))}><Trash2 size={13} /></button></div></div>{clip ? <small>{verifiedContextLine(clip)}</small> : <small>This clip reference ID remains in this collection and exported backups; its source URL is unavailable</small>}<textarea aria-label={`Notes for ${clip?.title ?? id}`} value={selectedCollection.notesByClip[id] ?? ""} placeholder="Add a personal note" onChange={(event) => updateCollection(selectedCollection.id, (item) => ({ ...item, notesByClip: { ...item.notesByClip, [id]: event.target.value } }))} /></article>)}</div> : <div className="finder-collection-empty"><BookmarkPlus size={19} /><span>No clips yet; save a result from its detail panel</span></div>}
            </section> : null}
          </div> : <div className="finder-collection-empty"><FolderOpen size={22} /><strong>No collections yet</strong><span>Create one to save clips and notes</span></div>}
          {selectedClip && collections.length ? <footer className="finder-add-to-collection"><span>Add current clip</span><div>{collections.map((collection) => <button className="button button-outline" type="button" key={collection.id} onClick={() => addClipToCollection(collection.id, selectedClip)}>{collection.name}</button>)}</div></footer> : null}
        </aside>
      </div> : null}
    </main>
  );
}

function ResultCard({result, selected, onSelect}: {result: SearchResult; selected: boolean; onSelect: () => void}) {
  const {clip} = result;
  return <button type="button" className={`finder-result-card ${selected ? "is-selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
    {clip.thumbnail ? <img className="finder-thumbnail" src={clip.thumbnail} alt="" loading="lazy" /> : <Clapperboard size={20} />}
    <span className="finder-result-main"><strong>{clip.title}</strong><span>{verifiedContextLine(clip)}</span><span className="finder-tags"><em>{clip.outcome}</em><em>{clip.phase}</em></span><span className="finder-why"><Check size={12} /> {result.why.join(" · ")}</span></span>
  </button>;
}
function ClipDetail({clip, active, videoRef, onSave, onOpenCollections, collections}: {clip: PlayClip; active: boolean; videoRef: React.RefObject<HTMLVideoElement | null>; onSave: (id: string, snapshot: PlayClip) => void; onOpenCollections: () => void; collections: FilmCollection[]}) {
 const [collectionId,setCollectionId]=useState("");const [failed,setFailed]=useState(false);
 const [snapshot,setSnapshot]=useState<PlayClip>(clip);
 const [detailError,setDetailError]=useState("");
 useEffect(()=>{
   setSnapshot(clip);setDetailError("");if(clip.mp4)return;
   let cancelled=false;
   void loadClipDetails(clip).then(record=>{if(!cancelled)setSnapshot(record);}).catch(error=>{if(!cancelled)setDetailError(error instanceof Error?error.message:"Clip details failed");});
   return()=>{cancelled=true;};
 },[clip]);
 useEffect(()=>{setFailed(false);},[clip.id]);
 useEffect(()=>{if(!collections.some(c=>c.id===collectionId))setCollectionId(collections[0]?.id??"");},[collections,collectionId]);
 return <article className="finder-detail-card">
  <div className="finder-detail-media">{active ? <video key={clip.id} ref={videoRef} src={snapshot.mp4} poster={clip.thumbnail} controls playsInline preload="metadata" onError={()=>setFailed(true)} aria-label={`NBA individual play: ${clip.title}`} /> : null}</div>
  <div className="finder-detail-body"><span className="section-kicker">Individual NBA play · event {clip.eventId}</span><h2>{clip.title}</h2><p>{verifiedContextLine(clip)}</p>
  {failed || detailError ? <p role="alert">The NBA video could not play here. Open the exact NBA Stats event below.</p> : null}
  <div className="finder-detail-context"><DetailFact label="Outcome" value={clip.outcome} /><DetailFact label="Score" value={`${clip.away} ${clip.scoreAway ?? "—"} · ${clip.home} ${clip.scoreHome ?? "—"}`} /><DetailFact label="Participants" value={clip.participants.map(p=>`${p.name} (${p.role})`).join(" · ")} />{clip.shotDistance!=null ? <DetailFact label="Shot distance" value={`${clip.shotDistance} ft`} /> : null}</div>
  <div className="finder-detail-actions"><a className="button button-primary" href={clip.eventUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> NBA Stats event</a>{collections.length ? <><ArcSelect className="arc-select--compact finder-collection-select" ariaLabel="Choose collection" value={collectionId} options={collections.map(c=>({value:c.id,label:c.name}))} onValueChange={setCollectionId} /><button className="button button-outline" disabled={!snapshot.mp4} onClick={()=>onSave(collectionId,snapshot)}><BookmarkPlus size={14} /> Save</button></> : <button className="button button-outline" onClick={onOpenCollections}>Create collection</button>}</div></div>
 </article>;
}
function verifiedContextLine(clip: PlayClip) {return `${clip.away} at ${clip.home} · ${clip.date} · ${clip.season} · ${clip.period <= 4 ? `Q${clip.period}` : `OT${clip.period-4}`} ${formatClock(clip.clock)}`;}
function DetailFact({label,value}: {label:string;value:string}) {return <div><span>{label}</span><strong>{value}</strong></div>;}
function formatConditionValue(item:PlayCondition) {return `${['lt','lte','gt','gte'].includes(item.operator)?({lt:'< ',lte:'≤ ',gt:'> ',gte:'≥ '} as Record<string,string>)[item.operator]:''}${item.value}`;}
function filterPlaceholder(field:SearchField) {return ({player:'Stephen Curry',team:'GSW',opponent:'BOS',season:'2023-24',date:'2025-05-16',phase:'regular, play-in, playoffs',eventType:'turnover, rebound, made shot',outcome:'made, missed, turnover',shotDistance:'17 or 15..20',shotValue:'2 or 3',period:'1–4, 5 for OT1',clock:'4.5 or 0..5',role:'shooter, assister, blocker, stealer',description:'step back, dunk, layup'})[field];}
function formatDate(value:string) {return value.slice(0,10);}
function formatClock(value:number) {const seconds=(value%60).toFixed(value%1?2:0).padStart(value%1?5:2,'0');return `${Math.floor(value/60)}:${seconds}`;}
function downloadBlob(blob:Blob,filename:string) {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);}
