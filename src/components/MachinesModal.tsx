import { useState } from "react";
import { useStore } from "../state/store";
import { saveMachine, deleteMachine, setActiveMachine, type Machine } from "../lib/ipc";
import MachineForm, { newMachine } from "./MachineForm";

export default function MachinesModal({ onClose }: { onClose: () => void }) {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const [editing, setEditing] = useState<Machine | null>(null);

  const machines = config?.machines ?? [];
  const activeId = config?.activeId ?? null;

  async function commit() {
    if (!editing) return;
    setConfig(await saveMachine(editing));
    setEditing(null);
  }
  async function remove(id: string) {
    setConfig(await deleteMachine(id));
  }
  async function activate(id: string) {
    setConfig(await setActiveMachine(id));
  }

  return (
    <div className="modal__scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>Machines</h2>
          <button onClick={onClose}>✕</button>
        </div>

        {editing ? (
          <>
            <MachineForm value={editing} onChange={setEditing} />
            <div className="modal__actions">
              <button onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn--go" onClick={commit}>
                Save machine
              </button>
            </div>
          </>
        ) : (
          <>
            <ul className="mlist">
              {machines.length === 0 && <li className="mlist__empty">No machines yet.</li>}
              {machines.map((m) => (
                <li key={m.id} className="mlist__item">
                  <label className="mlist__pick">
                    <input
                      type="radio"
                      checked={activeId === m.id}
                      onChange={() => activate(m.id)}
                    />
                    <span className="mlist__name">{m.name}</span>
                    <span className="mlist__meta">
                      {m.bedW}×{m.bedH} mm
                    </span>
                  </label>
                  <div className="mlist__btns">
                    <button onClick={() => setEditing({ ...m })}>Edit</button>
                    <button onClick={() => remove(m.id)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="modal__actions">
              <button className="btn--go" onClick={() => setEditing(newMachine())}>
                + Add machine
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
