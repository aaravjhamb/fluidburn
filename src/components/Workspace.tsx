import { useEffect, useRef, useState, useCallback } from "react";
import { useStore } from "../state/store";
import {
  toWorld,
  selectionBounds,
  boxContains,
  boxesIntersect,
  resizeBox,
  boxCenter,
  rotatePoint,
  type Box,
  type Handle,
  type SceneObj,
} from "../lib/scene";

interface View {
  scale: number;
  ox: number;
  oy: number;
}

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_HIT = 8;

function handlePos(b: Box, h: Handle): [number, number] {
  const hx = h.includes("w") ? b.x : h.includes("e") ? b.x + b.w : b.x + b.w / 2;
  const hy = h.includes("s") ? b.y : h.includes("n") ? b.y + b.h : b.y + b.h / 2;
  return [hx, hy];
}

function oppositeAnchor(b: Box, h: Handle): [number, number] {
  const ax = h.includes("e") ? b.x : h.includes("w") ? b.x + b.w : b.x + b.w / 2;
  const ay = h.includes("n") ? b.y : h.includes("s") ? b.y + b.h : b.y + b.h / 2;
  return [ax, ay];
}

type Drag =
  | { kind: "move"; sx: number; sy: number; gx: number; gy: number; boxes: Record<string, Box> }
  | { kind: "resize1"; handle: Handle; g0: Box; rot: number; objId: string; uniform: boolean }
  | { kind: "resizeM"; handle: Handle; g0: Box; boxes: Record<string, Box> }
  | { kind: "rotate"; center: [number, number]; start: number; init: Record<string, { c: [number, number]; rot: number }> }
  | { kind: "marquee"; x0: number; y0: number }
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number };

interface Overlay {
  corners: [number, number][];
  handles: { h: Handle; p: [number, number] }[];
  rotMm: [number, number];
  nMm: [number, number];
  single: SceneObj | null;
}

export default function Workspace() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const objects = useStore((s) => s.objects);
  const layers = useStore((s) => s.layers);
  const selection = useStore((s) => s.selection);
  const setObjects = useStore((s) => s.setObjects);
  const setSelection = useStore((s) => s.setSelection);
  const deleteSelected = useStore((s) => s.deleteSelected);
  const duplicateSelected = useStore((s) => s.duplicateSelected);
  const wpos = useStore((s) => s.status.wpos);
  const machine = useStore((s) => s.activeMachine());

  const bed = { w: machine?.bedW ?? 400, h: machine?.bedH ?? 400 };

  const [view, setView] = useState<View>({ scale: 1, ox: 24, oy: 0 });
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [snap, setSnap] = useState(true);
  const [snapStep, setSnapStep] = useState(10);
  const drag = useRef<Drag | null>(null);

  const snapV = useCallback(
    (v: number) => (snap ? Math.round(v / snapStep) * snapStep : v),
    [snap, snapStep],
  );

  const layerColor = useCallback(
    (id: string) => layers.find((l) => l.id === id)?.color ?? "#5ad1ff",
    [layers],
  );
  const layerEnabled = useCallback(
    (id: string) => layers.find((l) => l.id === id)?.enabled ?? true,
    [layers],
  );

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const m = 28;
    const scale = Math.min((el.clientWidth - m * 2) / bed.w, (el.clientHeight - m * 2) / bed.h);
    setView({ scale, ox: m, oy: el.clientHeight - m });
  }, [bed.w, bed.h]);

  useEffect(() => {
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [fit]);

  const toScreen = (mx: number, my: number): [number, number] => [
    view.ox + mx * view.scale,
    view.oy - my * view.scale,
  ];
  const toMm = (sx: number, sy: number): [number, number] => [
    (sx - view.ox) / view.scale,
    (view.oy - sy) / view.scale,
  ];

  const overlay = useCallback((): Overlay | null => {
    const sel = objects.filter((o) => selection.includes(o.id));
    if (sel.length === 0) return null;
    const off = 22 / view.scale;
    if (sel.length === 1) {
      const o = sel[0];
      const c = boxCenter(o.box);
      const b = o.box;
      const corners: [number, number][] = (
        [
          [b.x, b.y],
          [b.x + b.w, b.y],
          [b.x + b.w, b.y + b.h],
          [b.x, b.y + b.h],
        ] as [number, number][]
      ).map((p) => rotatePoint(p, c, o.rot));
      const handles = HANDLES.map((h) => ({ h, p: rotatePoint(handlePos(b, h), c, o.rot) }));
      const nMm = rotatePoint([c[0], b.y + b.h], c, o.rot);
      const rotMm = rotatePoint([c[0], b.y + b.h + off], c, o.rot);
      return { corners, handles, rotMm, nMm, single: o };
    }
    const sb = selectionBounds(sel)!;
    const corners: [number, number][] = [
      [sb.x, sb.y],
      [sb.x + sb.w, sb.y],
      [sb.x + sb.w, sb.y + sb.h],
      [sb.x, sb.y + sb.h],
    ];
    const handles = HANDLES.map((h) => ({ h, p: handlePos(sb, h) }));
    return {
      corners,
      handles,
      nMm: [sb.x + sb.w / 2, sb.y + sb.h],
      rotMm: [sb.x + sb.w / 2, sb.y + sb.h + off],
      single: null,
    };
  }, [objects, selection, view.scale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const el = wrapRef.current;
    if (!canvas || !el) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = el.clientWidth,
      H = el.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const [bx, by] = toScreen(0, 0);
    const bw = bed.w * view.scale;
    const bh = bed.h * view.scale;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(bx, by - bh, bw, bh);

    const minor = niceGrid(snapStep, view.scale);
    const major = minor * 5;
    const xMin = Math.max(0, (0 - view.ox) / view.scale);
    const xMax = Math.min(bed.w, (canvas.width / dpr - view.ox) / view.scale);
    const yMin = Math.max(0, (view.oy - canvas.height / dpr) / view.scale);
    const yMax = Math.min(bed.h, view.oy / view.scale);
    const gridLines = (step: number, style: string) => {
      if (step <= 0 || step * view.scale < 2) return;
      ctx.strokeStyle = style;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = Math.ceil(xMin / step); k <= Math.floor(xMax / step); k++) {
        const [sx, sy0] = toScreen(k * step, yMin);
        const [, sy1] = toScreen(k * step, yMax);
        ctx.moveTo(sx, sy0);
        ctx.lineTo(sx, sy1);
      }
      for (let k = Math.ceil(yMin / step); k <= Math.floor(yMax / step); k++) {
        const [sx0, sy] = toScreen(xMin, k * step);
        const [sx1] = toScreen(xMax, k * step);
        ctx.moveTo(sx0, sy);
        ctx.lineTo(sx1, sy);
      }
      ctx.stroke();
    };
    gridLines(minor, "#eef1f6");
    gridLines(major, "#dde2ea");
    ctx.strokeStyle = "#c2c8d2";
    ctx.strokeRect(bx, by - bh, bw, bh);

    for (const o of objects) {
      const enabled = layerEnabled(o.layerId);
      ctx.strokeStyle = enabled ? layerColor(o.layerId) : "#b3b9c4";
      ctx.lineWidth = 1.3;
      if (o.raster) ctx.setLineDash([5, 4]);
      for (const poly of toWorld(o)) {
        if (poly.length < 2) continue;
        ctx.beginPath();
        const [px, py] = toScreen(poly[0][0], poly[0][1]);
        ctx.moveTo(px, py);
        for (let i = 1; i < poly.length; i++) {
          const [x, y] = toScreen(poly[i][0], poly[i][1]);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    const ov = overlay();
    if (ov) {
      ctx.strokeStyle = "#0a84ff";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ov.corners.forEach((c, i) => {
        const [x, y] = toScreen(c[0], c[1]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      const [nx, ny] = toScreen(ov.nMm[0], ov.nMm[1]);
      const [rx, ry] = toScreen(ov.rotMm[0], ov.rotMm[1]);
      ctx.beginPath();
      ctx.moveTo(nx, ny);
      ctx.lineTo(rx, ry);
      ctx.stroke();
      ctx.fillStyle = "#1aa251";
      ctx.beginPath();
      ctx.arc(rx, ry, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#0a84ff";
      for (const { p } of ov.handles) {
        const [hx, hy] = toScreen(p[0], p[1]);
        ctx.fillRect(hx - 3, hy - 3, 6, 6);
      }
    }

    if (marquee) {
      const [mx, my] = toScreen(marquee.x, marquee.y + marquee.h);
      ctx.strokeStyle = "#8a93a3";
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(mx, my, marquee.w * view.scale, marquee.h * view.scale);
      ctx.setLineDash([]);
    }

    const [hx, hy] = toScreen(wpos[0], wpos[1]);
    ctx.strokeStyle = "#ff5a7a";
    ctx.beginPath();
    ctx.moveTo(hx - 8, hy);
    ctx.lineTo(hx + 8, hy);
    ctx.moveTo(hx, hy - 8);
    ctx.lineTo(hx, hy + 8);
    ctx.stroke();
  }, [objects, layers, selection, view, marquee, wpos, bed.w, bed.h, snapStep, overlay, layerColor, layerEnabled]);

  function near(mm: [number, number], cx: number, cy: number): boolean {
    const [sx, sy] = toScreen(mm[0], mm[1]);
    return Math.abs(sx - cx) <= HANDLE_HIT && Math.abs(sy - cy) <= HANDLE_HIT;
  }
  function hitObject(mx: number, my: number): SceneObj | null {
    const pad = 6 / view.scale;
    for (let i = objects.length - 1; i >= 0; i--) {
      if (boxContains(objects[i].box, mx, my, pad)) return objects[i];
    }
    return null;
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const [mx, my] = toMm(cx, cy);

    if (e.button === 1 || e.button === 2 || e.altKey) {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy };
      return;
    }

    const ov = overlay();
    if (ov) {

      if (near(ov.rotMm, cx, cy)) {
        const sel = objects.filter((o) => selection.includes(o.id));
        const center = ov.single ? boxCenter(ov.single.box) : groupCenter(sel);
        const init: Record<string, { c: [number, number]; rot: number }> = {};
        sel.forEach((o) => (init[o.id] = { c: boxCenter(o.box), rot: o.rot }));
        drag.current = { kind: "rotate", center, start: Math.atan2(my - center[1], mx - center[0]), init };
        return;
      }

      for (const { h, p } of ov.handles) {
        if (near(p, cx, cy)) {
          if (ov.single) {
            drag.current = {
              kind: "resize1",
              handle: h,
              g0: { ...ov.single.box },
              rot: ov.single.rot,
              objId: ov.single.id,
              uniform: e.shiftKey,
            };
          } else {
            const sel = objects.filter((o) => selection.includes(o.id));
            const g0 = selectionBounds(sel)!;
            const boxes: Record<string, Box> = {};
            sel.forEach((o) => (boxes[o.id] = { ...o.box }));
            drag.current = { kind: "resizeM", handle: h, g0, boxes };
          }
          return;
        }
      }
    }

    const hit = hitObject(mx, my);
    if (hit) {
      let sel = selection;
      if (e.shiftKey) {
        sel = selection.includes(hit.id)
          ? selection.filter((id) => id !== hit.id)
          : [...selection, hit.id];
      } else if (!selection.includes(hit.id)) {
        sel = [hit.id];
      }
      setSelection(sel);
      const selObjs = objects.filter((o) => sel.includes(o.id));
      const boxes: Record<string, Box> = {};
      selObjs.forEach((o) => (boxes[o.id] = { ...o.box }));
      const g = selectionBounds(selObjs)!;
      drag.current = { kind: "move", sx: mx, sy: my, gx: g.x, gy: g.y, boxes };
      return;
    }

    if (!e.shiftKey) setSelection([]);
    drag.current = { kind: "marquee", x0: mx, y0: my };
    setMarquee({ x: mx, y: my, w: 0, h: 0 });
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const [mx, my] = toMm(e.clientX - rect.left, e.clientY - rect.top);

    if (d.kind === "pan") {
      setView((v) => ({ ...v, ox: d.ox + (e.clientX - d.sx), oy: d.oy + (e.clientY - d.sy) }));
    } else if (d.kind === "move") {

      const dx = snapV(d.gx + (mx - d.sx)) - d.gx;
      const dy = snapV(d.gy + (my - d.sy)) - d.gy;
      setObjects(
        objects.map((o) =>
          d.boxes[o.id]
            ? { ...o, box: { ...o.box, x: d.boxes[o.id].x + dx, y: d.boxes[o.id].y + dy } }
            : o,
        ),
      );
    } else if (d.kind === "resize1") {
      const c0 = boxCenter(d.g0);

      const tx = d.rot === 0 ? snapV(mx) : mx;
      const ty = d.rot === 0 ? snapV(my) : my;
      const local = rotatePoint([tx, ty], c0, -d.rot);
      let nb = resizeBox(d.g0, d.handle, local[0], local[1], d.uniform);

      const anchor = oppositeAnchor(d.g0, d.handle);
      const before = rotatePoint(anchor, c0, d.rot);
      const after = rotatePoint(anchor, boxCenter(nb), d.rot);
      nb = { ...nb, x: nb.x + before[0] - after[0], y: nb.y + before[1] - after[1] };
      setObjects(objects.map((o) => (o.id === d.objId ? { ...o, box: nb } : o)));
    } else if (d.kind === "resizeM") {
      const g1 = resizeBox(d.g0, d.handle, snapV(mx), snapV(my), false);
      const fx = d.g0.w !== 0 ? g1.w / d.g0.w : 1;
      const fy = d.g0.h !== 0 ? g1.h / d.g0.h : 1;
      setObjects(
        objects.map((o) => {
          const b0 = d.boxes[o.id];
          if (!b0) return o;
          return {
            ...o,
            box: {
              x: g1.x + (b0.x - d.g0.x) * fx,
              y: g1.y + (b0.y - d.g0.y) * fy,
              w: b0.w * fx,
              h: b0.h * fy,
            },
          };
        }),
      );
    } else if (d.kind === "rotate") {
      let dAng = Math.atan2(my - d.center[1], mx - d.center[0]) - d.start;
      if (e.shiftKey) dAng = Math.round(dAng / (Math.PI / 12)) * (Math.PI / 12);
      setObjects(
        objects.map((o) => {
          const init = d.init[o.id];
          if (!init) return o;
          const nc = rotatePoint(init.c, d.center, dAng);
          return {
            ...o,
            rot: init.rot + dAng,
            box: { ...o.box, x: nc[0] - o.box.w / 2, y: nc[1] - o.box.h / 2 },
          };
        }),
      );
    } else if (d.kind === "marquee") {
      setMarquee({
        x: Math.min(d.x0, mx),
        y: Math.min(d.y0, my),
        w: Math.abs(mx - d.x0),
        h: Math.abs(my - d.y0),
      });
    }
  }

  function onPointerUp() {
    const d = drag.current;
    if (d?.kind === "marquee" && marquee) {
      const hits = objects.filter((o) => boxesIntersect(o.box, marquee)).map((o) => o.id);
      if (hits.length) setSelection(hits);
    }
    drag.current = null;
    setMarquee(null);
  }

  function onWheel(e: React.WheelEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const [mx, my] = toMm(cx, cy);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => {
      const scale = Math.max(0.2, Math.min(40, v.scale * factor));
      return { scale, ox: cx - mx * scale, oy: cy + my * scale };
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelected();
        e.preventDefault();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "c")) {
        duplicateSelected();
        e.preventDefault();
      } else if (e.key === "Escape") {
        setSelection([]);
      } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {

        const step = snap ? (e.shiftKey ? 1 : snapStep) : e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowDown" ? -step : e.key === "ArrowUp" ? step : 0;
        const { objects: objs, selection: sel } = useStore.getState();
        setObjects(
          objs.map((o) =>
            sel.includes(o.id) ? { ...o, box: { ...o.box, x: o.box.x + dx, y: o.box.y + dy } } : o,
          ),
        );
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, duplicateSelected, setObjects, setSelection, snap, snapStep]);

  return (
    <main className="workspace" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="workspace__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="workspace__hint">
        {objects.length === 0
          ? "Import a file to begin · scroll to zoom · alt-drag to pan"
          : `${objects.length} object(s) · ${selection.length} selected`}
      </div>
      <div className="workspace__snap">
        <label>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
          Snap
        </label>
        <select
          value={snapStep}
          onChange={(e) => setSnapStep(Number(e.target.value))}
          disabled={!snap}
          title="Grid snap step"
        >
          {[0.001, 0.01, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20].map((s) => (
            <option key={s} value={s}>
              {s} mm
            </option>
          ))}
        </select>
      </div>
    </main>
  );
}

function groupCenter(objs: SceneObj[]): [number, number] {
  const sb = selectionBounds(objs)!;
  return [sb.x + sb.w / 2, sb.y + sb.h / 2];
}

function niceGrid(snapStep: number, scale: number, minPx = 7): number {
  const mantissas = [1, 2, 5];
  const startExp = Math.floor(Math.log10(snapStep) - 1);
  for (let e = startExp; e < startExp + 14; e++) {
    for (const m of mantissas) {
      const c = m * Math.pow(10, e);
      if (c >= snapStep * 0.999 && c * scale >= minPx) return c;
    }
  }
  return snapStep;
}
