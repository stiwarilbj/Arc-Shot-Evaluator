import { useEffect, useRef, useState } from "react";
import { Magnet } from "lucide-react";
import type { Caption } from "./editProject";
import {
  shiftCaption,
  alignCaption,
  captionSnapTargets,
  type CaptionPart,
  type CaptionSnapTarget,
  type CaptionSnapGuide,
} from "./captionTiming";

const seconds = (frame: number) => `${(frame / 30).toFixed(2)}s`;

export default function CaptionTimeline({
  captions,
  frames,
  frame,
  cuts,
  selected,
  enabled,
  onSelect,
  onChange,
  onStart,
  onEnd,
}: {
  captions: Caption[];
  frames: number;
  frame: number;
  cuts: number[];
  selected: string | null;
  enabled: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, interval: { start: number; end: number }) => void;
  onStart: () => void;
  onEnd: () => void;
}) {
  const [magnet, setMagnet] = useState(true);
  const [guide, setGuide] = useState<
    (CaptionSnapGuide & { captionId: string }) | null
  >(null);
  const drag = useRef<{
    caption: Caption;
    part: CaptionPart;
    pointer: number;
    x: number;
    scale: number;
    node: HTMLElement;
    targets: CaptionSnapTarget[];
    moved: boolean;
  } | null>(null);
  const keyboard = useRef<HTMLElement | null>(null);
  const callbacks = useRef({ onChange, onEnd });
  callbacks.current = { onChange, onEnd };
  function finish() {
    const current = drag.current;
    const owned = !!current || !!keyboard.current;
    drag.current = null;
    keyboard.current = null;
    setGuide(null);
    if (current?.node.hasPointerCapture(current.pointer))
      current.node.releasePointerCapture(current.pointer);
    if (owned) callbacks.current.onEnd();
  }
  useEffect(() => {
    if (!enabled) finish();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    const hidden = () => {
      if (document.hidden) finish();
    };
    window.addEventListener("blur", finish);
    window.addEventListener("resize", finish);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      finish();
      window.removeEventListener("blur", finish);
      window.removeEventListener("resize", finish);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [enabled, frames]);
  useEffect(() => {
    if (
      (drag.current &&
        !captions.some((c) => c.id === drag.current?.caption.id)) ||
      (keyboard.current && !keyboard.current.isConnected)
    )
      finish();
  }, [captions]);
  function move(pointer: number, x: number) {
    const current = drag.current;
    if (!current || current.pointer !== pointer) return;
    if (!current.moved && Math.abs(x - current.x) < 2) return;
    current.moved = true;
    const interval = shiftCaption(
      current.caption,
      current.part,
      (x - current.x) * current.scale,
      frames,
    );
    const result = magnet
      ? alignCaption(
          interval,
          current.part,
          frames,
          current.targets,
          Math.min(3, 6 * current.scale),
          Math.min(6, 12 * current.scale),
        )
      : { interval, guide: null };
    setGuide(
      result.guide ? { ...result.guide, captionId: current.caption.id } : null,
    );
    callbacks.current.onChange(current.caption.id, result.interval);
  }
  if (!captions.length) return null;
  return (
    <section className="jumper-caption-timeline" aria-label="Caption intervals">
      <div className="jumper-caption-timing-heading">
        <strong>Caption timing</strong>
        <button
          aria-label="Caption timing magnet"
          aria-pressed={magnet}
          disabled={!enabled}
          onClick={() => {
            finish();
            setMagnet((value) => !value);
          }}
        >
          <Magnet size={16} aria-hidden="true" /> Magnet {magnet ? "on" : "off"}
        </button>
      </div>
      <p className="jumper-caption">
        Drag a bar to move it; drag an edge to trim it. Arrow keys adjust one
        frame; Shift adjusts ten
      </p>
      <p className="jumper-caption jumper-caption-snap-hint" role="status">
        {guide
          ? `${guide.snapped ? "Snapped" : "Align"} ${guide.edge} → ${guide.label} · ${seconds(guide.frame)}`
          : magnet
            ? "Magnet on · drag near a cut, playhead, or caption edge"
            : "Magnet off · drag freely; timing still uses 30 fps"}
      </p>
      {captions.map((caption, index) => (
        <div
          className={`jumper-caption-lane${caption.id === selected ? " is-selected" : ""}`}
          key={caption.id}
          data-caption-id={caption.id}
        >
          <div className="jumper-caption-lane-label">
            <span>{caption.text}</span>
            <span>
              {seconds(caption.start)}–{seconds(caption.end)}
            </span>
          </div>
          <div className="jumper-caption-track">
            {guide?.captionId === caption.id ? (
              <span
                className={`jumper-caption-snap-guide${guide.snapped ? " is-snapped" : ""}`}
                style={{ left: `${(guide.frame / frames) * 100}%` }}
                data-snap-frame={guide.frame}
                aria-hidden="true"
              />
            ) : null}
            <span
              className="jumper-caption-playhead"
              style={{ left: `${(frame / frames) * 100}%` }}
              aria-hidden="true"
            />
            <div
              className="jumper-caption-interval"
              style={{
                left: `${(caption.start / frames) * 100}%`,
                width: `${((caption.end - caption.start) / frames) * 100}%`,
              }}
            >
              {(["move", "start", "end"] as const).map((part) => {
                const value = part === "end" ? caption.end : caption.start;
                const min = part === "end" ? caption.start + 1 : 0;
                const max =
                  part === "start"
                    ? caption.end - 1
                    : part === "end"
                      ? frames
                      : frames - (caption.end - caption.start);
                return (
                  <div
                    key={part}
                    role="slider"
                    tabIndex={enabled ? 0 : -1}
                    aria-disabled={!enabled}
                    aria-label={`${part === "move" ? "Move" : part === "start" ? "Start of" : "End of"} caption ${index + 1}`}
                    aria-orientation="horizontal"
                    aria-valuemin={min}
                    aria-valuemax={max}
                    aria-valuenow={value}
                    aria-valuetext={seconds(value)}
                    className={`jumper-caption-grip jumper-caption-grip-${part}`}
                    onClick={() => {
                      if (enabled && !drag.current) onSelect(caption.id);
                    }}
                    onPointerDown={(event) => {
                      if (
                        !enabled ||
                        drag.current ||
                        keyboard.current ||
                        event.button !== 0 ||
                        !event.isPrimary
                      )
                        return;
                      const track = event.currentTarget
                        .closest(".jumper-caption-track")!
                        .getBoundingClientRect();
                      onSelect(caption.id);
                      onStart();
                      drag.current = {
                        caption: { ...caption },
                        part,
                        pointer: event.pointerId,
                        x: event.clientX,
                        scale: frames / track.width,
                        node: event.currentTarget,
                        targets: captionSnapTargets(
                          captions,
                          cuts,
                          frame,
                          caption.id,
                        ),
                        moved: false,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                      event.currentTarget.focus();
                      event.preventDefault();
                    }}
                    onPointerMove={(event) =>
                      move(event.pointerId, event.clientX)
                    }
                    onPointerUp={(event) => {
                      if (drag.current?.pointer === event.pointerId) {
                        move(event.pointerId, event.clientX);
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
                        !enabled ||
                        drag.current ||
                        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          event.key,
                        )
                      )
                        return;
                      event.preventDefault();
                      if (!keyboard.current) {
                        keyboard.current = event.currentTarget;
                        onSelect(caption.id);
                        onStart();
                      }
                      const delta =
                        event.key === "Home"
                          ? min - value
                          : event.key === "End"
                            ? max - value
                            : (event.key === "ArrowLeft" ? -1 : 1) *
                              (event.shiftKey ? 10 : 1);
                      onChange(
                        caption.id,
                        shiftCaption(caption, part, delta, frames),
                      );
                    }}
                    onKeyUp={(event) => {
                      if (
                        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          event.key,
                        )
                      )
                        finish();
                    }}
                    onBlur={() => {
                      if (keyboard.current) finish();
                    }}
                  >
                    {part === "move" ? (
                      caption.text
                    ) : (
                      <span aria-hidden="true">⋮</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ))}
      <div className="jumper-caption-scale" aria-hidden="true">
        <span>0s</span>
        <span>{seconds(frames)}</span>
      </div>
    </section>
  );
}
