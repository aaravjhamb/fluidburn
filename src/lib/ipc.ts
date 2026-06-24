import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type MachineState =
  | "Disconnected"
  | "Idle"
  | "Run"
  | "Hold"
  | "Jog"
  | "Alarm"
  | "Door"
  | "Home"
  | "Sleep"
  | "Check";

export interface GrblStatus {
  state: MachineState;
  wpos: [number, number, number];
  mpos: [number, number, number];
  feed: number;
  power: number;
}

export interface JobProgress {
  sent: number;
  total: number;
  elapsed: number;
}

export interface JobError {
  code: number | null;
  message: string;
}

export type CutKind = "Cut" | "Engrave" | "Score";

export interface Layer {
  id: string;
  name: string;
  kind: CutKind;
  enabled: boolean;
  feed: number;
  powerPct: number;
  passes: number;
  color: string;
}

export interface DocBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SceneObject {
  id: string;
  layerId: string;
  polylines: number[][][];
  raster: boolean;
}

export interface ImportResult {
  docId: string;
  bounds: DocBounds;
  layers: Layer[];
  objects: SceneObject[];
}

export type Origin = "FrontLeft" | "FrontRight" | "BackLeft" | "BackRight";

export interface Machine {
  id: string;
  name: string;
  bedW: number;
  bedH: number;
  origin: Origin;
  maxFeed: number;
  maxPower: number;
  homing: boolean;
  baud: number;
}

export interface Config {
  machines: Machine[];
  activeId: string | null;
  onboarded: boolean;
}

export interface GcodeResult {
  gcode: string;
  lineCount: number;
  estSeconds: number;
  bounds: DocBounds;
}

export interface VectorGroup {
  layerId: string;
  polylines: number[][][];
}

export interface RasterPlacement {
  docId: string;
  x: number;
  y: number;
  scale: number;
}

export interface GenerateInput {
  layers: Layer[];
  vectors: VectorGroup[];
  raster: RasterPlacement | null;
  travelFeed: number;
  dynamicPower: boolean;
  maxPower: number;
  /** Raster scan-line pitch in mm. Omit or 0 for one row per image pixel. */
  lineIntervalMm?: number;
}

export const listPorts = () => invoke<string[]>("list_ports");
export const connect = (port: string, baud: number) =>
  invoke<void>("connect", { port, baud });
export const disconnect = () => invoke<void>("disconnect");
export const sendLine = (line: string) => invoke<void>("send_line", { line });
export const sendRealtime = (byte: number) =>
  invoke<void>("send_realtime", { byte });

export const feedHold = () => sendRealtime(0x21);
export const resume = () => sendRealtime(0x7e);
export const softReset = () => sendRealtime(0x18);
export const requestStatus = () => sendRealtime(0x3f);

export const jog = (dx: number, dy: number, feed: number) =>
  invoke<void>("jog", { dx, dy, feed });
export const home = () => sendLine("$H");
export const unlock = () => sendLine("$X");

export const startJob = (gcode: string) => invoke<void>("start_job", { gcode });
export const pauseJob = () => invoke<void>("pause_job");
export const resumeJob = () => invoke<void>("resume_job");
export const cancelJob = () => invoke<void>("cancel_job");

export const importFile = (path: string) =>
  invoke<ImportResult>("import_file", { path });

export const generateGcode = (input: GenerateInput) =>
  invoke<GcodeResult>("generate_gcode", { input });

export const saveGcode = (path: string, gcode: string) =>
  invoke<void>("save_gcode", { path, gcode });

export type BoolOp = "union" | "difference" | "intersection";

export const booleanOp = (op: BoolOp, objects: number[][][][]) =>
  invoke<number[][][]>("boolean_op", { op, objects });

export const getConfig = () => invoke<Config>("get_config");
export const saveMachine = (machine: Machine) =>
  invoke<Config>("save_machine", { machine });
export const deleteMachine = (id: string) =>
  invoke<Config>("delete_machine", { id });
export const setActiveMachine = (id: string) =>
  invoke<Config>("set_active_machine", { id });
export const setOnboarded = (value: boolean) =>
  invoke<Config>("set_onboarded", { value });

export const onStatus = (cb: (s: GrblStatus) => void): Promise<UnlistenFn> =>
  listen<GrblStatus>("grbl:status", (e) => cb(e.payload));
export const onProgress = (cb: (p: JobProgress) => void): Promise<UnlistenFn> =>
  listen<JobProgress>("job:progress", (e) => cb(e.payload));
export const onConsole = (cb: (line: string) => void): Promise<UnlistenFn> =>
  listen<string>("grbl:console", (e) => cb(e.payload));
export const onJobError = (cb: (e: JobError) => void): Promise<UnlistenFn> =>
  listen<JobError>("job:error", (e) => cb(e.payload));
