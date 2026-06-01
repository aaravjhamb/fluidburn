import type { Machine, Origin } from "../lib/ipc";

export const ORIGINS: { value: Origin; label: string }[] = [
  { value: "FrontLeft", label: "Front-left" },
  { value: "FrontRight", label: "Front-right" },
  { value: "BackLeft", label: "Back-left" },
  { value: "BackRight", label: "Back-right" },
];

export function newMachine(): Machine {
  return {
    id: "",
    name: "My Laser",
    bedW: 400,
    bedH: 400,
    origin: "FrontLeft",
    maxFeed: 6000,
    maxPower: 1000,
    homing: false,
    baud: 115200,
  };
}

export default function MachineForm({
  value,
  onChange,
}: {
  value: Machine;
  onChange: (m: Machine) => void;
}) {
  const set = (patch: Partial<Machine>) => onChange({ ...value, ...patch });

  return (
    <div className="mform">
      <label className="mform__row mform__row--wide">
        <span>Name</span>
        <input value={value.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="mform__row">
        <span>Bed width (mm)</span>
        <input
          type="number"
          value={value.bedW}
          onChange={(e) => set({ bedW: Number(e.target.value) })}
        />
      </label>
      <label className="mform__row">
        <span>Bed height (mm)</span>
        <input
          type="number"
          value={value.bedH}
          onChange={(e) => set({ bedH: Number(e.target.value) })}
        />
      </label>
      <label className="mform__row">
        <span>Origin</span>
        <select
          value={value.origin}
          onChange={(e) => set({ origin: e.target.value as Origin })}
        >
          {ORIGINS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="mform__row">
        <span>Max feed (mm/min)</span>
        <input
          type="number"
          value={value.maxFeed}
          onChange={(e) => set({ maxFeed: Number(e.target.value) })}
        />
      </label>
      <label className="mform__row">
        <span>Max power ($30 S)</span>
        <input
          type="number"
          value={value.maxPower}
          onChange={(e) => set({ maxPower: Number(e.target.value) })}
        />
      </label>
      <label className="mform__row">
        <span>Baud</span>
        <select value={value.baud} onChange={(e) => set({ baud: Number(e.target.value) })}>
          {[115200, 250000, 57600].map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>
      <label className="mform__row mform__check">
        <input
          type="checkbox"
          checked={value.homing}
          onChange={(e) => set({ homing: e.target.checked })}
        />
        <span>Has homing / limit switches ($H)</span>
      </label>
    </div>
  );
}
