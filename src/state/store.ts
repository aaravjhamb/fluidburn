import { create } from "zustand";
import type {
  GrblStatus,
  JobProgress,
  Layer,
  GcodeResult,
  Config,
  Machine,
} from "../lib/ipc";
import type { SceneObj } from "../lib/scene";

const DEFAULT_STATUS: GrblStatus = {
  state: "Disconnected",
  wpos: [0, 0, 0],
  mpos: [0, 0, 0],
  feed: 0,
  power: 0,
};

let pasteCounter = 0;

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

  setPorts: (ports) => set({ ports }),
  setSelectedPort: (selectedPort) => set({ selectedPort }),
  setBaud: (baud) => set({ baud }),
  setConnected: (connected) =>
    set(connected ? { connected } : { connected, status: DEFAULT_STATUS }),
  setStatus: (status) => set({ status }),
  pushConsole: (line) =>
    set((s) => ({ console: [...s.console.slice(-499), line] })),

  setConfig: (config) => set({ config }),
  activeMachine: () => {
    const c = get().config;
    if (!c || !c.activeId) return c?.machines[0] ?? null;
    return c.machines.find((m) => m.id === c.activeId) ?? null;
  },

  loadScene: (docId, layers, objects) =>
    set({ docId, layers, objects, selection: [], gcode: null }),
  updateLayer: (id, patch) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    })),
  setObjects: (objects) => set({ objects }),
  setSelection: (selection) => set({ selection }),
  deleteSelected: () =>
    set((s) => ({
      objects: s.objects.filter((o) => !s.selection.includes(o.id)),
      selection: [],
    })),
  duplicateSelected: () =>
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
    }),

  setGcode: (gcode) => set({ gcode }),
  setProgress: (progress) => set({ progress }),
}));
