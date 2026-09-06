import { useState } from "react";
import { useStore } from "../state/store";
import { saveMachine, setOnboarded } from "../lib/ipc";
import MachineForm, { newMachine } from "./MachineForm";

const STEPS = ["Welcome", "Safety", "Bed", "Controller", "First job"];

export default function Onboarding() {
  const setConfig = useStore((s) => s.setConfig);
  const config = useStore((s) => s.config);
  const [step, setStep] = useState(0);
  const [ackSafety, setAckSafety] = useState(false);
  const [machine, setMachine] = useState(newMachine());
  const [saving, setSaving] = useState(false);

  const hasMachine = (config?.machines.length ?? 0) > 0;

  async function finish() {
    setSaving(true);
    try {
      if (!hasMachine) {
        setConfig(await saveMachine(machine));
      }
      setConfig(await setOnboarded(true));
    } finally {
      setSaving(false);
    }
  }

  const back = (to: number) => (
    <button onClick={() => setStep(to)}>← Back</button>
  );
  const next = (to: number, label = "Next →", disabled = false) => (
    <button className="btn--go" disabled={disabled} onClick={() => setStep(to)}>
      {label}
    </button>
  );

  return (
    <div className="onboard">
      <div className="onboard__card">
        <div className="onboard__brand">
          <span className="onboard__icon">◐</span> FluidBurn
        </div>

        {step === 0 && (
          <>
            <h1>Let's get your laser set up</h1>
            <p>
              FluidBurn turns drawings and images into laser G-code and sends it
              to your GRBL controller over USB. The next few screens ask for your
              bed size and a couple of controller settings — nothing here moves
              the machine.
            </p>
            <div className="onboard__nav">{next(1, "Start →")}</div>
          </>
        )}

        {step === 1 && (
          <>
            <h1>Safety first</h1>
            <ul className="onboard__safety">
              <li>
                <b>Goggles, always.</b> Rated for your wavelength (~450&nbsp;nm
                for a blue diode). Reflections blind too.
              </li>
              <li>
                <b>Enclose it and extract the fumes.</b>
              </li>
              <li>
                <b>Never walk away from a running job.</b> Keep an extinguisher
                within reach.
              </li>
              <li>
                <b>Wire a physical E-stop.</b> The one in this app goes over USB
                — it's a convenience, not your safety system.
              </li>
            </ul>
            <label className="onboard__ack">
              <input
                type="checkbox"
                checked={ackSafety}
                onChange={(e) => setAckSafety(e.target.checked)}
              />
              <span>I've read this and I'll run my laser safely.</span>
            </label>
            <div className="onboard__nav">
              {back(0)}
              {next(2, "Next →", !ackSafety)}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>{hasMachine ? "Your machine" : "How big is your bed?"}</h1>
            {hasMachine ? (
              <p>
                You already have a machine profile set up, so there's nothing to
                fill in. You can edit it any time from the toolbar.
              </p>
            ) : (
              <MachineForm value={machine} onChange={setMachine} section="size" />
            )}
            <div className="onboard__nav">
              {back(1)}
              {next(3)}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1>{hasMachine ? "Controller" : "How does your controller behave?"}</h1>
            {hasMachine ? (
              <p>Already configured — skip ahead.</p>
            ) : (
              <>
                <p className="onboard__lede">
                  Defaults suit most Arduino + CNC-shield diode lasers.
                </p>
                <MachineForm value={machine} onChange={setMachine} section="controller" />
              </>
            )}
            <div className="onboard__nav">
              {back(2)}
              {next(4)}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h1>How a job runs</h1>
            <p className="onboard__lede">
              All in the <b>Machine</b> panel, which tells you which step you're
              on as you go.
            </p>
            <ol className="onboard__flow">
              <li>
                <b>Connect</b> — pick your controller's USB port.
              </li>
              <li>
                <b>Map the travel area</b> — jog to each of the four corners and
                capture them, so FluidBurn knows where the edges are. Skippable.
              </li>
              <li>
                <b>Set job zero</b> — jog to where the design should start on the
                material. That point becomes X0 Y0.
              </li>
              <li>
                <b>Import and generate</b> — load a file, set power and speed per
                layer, then Generate G-code.
              </li>
              <li>
                <b>Frame, then run</b> — Frame traces the outline with the beam
                off to check placement.
              </li>
            </ol>
            <div className="onboard__nav">
              {back(3)}
              <button className="btn--go" disabled={saving} onClick={finish}>
                {saving ? "Saving…" : "Open FluidBurn"}
              </button>
            </div>
          </>
        )}

        <div className="onboard__rail">
          {STEPS.map((label, i) => (
            <button
              key={label}
              className={`onboard__rail-step${i === step ? " on" : ""}${
                i < step ? " done" : ""
              }`}
              disabled={i > step}
              onClick={() => setStep(i)}
            >
              <span className="onboard__rail-dot" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
