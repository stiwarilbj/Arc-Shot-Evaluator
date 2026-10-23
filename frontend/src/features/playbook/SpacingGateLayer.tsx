import { COURT_SCALE, courtPointToSvg } from "./courtGeometry.ts";
import type { SpacingGate, SpacingGateResult } from "./types.ts";

export type SpacingGateDragKind = "move" | "resize";

export function spacingGateStatusText(status: SpacingGateResult["status"] | undefined) {
  if (status === "checking") return "Checking";
  if (status === "met") return "Met";
  if (status === "missed") return "Missed";
  if (status === "not-evaluated") return "Not evaluated";
  return "Pending";
}

export function spacingGateStatusSymbol(status: SpacingGateResult["status"] | undefined) {
  if (status === "checking") return "◷";
  if (status === "met") return "✓";
  if (status === "missed") return "×";
  if (status === "not-evaluated") return "—";
  return "○";
}

export function SpacingGateLayer({ gates, results = [], visible = true, selectedGateId = null, onSelect, onPointerStart, interactive = false }: {
  gates: SpacingGate[];
  results?: SpacingGateResult[];
  visible?: boolean;
  selectedGateId?: string | null;
  onSelect?: (gateId: string) => void;
  onPointerStart?: (event: React.PointerEvent<SVGGElement>, gateId: string, kind: SpacingGateDragKind) => void;
  interactive?: boolean;
}) {
  if (!visible) return null;
  const resultById = new Map(results.map((result) => [result.gateId, result]));
  return <g className="spacing-gate-layer" aria-label="Spacing gates">
    {gates.map((gate, index) => {
      const center = courtPointToSvg(gate.area.center);
      const selected = gate.id === selectedGateId;
      const result = resultById.get(gate.id);
      const status = result?.status ?? "pending";
      const extentX = gate.area.shape === "circle" ? gate.area.radiusFeet : gate.area.widthFeet / 2;
      const extentY = gate.area.shape === "circle" ? gate.area.radiusFeet : gate.area.heightFeet / 2;
      const width = (gate.area.shape === "circle" ? gate.area.radiusFeet * 2 : gate.area.widthFeet) * COURT_SCALE;
      const height = (gate.area.shape === "circle" ? gate.area.radiusFeet * 2 : gate.area.heightFeet) * COURT_SCALE;
      const select = () => onSelect?.(gate.id);
      const begin = (event: React.PointerEvent<SVGGElement>, kind: SpacingGateDragKind) => {
        if (!interactive || !onPointerStart) return;
        event.preventDefault(); event.stopPropagation();
        select(); onPointerStart(event, gate.id, kind);
      };
      const description = `Gate ${index + 1}, Player ${gate.playerId}, stay ${gate.rule === "inside" ? "inside" : "outside"} ${gate.area.shape === "circle" ? `${gate.area.radiusFeet} foot radius` : `${gate.area.widthFeet} by ${gate.area.heightFeet} foot rectangle`}${gate.instruction ? ` · ${gate.instruction}` : ""}`;
      const instructionLines = (gate.instruction ?? "").match(/.{1,24}(?:\s|$)|\S+/g)?.map((line) => line.trim()).filter(Boolean).slice(0, 6) ?? [];
      return <g key={gate.id} className={`spacing-gate spacing-gate-${status} ${selected ? "is-selected" : ""}`} role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined} aria-label={description} aria-pressed={interactive ? selected : undefined}
        onClick={interactive ? select : undefined} onKeyDown={interactive ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } } : undefined}>
        <title>{`${description} · ${spacingGateStatusText(status)}${result?.reason ? ` · ${result.reason}` : ""}`}</title>
        {gate.area.shape === "circle"
          ? <circle cx={center.x} cy={center.y} r={width / 2} className="spacing-gate-area" onPointerDown={interactive ? (event) => begin(event, "move") : undefined} />
          : <rect x={center.x - width / 2} y={center.y - height / 2} width={width} height={height} rx="3" className="spacing-gate-area" onPointerDown={interactive ? (event) => begin(event, "move") : undefined} />}
        <g className="spacing-gate-label" pointerEvents="none"><rect x={center.x - 35} y={center.y - extentY * COURT_SCALE - 25} width="70" height="20" rx="8" /><text x={center.x} y={center.y - extentY * COURT_SCALE - 15}>{`GATE ${index + 1} · P${gate.playerId}`}</text></g>
        {instructionLines.length ? <text className="spacing-gate-instruction" x={center.x} y={center.y - (instructionLines.length - 1) * 6}>{instructionLines.map((line, lineIndex) => <tspan key={lineIndex} x={center.x} dy={lineIndex === 0 ? 0 : 12}>{line}</tspan>)}</text> : null}
        {result ? <g className={`spacing-gate-result-label status-${status}`} pointerEvents="none"><text x={center.x} y={center.y + extentY * COURT_SCALE + 16}>{`${spacingGateStatusSymbol(status)} ${spacingGateStatusText(status)}`}</text></g> : null}
        {selected && interactive ? <>
          <circle cx={center.x} cy={center.y} r="9" className="spacing-gate-center-handle" onPointerDown={(event) => begin(event, "move")} />
          {gate.area.shape === "circle"
            ? <circle cx={center.x + width / 2} cy={center.y} r="9" className="spacing-gate-resize-handle" aria-label="Resize spacing gate" onPointerDown={(event) => begin(event, "resize")} />
            : <rect x={center.x + width / 2 - 8} y={center.y + height / 2 - 8} width="16" height="16" rx="3" className="spacing-gate-resize-handle" aria-label="Resize spacing gate" onPointerDown={(event) => begin(event, "resize")} />}
        </> : null}
      </g>;
    })}
  </g>;
}
