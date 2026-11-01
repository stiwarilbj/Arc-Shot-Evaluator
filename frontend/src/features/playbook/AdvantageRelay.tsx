import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CircleDot, CornerDownRight, Minus, Sparkles } from "lucide-react";
import type { AdvantageRelay, AdvantageRelayEvent, AdvantageRelaySupportingTransfer, CounterLabMode, CounterLabProfile } from "./counterLabTypes.ts";

export type AdvantageRelaySelection =
  | { kind: "event"; value: AdvantageRelayEvent }
  | { kind: "transfer"; value: AdvantageRelaySupportingTransfer };
export type AdvantageRelaySide = "original" | "repair";

const eventLabel = (kind: AdvantageRelayEvent["kind"]) => kind === "created" ? "Opening created" : kind === "transferred" ? "Opening transferred" : "Opening lost";
const iconFor = (kind: AdvantageRelayEvent["kind"]) => kind === "created" ? <Sparkles size={14} aria-hidden="true" /> : kind === "transferred" ? <CornerDownRight size={14} aria-hidden="true" /> : <Minus size={14} aria-hidden="true" />;
const at = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const optionLabel = (kind: string) => kind === "shot" ? "shot" : kind === "pass" ? "pass" : "drive";
const gap = (feet: number) => Number.isFinite(feet) ? `${feet.toFixed(1)} ft` : "not applicable";

export function AdvantageRelay({
  original, repaired, durationMs, positionMs, profile, mode, visibleSide, onSelect,
}: {
  original: AdvantageRelay | null;
  repaired: AdvantageRelay | null;
  durationMs: number;
  positionMs: number;
  profile: CounterLabProfile;
  mode: CounterLabMode;
  visibleSide: AdvantageRelaySide | "dilemma";
  onSelect: (side: AdvantageRelaySide, selection: AdvantageRelaySelection) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<{ side: AdvantageRelaySide; kind: "event" | "transfer"; id: string } | null>(null);
  const selectedItem = useMemo(() => {
    if (!selected) return null;
    const relay = selected.side === "original" ? original : repaired;
    if (!relay) return null;
    if (selected.kind === "event") {
      const value = relay.events.find((event) => event.id === selected.id);
      return value ? { side: selected.side, kind: "event" as const, value } : null;
    }
    const value = relay.supportingTransfers.find((transfer) => transfer.id === selected.id);
    return value ? { side: selected.side, kind: "transfer" as const, value } : null;
  }, [original, repaired, selected]);
  const percent = durationMs > 0 ? Math.max(0, Math.min(100, positionMs / durationMs * 100)) : 0;
  const hasRepair = Boolean(repaired);
  const totalEvents = (original?.events.length ?? 0) + (repaired?.events.length ?? 0);
  const totalTransfers = (original?.supportingTransfers.length ?? 0) + (repaired?.supportingTransfers.length ?? 0);

  function choose(side: AdvantageRelaySide, selection: AdvantageRelaySelection) {
    setSelected({ side, kind: selection.kind, id: selection.value.id });
    setExpanded(true);
    onSelect(side, selection);
  }

  return <section className="counter-advantage-relay" data-visible-side={visibleSide} aria-label="Advantage Relay">
    <button className="counter-relay-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
      <span className="counter-relay-toggle-copy"><strong>Advantage Relay</strong><span>{totalEvents ? `${totalEvents} recorded opening moment${totalEvents === 1 ? "" : "s"}` : totalTransfers ? `${totalTransfers} recorded transfer${totalTransfers === 1 ? "" : "s"} · no qualifying opening chain` : "Follow recorded openings through this possession"}</span></span>
      {expanded ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronRight size={18} aria-hidden="true" />}
    </button>
    {expanded ? <div className="counter-relay-content">
      {!original ? <p className="counter-relay-state" role="status">Relay evidence is unavailable until a completed analysis is selected</p> : <>
        <p className="counter-relay-caption">Recorded from {profile.label} · {mode === "scripted" ? "Drawn play" : "Adaptive offense"} · All times share the court replay clock</p>
        <RelayLane side="original" relay={original} durationMs={durationMs} playheadPercent={percent} selected={selected} onSelect={choose} />
        {hasRepair ? <RelayLane side="repair" relay={repaired!} durationMs={durationMs} playheadPercent={percent} selected={selected} onSelect={choose} /> : null}
        {!original.events.length ? <p className="counter-relay-state" role="status">No eligible opening recorded</p> : null}
        {hasRepair && !repaired?.events.length ? <p className="counter-relay-state" role="status">No eligible opening recorded in this repair</p> : null}
        {selectedItem ? <EvidenceCard side={selectedItem.side} selection={selectedItem.kind === "event" ? { kind: "event", value: selectedItem.value as AdvantageRelayEvent } : { kind: "transfer", value: selectedItem.value as AdvantageRelaySupportingTransfer }} /> : null}
        <p className="counter-relay-note">Opportunity scores describe this simulation only · Recorded positions do not prove that a player caused a defensive reaction or was truly open</p>
      </>}
    </div> : null}
  </section>;
}

function RelayLane({ side, relay, durationMs, playheadPercent, selected, onSelect }: {
  side: AdvantageRelaySide;
  relay: AdvantageRelay;
  durationMs: number;
  playheadPercent: number;
  selected: { side: AdvantageRelaySide; kind: "event" | "transfer"; id: string } | null;
  onSelect: (side: AdvantageRelaySide, selection: AdvantageRelaySelection) => void;
}) {
  const laneName = side === "original" ? "Original" : "Repair";
  const events = relay.events;
  const transfers = relay.supportingTransfers;
  const items = [...events.map((value) => ({ kind: "event" as const, value, atMs: value.atMs })), ...transfers.map((value) => ({ kind: "transfer" as const, value, atMs: value.atMs }))]
    .sort((a, b) => a.atMs - b.atMs || (a.kind === "event" ? 0 : 1) - (b.kind === "event" ? 0 : 1) || a.value.id.localeCompare(b.value.id));
  return <div className="counter-relay-lane" data-side={side} aria-label={`${laneName} advantage ribbon`}>
    <div className="counter-relay-lane-heading"><strong>{laneName}</strong><span>{relay.status === "none" ? "No qualifying chain" : `${events.length} moment${events.length === 1 ? "" : "s"}`}</span></div>
    <div className="counter-relay-scale" role="group" aria-label={`${laneName} event positions on the replay timeline`}>
      <div className="counter-relay-track" />
      <div className="counter-relay-playhead" style={{ left: `${playheadPercent}%` }} aria-hidden="true" />
      {items.map((item) => item.kind === "event" ? <button
        key={item.value.id}
        type="button"
        className={`counter-relay-marker is-${item.value.kind}${selected?.side === side && selected.id === item.value.id ? " is-selected" : ""}`}
        style={{ left: `${durationMs > 0 ? Math.max(0, Math.min(100, item.atMs / durationMs * 100)) : 0}%` }}
        aria-label={`${eventLabel(item.value.kind)} at ${at(item.atMs)} · ${item.value.playerIds.map((id) => `Player ${id}`).join(", ") || "No player recorded"}`}
        title={`${eventLabel(item.value.kind)} · ${at(item.atMs)}`}
        onClick={() => onSelect(side, { kind: "event", value: item.value })}
      ><span>{iconFor(item.value.kind)}</span></button> : <button
        key={item.value.id}
        type="button"
        className={`counter-relay-marker is-neutral${selected?.side === side && selected.id === item.value.id ? " is-selected" : ""}`}
        style={{ left: `${durationMs > 0 ? Math.max(0, Math.min(100, item.atMs / durationMs * 100)) : 0}%` }}
        aria-label={`${item.value.outcome === "caught" ? "Completed transfer" : "Uncompleted transfer"} at ${at(item.atMs)} · Player ${item.value.giverId} to Player ${item.value.receiverId}`}
        title={`${item.value.outcome === "caught" ? "Caught transfer" : "Uncompleted transfer"} · ${at(item.atMs)}`}
        onClick={() => onSelect(side, { kind: "transfer", value: item.value })}
      ><span><CircleDot size={12} aria-hidden="true" /></span></button>)}
    </div>
    {events.length || transfers.length ? <div className="counter-relay-chain" aria-label={`${laneName} chronological opportunities`}>
      {items.map((item) => item.kind === "event" ? <button type="button" key={item.value.id} className={`counter-relay-chip is-${item.value.kind}${selected?.side === side && selected.id === item.value.id ? " is-selected" : ""}`} onClick={() => onSelect(side, { kind: "event", value: item.value })}>
        <span className="counter-relay-chip-kind">{iconFor(item.value.kind)}{eventLabel(item.value.kind)}</span><strong>{at(item.atMs)}</strong><span>{item.value.playerIds.length ? item.value.playerIds.map((id) => `#${id}`).join(" · ") : "No player"}</span>
      </button> : <button type="button" key={item.value.id} className={`counter-relay-chip is-neutral${selected?.side === side && selected.id === item.value.id ? " is-selected" : ""}`} onClick={() => onSelect(side, { kind: "transfer", value: item.value })}>
        <span className="counter-relay-chip-kind"><CircleDot size={13} aria-hidden="true" />{item.value.outcome === "caught" ? "Catch recorded" : `Transfer ${item.value.outcome}`}</span><strong>{at(item.atMs)}</strong><span>#{item.value.giverId} → #{item.value.receiverId}</span>
      </button>)}
    </div> : <p className="counter-relay-empty">No opportunity segments in this possession</p>}
  </div>;
}

function EvidenceCard({ side, selection }: { side: AdvantageRelaySide; selection: AdvantageRelaySelection }) {
  if (selection.kind === "transfer") {
    const transfer = selection.value;
    const outcomeNote = transfer.outcome === "caught"
      ? "A confirmed catch was recorded, but no eligible continuation met the opening rule"
      : transfer.outcome === "failed"
        ? "The transfer failed before a confirmed catch was recorded"
        : "The transfer was interrupted before a confirmed catch was recorded";
    return <article className="counter-relay-evidence"><span className="section-kicker">{side === "original" ? "ORIGINAL EVIDENCE" : "REPAIR EVIDENCE"}</span><h4>{transfer.outcome === "caught" ? "Completed transfer · Supporting evidence" : `Transfer ${transfer.outcome} · Supporting evidence`}</h4><p>Move {transfer.sequence} · {transfer.kind} · Player {transfer.giverId} to Player {transfer.receiverId}</p><p>Recorded at {at(transfer.atMs)} · {outcomeNote}</p></article>;
  }
  const event = selection.value;
  const evidence = event.evidence;
  const primary = event.kind === "transferred" ? event.transfer?.continuationOpportunity
    : [...evidence.opportunities].sort((a, b) => b.quality - a.quality || b.score - a.score || a.playerId - b.playerId || a.kind.localeCompare(b.kind))[0] ?? null;
  const alternatives = evidence.opportunities.filter((option) => !primary || option.playerId !== primary.playerId || option.kind !== primary.kind);
  const assignment = primary ? evidence.assignments.find((item) => item.playerId === primary.playerId) : null;
  return <article className="counter-relay-evidence">
    <span className="section-kicker">{side === "original" ? "ORIGINAL EVIDENCE" : "REPAIR EVIDENCE"}</span>
    <h4>{eventLabel(event.kind)} <time>{at(event.atMs)}</time></h4>
    {event.confirmedAtMs != null ? <p>First recorded below-threshold moment at {at(event.atMs)} · Confirmed after 300 ms at {at(event.confirmedAtMs)}</p> : null}
    {event.note ? <p>{event.note}</p> : null}
    <dl>
      <div><dt>Action</dt><dd>{evidence.action ? `${evidence.action}${evidence.sequence ? ` · Move ${evidence.sequence}` : ""}` : evidence.actionId ? `Recorded action · Move ${evidence.sequence ?? "—"}` : "No active authored action"}</dd></div>
      <div><dt>Possession</dt><dd>{evidence.ballHandlerId == null ? "No held-ball handler recorded" : `Player ${evidence.ballHandlerId} held the ball`}</dd></div>
      <div><dt>Opportunity</dt><dd>{primary ? `Player ${primary.playerId} · ${optionLabel(primary.kind)} · simulation quality ${primary.quality.toFixed(1)} · score ${primary.score.toFixed(1)}` : "No eligible option recorded at this sample"}</dd></div>
      {primary ? <div><dt>Recorded separation</dt><dd>{gap(primary.receiverGap)} from the nearest defender · Passing-lane clearance {gap(primary.laneGap)}{assignment ? ` · Defender ${assignment.defenderId} assigned to Player ${assignment.playerId}` : ""}</dd></div> : null}
      {event.transfer ? <div><dt>Transfer evidence</dt><dd>{event.transfer.kind} · Player {event.transfer.giverId} to Player {event.transfer.receiverId} · released {at(event.transfer.releasedAtMs)} · caught {at(event.transfer.caughtAtMs)} · eligible continuation {at(event.transfer.continuationAtMs)}</dd></div> : null}
    </dl>
    {alternatives.length ? <div className="counter-relay-alternatives"><strong>Other available opportunities at this sample</strong><ul>{alternatives.map((option, index) => <li key={`${option.playerId}-${option.kind}-${index}`}>Player {option.playerId} · {optionLabel(option.kind)} · quality {option.quality.toFixed(1)} · separation {gap(option.receiverGap)} · lane {gap(option.laneGap)}</li>)}</ul></div> : null}
    {event.kind === "transferred" ? <p className="counter-relay-caveat">The record shows a confirmed catch and eligible continuation · It does not establish why the receiver became available</p> : null}
  </article>;
}
