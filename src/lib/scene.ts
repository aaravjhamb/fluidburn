import type { SceneObject as ImportedObject } from "./ipc";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneObj {
  id: string;
  layerId: string;
  raster: boolean;
  base: number[][][];
  obb: Box;
  box: Box;

  rot: number;
}

export function boxCenter(b: Box): [number, number] {
  return [b.x + b.w / 2, b.y + b.h / 2];
}

export function rotatePoint(
  p: [number, number],
  c: [number, number],
  ang: number,
): [number, number] {
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
}

export function bbox(polys: number[][][]): Box {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const poly of polys)
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function fromImported(o: ImportedObject): SceneObj {
  const b = bbox(o.polylines);
  return {
    id: o.id,
    layerId: o.layerId,
    raster: o.raster,
    base: o.polylines,
    obb: b,
    box: { ...b },
    rot: 0,
  };
}

export function toWorld(o: SceneObj): number[][][] {
  const sx = o.obb.w !== 0 ? o.box.w / o.obb.w : 1;
  const sy = o.obb.h !== 0 ? o.box.h / o.obb.h : 1;
  const [cx, cy] = boxCenter(o.box);
  const cos = Math.cos(o.rot);
  const sin = Math.sin(o.rot);
  return o.base.map((poly) =>
    poly.map(([x, y]) => {
      const wx = o.box.x + (x - o.obb.x) * sx;
      const wy = o.box.y + (y - o.obb.y) * sy;
      if (o.rot === 0) return [wx, wy];
      const dx = wx - cx;
      const dy = wy - cy;
      return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
    }),
  );
}

export function selectionBounds(objs: SceneObj[]): Box | null {
  if (objs.length === 0) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const o of objs) {
    minX = Math.min(minX, o.box.x);
    minY = Math.min(minY, o.box.y);
    maxX = Math.max(maxX, o.box.x + o.box.w);
    maxY = Math.max(maxY, o.box.y + o.box.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function boxContains(b: Box, px: number, py: number, pad = 0): boolean {
  return (
    px >= b.x - pad &&
    px <= b.x + b.w + pad &&
    py >= b.y - pad &&
    py <= b.y + b.h + pad
  );
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return !(
    a.x + a.w < b.x ||
    b.x + b.w < a.x ||
    a.y + a.h < b.y ||
    b.y + b.h < a.y
  );
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export function resizeBox(
  b: Box,
  handle: Handle,
  mx: number,
  my: number,
  uniform: boolean,
): Box {
  let { x, y, w, h } = b;
  const right = x + w;
  const top = y + h;
  const movesLeft = handle.includes("w");
  const movesRight = handle.includes("e");
  const movesBottom = handle.includes("s");
  const movesTop = handle.includes("n");

  if (movesLeft) {
    x = Math.min(mx, right - 1);
    w = right - x;
  } else if (movesRight) {
    w = Math.max(1, mx - x);
  }
  if (movesBottom) {
    y = Math.min(my, top - 1);
    h = top - y;
  } else if (movesTop) {
    h = Math.max(1, my - y);
  }

  if (uniform && b.w > 0 && b.h > 0) {

    const rw = w / b.w;
    const rh = h / b.h;
    const r = Math.max(rw, rh);
    const nw = b.w * r;
    const nh = b.h * r;
    if (movesLeft) x = right - nw;
    if (movesBottom) y = top - nh;
    w = nw;
    h = nh;
  }
  return { x, y, w, h };
}
