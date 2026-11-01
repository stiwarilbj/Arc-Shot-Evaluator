import { useState } from "react";
import { ArrowLeftRight, MapPin, RefreshCw, X } from "lucide-react";
import { CourtMarkings } from "./CourtMarkings";
import { CourtRoutes } from "./CourtRoutes";
import { routeVisible, type ArrowVisibility } from "./arrowVisibility";
import { authoredCourtRoutes } from "./simulation";
import { resolvePlaybookPath } from "./playbookBranches";
import { roleAssignmentsForPath, roleSwitchSourceKey, type RoleSwitchPreview } from "./roleSwitchboard";
import { COURT_VIEWBOX, courtPointToSvg } from "./courtGeometry";
import type { PlaybookDraft } from "./types";

type Props = {
  source: PlaybookDraft;
  activePath: PlaybookDraft;
  activeBranchId: string | null;
  activeBranchLabel: string;
  arrowVisibility: ArrowVisibility;
  firstPlayerId: number | null;
  secondPlayerId: number | null;
  pickTarget: "first" | "second" | null;
  preview: RoleSwitchPreview | null;
  onSelectPlayer: (which: "first" | "second", playerId: number) => void;
  onPickTarget: (which: "first" | "second") => void;
  onPreview: () => void;
  onApply: () => void;
  onCancel: () => void;
  onHighlightActions: (actionIds: string[]) => void;
};

const jobDescriptions: Record<string, string> = {
  Handler: "Controls the ball for this action",
  Passer: "Starts a pass",
  "Handoff giver": "Delivers the handoff",
  Receiver: "Receives the pass or handoff",
  Screener: "Sets the screen",
  "Screen user": "Uses the screen",
  Cutter: "Moves through an off-ball screen",
  Roller: "Rolls toward the basket",
  Popper: "Pops away from the screen",
  Mover: "Executes this authored route",
  "Hold position": "Has no authored movement in this ending",
};

function labelAction(kind: string) {
  return kind.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function RoleSwapCourt({ play, visibility, highlightedIds, swappedPlayerIds, label }: { play: PlaybookDraft; visibility: ArrowVisibility; highlightedIds: ReadonlySet<string>; swappedPlayerIds: ReadonlySet<number>; label: string }) {
  const routes = authoredCourtRoutes(play);
  return <div className="role-switch-court-wrap"><svg className="role-switch-court" viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} role="img" aria-label={`${label} court preview with exchanged starting spots`}>
    <rect x="0" y="0" width={COURT_VIEWBOX.width} height={COURT_VIEWBOX.height} className="court-floor" />
    <CourtMarkings />
    <CourtRoutes routes={routes.filter((route) => routeVisible(route, visibility))} visibility={visibility} highlightActionIds={highlightedIds} />
    {play.players.map((player) => {
      const point = courtPointToSvg(player);
      return <g key={player.id} className={`role-switch-player-marker ${swappedPlayerIds.has(player.id) ? "is-exchanged" : ""}`}>
        <circle cx={point.x} cy={point.y} r="23" />
        <text x={point.x} y={point.y + 1}>P{player.id}</text>
      </g>;
    })}
    {play.ball ? <g className="role-switch-ball-marker"><circle cx={courtPointToSvg(play.ball).x} cy={courtPointToSvg(play.ball).y} r="8" /><path d={`M${courtPointToSvg(play.ball).x - 6} ${courtPointToSvg(play.ball).y}h12M${courtPointToSvg(play.ball).x} ${courtPointToSvg(play.ball).y - 6}v12`} /></g> : null}
  </svg></div>;
}

export function RoleSwitchboardPanel(props: Props) {
  const { source, activePath, activeBranchId, activeBranchLabel, arrowVisibility, firstPlayerId, secondPlayerId, pickTarget, preview } = props;
  const [compareSide, setCompareSide] = useState<"before" | "after">("before");
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const assignments = roleAssignmentsForPath(activePath);
  const stale = Boolean(preview && (preview.sourceKey !== roleSwitchSourceKey(source)
    || preview.firstPlayerId !== firstPlayerId || preview.secondPlayerId !== secondPlayerId));
  const selectedPairValid = firstPlayerId != null && secondPlayerId != null && firstPlayerId !== secondPlayerId
    && source.players.some((player) => player.id === firstPlayerId) && source.players.some((player) => player.id === secondPlayerId);
  const previewPath = preview ? resolvePlaybookPath(compareSide === "after" ? preview.after : source, activeBranchId).play : activePath;
  const selectedImpact = preview?.paths.find((path) => path.branchId === activeBranchId) ?? preview?.paths[0];
  const highlightedIds = new Set(selectedImpact?.actions.map((action) => action.actionId) ?? []);
  const referenceGroups = new Map<string, RoleSwitchPreview["references"]>();
  for (const reference of preview?.references ?? []) {
    const list = referenceGroups.get(reference.category) ?? [];
    list.push(reference);
    referenceGroups.set(reference.category, list);
  }

  return <>
    <details className="role-switchboard-panel">
      <summary><ArrowLeftRight size={17} /><span>Role Switchboard</span><small>Swap jobs and starting spots</small></summary>
      <div className="role-switchboard-content">
        <p className="role-switchboard-intro">Jobs come from this ending’s authored action bindings · A player can hold several jobs · Ratings and badges stay with each player</p>
        <div className="role-switchboard-job-list" aria-label="Jobs in the selected ending">
          {assignments.map((assignment) => <section className="role-switchboard-player" key={assignment.playerId}>
            <strong>Player {assignment.playerId}</strong>
            <div>{assignment.jobs.map((job) => {
              const key = `${assignment.playerId}:${job.label}`;
              const sequences = job.sequences.length ? [...new Set(job.sequences)].sort((a, b) => a - b) : [];
              return <button type="button" key={key} className={activeJob === key ? "is-active" : ""} aria-pressed={activeJob === key} title={jobDescriptions[job.label]} onClick={() => {
                setActiveJob(activeJob === key ? null : key);
                props.onHighlightActions(activeJob === key ? [] : job.actionIds);
              }}><span>{job.label}</span>{sequences.length ? <small>{sequences.map((sequence) => `Move ${sequence}`).join(", ")}</small> : <small>No move</small>}</button>;
            })}</div>
          </section>)}
          {!assignments.length ? <p>Add at least two offensive players to preview a role exchange</p> : null}
        </div>
        <div className="role-switchboard-pair">
          {(["first", "second"] as const).map((which) => {
            const selectedId = which === "first" ? firstPlayerId : secondPlayerId;
            return <label key={which}><span>{which === "first" ? "First player" : "Second player"}</span><select aria-label={`${which === "first" ? "First" : "Second"} player for role exchange`} value={selectedId == null ? "" : String(selectedId)} onChange={(event) => props.onSelectPlayer(which, Number(event.currentTarget.value))}>
              <option value="" disabled>Choose player</option>
              {source.players.map((player) => <option key={player.id} value={player.id}>Player {player.id}</option>)}
            </select><button type="button" className={`button button-subtle role-switch-pick ${pickTarget === which ? "is-active" : ""}`} aria-pressed={pickTarget === which} onClick={() => props.onPickTarget(which)}><MapPin size={14} />{pickTarget === which ? "Select a court marker" : "Pick on court"}</button></label>;
          })}
        </div>
        <p className="role-switchboard-impact-note"><strong>Affects Main and all endings</strong><span>{source.branches?.length ?? 0} ending{source.branches?.length === 1 ? "" : "s"} · {activeBranchLabel} shown on the court</span></p>
        <button type="button" className="button button-primary role-switch-preview-button" disabled={!selectedPairValid || pickTarget !== null} onClick={props.onPreview}>Preview exchange</button>
        {pickTarget ? <p className="role-switch-pick-note" role="status">Click an offensive marker on the court · Escape cancels</p> : null}
      </div>
    </details>

    {preview ? <div className="role-switch-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onCancel(); }}>
      <section className="role-switch-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="role-switch-preview-title" aria-describedby="role-switch-preview-description" tabIndex={-1}>
        <header><div><span className="section-kicker">Main + {source.branches?.length ?? 0} ending{source.branches?.length === 1 ? "" : "s"}</span><h2 id="role-switch-preview-title">Preview role exchange</h2></div><button type="button" className="icon-button" aria-label="Cancel role exchange preview" onClick={props.onCancel}><X size={18} /></button></header>
        <p id="role-switch-preview-description">Player {preview.firstPlayerId} takes Player {preview.secondPlayerId}’s authored responsibilities and starting spot · Player identities, ratings, badges, and roster order stay attached to the same people</p>
        <div className="role-switch-preview-body">
          <section className="role-switch-preview-court-section" aria-label="Court comparison">
            <div className="role-switch-side-toggle" role="group" aria-label="Before or after role exchange">
              <button type="button" aria-pressed={compareSide === "before"} className={compareSide === "before" ? "is-active" : ""} onClick={() => setCompareSide("before")}>Before</button>
              <button type="button" aria-pressed={compareSide === "after"} className={compareSide === "after" ? "is-active" : ""} onClick={() => setCompareSide("after")}>After</button>
            </div>
            <RoleSwapCourt play={previewPath} visibility={arrowVisibility} highlightedIds={highlightedIds} swappedPlayerIds={new Set([preview.firstPlayerId, preview.secondPlayerId])} label={compareSide === "before" ? "Before" : "After"} />
            <small>{compareSide === "before" ? "Original assignments and starting spots" : "Proposed assignments and exchanged starting spots"} · Arrows follow your shared visibility setting</small>
          </section>
          <div className="role-switch-preview-details">
            {stale ? <div className="role-switch-stale" role="alert"><strong>The drawing changed after this preview</strong><span>Refresh the comparison before applying the exchange</span><button type="button" className="button button-outline" onClick={props.onPreview}><RefreshCw size={14} />Refresh preview</button></div> : null}
            <section><h3>Starting setup</h3><p>Players {preview.firstPlayerId} and {preview.secondPlayerId} exchange court positions · The ball stays at its original court location</p>{preview.materializedBallLocation ? <small>The original implicit ball spot is saved explicitly so the same court location starts with the incoming handler</small> : null}</section>
            <section className="role-switch-impact-list"><h3>Changed actions</h3>
              {preview.paths.map((path) => <details key={path.branchId ?? "main"} open={path.actions.length > 0}>
                <summary>{path.label} <span>{path.actions.length} action{path.actions.length === 1 ? "" : "s"}</span></summary>
                {path.actions.length ? <ul>{path.actions.map((action, index) => <li key={`${path.branchId ?? "main"}-${action.actionId}-${index}`}><strong>Move {action.sequence} · {labelAction(action.kind)}</strong><span>{action.participants.map((participant) => `${participant.role}: Player ${participant.beforeId} → Player ${participant.afterId}`).join(" · ")}</span></li>)}</ul> : <p>No bound actions change in this path</p>}
              </details>)}
            </section>
            {referenceGroups.size ? <section className="role-switch-impact-list"><h3>Connected instructions</h3>{[...referenceGroups.entries()].map(([category, references]) => <details key={category} open><summary>{category} <span>{references.length}</span></summary><ul>{references.map((reference, index) => <li key={`${category}-${index}`}><strong>{reference.label}</strong><span>{reference.before} → {reference.after}{reference.review ? " · Review wording after the swap" : ""}</span></li>)}</ul></details>)}</section> : null}
            {preview.frozenLessonCount ? <p className="role-switch-frozen-note">{preview.frozenLessonCount} frozen Read Coach or Flipbook lesson{preview.frozenLessonCount === 1 ? "" : "s"} keep their captured players · Rebuild them explicitly if you want the new personnel</p> : null}
            {preview.validationErrors.length ? <section className="role-switch-validation-errors" role="alert"><h3>Resolve before applying</h3><ul>{preview.validationErrors.map((message) => <li key={message}>{message}</li>)}</ul></section> : null}
          </div>
        </div>
        <footer><button type="button" className="button button-outline" onClick={props.onCancel}>Cancel</button><button type="button" className="button button-primary" disabled={stale || preview.validationErrors.length > 0} onClick={props.onApply}>Apply swap</button></footer>
      </section>
    </div> : null}
  </>;
}
