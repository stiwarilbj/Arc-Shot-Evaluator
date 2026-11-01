import { useEffect, useRef, useState, type RefObject } from "react";
import type { Framing } from "./editProject";
import { framingRect, panFraming } from "./framingGeometry";

/** Source-space guide only; no overlay pixels enter the video renderer. */
export default function FramingPreview({
  canvas,
  dimensions,
  framing,
  endpoint,
  identity,
  visible,
  onMove,
  onStart,
  onEnd,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  dimensions: { width: number; height: number };
  framing: Framing;
  endpoint: "Start" | "End";
  identity: string;
  visible: boolean;
  onMove: (framing: Framing) => void;
  onStart: () => void;
  onEnd: () => void;
}) {
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const callbacks = useRef({ onMove, onEnd });
  callbacks.current = { onMove, onEnd };
  const drag = useRef<{
    pointer: number;
    node: HTMLButtonElement;
    x: number;
    y: number;
    width: number;
    height: number;
    framing: Framing;
  } | null>(null);
  const keyboard = useRef(false);
  function finish() {
    const current = drag.current,
      owned = !!current || keyboard.current;
    drag.current = null;
    keyboard.current = false;
    if (current?.node.hasPointerCapture(current.pointer))
      current.node.releasePointerCapture(current.pointer);
    if (owned) callbacks.current.onEnd();
  }
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const measure = () => {
      finish();
      const r = node.getBoundingClientRect();
      setBounds({ width: r.width, height: r.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [canvas, dimensions]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) finish();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("blur", finish);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      finish();
      window.removeEventListener("blur", finish);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [visible, identity]);
  function move(pointer: number, x: number, y: number) {
    const current = drag.current;
    if (!current || current.pointer !== pointer) return;
    callbacks.current.onMove(
      panFraming(
        current.framing,
        (x - current.x) / current.width,
        (y - current.y) / current.height,
      ),
    );
  }
  if (!visible || !dimensions.width || !bounds.width) return null;
  const scale = Math.min(
    bounds.width / dimensions.width,
    bounds.height / dimensions.height,
  );
  const width = dimensions.width * scale,
    height = dimensions.height * scale;
  const crop = framingRect(framing);
  return (
    <div
      className="jumper-framing-layer"
      style={{
        left: (bounds.width - width) / 2,
        top: (bounds.height - height) / 2,
        width,
        height,
      }}
    >
      <button
        type="button"
        className="jumper-framing-rectangle"
        aria-label={`Move ${endpoint.toLowerCase()} framing`}
        aria-disabled={framing.zoom === 1}
        title="Drag to pan; arrow keys move 1%, Shift moves 10%"
        style={{
          left: `${crop.left * 100}%`,
          top: `${crop.top * 100}%`,
          width: `${crop.width * 100}%`,
          height: `${crop.height * 100}%`,
        }}
        onPointerDown={(event) => {
          if (
            drag.current ||
            keyboard.current ||
            framing.zoom === 1 ||
            event.button !== 0 ||
            !event.isPrimary
          )
            return;
          drag.current = {
            pointer: event.pointerId,
            node: event.currentTarget,
            x: event.clientX,
            y: event.clientY,
            width,
            height,
            framing: { ...framing },
          };
          onStart();
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          event.preventDefault();
        }}
        onPointerMove={(event) =>
          move(event.pointerId, event.clientX, event.clientY)
        }
        onPointerUp={(event) => {
          if (drag.current?.pointer === event.pointerId) {
            move(event.pointerId, event.clientX, event.clientY);
            finish();
          }
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointer === event.pointerId) finish();
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointer === event.pointerId) finish();
        }}
        onKeyDown={(event) => {
          if (
            drag.current ||
            framing.zoom === 1 ||
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          )
            return;
          event.preventDefault();
          if (!keyboard.current) {
            keyboard.current = true;
            onStart();
          }
          const step = event.shiftKey ? 0.1 : 0.01;
          const clamp = (v: number) => Math.max(0, Math.min(1, v));
          onMove({
            ...framing,
            x: clamp(
              framing.x +
                (event.key === "ArrowRight"
                  ? step
                  : event.key === "ArrowLeft"
                    ? -step
                    : 0),
            ),
            y: clamp(
              framing.y +
                (event.key === "ArrowDown"
                  ? step
                  : event.key === "ArrowUp"
                    ? -step
                    : 0),
            ),
          });
        }}
        onKeyUp={(event) => {
          if (event.key.startsWith("Arrow")) finish();
        }}
        onBlur={() => {
          if (keyboard.current) finish();
        }}
      >
        <span>
          {endpoint} framing · {framing.zoom.toFixed(2)}×
        </span>
      </button>
    </div>
  );
}
