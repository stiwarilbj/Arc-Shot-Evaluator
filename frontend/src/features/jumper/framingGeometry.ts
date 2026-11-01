import type { Framing } from "./editProject";

/** Normalized source crop; shared by the guide and finished-video renderer. */
export function framingRect({ zoom, x, y }: Framing) {
  const size = 1 / zoom;
  return {
    left: x * (1 - size),
    top: y * (1 - size),
    width: size,
    height: size,
  };
}

export function panFraming(framing: Framing, dx: number, dy: number) {
  const travel = 1 - 1 / framing.zoom;
  if (travel === 0) return { ...framing };
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return {
    ...framing,
    x: clamp(framing.x + dx / travel),
    y: clamp(framing.y + dy / travel),
  };
}
