import { useStore } from "../state/store";
import { selectionBounds, bbox, toWorld, type Box, type SceneObj } from "../lib/scene";
import { booleanOp, type BoolOp } from "../lib/ipc";

export default function TransformPanel() {
  const objects = useStore((s) => s.objects);
  const selection = useStore((s) => s.selection);
  const setObjects = useStore((s) => s.setObjects);
  const setSelection = useStore((s) => s.setSelection);
  const pushConsole = useStore((s) => s.pushConsole);

  const selObjs = objects.filter((o) => selection.includes(o.id));
  const sb = selectionBounds(selObjs);
  if (!sb) return null;

  const boolable = selObjs.filter((o) => !o.raster);

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
      };
      const removed = new Set(boolable.map((o) => o.id));
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

  return (
    <div className="xf">
      <div className="xf__title">Transform · {selection.length} selected</div>
      <div className="xf__grid">
        {field("X", sb.x, (v) => applyGroup({ ...sb, x: v }))}
        {field("Y", sb.y, (v) => applyGroup({ ...sb, y: v }))}
        {field("W", sb.w, (v) => applyGroup({ ...sb, w: Math.max(0.1, v) }))}
        {field("H", sb.h, (v) => applyGroup({ ...sb, h: Math.max(0.1, v) }))}
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
