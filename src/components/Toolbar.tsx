import { open, save } from "@tauri-apps/plugin-dialog";
import { useStore } from "../state/store";
import {
  importFile,
  generateGcode,
  saveGcode,
  startJob,
  pauseJob,
  cancelJob,
  softReset,
  type VectorGroup,
  type RasterPlacement,
} from "../lib/ipc";
import { fromImported, toWorld } from "../lib/scene";

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
  } = useStore();

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
      pushConsole(`[import] ${path.split("/").pop()} → ${r.objects.length} object(s)`);
    } catch (e) {
      pushConsole(`[error] import: ${e}`);
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
      pushConsole(`[cam] ${r.lineCount} lines, est ${Math.round(r.estSeconds)}s`);
    } catch (e) {
      pushConsole(`[error] generate: ${e}`);
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
      pushConsole(`[save] ${path}`);
    } catch (e) {
      pushConsole(`[error] save: ${e}`);
    }
  }

  const running = status.state === "Run" || status.state === "Jog";
  const machineName = activeMachine()?.name ?? "No machine";

  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <span className="toolbar__icon">◐</span> FluidBurn
      </div>
      <div className="toolbar__group">
        <button onClick={onImport}>Import…</button>
        <button onClick={onGenerate} disabled={!docId}>
          Generate G-code
        </button>
        <button onClick={onSave} disabled={!gcode} title="Export the generated G-code to a file">
          Save G-code…
        </button>
      </div>
      <button className="toolbar__machine" onClick={onOpenMachines} title="Manage machines">
        ⚙ {machineName}
      </button>
      <div className="toolbar__group toolbar__group--run">
        <button
          className="btn--go"
          disabled={!connected || !gcode || running}
          onClick={() => gcode && startJob(gcode.gcode)}
        >
          ▶ Run
        </button>
        <button disabled={!running} onClick={() => pauseJob()}>
          ❙❙ Hold
        </button>
        <button disabled={!connected} onClick={() => cancelJob()}>
          ■ Stop
        </button>
        <button
          className="btn--estop"
          disabled={!connected}
          onClick={() => softReset()}
          title="Soft-reset GRBL (Ctrl-X)"
        >
          ⏻ E-STOP
        </button>
      </div>
      <div className={`toolbar__state toolbar__state--${status.state.toLowerCase()}`}>
        {status.state}
      </div>
    </header>
  );
}
