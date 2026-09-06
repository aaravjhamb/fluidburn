import type { Machine, Origin } from "../lib/ipc";

// Which corner of the bed the controller treats as X0 Y0.
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
    corexy: false,
    laserMode: true,
  };
}

/** Onboarding shows one half at a time; the machines dialog shows everything. */
export type FormSection = "size" | "controller" | "all";

export default function MachineForm({
  value,
  onChange,
  section = "all",
}: {
  value: Machine;
  onChange: (m: Machine) => void;
  section?: FormSection;
}) {
  const set = (patch: Partial<Machine>) => onChange({ ...value, ...patch });
  const show = (s: FormSection) => section === "all" || section === s;

  return (
    <div className="mform">
      {show("size") && (
        <>
          <label className="mform__row mform__row--wide">
            <span>Name</span>
            <input value={value.name} onChange={(e) => set({ name: e.target.value })} />
          </label>

          <label className="mform__row" title="How far the head can travel, not the size of the frame">
            <span>Bed width — X (mm)</span>
            <input
              type="number"
              value={value.bedW}
              onChange={(e) => set({ bedW: Number(e.target.value) })}
            />
          </label>
          <label className="mform__row" title="How far the head can travel, not the size of the frame">
            <span>Bed height — Y (mm)</span>
            <input
              type="number"
              value={value.bedH}
              onChange={(e) => set({ bedH: Number(e.target.value) })}
            />
          </label>

          <label
            className="mform__row mform__row--wide"
            title="Jog X and Y positive — the corner the head moves away from is the one to pick. Front is the side you stand at."
          >
            <span>Which corner is X0 Y0?</span>
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
        </>
      )}

      {show("controller") && (
        <>
          <label className="mform__row" title="Used for rapid moves and framing">
            <span>Top travel speed (mm/min)</span>
            <input
              type="number"
              value={value.maxFeed}
              onChange={(e) => set({ maxFeed: Number(e.target.value) })}
            />
          </label>
          <label className="mform__row" title="Your controller's $30. Layer power percentages scale against it.">
            <span>Full-power S value</span>
            <input
              type="number"
              value={value.maxPower}
              onChange={(e) => set({ maxPower: Number(e.target.value) })}
            />
          </label>

          <label className="mform__row mform__row--wide" title="115200 unless you flashed something else">
            <span>Connection speed (baud)</span>
            <select value={value.baud} onChange={(e) => set({ baud: Number(e.target.value) })}>
              {[115200, 250000, 57600].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>

          <label className="mform__row mform__check" title="The head can find its own corner with $H">
            <input
              type="checkbox"
              checked={value.homing}
              onChange={(e) => set({ homing: e.target.checked })}
            />
            <span>Has homing switches</span>
          </label>

          <label className="mform__row mform__check" title="Both motors move the head diagonally. Off for a normal gantry.">
            <input
              type="checkbox"
              checked={value.corexy}
              onChange={(e) => set({ corexy: e.target.checked })}
            />
            <span>CoreXY / H-bot belts</span>
          </label>

          <label
            className="mform__row mform__check"
            title="Sets $32=1 so the controller dims the beam as it slows. Leave on for a laser — without it every corner gets a scorched dot."
          >
            <input
              type="checkbox"
              checked={value.laserMode}
              onChange={(e) => set({ laserMode: e.target.checked })}
            />
            <span>Laser mode ($32)</span>
          </label>
        </>
      )}
    </div>
  );
}
