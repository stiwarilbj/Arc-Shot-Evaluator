import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  captionLayout,
  captionPositions,
  snapCaptionPosition,
} from "./captionLayout";
import type { Caption } from "./editProject";

/** Editing affordances only. Exports continue to use drawEdit, without this layer. */
export default function CaptionPreview({
  canvas,
  dimensions,
  captions,
  frame,
  visible,
  selected,
  onSelect,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  dimensions: { width: number; height: number };
  captions: Caption[];
  frame: number;
  visible: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, position: Caption["position"]) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState<string | null>(null);
  const callbacks = useRef({ onMove, onDragEnd });
  callbacks.current = { onMove, onDragEnd };
  const drag = useRef<{
    id: string;
    pointer: number;
    node: HTMLButtonElement;
    startY: number;
    center: number;
    scale: number;
    centers: Record<Caption["position"], number>;
    moved: boolean;
  } | null>(null);
  function finish() {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    setDragging(null);
    if (current.node.hasPointerCapture(current.pointer))
      current.node.releasePointerCapture(current.pointer);
    callbacks.current.onDragEnd();
  }
  useEffect(() => {
    if (
      drag.current &&
      !captions.some((caption) => caption.id === drag.current?.id)
    )
      finish();
  }, [captions]);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const measure = () => {
      finish();
      const bounds = node.getBoundingClientRect();
      setBox({ width: bounds.width, height: bounds.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [canvas, dimensions]);
  useEffect(() => {
    if (!visible) finish();
    const hidden = () => {
      if (document.hidden) finish();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) {
        event.preventDefault();
        finish();
      }
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
  }, [visible, frame]);
  const layouts = useMemo(() => {
    if (!dimensions.width || !dimensions.height) return [];
    const context = document.createElement("canvas").getContext("2d");
    return context
      ? captions.map((caption) => ({
          caption,
          layout: captionLayout(
            context,
            dimensions.width,
            dimensions.height,
            caption,
          ),
        }))
      : [];
  }, [captions, dimensions]);
  if (!visible || !dimensions.width || !box.width) return null;
  const scale = Math.min(
    box.width / dimensions.width,
    box.height / dimensions.height,
  );
  const width = dimensions.width * scale,
    height = dimensions.height * scale;
  const moving = layouts.find(({ caption }) => caption.id === dragging);
  const chosen = layouts.find(({ caption }) => caption.id === selected);
  function move(clientY: number) {
    const current = drag.current;
    if (!current) return;
    if (Math.abs(clientY - current.startY) >= 4) current.moved = true;
    if (!current.moved) return;
    callbacks.current.onMove(
      current.id,
      snapCaptionPosition(
        current.center + (clientY - current.startY) / current.scale,
        current.centers,
      ),
    );
  }
  return (
    <div
      className="jumper-caption-layer"
      style={{
        left: (box.width - width) / 2,
        top: (box.height - height) / 2,
        width,
        height,
      }}
    >
      {chosen ? (
        <div
          className={`jumper-caption-safe${chosen.layout.fits ? "" : " is-overflow"}`}
          role="img"
          aria-label="Caption-safe area"
          style={{
            left: chosen.layout.safe.x * scale,
            top: chosen.layout.safe.y * scale,
            width: chosen.layout.safe.width * scale,
            height: chosen.layout.safe.height * scale,
          }}
        ></div>
      ) : null}
      {moving ? (
        <div className="jumper-caption-guides" aria-hidden="true">
          {captionPositions.map((position) => (
            <div
              key={position}
              className={
                moving.caption.position === position ? "is-snapped" : ""
              }
              style={{ top: moving.layout.centers[position] * scale }}
            >
              <span>{position}</span>
            </div>
          ))}
        </div>
      ) : null}
      {layouts
        .filter(({ caption }) => frame >= caption.start && frame < caption.end)
        .map(({ caption, layout }) => (
          <button
            key={caption.id}
            type="button"
            className="jumper-caption-hit"
            aria-label={`Edit caption: ${caption.text}`}
            aria-pressed={selected === caption.id}
            title="Select caption; drag to top, center, or bottom"
            style={{
              left: layout.x * scale,
              top: Math.max(layout.safe.y, layout.y) * scale,
              width: layout.width * scale,
              height: Math.min(layout.boxHeight, layout.safe.height) * scale,
            }}
            onClick={() => {
              if (!drag.current) onSelect(caption.id);
            }}
            onPointerDown={(event) => {
              if (drag.current || event.button !== 0 || !event.isPrimary)
                return;
              event.preventDefault();
              onSelect(caption.id);
              drag.current = {
                id: caption.id,
                pointer: event.pointerId,
                node: event.currentTarget,
                startY: event.clientY,
                center: layout.cy,
                centers: layout.centers,
                scale,
                moved: false,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(caption.id);
              onDragStart();
            }}
            onPointerMove={(event) => {
              if (event.pointerId === drag.current?.pointer)
                move(event.clientY);
            }}
            onPointerUp={(event) => {
              if (event.pointerId === drag.current?.pointer) {
                move(event.clientY);
                finish();
              }
            }}
            onPointerCancel={(event) => {
              if (event.pointerId === drag.current?.pointer) finish();
            }}
            onLostPointerCapture={(event) => {
              if (event.pointerId === drag.current?.pointer) finish();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                finish();
              }
            }}
          />
        ))}
    </div>
  );
}
