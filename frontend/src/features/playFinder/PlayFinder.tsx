import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, BookmarkPlus, Check, ChevronLeft, ChevronRight, Clapperboard, Download, ExternalLink, Filter, FolderOpen, Info, Plus, Search, Share2, Trash2, Upload, X } from "lucide-react";
import { createCollection, duplicateCollection, exportCollections, parseCollectionBackup, readCollections, writeCollections } from "./collections";
import { ACTION_LABELS, FIELD_LABELS, findSimilarPlays, makeFilterCondition, parsePlayPrompt, PLAY_FINDER_CATALOG, resolveAmbiguousCondition, searchCatalog } from "./search";
import type { FilmCollection, PlayAction, PlayClip, PlayCondition, SearchField, SearchResult } from "./types";
import "./playFinder.css";

const PAGE_SIZE = 20;
const EXAMPLES = ["pick-and-rolls ending in a turnover", "Curry threes against Boston", "handoffs followed by a backdoor cut"];
const FILTER_FIELDS: SearchField[] = ["player", "team", "opponent", "season", "postseason", "quarter", "gameClock", "scoreMargin", "shotType", "result", "action", "coverage"];
const ACTIONS: PlayAction[] = ["pick-and-roll", "pick-and-pop", "handoff", "off-ball-screen", "cut", "drive-and-kick", "isolation", "transition"];

interface PlayFinderProps { active: boolean }

export function PlayFinder({ active }: PlayFinderProps) {
  const [prompt, setPrompt] = useState("");
  const [conditions, setConditions] = useState<PlayCondition[]>([]);
  const [sort, setSort] = useState<"relevance" | "date">("relevance");
  const [page, setPage] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterField, setFilterField] = useState<SearchField>("action");
  const [filterValue, setFilterValue] = useState("");
  const [filterOperator, setFilterOperator] = useState<"includes" | "excludes">("includes");
  const [collectionDrawer, setCollectionDrawer] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [collections, setCollections] = useState<FilmCollection[]>(() => readCollections());
  const [collectionWriteFailed, setCollectionWriteFailed] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [includeCollectionNotes, setIncludeCollectionNotes] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLIFrameElement>(null);
  const lastSubmittedPrompt = useRef("");

  const allResults = useMemo(() => searchCatalog(conditions, sort), [conditions, sort]);
  const pageCount = Math.max(1, Math.ceil(allResults.length / PAGE_SIZE));
  const pagedResults = allResults.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selectedClip = allResults.find((item) => item.clip.id === selectedClipId)?.clip
    ?? PLAY_FINDER_CATALOG.clips.find((clip) => clip.id === selectedClipId)
    ?? pagedResults[0]?.clip
    ?? allResults[0]?.clip
    ?? null;
  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? collections[0] ?? null;
  const collectionClips = (selectedCollection?.clipIds ?? []).map((id) => ({ id, clip: PLAY_FINDER_CATALOG.clips.find((item) => item.id === id) }));
  const missingConditions = conditions.filter((item) => item.status !== "ready");
  const similar = useMemo(() => selectedClip ? findSimilarPlays(selectedClip) : [], [selectedClip]);
  const verifiedActionFamilies = new Set(PLAY_FINDER_CATALOG.clips
    .filter((clip) => isVerified(clip, "actions"))
    .flatMap((clip) => clip.actions));
  const sourceCount = new Set(PLAY_FINDER_CATALOG.clips.map((clip) => clip.source.url)).size;

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
    const queryConditions = nextConditions ?? (prompt === lastSubmittedPrompt.current ? conditions : parsePlayPrompt(prompt));
    lastSubmittedPrompt.current = prompt;
    setConditions(queryConditions);
    setPage(0);
    setSubmitted(true);
    const first = searchCatalog(queryConditions, sort)[0]?.clip;
    if (first) setSelectedClipId(first.id);
    else setSelectedClipId(null);
  }

  function chooseExample(value: string) {
    setPrompt(value);
    lastSubmittedPrompt.current = value;
    submitSearch(parsePlayPrompt(value));
  }

  function removeCondition(id: string) {
    const next = conditions.filter((item) => item.id !== id);
    setConditions(next);
    setPage(0);
    setSubmitted(true);
    setSelectedClipId(searchCatalog(next, sort)[0]?.clip.id ?? null);
  }

  function addFilter() {
    if (!filterValue.trim()) return;
    const next = [...conditions, makeFilterCondition(filterField, filterValue, filterOperator)];
    setConditions(next);
    setPage(0);
    setSubmitted(true);
    setFilterValue("");
    setSelectedClipId(searchCatalog(next, sort)[0]?.clip.id ?? null);
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

  function addClipToCollection(collectionId: string, clip: PlayClip) {
    const target = collections.find((item) => item.id === collectionId);
    if (!target) return;
    const saved = updateCollection(collectionId, (item) => ({ ...item, clipIds: item.clipIds.includes(clip.id) ? item.clipIds : [...item.clipIds, clip.id] }));
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
        const existing = merged.findIndex((candidate) => candidate.id === item.id);
        if (existing >= 0) merged[existing] = { ...item, id: `${item.id}-import-${Date.now()}` };
        else merged.push(item);
      }
      if (persist(merged)) setToast(`Imported ${imported.length} collection${imported.length === 1 ? "" : "s"}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not import that backup");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function openCollectionClip(id: string) {
    const clip = PLAY_FINDER_CATALOG.clips.find((item) => item.id === id);
    if (!clip) {
      setToast("This saved clip is unavailable in the current catalog; its reference ID remains in this collection and exported backups");
      return;
    }
    setSelectedClipId(clip.id);
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
          <p>Search a growing, manually reviewed library of official NBA film by action, player, matchup, and situation</p>
        </div>
        <button className="button button-outline finder-collections-button" type="button" onClick={() => setCollectionDrawer(true)}><FolderOpen size={16} /> Collections <span className="finder-count">{collections.length}</span></button>
      </section>

      <form className="finder-search-panel" onSubmit={(event) => { event.preventDefault(); submitSearch(); }}>
        <div className="finder-search-line">
          <Search size={19} aria-hidden="true" />
          <input aria-label="Search NBA plays" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe a play or matchup…" />
          <button className="button button-primary" type="submit"><Search size={15} /> Search</button>
        </div>
        <div className="finder-search-actions">
          <button type="button" className={`button button-subtle ${filtersOpen ? "is-active" : ""}`} onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen}><Filter size={15} /> Filters {conditions.length > 0 ? <span className="finder-count">{conditions.length}</span> : null}</button>
          <span className="finder-hint">Prompts become editable search conditions</span>
        </div>
        <div className="finder-examples" aria-label="Example searches">
          <span>Try</span>
          {EXAMPLES.map((example) => <button key={example} type="button" onClick={() => chooseExample(example)}>{example}</button>)}
        </div>
        {conditions.length > 0 ? <div className="finder-chips" aria-label="Search conditions">
          {conditions.map((item) => <span className={`finder-chip ${item.status !== "ready" ? `finder-chip-${item.status}` : ""}`} key={item.id}>
            {item.status === "ambiguous" ? <><span>{FIELD_LABELS[item.field]}:</span><select aria-label={`Choose ${FIELD_LABELS[item.field]}`} value="" onChange={(event) => setConditions((current) => current.map((condition) => condition.id === item.id ? resolveAmbiguousCondition(condition, event.target.value) : condition))}><option value="">Choose a player</option>{item.candidates?.map((candidate) => <option key={candidate}>{candidate}</option>)}</select></> : <><span>{item.status === "unsupported" ? "Check:" : item.operator === "excludes" ? "Without:" : `${FIELD_LABELS[item.field]}:`}</span><strong>{formatConditionValue(item)}</strong></>}
            {item.status !== "ready" ? <span title={item.status === "unsupported" ? "This condition is not supported yet; remove it to search" : "Choose the intended player"}><Info size={13} aria-hidden="true" /></span> : null}
            <button type="button" onClick={() => removeCondition(item.id)} aria-label={`Remove ${FIELD_LABELS[item.field]} condition`}><X size={13} /></button>
          </span>)}
          {missingConditions.length > 0 ? <span className="finder-condition-alert" role="status">Resolve or remove highlighted conditions before searching</span> : null}
        </div> : null}
        {filtersOpen ? <div className="finder-filter-builder">
          <label>Field<select value={filterField} onChange={(event) => setFilterField(event.target.value as SearchField)}>{FILTER_FIELDS.map((field) => <option value={field} key={field}>{FIELD_LABELS[field]}</option>)}</select></label>
          <label>Condition<select value={filterOperator} onChange={(event) => setFilterOperator(event.target.value as "includes" | "excludes")}><option value="includes">Includes</option><option value="excludes">Excludes</option></select></label>
          <label className="finder-filter-value">Value{filterField === "action" ? <select value={filterValue} onChange={(event) => setFilterValue(event.target.value)}><option value="">Choose an action</option>{ACTIONS.map((action) => <option key={action} value={action}>{ACTION_LABELS[action]}</option>)}</select> : <input value={filterValue} onChange={(event) => setFilterValue(event.target.value)} placeholder={filterPlaceholder(filterField)} />}</label>
          <button className="button button-outline" type="button" onClick={addFilter}><Plus size={14} /> Add condition</button>
          <p>Filters use the same verified catalog fields as prompt search; unavailable evidence never counts as a match</p>
        </div> : null}
      </form>

      <div className="finder-catalog-line"><span><strong>{allResults.length}</strong> verified catalog {allResults.length === 1 ? "match" : "matches"}</span><span>{PLAY_FINDER_CATALOG.clips.length} clip records · {sourceCount} official pages · reviewed {formatDate(PLAY_FINDER_CATALOG.lastReviewed)}</span></div>
      <details className="finder-coverage-details"><summary>View verified coverage</summary><span>{verifiedActionFamilies.size} action families · {[...verifiedActionFamilies].map((action) => ACTION_LABELS[action]).join(", ")}</span><span>{new Set(PLAY_FINDER_CATALOG.clips.filter((clip) => isVerified(clip, "season")).map((clip) => clip.season).filter(Boolean)).size} seasons · {PLAY_FINDER_CATALOG.clips.filter((clip) => isVerified(clip, "game")).length} clips with a verified game context</span></details>

      <section className="finder-results-layout" aria-label="Play Finder results">
        <div className="finder-results-column">
          <div className="finder-results-heading"><div><span className="section-kicker">Film results</span><h2>{submitted && conditions.length ? "Search results" : "Browse the catalog"}</h2></div><label className="finder-sort">Sort<select value={sort} onChange={(event) => { setSort(event.target.value as "relevance" | "date"); setPage(0); }}><option value="relevance">Relevance</option><option value="date">Newest first</option></select></label></div>
          {allResults.length ? <>
            <div className="finder-result-list">
              {pagedResults.map((result) => <ResultCard key={result.clip.id} result={result} selected={selectedClip?.id === result.clip.id} onSelect={() => setSelectedClipId(result.clip.id)} />)}
            </div>
            {pageCount > 1 ? <div className="finder-pagination"><button className="icon-button" disabled={page === 0} onClick={() => setPage((current) => current - 1)} aria-label="Previous results"><ChevronLeft size={16} /></button><span>Page {page + 1} of {pageCount}</span><button className="icon-button" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => current + 1)} aria-label="Next results"><ChevronRight size={16} /></button></div> : null}
          </> : <div className="finder-empty"><Search size={20} /><strong>{missingConditions.length ? "Search needs attention" : "No verified matches"}</strong><p>{missingConditions.length ? "Choose an ambiguous player or remove unsupported conditions, then search again" : "The catalog has no clip with all of these confirmed details. Try fewer conditions or adjust the filters"}</p></div>}
          <div className="finder-coverage-note"><Info size={14} /><span>This is a growing, verified clip library, not a search of every filmed NBA possession. Conditions without source evidence are not treated as matches</span></div>
        </div>

        <div className="finder-detail-column">
          {selectedClip ? <ClipDetail clip={selectedClip} similar={similar} active={active} videoRef={videoRef} onSave={(collectionId) => addClipToCollection(collectionId, selectedClip)} onOpenCollections={() => setCollectionDrawer(true)} onSelectSimilar={(clip) => { setSelectedClipId(clip.id); window.scrollTo({ top: 0, behavior: "smooth" }); }} collections={collections} /> : <div className="finder-detail-empty"><Clapperboard size={22} /><span>Select a result to inspect the play</span></div>}
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
              {collectionClips.length ? <div className="finder-saved-clips">{collectionClips.map(({ id, clip }, index) => <article className="finder-saved-clip" key={`${selectedCollection.id}-${id}`}><div className="finder-saved-clip-top"><button type="button" className="finder-saved-clip-open" onClick={() => openCollectionClip(id)}>{clip ? clip.title : `Unavailable catalog clip · ${id}`}</button><div><button className="icon-button" type="button" disabled={index === 0} aria-label="Move clip up" onClick={() => moveCollectionClip(selectedCollection, index, -1)}><ArrowUp size={13} /></button><button className="icon-button" type="button" disabled={index + 1 === collectionClips.length} aria-label="Move clip down" onClick={() => moveCollectionClip(selectedCollection, index, 1)}><ArrowDown size={13} /></button><button className="icon-button danger" type="button" aria-label="Remove clip from collection" onClick={() => updateCollection(selectedCollection.id, (item) => ({ ...item, clipIds: item.clipIds.filter((clipId) => clipId !== id) }))}><Trash2 size={13} /></button></div></div>{clip ? <small>{verifiedContextLine(clip)}</small> : <small>This clip reference ID remains in this collection and exported backups; its source URL is unavailable</small>}<textarea aria-label={`Notes for ${clip?.title ?? id}`} value={selectedCollection.notesByClip[id] ?? ""} placeholder="Add a personal note" onChange={(event) => updateCollection(selectedCollection.id, (item) => ({ ...item, notesByClip: { ...item.notesByClip, [id]: event.target.value } }))} /></article>)}</div> : <div className="finder-collection-empty"><BookmarkPlus size={19} /><span>No clips yet; save a result from its detail panel</span></div>}
            </section> : null}
          </div> : <div className="finder-collection-empty"><FolderOpen size={22} /><strong>No collections yet</strong><span>Create one to save clips and notes</span></div>}
          {selectedClip && collections.length ? <footer className="finder-add-to-collection"><span>Add current clip</span><div>{collections.map((collection) => <button className="button button-outline" type="button" key={collection.id} onClick={() => addClipToCollection(collection.id, selectedClip)}>{collection.name}</button>)}</div></footer> : null}
        </aside>
      </div> : null}
    </main>
  );
}

function ResultCard({ result, selected, onSelect }: { result: SearchResult; selected: boolean; onSelect: () => void }) {
  const { clip } = result;
  const actions = isVerified(clip, "actions") ? clip.actions : [];
  const context = [
    isVerified(clip, "game") ? clip.game : undefined,
    isVerified(clip, "teams") ? clip.teams?.join(" vs ") : isVerified(clip, "team") ? clip.team : undefined,
    isVerified(clip, "season") ? clip.season : undefined,
    isVerified(clip, "publishedAt") && clip.publishedAt ? formatDate(clip.publishedAt) : undefined,
  ].filter(Boolean).join(" · ") || clip.source.publisher;
  return <button type="button" className={`finder-result-card ${selected ? "is-selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
    <span className="finder-result-icon"><Clapperboard size={16} /></span>
    <span className="finder-result-main"><strong>{clip.title}</strong><span>{context}</span><span className="finder-tags">{actions.map((action) => <em key={action}>{ACTION_LABELS[action]}</em>)}{isVerified(clip, "shotType") && clip.shotType ? <em>{clip.shotType}</em> : null}{isVerified(clip, "result") && clip.result ? <em>{clip.result}</em> : null}{!actions.length ? <em>Play type not verified</em> : null}</span><span className="finder-why"><Check size={12} /> Why this matches: {result.why.join(" · ")}</span></span>
    <ExternalLink size={14} className="finder-result-chevron" aria-hidden="true" />
  </button>;
}

function ClipDetail({ clip, similar, active, videoRef, onSave, onOpenCollections, onSelectSimilar, collections }: { clip: PlayClip; similar: Array<{ clip: PlayClip; shared: string[] }>; active: boolean; videoRef: React.RefObject<HTMLIFrameElement | null>; onSave: (collectionId: string) => void; onOpenCollections: () => void; onSelectSimilar: (clip: PlayClip) => void; collections: FilmCollection[] }) {
  const [collectionId, setCollectionId] = useState("");
  useEffect(() => { if (!collections.some((collection) => collection.id === collectionId)) setCollectionId(collections[0]?.id ?? ""); }, [collections, collectionId]);
  const facts = verifiedFacts(clip);
  return <article className="finder-detail-card">
    <div className="finder-detail-media">{clip.source.embedUrl && active ? <iframe ref={videoRef} title={`Official NBA video: ${clip.title}`} src={clip.source.embedUrl} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" /> : <div className="finder-media-placeholder"><Clapperboard size={27} /><span>{clip.source.embedUrl ? "Official NBA clip" : "Watch this play on its official source"}</span></div>}</div>
    <div className="finder-detail-body"><div className="finder-detail-label"><span className="section-kicker">{clip.source.publisher} film</span><span className="finder-evidence-pill">Source checked</span></div><h2>{clip.title}</h2><p className="finder-detail-description">{clip.description}</p>
      {facts.length ? <div className="finder-detail-context">{facts.map((fact) => <DetailFact key={fact.label} label={fact.label} value={fact.value} />)}</div> : null}
      <div className="finder-detail-actions">{clip.source.embedUrl ? <a className="button button-primary" href={clip.source.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open official clip</a> : <a className="button button-primary" href={clip.source.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Watch on {clip.source.publisher}</a>}{collections.length ? <><select aria-label="Choose collection" value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><button className="button button-outline" type="button" onClick={() => collectionId ? onSave(collectionId) : onOpenCollections()}><BookmarkPlus size={14} /> Save</button></> : <button className="button button-outline" type="button" onClick={onOpenCollections}><BookmarkPlus size={14} /> Create collection</button>}</div>
      <div className="finder-detail-source"><Info size={13} /><span>Verified fields: {clip.evidence.verifiedFields.map(humanizeField).join(" · ") || "title and source"}</span><a href={clip.source.url} target="_blank" rel="noreferrer">{clip.source.label}</a></div>
      {similar.length ? <section className="finder-similar"><h3>Find similar plays</h3><p>Ranked by shared, verified features; no confidence score is inferred</p>{similar.map(({ clip: other, shared }) => <button type="button" key={other.id} onClick={() => onSelectSimilar(other)}><span>{other.title}</span><small>Shares {shared.join(" · ")}</small></button>)}</section> : null}
    </div>
  </article>;
}

function isVerified(clip: PlayClip, field: string) { return clip.evidence.verifiedFields.includes(field); }
function verifiedFacts(clip: PlayClip) {
  const facts: Array<{ label: string; value: string }> = [];
  if (isVerified(clip, "game") && clip.game) facts.push({ label: "Game", value: clip.game });
  if (isVerified(clip, "season") && clip.season) facts.push({ label: "Season", value: clip.season });
  if (isVerified(clip, "players") && clip.players.length) facts.push({ label: "Players", value: clip.players.join(", ") });
  if (isVerified(clip, "teams") && clip.teams?.length) facts.push({ label: "Teams", value: clip.teams.join(" · ") });
  else if (isVerified(clip, "team") && clip.team) facts.push({ label: "Team", value: clip.team });
  if (isVerified(clip, "opponent") && clip.opponent) facts.push({ label: "Opponent", value: clip.opponent });
  if (isVerified(clip, "quarter") && clip.quarter) facts.push({ label: "Quarter", value: `Q${clip.quarter}` });
  if (isVerified(clip, "gameClockSeconds") && clip.gameClockSeconds != null) facts.push({ label: "Game clock", value: formatClock(clip.gameClockSeconds) });
  if (isVerified(clip, "scoreMargin") && clip.scoreMargin != null) facts.push({ label: "Score margin", value: String(clip.scoreMargin) });
  if (isVerified(clip, "coverage") && clip.coverage) facts.push({ label: "Coverage", value: clip.coverage });
  if (isVerified(clip, "shotType") && clip.shotType) facts.push({ label: "Shot type", value: clip.shotType });
  if (isVerified(clip, "result") && clip.result) facts.push({ label: "Result", value: clip.result });
  return facts;
}
function verifiedContextLine(clip: PlayClip) {
  const context = verifiedFacts(clip).filter((fact) => ["Game", "Season", "Teams", "Team"].includes(fact.label)).map((fact) => fact.value);
  const actions = isVerified(clip, "actions") ? clip.actions.map((action) => ACTION_LABELS[action]) : [];
  return [...context, ...actions].join(" · ") || "No play type or game details verified";
}

function DetailFact({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function formatConditionValue(item: PlayCondition) {
  if (item.field === "action") return ACTION_LABELS[item.value as PlayAction] ?? String(item.value);
  if (item.field === "sequence") return (item.value as PlayAction[]).map((action) => ACTION_LABELS[action]).join(" → ");
  return String(item.value);
}
function filterPlaceholder(field: SearchField) {
  return ({ player: "e.g. Stephen Curry", team: "e.g. Boston Celtics", opponent: "e.g. Boston Celtics", season: "e.g. 2023-24", postseason: "true or false", quarter: "1–4", gameClock: "e.g. 2:30", scoreMargin: "e.g. 5", shotType: "three, layup, dunk…", result: "made, missed, turnover…", action: "Choose an action", coverage: "e.g. drop" })[field];
}
function humanizeField(field: string) {
  return ({ actions: "play actions", sequence: "action order", players: "players", teams: "teams", gameClockSeconds: "game clock", scoreMargin: "score margin", shotType: "shot type" } as Record<string, string>)[field] ?? field.replace(/([A-Z])/g, " $1").toLowerCase();
}
function formatDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}
function formatClock(value: number) { return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
