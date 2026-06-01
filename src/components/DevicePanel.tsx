import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import {
  listPorts,
  connect,
  disconnect,
  jog,
  home,
  unlock,
  sendLine,
  requestStatus,
} from "../lib/ipc";

const JOG_STEPS = [0.1, 1, 10];
const JOG_FEED = 2000;

export default function DevicePanel() {
  const {
    ports,
    selectedPort,
    baud,
    connected,
    status,
    console: log,
    progress,
    setPorts,
    setSelectedPort,
    setBaud,
    setConnected,
    pushConsole,
  } = useStore();

  const [step, setStep] = useState(1);
  const [cmd, setCmd] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => requestStatus().catch(() => {}), 250);
    return () => clearInterval(id);
  }, [connected]);

  async function refresh() {
    const p = await listPorts();
    setPorts(p);
    if (!selectedPort && p.length) setSelectedPort(p[0]);
  }

  async function toggleConnect() {
    try {
      if (connected) {
        await disconnect();
        setConnected(false);
      } else if (selectedPort) {
        await connect(selectedPort, baud);
        setConnected(true);
        pushConsole(`[serial] connected ${selectedPort} @ ${baud}`);
      }
    } catch (e) {
      pushConsole(`[error] ${e}`);
    }
  }

  return (
    <aside className="panel panel--device">
      <h2>Machine</h2>

      <div className="device__conn">
        <select
          value={selectedPort ?? ""}
          onChange={(e) => setSelectedPort(e.target.value)}
          disabled={connected}
        >
          <option value="">— port —</option>
          {ports.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button onClick={refresh} disabled={connected} title="Rescan ports">
          ⟳
        </button>
        <select
          value={baud}
          onChange={(e) => setBaud(Number(e.target.value))}
          disabled={connected}
        >
          {[115200, 250000, 57600].map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <button
          className={connected ? "btn--on" : ""}
          onClick={toggleConnect}
          disabled={!selectedPort && !connected}
        >
          {connected ? "Disconnect" : "Connect"}
        </button>
      </div>

      <div className="device__dro">
        <div>
          <label>X</label>
          <span>{status.wpos[0].toFixed(2)}</span>
        </div>
        <div>
          <label>Y</label>
          <span>{status.wpos[1].toFixed(2)}</span>
        </div>
        <div>
          <label>F</label>
          <span>{status.feed.toFixed(0)}</span>
        </div>
        <div>
          <label>S</label>
          <span>{status.power.toFixed(0)}</span>
        </div>
      </div>

      <div className="device__jog">
        <div className="jog__steps">
          {JOG_STEPS.map((s) => (
            <button
              key={s}
              className={step === s ? "btn--on" : ""}
              onClick={() => setStep(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="jog__pad">
          <button style={{ gridArea: "u" }} disabled={!connected} onClick={() => jog(0, step, JOG_FEED)}>↑</button>
          <button style={{ gridArea: "l" }} disabled={!connected} onClick={() => jog(-step, 0, JOG_FEED)}>←</button>
          <button style={{ gridArea: "h" }} disabled={!connected} onClick={() => home()} title="Home ($H)">⌂</button>
          <button style={{ gridArea: "r" }} disabled={!connected} onClick={() => jog(step, 0, JOG_FEED)}>→</button>
          <button style={{ gridArea: "d" }} disabled={!connected} onClick={() => jog(0, -step, JOG_FEED)}>↓</button>
        </div>
        <button className="jog__unlock" disabled={!connected} onClick={() => unlock()}>
          Unlock ($X)
        </button>
      </div>

      {progress && (
        <div className="device__progress">
          <div
            className="device__progress-bar"
            style={{ width: `${(progress.sent / Math.max(1, progress.total)) * 100}%` }}
          />
          <span>
            {progress.sent}/{progress.total} · {progress.elapsed.toFixed(0)}s
          </span>
        </div>
      )}

      <div className="device__console" ref={logRef}>
        {log.map((line, i) => (
          <div key={i} className="console__line">
            {line}
          </div>
        ))}
      </div>
      <form
        className="device__cmd"
        onSubmit={(e) => {
          e.preventDefault();
          if (!cmd.trim()) return;
          sendLine(cmd).catch((err) => pushConsole(`[error] ${err}`));
          pushConsole(`> ${cmd}`);
          setCmd("");
        }}
      >
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="$$  $H  G0 X10…"
          disabled={!connected}
        />
        <button type="submit" disabled={!connected}>
          Send
        </button>
      </form>
    </aside>
  );
}
