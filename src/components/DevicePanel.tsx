import { useEffect, useRef, useState } from "react";
import { useStore, cornerBox } from "../state/store";
import { saveMachine } from "../lib/ipc";
import {
  listPorts,
  connect,
  disconnect,
  jog,
  home,
  unlock,
  setOrigin,
  sendLine,
  requestStatus,
} from "../lib/ipc";
const JOG_STEPS = [0.1, 1, 10];
const JOG_FEED = 2000;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// The four travel-limit corners, captured by jogging the head to each one.
const CORNERS = [
  { key: "TL", label: "Top-left" },
  { key: "TR", label: "Top-right" },
  { key: "BL", label: "Bottom-left" },
  { key: "BR", label: "Bottom-right" },
] as const;
type CornerKey = (typeof CORNERS)[number]["key"];

// Soft limit for one axis. `dir` is the captured "into the bed" sign
// (0 = not yet known). Returns the allowed delta and the (possibly newly
// learned) direction. Travel is bounded to [0, dir*bed] from the origin, so
// you can roam the bed but never cross the origin into the rail.
function clampAxis(
  cur: number,
  d: number,
  dir: number,
  bed: number,
): { delta: number; dir: number } {
  if (d === 0) return { delta: 0, dir };
  const sign = dir !== 0 ? dir : Math.sign(d);
  const lo = Math.min(0, sign * bed);
  const hi = Math.max(0, sign * bed);
  const target = clamp(cur + d, lo, hi);
  return { delta: target - cur, dir: sign };
}

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
    activeMachine,
    corners,
    setCorner,
    clearCorners,
    setConfig,
  } = useStore();

  const [step, setStep] = useState(1);
  const [cmd, setCmd] = useState("");
  const [softLimits, setSoftLimits] = useState(true);
  const [originSet, setOriginSet] = useState(false);
  const dirRef = useRef<[number, number]>([0, 0]);
  const logRef = useRef<HTMLDivElement>(null);

  const machine = activeMachine();
  const calibrated = CORNERS.every((c) => corners[c.key]);
  const box = cornerBox(corners);

  // Jog by (dx, dy), enforcing soft limits. Calibrated corners (real measured
  // machine positions) take precedence; otherwise fall back to learning the
  // bed direction from the first jog after setting origin.
  function jogBy(dx: number, dy: number) {
    if (softLimits && calibrated && box) {
      const mp = status.mpos;
      const adx = clamp(mp[0] + dx, box.xmin, box.xmax) - mp[0];
      const ady = clamp(mp[1] + dy, box.ymin, box.ymax) - mp[1];
      if (Math.abs(adx) < 1e-4 && Math.abs(ady) < 1e-4) {
        pushConsole("[soft limit] at calibrated edge — move blocked");
        return;
      }
      if (Math.abs(adx - dx) > 1e-4 || Math.abs(ady - dy) > 1e-4) {
        pushConsole(`[soft limit] clamped to ${adx.toFixed(2)},${ady.toFixed(2)}`);
      }
      jog(adx, ady, JOG_FEED).catch((e) => pushConsole(`[error] ${e}`));
      return;
    }
    if (softLimits && originSet && machine) {
      const wp = status.wpos;
      const [dirX, dirY] = dirRef.current;
      const x = clampAxis(wp[0], dx, dirX, machine.bedW);
      const y = clampAxis(wp[1], dy, dirY, machine.bedH);
      dirRef.current = [x.dir, y.dir];
      if (Math.abs(x.delta) < 1e-4 && Math.abs(y.delta) < 1e-4) {
        pushConsole("[soft limit] at bed edge — move blocked");
        return;
      }
      if (Math.abs(x.delta - dx) > 1e-4 || Math.abs(y.delta - dy) > 1e-4) {
        pushConsole(`[soft limit] clamped to ${x.delta.toFixed(2)},${y.delta.toFixed(2)}`);
      }
      jog(x.delta, y.delta, JOG_FEED).catch((e) => pushConsole(`[error] ${e}`));
      return;
    }
    jog(dx, dy, JOG_FEED).catch((e) => pushConsole(`[error] ${e}`));
  }

  function markOrigin() {
    setOrigin().catch((e) => pushConsole(`[error] ${e}`));
    dirRef.current = [0, 0];
    setOriginSet(true);
    pushConsole("[origin] set here — jog into the bed to lock the safe direction");
  }

  function captureCorner(key: CornerKey, label: string) {
    const [x, y] = status.mpos;
    setCorner(key, [x, y]);
    pushConsole(`[limit] ${label} @ machine X${x.toFixed(1)} Y${y.toFixed(1)}`);
  }

  function resetCorners() {
    clearCorners();
    pushConsole("[limit] corners cleared");
  }

  // Resize the on-screen bed to match the calibrated travel rectangle, so the
  // workspace square maps onto the four corners you measured.
  async function fitBedToArea() {
    if (!box || !machine) return;
    const w = Math.round((box.xmax - box.xmin) * 10) / 10;
    const h = Math.round((box.ymax - box.ymin) * 10) / 10;
    try {
      const cfg = await saveMachine({ ...machine, bedW: w, bedH: h });
      setConfig(cfg);
      pushConsole(`[limit] bed set to calibrated area ${w} × ${h} mm`);
      pushConsole("[limit] jog to the matching corner, then Set origin here");
    } catch (e) {
      pushConsole(`[error] ${e}`);
    }
  }

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
        setOriginSet(false);
        clearCorners();
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
      <div className="device__mpos" title="Machine position — what corner calibration captures">
        <span>machine</span>
        <span>X {status.mpos[0].toFixed(1)}</span>
        <span>Y {status.mpos[1].toFixed(1)}</span>
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
          <button style={{ gridArea: "u" }} disabled={!connected} onClick={() => jogBy(0, step)}>↑</button>
          <button style={{ gridArea: "l" }} disabled={!connected} onClick={() => jogBy(-step, 0)}>←</button>
          <button style={{ gridArea: "h" }} disabled={!connected} onClick={() => home()} title="Home ($H)">⌂</button>
          <button style={{ gridArea: "r" }} disabled={!connected} onClick={() => jogBy(step, 0)}>→</button>
          <button style={{ gridArea: "d" }} disabled={!connected} onClick={() => jogBy(0, -step)}>↓</button>
        </div>
        <button
          className="jog__origin"
          disabled={!connected}
          onClick={markOrigin}
          title="Zero work coordinates at the current head position (G10 L20)"
        >
          Set origin here
        </button>
        <label className="jog__soft" title="Block jogs that would leave the safe area">
          <input
            type="checkbox"
            checked={softLimits}
            onChange={(e) => setSoftLimits(e.target.checked)}
          />
          <span>
            Soft limits{" "}
            {softLimits &&
              (calibrated
                ? "· corners set"
                : originSet
                  ? "· armed (jog-learned)"
                  : "· calibrate corners")}
          </span>
        </label>

        <div className="jog__cal">
          <div className="jog__cal-title">
            Corner limits{calibrated ? " ✓" : ` (${Object.keys(corners).length}/4)`}
          </div>
          <div className="jog__cal-grid">
            {CORNERS.map((c) => (
              <button
                key={c.key}
                className={corners[c.key] ? "btn--on" : ""}
                disabled={!connected}
                onClick={() => captureCorner(c.key, c.label)}
                title={`Jog the head to the ${c.label.toLowerCase()} extent, then capture it`}
              >
                {corners[c.key] ? "✓ " : ""}
                {c.label}
              </button>
            ))}
          </div>
          <button
            className="jog__cal-fit"
            disabled={!calibrated || !machine}
            onClick={fitBedToArea}
            title="Resize the workspace square to the calibrated travel area"
          >
            Fit bed to area
          </button>
          <button
            className="jog__cal-clear"
            disabled={!Object.keys(corners).length}
            onClick={resetCorners}
          >
            Clear corners
          </button>
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
