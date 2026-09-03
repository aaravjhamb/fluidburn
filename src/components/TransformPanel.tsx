import { useStore } from "../state/store";
import { selectionBounds, bbox, toWorld, type Box, type SceneObj } from "../lib/scene";
import { booleanOp, type BoolOp } from "../lib/ipc";
import type { AlignEdge } from "../state/store";

const DEG = 180 / Math.PI;

const ALIGN: { edge: AlignEdge; glyph: string; title: string }[] = [
  { edge: "left", glyph: "⇤", title: "Align left edges" },
  { edge: "hcenter", glyph: "⇹", title: "Centre horizontally" },
  { edge: "right", glyph: "⇥", title: "Align right edges" },
  { edge: "bottom", glyph: "⤓", title: "Align bottom edges" },
  { edge: "vcenter", glyph: "⇳", title: "Centre vertically" },
  { edge: "top", glyph: "⤒", title: "Align top edges" },
];

export default function TransformPanel() {
  const objects = useStore((s) => s.objects);
  const selection = useStore((s) => s.selection);
  const setObjects = useStore((s) => s.setObjects);
  const setSelection = useStore((s) => s.setSelection);
  const pushConsole = useStore((s) => s.pushConsole);
  const snapshot = useStore((s) => s.snapshot);
  const flipSelection = useStore((s) => s.flipSelection);
  const rotateSelectionBy = useStore((s) => s.rotateSelectionBy);
  const setSelectionRotation = useStore((s) => s.setSelectionRotation);
  const alignSelection = useStore((s) => s.alignSelection);
  const distributeSelection = useStore((s) => s.distributeSelection);
  const centerOnBed = useStore((s) => s.centerOnBed);
  const fitToBed = useStore((s) => s.fitToBed);
  const machine = useStore((s) => s.activeMachine());

  const selObjs = objects.filter((o) => selection.includes(o.id));
  const sb = selectionBounds(selObjs);
  if (!sb) return null;

  const boolable = selObjs.filter((o) => !o.raster);
  const bed = { w: machine?.bedW ?? 400, h: machine?.bedH ?? 400 };
  const multi = selObjs.length > 1;

  async function runBool(op: BoolOp) {
    if (boolable.length < 2) return;
    try {
      const result = await booleanOp(op, boolable.map(toWorld));
      if (result.length === 0) {
        pushConsole(`[bool] ${op}: empty result`);
        return;
      }
      const b = bbox(result);
      const id = `bool-${Date.now()}`;
      const newObj: SceneObj = {
        id,
        layerId: boolable[0].layerId,
        raster: false,
        base: result,
        obb: b,
        box: { ...b },
        rot: 0,
        flipX: false,
        flipY: false,
      };
      const removed = new Set(boolable.map((o) => o.id));
      snapshot();
      setObjects([...objects.filter((o) => !removed.has(o.id)), newObj]);
      setSelection([id]);
    } catch (e) {
      pushConsole(`[error] bool: ${e}`);
    }
  }

  function applyGroup(next: Box) {
    const g0 = sb!;
    const fx = g0.w !== 0 ? next.w / g0.w : 1;
    const fy = g0.h !== 0 ? next.h / g0.h : 1;
    snapshot();
    setObjects(
      objects.map((o) =>
        selection.includes(o.id)
          ? {
              ...o,
              box: {
                x: next.x + (o.box.x - g0.x) * fx,
                y: next.y + (o.box.y - g0.y) * fy,
                w: o.box.w * fx,
                h: o.box.h * fy,
              },
            }
          : o,
      ),
    );
  }

  const field = (label: string, value: number, onCommit: (v: number) => void) => (
    <label className="xf__field">
      <span>{label}</span>
      <input
        type="number"
        step={0.5}
        value={Number(value.toFixed(2))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onCommit(v);
        }}
      />
    </label>
  );

  // Shown angle tracks the first selected object; committing turns the whole
  // selection by the difference.
  const angle = selObjs[0] ? selObjs[0].rot * DEG : 0;

  return (
    <div className="xf">
      <div className="xf__title">Transform · {selection.length} selected</div>
      <div className="xf__grid">
        {field("X", sb.x, (v) => applyGroup({ ...sb, x: v }))}
        {field("Y", sb.y, (v) => applyGroup({ ...sb, y: v }))}
        {field("W", sb.w, (v) => applyGroup({ ...sb, w: Math.max(0.1, v) }))}
        {field("H", sb.h, (v) => applyGroup({ ...sb, h: Math.max(0.1, v) }))}
      </div>

      <div className="xf__section">Flip &amp; rotate</div>
      <div className="xf__row">
        <button onClick={() => flipSelection("x")} title="Mirror horizontally">
          ⇄ Flip H
        </button>
        <button onClick={() => flipSelection("y")} title="Mirror vertically">
          ⇅ Flip V
        </button>
      </div>
      <div className="xf__row">
        <label className="xf__field xf__field--angle">
          <span>∠</span>
          <input
            type="number"
            step={1}
            value={Number(angle.toFixed(1))}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isNaN(v)) setSelectionRotation(v / DEG);
            }}
          />
        </label>
        <button
          className="xf__rot-btn"
          onClick={() => rotateSelectionBy(-Math.PI / 2)}
          title="Rotate 90° CCW"
        >
          ↺
        </button>
        <button
          className="xf__rot-btn"
          onClick={() => rotateSelectionBy(Math.PI / 2)}
          title="Rotate 90° CW"
        >
          ↻
        </button>
      </div>

      {multi && (
        <>
          <div className="xf__section">Align</div>
          <div className="xf__align">
            {ALIGN.map((a) => (
              <button
                key={a.edge}
                className={`xf__align-btn xf__align-btn--${a.edge}`}
                onClick={() => alignSelection(a.edge)}
                title={a.title}
              >
                {a.glyph}
              </button>
            ))}
          </div>
          {selObjs.length >= 3 && (
            <div className="xf__row">
              <button onClick={() => distributeSelection("x")} title="Even horizontal gaps">
                Dist H
              </button>
              <button onClick={() => distributeSelection("y")} title="Even vertical gaps">
                Dist V
              </button>
            </div>
          )}
        </>
      )}

      <div className="xf__section">Bed</div>
      <div className="xf__row">
        <button onClick={() => centerOnBed(bed.w, bed.h)} title="Centre on the bed">
          Centre
        </button>
        <button onClick={() => fitToBed(bed.w, bed.h)} title="Scale to fill the bed">
          Fit
        </button>
      </div>

      {boolable.length >= 2 && (
        <div className="xf__bool">
          <button onClick={() => runBool("union")} title="Merge into one outline">
            Union
          </button>
          <button onClick={() => runBool("difference")} title="Subtract later from first">
            Subtract
          </button>
          <button onClick={() => runBool("intersection")} title="Keep overlap only">
            Intersect
          </button>
        </div>
      )}
    </div>
  );
}
