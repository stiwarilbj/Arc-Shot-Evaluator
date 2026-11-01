"""Read-only outline/fragment diagnostics, equivalent to maskOutline.ts."""
import math
import cv2
import numpy as np


def components(mask):
    # SAUF keeps row-major labels, matching the browser flood fill on ties.
    _, labels, stats, _ = cv2.connectedComponentsWithStatsWithAlgorithm(
        mask, 8, cv2.CV_32S, cv2.CCL_WU)
    main = int(np.argmax(stats[1:, cv2.CC_STAT_AREA]) + 1) if len(stats) > 1 else 0
    return labels, stats, main


def outline_changes(previous, current, identity, a, b):
    height, width = current.shape
    # Match JS rounding, including negative translations at half pixels.
    rounded = lambda v: math.floor(v + .5)
    dx, dy = rounded((b["x"]-a["x"])*width), rounded((b["y"]-a["y"])*height)
    left = min(rounded(a["bounds"][0]*width), rounded(b["bounds"][0]*width)-dx)
    top = min(rounded(a["bounds"][1]*height), rounded(b["bounds"][1]*height)-dy)
    right = max(rounded(a["bounds"][2]*width), rounded(b["bounds"][2]*width)-dx)
    bottom = max(rounded(a["bounds"][3]*height), rounded(b["bounds"][3]*height)-dy)
    w, h = right-left, bottom-top
    old, now = np.zeros((h, w), np.uint8), np.zeros((h, w), np.uint8)
    for mask, source, sx, sy in ((old, previous, left, top), (now, current, left+dx, top+dy)):
        x1, y1, x2, y2 = max(0, sx), max(0, sy), min(width, sx+w), min(height, sy+h)
        if x2 > x1 and y2 > y1:
            mask[y1-sy:y2-sy, x1-sx:x2-sx] = source[y1:y2, x1:x2] == identity
    yy,xx=np.indices((h,w))
    px,py=xx+left,yy+top
    common=(px>=0)&(px<width)&(py>=0)&(py<height)&(px+dx>=0)&(px+dx<width)&(py+dy>=0)&(py+dy<height)
    old[~common]=0;now[~common]=0
    image_edge=(px==0)|(py==0)|(px==width-1)|(py==height-1)|(px+dx==0)|(py+dy==0)|(px+dx==width-1)|(py+dy==height-1)
    before, _, before_main = components(old)
    after, stats, after_main = components(now)
    minimum = max(4, math.ceil(min(a["area"], b["area"]) * .005))
    fragmented = False
    for label in range(1, len(stats)):
        x, y, bw, bh, area = stats[label]
        if label == after_main or area < minimum or max(bw, bh) < 3:
            continue
        piece = after[y:y+bh, x:x+bw] == label
        overlap = np.count_nonzero(old[y:y+bh, x:x+bw][piece])
        main_overlap = np.count_nonzero(before[y:y+bh, x:x+bw][piece] == before_main)
        cropped=np.any(image_edge[y:y+bh,x:x+bw][piece])
        if not cropped and (main_overlap >= area * .5 or overlap < area * .25):
            fragmented = True
    body_height = max((a["bounds"][3]-a["bounds"][1])*height, (b["bounds"][3]-b["bounds"][1])*height)
    tolerance = max(1, min(4, rounded(body_height * .02)))
    kernel = np.ones((tolerance*2+1, tolerance*2+1), np.uint8)
    old_near, now_near = cv2.dilate(old, kernel), cv2.dilate(now, kernel)
    lost = (old.astype(bool) & ~now_near.astype(bool)).astype(np.uint8)
    gained = (now.astype(bool) & ~old_near.astype(bool)).astype(np.uint8)
    reach, length = max(3, math.ceil(body_height * .2)), max(3, math.ceil(body_height * .08))

    def unmatched(changed, opposite):
        _, regions, _ = components(changed)
        for x, y, bw, bh, area in regions[1:]:
            if area < minimum or max(bw, bh) < length:
                continue
            nearby = np.count_nonzero(opposite[max(0,y-reach):min(h,y+bh+reach), max(0,x-reach):min(w,x+bw+reach)])
            if nearby < area * .6:
                return True
        return False

    return dict(outline=unmatched(lost, gained) or unmatched(gained, lost), fragmented=fragmented)
