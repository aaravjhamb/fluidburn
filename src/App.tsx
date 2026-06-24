import { useEffect, useState } from "react";
import { useStore } from "./state/store";
import {
  onStatus,
  onProgress,
  onConsole,
  onJobError,
  listPorts,
  getConfig,
} from "./lib/ipc";
import Toolbar from "./components/Toolbar";
import Workspace from "./components/Workspace";
import LayerPanel from "./components/LayerPanel";
import DevicePanel from "./components/DevicePanel";
import MachinesModal from "./components/MachinesModal";
import Onboarding from "./components/Onboarding";

export default function App() {
  const setStatus = useStore((s) => s.setStatus);
  const setProgress = useStore((s) => s.setProgress);
  const pushConsole = useStore((s) => s.pushConsole);
  const setPorts = useStore((s) => s.setPorts);
  const setConfig = useStore((s) => s.setConfig);
  const setJobError = useStore((s) => s.setJobError);
  const jobError = useStore((s) => s.jobError);
  const config = useStore((s) => s.config);

  const [machinesOpen, setMachinesOpen] = useState(false);

  useEffect(() => {
    const unlisteners = Promise.all([
      onStatus(setStatus),
      onProgress(setProgress),
      onConsole(pushConsole),
      onJobError((e) => {
        setProgress(null);
        setJobError(e.message);
      }),
    ]);
    listPorts().then(setPorts).catch(() => {});
    getConfig().then(setConfig).catch(() => {});
    return () => {
      unlisteners.then((us) => us.forEach((u) => u()));
    };
  }, [setStatus, setProgress, pushConsole, setJobError, setPorts, setConfig]);

  if (config && !config.onboarded) {
    return <Onboarding />;
  }

  return (
    <div className="app">
      {jobError && (
        <div className="job-error" role="alert">
          <span>⚠ Job halted — {jobError}</span>
          <button onClick={() => setJobError(null)}>Dismiss</button>
        </div>
      )}
      <Toolbar onOpenMachines={() => setMachinesOpen(true)} />
      <div className="app__body">
        <LayerPanel />
        <Workspace />
        <DevicePanel />
      </div>
      {machinesOpen && <MachinesModal onClose={() => setMachinesOpen(false)} />}
    </div>
  );
}
