import { useEffect, useRef } from "react";

export default function SelectionMagnifier({
  src,
  cursor,
}: {
  src: string;
  cursor: number[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLImageElement | null>(null);
  const position = useRef(cursor);
  position.current = cursor;
  function draw() {
    const ctx = canvas.current?.getContext("2d"),
      image = source.current;
    if (!ctx || !image) return;
    const size = Math.max(24, image.naturalWidth / 5);
    ctx.fillStyle = "#e0e0e0";
    ctx.fillRect(0, 0, 180, 180);
    ctx.drawImage(
      image,
      position.current[0] * image.naturalWidth - size / 2,
      position.current[1] * image.naturalHeight - size / 2,
      size,
      size,
      0,
      0,
      180,
      180,
    );
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 4;
    for (const color of ["#000", "#fff"]) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(78, 90);
      ctx.lineTo(102, 90);
      ctx.moveTo(90, 78);
      ctx.lineTo(90, 102);
      ctx.stroke();
      ctx.lineWidth = 2;
    }
  }
  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    source.current = null;
    image.onload = () => {
      if (!cancelled) {
        source.current = image;
        draw();
      }
    };
    image.src = src;
    return () => {
      cancelled = true;
      source.current = null;
    };
  }, [src]);
  useEffect(draw, [cursor]);
  return (
    <div className="jumper-magnifier">
      <canvas
        ref={canvas}
        width={180}
        height={180}
        aria-label="Magnified selection cursor"
      />
      <span>Magnified selection</span>
    </div>
  );
}
