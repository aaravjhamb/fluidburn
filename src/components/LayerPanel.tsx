import { useStore } from "../state/store";
import type { CutKind } from "../lib/ipc";
import TransformPanel from "./TransformPanel";

const KINDS: CutKind[] = ["Cut", "Engrave", "Score"];

export default function LayerPanel() {
  const layers = useStore((s) => s.layers);
  const updateLayer = useStore((s) => s.updateLayer);
  const gcode = useStore((s) => s.gcode);

  return (
    <aside className="panel panel--layers">
      <TransformPanel />
      <h2>Layers</h2>
      {layers.length === 0 && (
        <p className="panel__empty">Import a file to begin.</p>
      )}
      {layers.map((l) => (
        <div className="layer" key={l.id}>
          <div className="layer__head">
            <input
              type="checkbox"
              checked={l.enabled}
              onChange={(e) => updateLayer(l.id, { enabled: e.target.checked })}
            />
            <span
              className="layer__swatch"
              style={{ background: l.color }}
            />
            <span className="layer__name">{l.name}</span>
          </div>
          <div className="layer__row">
            <label>Op</label>
            <select
              value={l.kind}
              onChange={(e) =>
                updateLayer(l.id, { kind: e.target.value as CutKind })
              }
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="layer__row">
            <label>Power %</label>
            <input
              type="number"
              min={0}
              max={100}
              value={l.powerPct}
              onChange={(e) =>
                updateLayer(l.id, { powerPct: Number(e.target.value) })
              }
            />
          </div>
          <div className="layer__row">
            <label>Speed</label>
            <input
              type="number"
              min={1}
              value={l.feed}
              onChange={(e) => updateLayer(l.id, { feed: Number(e.target.value) })}
            />
            <span className="layer__unit">mm/min</span>
          </div>
          <div className="layer__row">
            <label>Passes</label>
            <input
              type="number"
              min={1}
              value={l.passes}
              onChange={(e) =>
                updateLayer(l.id, { passes: Number(e.target.value) })
              }
            />
          </div>
        </div>
      ))}
      {gcode && (
        <div className="panel__estimate">
          ≈ {Math.round(gcode.estSeconds)}s · {gcode.lineCount} lines
        </div>
      )}
    </aside>
  );
}
