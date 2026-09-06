import { open, save } from "@tauri-apps/plugin-dialog";
import { useStore, cornerBox } from "../state/store";
import {
  importFile,
  generateGcode,
  saveGcode,
  startJob,
  frameJob,
  pauseJob,
  resumeJob,
  cancelJob,
  softReset,
  setTheme as persistTheme,
  type DocBounds,
  type Theme,
  type VectorGroup,
  type RasterPlacement,
} from "../lib/ipc";
import { fromImported, toWorld } from "../lib/scene";

const THEMES: Theme[] = ["Auto", "Light", "Dark"];

const STATE_LABEL: Record<string, string> = {
  Disconnected: "Offline",
  Idle: "Ready",
  Run: "Cutting",
  Hold: "Paused",
  Jog: "Moving",
  Alarm: "Alarm",
  Door: "Door open",
  Home: "Homing",
  Sleep: "Asleep",
  Check: "Dry run",
};

const STATE_HELP: Record<string, string> = {
  Disconnected: "Not connected to a controller yet",
  Idle: "Connected and waiting for a job",
  Run: "A job is running",
  Hold: "Paused mid-job — press Run to pick up where it stopped",
  Jog: "The head is moving",
  Alarm: "The controller has stopped and won't move until you clear the alarm",
  Door: "The safety door input is open",
  Home: "Finding the homing switches",
  Sleep: "The controller has powered down its motors",
  Check: "Reading the job without firing the beam",
};

export default function Toolbar({ onOpenMachines }: { onOpenMachines: () => void }) {
  const {
    docId,
    layers,
    objects,
    loadScene,
    setGcode,
    gcode,
    connected,
    status,
    pushConsole,
    activeMachine,
    corners,
    past,
    future,
    undo,
    redo,
    theme,
    setTheme,
    setConfig,
  } = useStore();

  // Block a job whose path would leave the mapped travel area. Works in
  // controller coords: the job's coordinates relative to job zero, plus the
  // current offset between the two. Returns a reason, or null when it's safe.
  function limitViolation(b: DocBounds): string | null {
    const box = cornerBox(corners);
    if (!box) return null;
    const wcoX = status.mpos[0] - status.wpos[0];
    const wcoY = status.mpos[1] - status.wpos[1];
    // include job zero (0,0) — jobs travel through it and park there.
    const lo = (v: number, w: number) => Math.min(v, 0) + w;
    const hi = (v: number, w: number) => Math.max(v, 0) + w;
    const mnx = lo(b.minX, wcoX);
    const mxx = hi(b.maxX, wcoX);
    const mny = lo(b.minY, wcoY);
    const mxy = hi(b.maxY, wcoY);
    // tolerance absorbs sub-mm rounding in the measured offset; each limit is
    // a point the head physically reached while the corners were mapped.
    const eps = 0.5;
    if (
      mnx < box.xmin - eps ||
      mxx > box.xmax + eps ||
      mny < box.ymin - eps ||
      mxy > box.ymax + eps
    ) {
      return (
        `it needs X ${mnx.toFixed(1)} to ${mxx.toFixed(1)} and ` +
        `Y ${mny.toFixed(1)} to ${mxy.toFixed(1)}, but the head can only reach ` +
        `X ${box.xmin} to ${box.xmax} and Y ${box.ymin} to ${box.ymax}`
      );
    }
    return null;
  }

  function runJob() {
    if (!gcode) return;
    const bad = limitViolation(gcode.bounds);
    if (bad) {
      pushConsole(`[limits] run blocked — ${bad}`);
      pushConsole(
        "[limits] move the design further onto the bed, or jog somewhere with more room and set job zero again",
      );
      return;
    }
    startJob(gcode.gcode).catch((e) => pushConsole(`[error] ${e}`));
  }

  function runFrame() {
    if (!gcode) return;
    const bad = limitViolation(gcode.bounds);
    if (bad) {
      pushConsole(`[limits] framing blocked — ${bad}`);
      return;
    }
    const feed = activeMachine()?.maxFeed ?? 6000;
    pushConsole("[frame] tracing the job outline with the beam off");
    frameJob(gcode.bounds, feed).catch((e) => pushConsole(`[error] framing failed: ${e}`));
  }

  function onTheme(t: Theme) {
    setTheme(t);
    persistTheme(t).then(setConfig).catch((e) => pushConsole(`[error] could not save the theme: ${e}`));
  }

  async function onImport() {
    const path = await open({
      multiple: false,
      filters: [
        { name: "Vector / Image", extensions: ["svg", "dxf", "png", "jpg", "jpeg", "bmp"] },
      ],
    });
    if (typeof path !== "string") return;
    try {
      const r = await importFile(path);
      loadScene(r.docId, r.layers, r.objects.map(fromImported));
      pushConsole(`[import] ${path.split("/").pop()} — ${r.objects.length} object(s)`);
    } catch (e) {
      pushConsole(`[error] could not import that file: ${e}`);
    }
  }

  async function onGenerate() {
    if (!docId) return;
    const machine = activeMachine();

    const byLayer = new Map<string, number[][][]>();
    let raster: RasterPlacement | null = null;
    for (const o of objects) {
      if (o.raster) {
        raster = {
          docId,
          x: o.box.x,
          y: o.box.y,
          scale: o.obb.w !== 0 ? o.box.w / o.obb.w : 1,
          flipX: o.flipX,
          flipY: o.flipY,
        };
      } else {
        const arr = byLayer.get(o.layerId) ?? [];
        arr.push(...toWorld(o));
        byLayer.set(o.layerId, arr);
      }
    }
    const vectors: VectorGroup[] = [...byLayer].map(([layerId, polylines]) => ({
      layerId,
      polylines,
    }));

    try {
      const r = await generateGcode({
        layers,
        vectors,
        raster,
        travelFeed: machine?.maxFeed ?? 6000,
        dynamicPower: true,
        maxPower: machine?.maxPower ?? 1000,
      });
      setGcode(r);
      pushConsole(
        `[gcode] ready — ${r.lineCount} lines, about ${Math.round(r.estSeconds)}s to run`,
      );
    } catch (e) {
      pushConsole(`[error] could not generate G-code: ${e}`);
    }
  }

  async function onSave() {
    if (!gcode) return;
    const path = await save({
      defaultPath: "job.gcode",
      filters: [{ name: "G-code", extensions: ["gcode", "nc", "ngc"] }],
    });
    if (!path) return;
    try {
      await saveGcode(path, gcode.gcode);
      pushConsole(`[save] G-code written to ${path}`);
    } catch (e) {
      pushConsole(`[error] could not save: ${e}`);
    }
  }

  const running = status.state === "Run" || status.state === "Jog";
  // Held still has a job loaded, so Run must not offer to start it over.
  const held = status.state === "Hold";
  const machineName = activeMachine()?.name ?? "No machine set up";

  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <span className="toolbar__icon">◐</span> FluidBurn
      </div>
      <div className="toolbar__group">
        <button onClick={onImport} title="Open an SVG, DXF or image to cut or engrave">
          Import…
        </button>
        <button
          onClick={onGenerate}
          disabled={!docId}
          title="Turn the layers on the left into G-code, using their power and speed settings"
        >
          Generate G-code
        </button>
        <button onClick={onSave} disabled={!gcode} title="Write the generated G-code out to a file">
          Save G-code…
        </button>
      </div>
      <div className="toolbar__group toolbar__group--history">
        <button
          className="toolbar__icon-btn"
          onClick={undo}
          disabled={past.length === 0}
          title="Undo (⌘Z)"
        >
          ↶
        </button>
        <button
          className="toolbar__icon-btn"
          onClick={redo}
          disabled={future.length === 0}
          title="Redo (⇧⌘Z)"
        >
          ↷
        </button>
      </div>
      <button className="toolbar__machine" onClick={onOpenMachines} title="Edit or switch machine profiles">
        ⚙ {machineName}
      </button>
      <select
        className="toolbar__theme"
        value={theme}
        onChange={(e) => onTheme(e.target.value as Theme)}
        title="Appearance"
      >
        {THEMES.map((t) => (
          <option key={t} value={t}>
            {t === "Auto" ? "◐ Auto" : t === "Light" ? "☀ Light" : "☾ Dark"}
          </option>
        ))}
      </select>
      <div className="toolbar__group toolbar__group--run">
        <button
          disabled={!connected || !gcode || running}
          onClick={runFrame}
          title="Run a lap around the job outline with the beam off, to check where it will land"
        >
          ▭ Frame
        </button>
        <button
          className="btn--go"
          disabled={!connected || !gcode || running || held}
          onClick={runJob}
          title="Start cutting"
        >
          ▶ Run
        </button>
        <button
          disabled={!running && !held}
          onClick={() => (held ? resumeJob() : pauseJob()).catch((e) => pushConsole(`[error] ${e}`))}
          title={
            held
              ? "Carry on from where the job stopped"
              : "Pause — the beam stops and the head holds its place"
          }
        >
          {held ? "▶ Resume" : "❙❙ Hold"}
        </button>
        <button disabled={!connected} onClick={() => cancelJob()} title="Give up on the job — it cannot be resumed after this">
          ■ Stop
        </button>
        <button
          className="btn--estop"
          disabled={!connected}
          onClick={() => softReset()}
          title="Cut power to the beam and reset the controller immediately (Ctrl-X). Not a substitute for a physical E-stop."
        >
          ⏻ E-STOP
        </button>
      </div>
      <div
        className={`toolbar__state toolbar__state--${status.state.toLowerCase()}`}
        title={STATE_HELP[status.state] ?? status.state}
      >
        {STATE_LABEL[status.state] ?? status.state}
      </div>
    </header>
  );
}
