// Keep geometry and acceptance gates equivalent to backend/jumper/small_player.py.
// Crops refine visible surfaces only. They never enter tracking memory.
import type { PointPrompt } from "./domain.ts";

export interface PlayerCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  box: number[];
  points: number[][];
  labels: number[];
  unusable: boolean;
  padding?: number[]; // left/top/right/bottom outside the visible image, never output pixels
}

export function smallPlayerCrop(
  values: Float32Array,
  width: number,
  height: number,
  prompt?: PointPrompt,
): PlayerCrop | undefined {
  let left = width,
    top = height,
    right = 0,
    bottom = 0,
    area = 0;
  for (let i = 0; i < values.length; i++)
    if (values[i] > 0) {
      const x = i % width,
        y = Math.floor(i / width);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
      area++;
    }
  const boundary = left === 0 || top === 0 || right === width || bottom === height;
  const small = area <= width*height*.015 && bottom-top <= height*.4 && right-left <= width*.2;
  const boundedEdge = boundary && area <= width*height*.35 && bottom-top <= height*.95 && right-left <= width*.85;
  if (!area || (!small && !boundedEdge)) return;
  const pad = Math.max(8, Math.min(boundary ? 32 : Infinity, Math.ceil((bottom-top)*.5)));
  const x = Math.max(0, left - pad),
    y = Math.max(0, top - pad);
  const w = Math.min(width, right + pad) - x,
    h = Math.min(height, bottom + pad) - y;
  const points: number[][] = [],
    labels: number[] = [];
  // Current-frame interior evidence across the body, never extrapolated joints.
  for (let part = 0; part < 3; part++) {
    let best = -Infinity,
      at = -1;
    for (
      let py = top + Math.floor(((bottom - top) * part) / 3);
      py < top + Math.floor(((bottom - top) * (part + 1)) / 3);
      py++
    )
      for (let px = left; px < right; px++) {
        const i = py * width + px;
        if (values[i] > 0 && values[i] > best) {
          best = values[i];
          at = i;
        }
      }
    if (at >= 0) {
      points.push([
        ((at % width) + 0.5 - x) / w,
        (Math.floor(at / width) + 0.5 - y) / h,
      ]);
      labels.push(1);
    }
  }
  let unusable = area < 12 || bottom - top < 6 || right - left < 3;
  for (let i = 0; i < (prompt?.points?.length ?? 0); i++) {
    const p = prompt!.points![i],
      px = p[0] * width - x,
      py = p[1] * height - y;
    if (px >= 0 && py >= 0 && px <= w && py <= h) {
      points.push([px / w, py / h]);
      labels.push(prompt!.labels![i]);
    } else if (prompt!.labels![i] === 1) unusable = true;
  }
  return {
    x,
    y,
    width: w,
    height: h,
    box: [
      Math.max(0, left - x - 2) / w,
      Math.max(0, top - y - 2) / h,
      Math.min(w, right - x + 2) / w,
      Math.min(h, bottom - y + 2) / h,
    ],
    points,
    labels,
    unusable,
    padding: [Math.max(0,pad-left),Math.max(0,pad-top),
      Math.max(0,right+pad-width),Math.max(0,bottom+pad-height)],
  };
}

export function sourceCrop(
  crop: PlayerCrop,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
) {
  const x = Math.floor((crop.x * sourceWidth) / width),
    y = Math.floor((crop.y * sourceHeight) / height);
  return {
    x,
    y,
    width: Math.ceil(((crop.x + crop.width) * sourceWidth) / width) - x,
    height: Math.ceil(((crop.y + crop.height) * sourceHeight) / height) - y,
  };
}

/** Visible source rectangle plus a bounded neutral margin outside the actual frame. */
export function paddedSourceCrop(crop: PlayerCrop, width: number, height: number, sourceWidth: number, sourceHeight: number) {
  const region = sourceCrop(crop,width,height,sourceWidth,sourceHeight);
  const padding = (crop.padding ?? [0,0,0,0]).map((n,i) => Math.ceil(n*(i%2 ? sourceHeight/height : sourceWidth/width)));
  return {...region, left:padding[0], top:padding[1],
    inputWidth:region.width+padding[0]+padding[2], inputHeight:region.height+padding[1]+padding[3]};
}

/** Map prompts through the actual integer source crop, including its rounded edges. */
export function sourceCropPrompt(crop: PlayerCrop, width: number, height: number, sourceWidth: number, sourceHeight: number) {
  const region = paddedSourceCrop(crop, width, height, sourceWidth, sourceHeight);
  const point = (x: number, y: number) => [
    ((crop.x + x * crop.width) * sourceWidth / width - region.x + region.left) / region.inputWidth,
    ((crop.y + y * crop.height) * sourceHeight / height - region.y + region.top) / region.inputHeight,
  ];
  return { points: crop.points.map(([x, y]) => point(x, y)), labels: crop.labels,
    box: [...point(crop.box[0], crop.box[1]), ...point(crop.box[2], crop.box[3])] };
}

/** Sample crop logits at coarse pixel centers; do not stretch rounded margins. */
export function projectRefinement(values: Float32Array, crop: PlayerCrop, width: number, height: number, sourceWidth: number, sourceHeight: number) {
  const region = paddedSourceCrop(crop, width, height, sourceWidth, sourceHeight);
  const result = new Float32Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++) {
    const fy = Math.max(0, Math.min(255, (((crop.y + y + .5) * sourceHeight / height - region.y + region.top) / region.inputHeight) * 256 - .5));
    const y0 = Math.floor(fy), y1 = Math.min(255, y0 + 1), dy = fy - y0;
    for (let x = 0; x < crop.width; x++) {
      const fx = Math.max(0, Math.min(255, (((crop.x + x + .5) * sourceWidth / width - region.x + region.left) / region.inputWidth) * 256 - .5));
      const x0 = Math.floor(fx), x1 = Math.min(255, x0 + 1), dx = fx - x0;
      result[y * crop.width + x] =
        (values[y0 * 256 + x0] * (1 - dx) + values[y0 * 256 + x1] * dx) * (1 - dy) +
        (values[y1 * 256 + x0] * (1 - dx) + values[y1 * 256 + x1] * dx) * dy;
    }
  }
  return result;
}

/** Refuse identity/occlusion changes and crop-edge leaks; keep coarse scores on refusal. */
export function acceptRefinement(
  coarse: Float32Array,
  cropValues: Float32Array,
  crop: PlayerCrop,
  width: number,
  height: number,
  owners: Uint8Array,
  id: number,
) {
  let original = 0,
    refined = 0,
    intersection = 0,
    blocked = 0,
    occluded = 0,
    leaked = false,
    lostVisibleEdge = false;
  for (let y = 0; y < crop.height; y++)
    for (let x = 0; x < crop.width; x++) {
      const at = (crop.y + y) * width + crop.x + x,
        a = coarse[at] > 0,
        b = cropValues[y * crop.width + x] > 0;
      if (a) {
        if (!b && ((crop.x+x===0) || (crop.y+y===0) ||
          (crop.x+x===width-1) || (crop.y+y===height-1))) lostVisibleEdge = true;
        original++;
        if (owners[at] && owners[at] !== id) occluded++;
      }
      if (b) {
        refined++;
        if (a) intersection++;
        if (!a && owners[at] && owners[at] !== id) blocked++;
        if (
          (x === 0 && crop.x > 0) ||
          (y === 0 && crop.y > 0) ||
          (x === crop.width - 1 && crop.x + crop.width < width) ||
          (y === crop.height - 1 && crop.y + crop.height < height)
        )
          leaked = true;
      }
    }
  const union = original + refined - intersection;
  if (
    !refined ||
    !union ||
    intersection / union < 0.6 ||
    refined < original * 0.65 ||
    refined > original * 1.6 ||
    blocked > Math.max(2, refined * 0.03) ||
    occluded > Math.max(2, original * 0.03) ||
    leaked || lostVisibleEdge ||
    !cropValues.every(Number.isFinite)
  )
    return;
  const result = coarse.slice();
  for (let y = 0; y < crop.height; y++)
    for (let x = 0; x < crop.width; x++) {
      const at = (crop.y + y) * width + crop.x + x,
        value = cropValues[y * crop.width + x];
      // Never add a surface already attributed to another person. Preserve the
      // original overlap scores so independent crop logits cannot win an occlusion.
      result[at] = owners[at] && owners[at] !== id ? coarse[at] : value;
    }
  return result;
}
