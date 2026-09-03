import { create } from "zustand";
import type {
  GrblStatus,
  JobProgress,
  Layer,
  GcodeResult,
  Config,
  Machine,
  Theme,
} from "../lib/ipc";
import {
  boxCenter,
  rotatePoint,
  selectionBounds,
  type SceneObj,
} from "../lib/scene";

const DEFAULT_STATUS: GrblStatus = {
  state: "Disconnected",
  wpos: [0, 0, 0],
  mpos: [0, 0, 0],
  feed: 0,
  power: 0,
};

let pasteCounter = 0;

// Travel-limit corners captured by jogging, in machine coordinates.
export type Corners = Partial<Record<string, [number, number]>>;
export const CORNER_KEYS = ["TL", "TR", "BL", "BR"] as const;

// Axis-aligned box (machine coords) bounding the captured corners, or null.
export function cornerBox(corners: Corners) {
  const pts = Object.values(corners).filter(Boolean) as [number, number][];
  if (pts.length < CORNER_KEYS.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    xmin: Math.min(...xs),
    xmax: Math.max(...xs),
    ymin: Math.min(...ys),
    ymax: Math.max(...ys),
  };
}

export type Axis = "x" | "y";
export type AlignEdge = "left" | "hcenter" | "right" | "bottom" | "vcenter" | "top";

interface Snapshot {
  objects: SceneObj[];
  selection: string[];
}

const HISTORY_LIMIT = 60;

interface AppState {

  ports: string[];
  selectedPort: string | null;
  baud: number;
  connected: boolean;
  status: GrblStatus;
  console: string[];

  config: Config | null;

  docId: string | null;
  layers: Layer[];
  objects: SceneObj[];
  selection: string[];

  gcode: GcodeResult | null;
  progress: JobProgress | null;
  jobError: string | null;

  setPorts: (p: string[]) => void;
  setSelectedPort: (p: string | null) => void;
  setBaud: (b: number) => void;
  setConnected: (c: boolean) => void;
  setStatus: (s: GrblStatus) => void;
  pushConsole: (line: string) => void;

  setConfig: (c: Config) => void;
  activeMachine: () => Machine | null;

  loadScene: (docId: string, layers: Layer[], objects: SceneObj[]) => void;
  updateLayer: (id: string, patch: Partial<Layer>) => void;
  setObjects: (objects: SceneObj[]) => void;
  setSelection: (ids: string[]) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;

  setGcode: (g: GcodeResult | null) => void;
  setProgress: (p: JobProgress | null) => void;
  setJobError: (msg: string | null) => void;

  corners: Corners;
  setCorner: (key: string, pt: [number, number]) => void;
  clearCorners: () => void;

  // ---- undo / redo ----
  past: Snapshot[];
  future: Snapshot[];
  /** Record the current scene as an undo point. Call before mutating. */
  snapshot: () => void;
  undo: () => void;
  redo: () => void;

  // ---- object transforms ----
  flipSelection: (axis: Axis) => void;
  rotateSelectionBy: (rad: number) => void;
  setSelectionRotation: (rad: number) => void;
  alignSelection: (edge: AlignEdge) => void;
  distributeSelection: (axis: Axis) => void;
  centerOnBed: (bedW: number, bedH: number) => void;
  fitToBed: (bedW: number, bedH: number, margin?: number) => void;

  // ---- view / appearance ----
  theme: Theme;
  systemDark: boolean;
  setTheme: (t: Theme) => void;
  setSystemDark: (d: boolean) => void;
  resolvedTheme: () => "light" | "dark";
  showToolpath: boolean;
  setShowToolpath: (v: boolean) => void;
}

export const useStore = create<AppState>((set, get) => ({
  ports: [],
  selectedPort: null,
  baud: 115200,
  connected: false,
  status: DEFAULT_STATUS,
  console: [],

  config: null,

  docId: null,
  layers: [],
  objects: [],
  selection: [],

  gcode: null,
  progress: null,
  jobError: null,
  corners: {},

  past: [],
  future: [],

  theme: "Auto",
  systemDark: false,
  showToolpath: true,

  setCorner: (key, pt) => set((s) => ({ corners: { ...s.corners, [key]: pt } })),
  clearCorners: () => set({ corners: {} }),

  setPorts: (ports) => set({ ports }),
  setSelectedPort: (selectedPort) => set({ selectedPort }),
  setBaud: (baud) => set({ baud }),
  setConnected: (connected) =>
    set(connected ? { connected } : { connected, status: DEFAULT_STATUS }),
  setStatus: (status) => set({ status }),
  pushConsole: (line) =>
    set((s) => ({ console: [...s.console.slice(-499), line] })),

  setConfig: (config) => set({ config, theme: config.theme ?? "Auto" }),
  activeMachine: () => {
    const c = get().config;
    if (!c || !c.activeId) return c?.machines[0] ?? null;
    return c.machines.find((m) => m.id === c.activeId) ?? null;
  },

  loadScene: (docId, layers, objects) =>
    set({ docId, layers, objects, selection: [], gcode: null, past: [], future: [] }),
  updateLayer: (id, patch) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    })),
  setObjects: (objects) => set({ objects }),
  setSelection: (selection) => set({ selection }),

  // Every scene mutation funnels through here, which makes it the one place
  // to drop generated G-code: once the art moves, the toolpath on screen (and
  // anything Run would stream) no longer matches it.
  snapshot: () =>
    set((s) => ({
      past: [...s.past, { objects: s.objects, selection: s.selection }].slice(-HISTORY_LIMIT),
      future: [],
      gcode: null,
    })),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return {};
      return {
        past: s.past.slice(0, -1),
        future: [...s.future, { objects: s.objects, selection: s.selection }],
        objects: prev.objects,
        selection: prev.selection,
        gcode: null,
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[s.future.length - 1];
      if (!next) return {};
      return {
        future: s.future.slice(0, -1),
        past: [...s.past, { objects: s.objects, selection: s.selection }],
        objects: next.objects,
        selection: next.selection,
        gcode: null,
      };
    }),

  deleteSelected: () => {
    get().snapshot();
    set((s) => ({
      objects: s.objects.filter((o) => !s.selection.includes(o.id)),
      selection: [],
    }));
  },
  duplicateSelected: () => {
    get().snapshot();
    set((s) => {
      const dupes = s.objects
        .filter((o) => s.selection.includes(o.id) && !o.raster)
        .map((o) => {
          pasteCounter++;
          return {
            ...o,
            id: `${o.id}-copy${pasteCounter}`,
            obb: { ...o.obb },
            box: { ...o.box, x: o.box.x + 5, y: o.box.y + 5 },
          };
        });
      return {
        objects: [...s.objects, ...dupes],
        selection: dupes.map((d) => d.id),
      };
    });
  },

  flipSelection: (axis) => {
    get().snapshot();
    set((s) => {
      const sel = s.objects.filter((o) => s.selection.includes(o.id));
      const g = selectionBounds(sel);
      if (!g) return {};
      return {
        objects: s.objects.map((o) => {
          if (!s.selection.includes(o.id)) return o;
          // Mirroring commutes with rotation as M·R(t) = R(-t)·M, so the
          // angle negates. The box also mirrors within the group bounds, so a
          // multi-selection flips as one piece rather than in place.
          if (axis === "x") {
            return {
              ...o,
              flipX: !o.flipX,
              rot: -o.rot,
              box: { ...o.box, x: g.x + g.w - (o.box.x - g.x) - o.box.w },
            };
          }
          return {
            ...o,
            flipY: !o.flipY,
            rot: -o.rot,
            box: { ...o.box, y: g.y + g.h - (o.box.y - g.y) - o.box.h },
          };
        }),
      };
    });
  },

  rotateSelectionBy: (rad) => {
    if (rad === 0) return;
    get().snapshot();
    set((s) => {
      const sel = s.objects.filter((o) => s.selection.includes(o.id));
      const g = selectionBounds(sel);
      if (!g) return {};
      const c: [number, number] = [g.x + g.w / 2, g.y + g.h / 2];
      return {
        objects: s.objects.map((o) => {
          if (!s.selection.includes(o.id)) return o;
          const nc = rotatePoint(boxCenter(o.box), c, rad);
          return {
            ...o,
            rot: o.rot + rad,
            box: { ...o.box, x: nc[0] - o.box.w / 2, y: nc[1] - o.box.h / 2 },
          };
        }),
      };
    });
  },

  setSelectionRotation: (rad) => {
    const s = get();
    const first = s.objects.find((o) => s.selection.includes(o.id));
    if (!first) return;
    s.rotateSelectionBy(rad - first.rot);
  },

  alignSelection: (edge) => {
    get().snapshot();
    set((s) => {
      const sel = s.objects.filter((o) => s.selection.includes(o.id));
      const g = selectionBounds(sel);
      if (!g) return {};
      return {
        objects: s.objects.map((o) => {
          if (!s.selection.includes(o.id)) return o;
          switch (edge) {
            case "left":
              return { ...o, box: { ...o.box, x: g.x } };
            case "right":
              return { ...o, box: { ...o.box, x: g.x + g.w - o.box.w } };
            case "hcenter":
              return { ...o, box: { ...o.box, x: g.x + (g.w - o.box.w) / 2 } };
            case "bottom":
              return { ...o, box: { ...o.box, y: g.y } };
            case "top":
              return { ...o, box: { ...o.box, y: g.y + g.h - o.box.h } };
            case "vcenter":
              return { ...o, box: { ...o.box, y: g.y + (g.h - o.box.h) / 2 } };
          }
        }),
      };
    });
  },

  distributeSelection: (axis) => {
    const state = get();
    const sel = state.objects.filter((o) => state.selection.includes(o.id));
    // Two objects already span the bounds; there is no gap to even out.
    if (sel.length < 3) return;
    state.snapshot();
    set((s) => {
      const g = selectionBounds(sel)!;
      const horiz = axis === "x";
      const size = (o: SceneObj) => (horiz ? o.box.w : o.box.h);
      const order = [...sel].sort((a, b) =>
        horiz ? a.box.x - b.box.x : a.box.y - b.box.y,
      );
      const span = horiz ? g.w : g.h;
      const used = order.reduce((n, o) => n + size(o), 0);
      const gap = (span - used) / (order.length - 1);
      const at = new Map<string, number>();
      let cursor = horiz ? g.x : g.y;
      for (const o of order) {
        at.set(o.id, cursor);
        cursor += size(o) + gap;
      }
      return {
        objects: s.objects.map((o) => {
          const v = at.get(o.id);
          if (v === undefined) return o;
          return { ...o, box: horiz ? { ...o.box, x: v } : { ...o.box, y: v } };
        }),
      };
    });
  },

  centerOnBed: (bedW, bedH) => {
    get().snapshot();
    set((s) => {
      const sel = s.objects.filter((o) => s.selection.includes(o.id));
      const g = selectionBounds(sel);
      if (!g) return {};
      const dx = (bedW - g.w) / 2 - g.x;
      const dy = (bedH - g.h) / 2 - g.y;
      return {
        objects: s.objects.map((o) =>
          s.selection.includes(o.id)
            ? { ...o, box: { ...o.box, x: o.box.x + dx, y: o.box.y + dy } }
            : o,
        ),
      };
    });
  },

  fitToBed: (bedW, bedH, margin = 5) => {
    get().snapshot();
    set((s) => {
      const sel = s.objects.filter((o) => s.selection.includes(o.id));
      const g = selectionBounds(sel);
      if (!g || g.w === 0 || g.h === 0) return {};
      const f = Math.min((bedW - margin * 2) / g.w, (bedH - margin * 2) / g.h);
      const nw = g.w * f;
      const nh = g.h * f;
      const ox = (bedW - nw) / 2;
      const oy = (bedH - nh) / 2;
      return {
        objects: s.objects.map((o) =>
          s.selection.includes(o.id)
            ? {
                ...o,
                box: {
                  x: ox + (o.box.x - g.x) * f,
                  y: oy + (o.box.y - g.y) * f,
                  w: o.box.w * f,
                  h: o.box.h * f,
                },
              }
            : o,
        ),
      };
    });
  },

  setGcode: (gcode) => set({ gcode }),
  setProgress: (progress) => set({ progress }),
  setJobError: (jobError) => set({ jobError }),

  setTheme: (theme) => set({ theme }),
  setSystemDark: (systemDark) => set({ systemDark }),
  resolvedTheme: () => {
    const s = get();
    if (s.theme === "Dark") return "dark";
    if (s.theme === "Light") return "light";
    return s.systemDark ? "dark" : "light";
  },
  setShowToolpath: (showToolpath) => set({ showToolpath }),
}));
