import { forwardRef, type PointerEvent, type KeyboardEvent } from "react";
import {
  courtLines,
  regionPolygons,
  project,
  measure,
  measurementPointSupported,
  LANDMARKS,
  type Alignment,
} from "./geometry.ts";
import type { FloorProject, Point } from "./types.ts";
export type SceneProps = {
  project: FloorProject;
  alignment: Alignment;
  imageUrl: string;
  view: "photo" | "court";
  check: boolean;
  measurementCoverage?: boolean;
  selected?: string | null;
  hovered?: string | null;
  cursor?: Point | null;
  pending?: Point | null;
  highlightedMeasurement?: string | null;
  editing?: boolean;
  onPointerDown?: (e: PointerEvent<SVGSVGElement>) => void;
  onPointerMove?: (e: PointerEvent<SVGSVGElement>) => void;
  onPointerUp?: (e: PointerEvent<SVGSVGElement>) => void;
  onPointerCancel?: () => void;
  onPointerLeave?: () => void;
  onKeyDown?: (e: KeyboardEvent<SVGSVGElement>) => void;
};
const colors = {
  orange: "#f27b43",
  line: "#b3bdbe",
  muted: "#b8bec3",
  blue: "#8dcbeb",
  ink: "#111719",
};
export const FloorScene = forwardRef<SVGSVGElement, SceneProps>(
  function FloorScene(p, ref) {
    const photo = p.view === "photo",
      w = photo ? p.project.width : 54,
      h = photo ? p.project.height : 51,
      unit = photo ? Math.max(w, h) / 800 : 0.12;
    const mapped = (v: Point): Point | null => {
      if (!photo) return { x: v.x + 2, y: v.y + 2 };
      const q = p.alignment.h ? project(p.alignment.h, v) : null;
      return q ? { x: q.x * w, y: q.y * h } : null;
    };
    const fromImage = (v: Point): Point | null =>
      photo
        ? { x: v.x * w, y: v.y * h }
        : p.alignment.inverse
          ? mapped(project(p.alignment.inverse, v) ?? { x: -999, y: -999 })
          : null;
    const points = (v: Point[], floor = true) =>
      v
        .map((q) => (floor ? mapped(q) : fromImage(q)))
        .filter((q): q is Point => !!q)
        .map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)}`)
        .join(" ");
    const regions = regionPolygons(),
      r = 3.3 * unit;
    const coverageVertices = p.alignment.hull.map(mapped);
    const coverage =
      p.measurementCoverage &&
      p.alignment.h &&
      p.alignment.inverse &&
      coverageVertices.length >= 3 &&
      coverageVertices.every((v) => v !== null)
        ? coverageVertices
            .map((v) => `${v!.x.toFixed(3)},${v!.y.toFixed(3)}`)
            .join(" ")
        : null;
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={
          photo
            ? "Basketball photograph with editable floor contacts and landmarks"
            : "NBA half-court with projected floor contacts"
        }
        tabIndex={p.editing ? 0 : undefined}
        onPointerDown={p.onPointerDown}
        onPointerMove={p.onPointerMove}
        onPointerUp={p.onPointerUp}
        onPointerCancel={p.onPointerCancel}
        onPointerLeave={p.onPointerLeave}
        onKeyDown={p.onKeyDown}
        style={{
          touchAction: p.editing ? "none" : undefined,
          display: "block",
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        <defs>
          <clipPath id={`ff-clip-${p.view}`}>
            <rect width={w} height={h} />
          </clipPath>
        </defs>
        <g clipPath={`url(#ff-clip-${p.view})`}>
          <rect width={w} height={h} fill={colors.ink} />
          {photo && p.imageUrl ? (
            <image
              href={p.imageUrl}
              width={w}
              height={h}
              preserveAspectRatio="none"
            />
          ) : null}
          {coverage ? (
            <g
              data-measurement-coverage
              aria-label="Measurement coverage boundary"
              pointerEvents="none"
              strokeLinejoin="round"
              strokeDasharray={`${5 * unit} ${4 * unit}`}
              fill="none"
            >
              <title>Floor region supported by accepted landmarks</title>
              <polygon
                points={coverage}
                stroke={colors.ink}
                strokeWidth={3.5 * unit}
              />
              <polygon
                points={coverage}
                stroke={colors.blue}
                strokeWidth={1.8 * unit}
              />
            </g>
          ) : null}
          {!photo || p.alignment.h ? (
            <g strokeLinejoin="round">
              {p.project.regions.paint ? (
                <polygon
                  points={points(regions.paint)}
                  fill={colors.orange}
                  fillOpacity=".2"
                />
              ) : null}
              {p.project.regions.corners
                ? regions.corners.map((r, i) => (
                    <polygon
                      key={i}
                      points={points(r)}
                      fill={colors.blue}
                      fillOpacity=".22"
                    />
                  ))
                : null}
              {p.project.regions.restricted ? (
                <polygon
                  points={points(regions.restricted)}
                  fill={colors.orange}
                  fillOpacity=".3"
                />
              ) : null}
              {!photo || p.check
                ? courtLines().map((line, i) => (
                    <polyline
                      key={i}
                      points={points(line)}
                      fill="none"
                      stroke={photo ? "#67e9c0" : colors.line}
                      strokeWidth={photo ? 1.1 * unit : 0.1}
                      strokeOpacity={photo ? 0.9 : 0.75}
                    />
                  ))
                : null}
              {!photo ? (
                <>
                  <path d="M24 6H30" stroke={colors.line} strokeWidth=".2" />
                  <circle
                    cx="27"
                    cy="7.25"
                    r=".75"
                    fill="none"
                    stroke={colors.orange}
                    strokeWidth=".15"
                  />
                </>
              ) : null}
            </g>
          ) : null}
          {p.project.measurements.map((m) => {
            const highlighted = m.id === p.highlightedMeasurement;
            const a =
                p.project.contacts.find((c) => c.id === m.a.contactId)?.image ??
                m.a.image,
              b =
                p.project.contacts.find((c) => c.id === m.b.contactId)?.image ??
                m.b.image;
            const x = fromImage(a),
              y = fromImage(b),
              result = measure(p.project, p.alignment, m.a, m.b);
            const endpointSupport = [m.a, m.b].map((v) =>
              measurementPointSupported(p.project, p.alignment, v),
            );
            const outside = endpointSupport.includes(false);
            if (!x || !y) return null;
            const label =
              outside
                ? "Outside"
                : result.value !== undefined
                  ? `≈ ${result.value.toFixed(1)} ${p.project.units}`
                  : "Uncertain";
            return (
              <g
                key={m.id}
                data-measurement={m.id}
                data-highlighted={highlighted}
                pointerEvents="none"
              >
                <title>{outside ? "Outside supported region" : result.reason}</title>
                <line
                  x1={x.x}
                  y1={x.y}
                  x2={y.x}
                  y2={y.y}
                  stroke={colors.orange}
                  strokeWidth={(highlighted ? 3 : 1.5) * unit}
                  strokeDasharray={
                    highlighted ? undefined : `${5 * unit} ${4 * unit}`
                  }
                />
                {[x, y].map((q, i) => (
                  <circle
                    key={i}
                    cx={q.x}
                    cy={q.y}
                    r={r}
                    data-outside={endpointSupport[i] === false}
                    fill={colors.ink}
                    stroke={endpointSupport[i] === false ? "#ff8b8b" : colors.orange}
                    strokeWidth={(highlighted ? 2.5 : 1.3) * unit}
                  />
                ))}
                <rect
                  x={(x.x + y.x) / 2 - label.length * 2.9 * unit}
                  y={(x.y + y.y) / 2 - 8 * unit}
                  rx={3 * unit}
                  width={label.length * 5.8 * unit}
                  height={16 * unit}
                  fill={colors.ink}
                />
                <text
                  x={(x.x + y.x) / 2}
                  y={(x.y + y.y) / 2 + 3 * unit}
                  fill={colors.orange}
                  textAnchor="middle"
                  fontFamily="Arial,sans-serif"
                  fontSize={10 * unit}
                >
                  {label}
                </text>
              </g>
            );
          })}
          {p.project.contacts.map((c) => {
            const q = fromImage(c.image);
            if (!q) return null;
            const active = c.id === p.selected || c.id === p.hovered,
              uncertain = c.status !== "grounded";
            return (
              <g
                key={c.id}
                data-contact={c.id}
                opacity={c.status === "hidden" ? 0.65 : 1}
              >
                {photo && active && c.box ? (
                  <rect
                    x={c.box[0] * w}
                    y={c.box[1] * h}
                    width={(c.box[2] - c.box[0]) * w}
                    height={(c.box[3] - c.box[1]) * h}
                    fill="none"
                    stroke={colors.orange}
                    strokeWidth={unit}
                    strokeDasharray={`${4 * unit} ${3 * unit}`}
                  />
                ) : null}
                <circle
                  cx={q.x}
                  cy={q.y}
                  r={r * (active ? 2 : 1.5)}
                  fill={active ? colors.orange : colors.ink}
                  stroke={uncertain ? colors.muted : colors.orange}
                  strokeWidth={1.4 * unit}
                  strokeDasharray={
                    uncertain ? `${2 * unit} ${2 * unit}` : undefined
                  }
                />
                <text
                  x={q.x + 8 * unit}
                  y={q.y + 3 * unit}
                  fontSize={11 * unit}
                  fontWeight="700"
                  fill={
                    active ? "#fff" : uncertain ? colors.muted : colors.orange
                  }
                  stroke={colors.ink}
                  strokeWidth={2 * unit}
                  paintOrder="stroke"
                  fontFamily="Arial,sans-serif"
                >
                  {c.label}
                  {uncertain ? " ?" : ""}
                </text>
                <title>{`Player ${c.label} · ${c.status}`}</title>
              </g>
            );
          })}
          {p.check && photo
            ? p.project.anchors.map((a, i) => {
                const q = fromImage(a.image)!;
                return (
                  <g
                    key={a.id}
                    data-anchor={a.id}
                    opacity={a.enabled ? 1 : 0.45}
                  >
                    <circle
                      cx={q.x}
                      cy={q.y}
                      r={r * (a.id === p.selected ? 2 : 1.4)}
                      stroke={
                        p.alignment.rejected.includes(a.id)
                          ? "#ff8b8b"
                          : "#67e9c0"
                      }
                      strokeWidth={1.3 * unit}
                      fill={colors.ink}
                    />
                    <text
                      x={q.x + 7 * unit}
                      y={q.y - 5 * unit}
                      fill="#b8ffe8"
                      stroke={colors.ink}
                      strokeWidth={2 * unit}
                      paintOrder="stroke"
                      fontSize={10 * unit}
                      fontFamily="Arial,sans-serif"
                    >
                      L{i + 1}
                    </text>
                    <title>
                      {LANDMARKS.find((l) => l.id === a.landmark)?.label ??
                        a.landmark}
                    </title>
                  </g>
                );
              })
            : null}
          {p.cursor
            ? (() => {
                const q = fromImage(p.cursor!);
                return q ? (
                  <g pointerEvents="none" stroke="white" strokeWidth={unit}>
                    <path
                      d={`M${q.x - 6 * unit} ${q.y}h${12 * unit}M${q.x} ${q.y - 6 * unit}v${12 * unit}`}
                    />
                    <circle cx={q.x} cy={q.y} r={4 * unit} fill="none" />
                  </g>
                ) : null;
              })()
            : null}
          {p.pending
            ? (() => {
                const q = fromImage(p.pending!);
                return q ? (
                  <circle
                    cx={q.x}
                    cy={q.y}
                    r={7 * unit}
                    fill="none"
                    stroke={
                      measurementPointSupported(p.project, p.alignment, {
                        image: p.pending!,
                      }) === false
                        ? "#ff8b8b"
                        : colors.orange
                    }
                    strokeWidth={unit}
                  />
                ) : null;
              })()
            : null}
        </g>
      </svg>
    );
  },
);
