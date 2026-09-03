import { corexyInv } from "./scene";

export interface PathSeg {
  a: [number, number];
  b: [number, number];
  /** True for a burning move — G1 with the beam actually on. */
  cut: boolean;
}

const WORD = /[A-Z]-?\d*\.?\d+/g;

/**
 * Parse generated G-code back into drawable segments.
 *
 * Only the subset FluidBurn emits is handled, but modally: raster rows send
 * bare `G1 X… S…` lines that inherit both the motion mode and Y from the
 * previous line. When the machine is CoreXY the emitted words are motor
 * coordinates, so they get mapped back to cartesian for display.
 */
export function parseToolpath(gcode: string, corexy: boolean): PathSeg[] {
  const segs: PathSeg[] = [];
  let mode = 0; // modal motion: 0 = rapid, 1 = feed
  let x = 0;
  let y = 0;
  let s = 0;

  for (const raw of gcode.split("\n")) {
    const line = raw.split(";")[0].trim().toUpperCase();
    if (!line) continue;

    let nx = x;
    let ny = y;
    let moved = false;

    for (const w of line.match(WORD) ?? []) {
      const v = Number(w.slice(1));
      if (Number.isNaN(v)) continue;
      switch (w[0]) {
        case "G":
          if (v === 0) mode = 0;
          else if (v === 1) mode = 1;
          break;
        case "X":
          nx = v;
          moved = true;
          break;
        case "Y":
          ny = v;
          moved = true;
          break;
        case "S":
          s = v;
          break;
        case "M":
          // M5 parks the beam; S0 on the same line covers it too, but a bare
          // M5 has to count.
          if (v === 5) s = 0;
          break;
      }
    }

    if (!moved) continue;
    const map = (p: [number, number]): [number, number] =>
      corexy ? corexyInv(p) : p;
    segs.push({ a: map([x, y]), b: map([nx, ny]), cut: mode === 1 && s > 0 });
    x = nx;
    y = ny;
  }
  return segs;
}
