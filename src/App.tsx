import { Suspense, lazy, useEffect, useState } from "react";
import { useStore } from "./state/store";
import {
  onStatus,
  onProgress,
  onConsole,
  onJobError,
  listPorts,
  getConfig,
} from "./lib/ipc";
import { revealWindow } from "./lib/window";
import Toolbar from "./components/Toolbar";
import Workspace from "./components/Workspace";
import LayerPanel from "./components/LayerPanel";
import DevicePanel from "./components/DevicePanel";

// Cold paths: the onboarding wizard runs once per install and the machines
// modal only opens on demand, so neither belongs in the startup chunk.
const MachinesModal = lazy(() => import("./components/MachinesModal"));
const Onboarding = lazy(() => import("./components/Onboarding"));

/**
 * Mounted as a sibling of the first real screen, so its effect runs only once
 * that screen has committed. It waits one frame for the webview to paint,
 * shows the native window, and only then starts the serial port scan: the
 * scan is not needed for first paint, and keeping it off the critical path
 * means its IPC response and re-render land after the user already sees UI.
 */
function Reveal() {
  const setPorts = useStore((s) => s.setPorts);
  useEffect(() => {
    let cancelled = false;
    requestAnimationFrame(() => {
      revealWindow().finally(() => {
        if (!cancelled) listPorts().then(setPorts).catch(() => {});
      });
    });
    return () => {
      cancelled = true;
    };
  }, [setPorts]);
  return null;
}

export default function App() {
  const setStatus = useStore((s) => s.setStatus);
  const setProgress = useStore((s) => s.setProgress);
  const pushConsole = useStore((s) => s.pushConsole);
  const setConfig = useStore((s) => s.setConfig);
  const setJobError = useStore((s) => s.setJobError);
  const jobError = useStore((s) => s.jobError);
  const config = useStore((s) => s.config);
  const setSystemDark = useStore((s) => s.setSystemDark);
  const theme = useStore((s) => s.resolvedTheme());

  const [machinesOpen, setMachinesOpen] = useState(false);
  // True once get_config has settled either way. Until then nothing is
  // rendered: mounting the full workspace and then swapping it for the
  // onboarding wizard (or re-theming it) would be wasted work on the
  // critical path, and the window is hidden anyway.
  const [configReady, setConfigReady] = useState(false);

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
    getConfig()
      .then(setConfig)
      .catch(() => {})
      .finally(() => setConfigReady(true));
    return () => {
      unlisteners.then((us) => us.forEach((u) => u()));
    };
  }, [setStatus, setProgress, pushConsole, setJobError, setConfig]);

  // Track the OS appearance so the "Auto" setting can follow it live.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [setSystemDark]);

  // Stamped on <html> so the stylesheet can key every colour off one attribute.
  // index.html sets the same attribute before first paint; this keeps it live.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (!configReady) return null;

  if (config && !config.onboarded) {
    return (
      <Suspense fallback={null}>
        <Onboarding />
        <Reveal />
      </Suspense>
    );
  }

  return (
    <>
      <div className="app">
        {jobError && (
          <div className="job-error" role="alert">
            <span>⚠ The job stopped — {jobError}</span>
            <button onClick={() => setJobError(null)}>Dismiss</button>
          </div>
        )}
        <Toolbar onOpenMachines={() => setMachinesOpen(true)} />
        <div className="app__body">
          <LayerPanel />
          <Workspace />
          <DevicePanel />
        </div>
        {machinesOpen && (
          <Suspense fallback={null}>
            <MachinesModal onClose={() => setMachinesOpen(false)} />
          </Suspense>
        )}
      </div>
      <Reveal />
    </>
  );
}
