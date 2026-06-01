import { useState } from "react";
import { useStore } from "../state/store";
import { saveMachine, setOnboarded } from "../lib/ipc";
import MachineForm, { newMachine } from "./MachineForm";

export default function Onboarding() {
  const setConfig = useStore((s) => s.setConfig);
  const config = useStore((s) => s.config);
  const [step, setStep] = useState(0);
  const [ackSafety, setAckSafety] = useState(false);
  const [machine, setMachine] = useState(newMachine());

  const hasMachine = (config?.machines.length ?? 0) > 0;

  async function finish() {
    if (!hasMachine) {
      setConfig(await saveMachine(machine));
    }
    setConfig(await setOnboarded(true));
  }

  return (
    <div className="onboard">
      <div className="onboard__card">
        <div className="onboard__brand">
          <span className="onboard__ghost">◐</span> GhostSlicer
        </div>

        {step === 0 && (
          <>
            <h1>Welcome</h1>
            <p>
              GhostSlicer turns vector art and images into laser G-code and streams it
              to your GRBL controller. Let's set up your machine in a couple of steps.
            </p>
            <div className="onboard__nav">
              <button className="btn--go" onClick={() => setStep(1)}>
                Get started →
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1>⚠️ Laser safety</h1>
            <ul className="onboard__safety">
              <li>Wear goggles rated for your laser's wavelength (~450 nm for blue diodes). Reflections blind too.</li>
              <li>Run inside an enclosure with active fume extraction.</li>
              <li>Never leave a running job unattended — keep a fire extinguisher nearby.</li>
              <li>Wire a hardware interlock / E-stop. The software E-STOP is a backup, not a substitute.</li>
            </ul>
            <label className="onboard__ack">
              <input
                type="checkbox"
                checked={ackSafety}
                onChange={(e) => setAckSafety(e.target.checked)}
              />
              <span>I understand and will operate my laser safely.</span>
            </label>
            <div className="onboard__nav">
              <button onClick={() => setStep(0)}>← Back</button>
              <button className="btn--go" disabled={!ackSafety} onClick={() => setStep(2)}>
                Continue →
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>{hasMachine ? "You're set" : "Add your machine"}</h1>
            {hasMachine ? (
              <p>You already have a machine configured. You can add more later from the toolbar.</p>
            ) : (
              <MachineForm value={machine} onChange={setMachine} />
            )}
            <div className="onboard__nav">
              <button onClick={() => setStep(1)}>← Back</button>
              <button className="btn--go" onClick={finish}>
                Finish
              </button>
            </div>
          </>
        )}

        <div className="onboard__dots">
          {[0, 1, 2].map((i) => (
            <span key={i} className={i === step ? "on" : ""} />
          ))}
        </div>
      </div>
    </div>
  );
}
