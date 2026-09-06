import type { Machine, Origin } from "../lib/ipc";

// Which corner of the bed the controller treats as X0 Y0.
export const ORIGINS: { value: Origin; label: string }[] = [
  { value: "FrontLeft", label: "Front-left — near side, on the left" },
  { value: "FrontRight", label: "Front-right — near side, on the right" },
  { value: "BackLeft", label: "Back-left — far side, on the left" },
  { value: "BackRight", label: "Back-right — far side, on the right" },
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
            <span>Machine name</span>
            <input value={value.name} onChange={(e) => set({ name: e.target.value })} />
            <small>Anything you like — it just labels this profile.</small>
          </label>

          <label className="mform__row">
            <span>Bed width — X (mm)</span>
            <input
              type="number"
              value={value.bedW}
              onChange={(e) => set({ bedW: Number(e.target.value) })}
            />
          </label>
          <label className="mform__row">
            <span>Bed height — Y (mm)</span>
            <input
              type="number"
              value={value.bedH}
              onChange={(e) => set({ bedH: Number(e.target.value) })}
            />
          </label>
          <p className="mform__note mform__note--tight">
            How far the head can actually travel, not the size of the frame. A
            rough guess is fine — you can measure it exactly later under{" "}
            <b>Travel area</b> in the Machine panel.
          </p>

          <label className="mform__row mform__row--wide">
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
            <small>
              &ldquo;Near&rdquo; is the side you stand at. To find the answer:
              stand at the machine and jog X and Y a little in the positive
              direction — the corner the head moves <i>away</i> from is the one
              to pick. Most diode lasers are front-left.
            </small>
          </label>
        </>
      )}

      {show("controller") && (
        <>
          <label className="mform__row">
            <span>Top travel speed (mm/min)</span>
            <input
              type="number"
              value={value.maxFeed}
              onChange={(e) => set({ maxFeed: Number(e.target.value) })}
            />
          </label>
          <label className="mform__row">
            <span>Full-power S value</span>
            <input
              type="number"
              value={value.maxPower}
              onChange={(e) => set({ maxPower: Number(e.target.value) })}
            />
          </label>
          <p className="mform__note mform__note--tight">
            Top speed is used for rapid moves and framing. The S value is
            whatever your controller's <code>$30</code> is set to — layer
            power percentages are scaled against it, so 1000 here means
            <code> S1000</code> is 100&nbsp;%.
          </p>

          <label className="mform__row mform__row--wide">
            <span>Connection speed (baud)</span>
            <select value={value.baud} onChange={(e) => set({ baud: Number(e.target.value) })}>
              {[115200, 250000, 57600].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <small>115200 unless you flashed your board with something else.</small>
          </label>

          <label className="mform__row mform__check">
            <input
              type="checkbox"
              checked={value.homing}
              onChange={(e) => set({ homing: e.target.checked })}
            />
            <span>My machine has homing switches</span>
          </label>
          <p className="mform__note mform__note--tight">
            Tick this if the head can find its own corner with <code>$H</code>.
            Without switches you set the starting point by hand each session —
            that's normal, and FluidBurn walks you through it.
          </p>

          <label className="mform__row mform__check">
            <input
              type="checkbox"
              checked={value.corexy}
              onChange={(e) => set({ corexy: e.target.checked })}
            />
            <span>CoreXY / H-bot belts</span>
          </label>
          <p className="mform__note mform__note--tight">
            Only for frames where both motors move the head diagonally. Leave
            off for a normal gantry where one motor is X and the other is Y.
          </p>

          <label className="mform__row mform__check">
            <input
              type="checkbox"
              checked={value.laserMode}
              onChange={(e) => set({ laserMode: e.target.checked })}
            />
            <span>Laser mode — turn on at connect</span>
          </label>
          <p className="mform__note mform__note--tight">
            Leave this on for a laser. It sets <code>$32=1</code>, which makes
            the controller dim the beam as it slows down. Without it the head
            stops dead at every corner while the beam keeps burning, leaving a
            scorched dot at each vertex. Turn it off only if this is a spindle.
          </p>
        </>
      )}
    </div>
  );
}
