import { ArrowRightCircle, CheckCircle2, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { ShotAnalysis, ShotCoaching } from "../../domain/analysisTypes";

interface CoachNotesProps {
  shot: ShotAnalysis;
}

const ICONS = {
  positive: CheckCircle2,
  action: ArrowRightCircle,
  consistency: ArrowRightCircle,
};

function sourceRows(coaching: ShotCoaching) {
  const sources = new Map(coaching.sources.map((source) => [source.id, source]));
  const seen = new Set<string>();
  return coaching.tips.flatMap((tip) => {
    const sourceId = tip.source_ids.find((id) => !seen.has(id));
    if (!sourceId) return [];
    const source = sources.get(sourceId);
    if (!source) return [];
    seen.add(sourceId);
    return [{ id: `${tip.id}:${sourceId}`, evidence: tip.evidence, source }];
  }).slice(0, 3);
}

function evidenceText(evidence: ShotCoaching["tips"][number]["evidence"]) {
  if (!evidence) return "Coaching cue";
  if (evidence.metric === "session.attempts") {
    const count = Number.parseInt(evidence.value, 10);
    return `${Number.isFinite(count) ? count : evidence.value} analyzed ${count === 1 ? "shot" : "shots"}`;
  }
  return `${evidence.value} ${evidence.label.toLowerCase()}`;
}

export function CoachNotes({ shot }: CoachNotesProps) {
  const coaching = shot.coaching;
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const rows = useMemo(() => coaching ? sourceRows(coaching) : [], [coaching]);

  useEffect(() => setExpanded(false), [shot.id]);

  if (!coaching) return null;
  const matchedLabel = `${coaching.matched_source_count} local coaching ${coaching.matched_source_count === 1 ? "note" : "notes"} matched`;

  return (
    <section className={`coach-notes ${coaching.limited ? "coach-notes-limited" : ""}`} aria-label={`Coach Notes for Shot ${shot.id}`}>
      <div className="coach-notes-main">
        <h2>Coach Notes</h2>
        <p className="coach-intro">{coaching.intro}</p>
        <ul className="coach-tip-list">
          {coaching.tips.map((tip) => {
            const Icon = ICONS[tip.tone];
            return (
              <li className={`coach-tip coach-tip-${tip.tone}`} key={tip.id}>
                <Icon size={17} aria-hidden="true" />
                <span>{tip.text}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="coach-source-footer">
        <div className="coach-source-heading">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((current) => !current)}
          >
            Why these tips? {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <span>{matchedLabel}</span>
        </div>

        {expanded ? (
          <div className="coach-source-details" id={detailsId}>
            <div className="coach-source-list">
              {rows.map(({ id, evidence, source }) => {
                const content = (
                  <>
                    <span>{evidenceText(evidence)} · {source.title}</span>
                    {source.url ? <ExternalLink size={13} aria-hidden="true" /> : null}
                  </>
                );
                return source.url ? (
                  <a key={id} href={source.url} target="_blank" rel="noreferrer">{content}</a>
                ) : (
                  <div className="coach-source-row" key={id}>{content}</div>
                );
              })}
            </div>
            <p>Single-camera numbers can be a little off.</p>
            <button className="coach-hide-details" type="button" onClick={() => setExpanded(false)}>Hide details</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
