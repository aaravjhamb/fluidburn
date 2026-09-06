import { useEffect, useRef, useState } from "react";
import { useStore, cornerBox } from "../state/store";
import { saveMachine } from "../lib/ipc";
import {
  listPorts,
  connect,
  disconnect,
  jog,
  unlock,
  setOrigin,
  gotoOrigin,
  sendLine,
  requestStatus,
} from "../lib/ipc";
const JOG_STEPS = [1, 10, 50, 100];
const JOG_FEED = 6000;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// Back row first, so the 2x2 grid reads like the bed seen from above.
const CORNERS = [
  { key: "BL", label: "Back-left" },
  { key: "BR", label: "Back-right" },
  { key: "FL", label: "Front-left" },
  { key: "FR", label: "Front-right" },
] as const;
type CornerKey = (typeof CORNERS)[number]["key"];

// Walk the perimeter rather than hopping across the bed.
const CAPTURE_ORDER: CornerKey[] = ["FL", "FR", "BR", "BL"];

const cornerLabel = (key: CornerKey) =>
  CORNERS.find((c) => c.key === key)!.label.toLowerCase();

// Keep one axis inside the bed. `dir` is the direction "into the bed", learned
// from the first jog after job zero (0 = not yet known). Travel is bounded to
// [0, dir*bed] so you can roam the bed but never cross zero into the rail.
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
    gcode,
    docId,
  } = useStore();

  const [step, setStep] = useState(1);
  const [cmd, setCmd] = useState("");
  const [guard, setGuard] = useState(true);
  const [zeroSet, setZeroSet] = useState(false);
  const [skipMapping, setSkipMapping] = useState(false);
  const dirRef = useRef<[number, number]>([0, 0]);
  const logRef = useRef<HTMLDivElement>(null);

  const machine = activeMachine();
  const mapped = CORNERS.every((c) => corners[c.key]);
  const mappedCount = CORNERS.filter((c) => corners[c.key]).length;
  const box = cornerBox(corners);
  const nextCorner = CAPTURE_ORDER.find((k) => !corners[k]);

  function guide(): { n: number; text: string; warn?: boolean } {
    if (!connected) return { n: 1, text: "Pick your controller's port and press Connect." };
    if (status.state === "Alarm")
      return { n: 1, text: "Controller is in alarm — press Clear alarm.", warn: true };
    if (!mapped && !skipMapping)
      return { n: 2, text: `Jog to the ${cornerLabel(nextCorner!)} corner, then press it below.` };
    if (!zeroSet)
      return { n: 3, text: "Jog to where the design starts, then Set job zero here." };
    if (!docId) return { n: 4, text: "Import a file from the toolbar." };
    if (!gcode) return { n: 4, text: "Set layer power and speed, then Generate G-code." };
    return { n: 5, text: "Frame to check placement, then Run." };
  }
  const g = guide();

  // Mapped corners are measured positions, so they win over the bed size.
  function jogBy(dx: number, dy: number) {
    if (guard && mapped && box) {
      const mp = status.mpos;
      const adx = clamp(mp[0] + dx, box.xmin, box.xmax) - mp[0];
      const ady = clamp(mp[1] + dy, box.ymin, box.ymax) - mp[1];
      if (Math.abs(adx) < 1e-4 && Math.abs(ady) < 1e-4) {
        pushConsole("[limits] blocked — the head is already at the edge of the mapped area");
        return;
      }
      if (Math.abs(adx - dx) > 1e-4 || Math.abs(ady - dy) > 1e-4) {
        pushConsole(
          `[limits] shortened to X${adx.toFixed(2)} Y${ady.toFixed(2)} to stay inside the mapped area`,
        );
      }
      jog(adx, ady, JOG_FEED).catch((e) => pushConsole(`[error] ${e}`));
      return;
    }
    if (guard && zeroSet && machine) {
      const wp = status.wpos;
      const [dirX, dirY] = dirRef.current;
      const x = clampAxis(wp[0], dx, dirX, machine.bedW);
      const y = clampAxis(wp[1], dy, dirY, machine.bedH);
      dirRef.current = [x.dir, y.dir];
      if (Math.abs(x.delta) < 1e-4 && Math.abs(y.delta) < 1e-4) {
        pushConsole("[limits] blocked — the head is a full bed away from job zero");
        return;
      }
      if (Math.abs(x.delta - dx) > 1e-4 || Math.abs(y.delta - dy) > 1e-4) {
        pushConsole(
          `[limits] shortened to X${x.delta.toFixed(2)} Y${y.delta.toFixed(2)} to stay on the bed`,
        );
      }
      jog(x.delta, y.delta, JOG_FEED).catch((e) => pushConsole(`[error] ${e}`));
      return;
    }
    jog(dx, dy, JOG_FEED).catch((e) => pushConsole(`[error] ${e}`));
  }

  function markZero() {
    setOrigin().catch((e) => pushConsole(`[error] ${e}`));
    dirRef.current = [0, 0];
    setZeroSet(true);
    pushConsole("[zero] job zero set at the current position — this spot is now X0 Y0");
    if (!mapped) {
      pushConsole("[zero] jog once in each direction so FluidBurn learns which way the bed lies");
    }
  }

  function goZero() {
    gotoOrigin().catch((e) => pushConsole(`[error] ${e}`));
    pushConsole("[zero] moving back to job zero");
  }

  function captureCorner(key: CornerKey, label: string) {
    const [x, y] = status.mpos;
    setCorner(key, [x, y]);
    pushConsole(`[travel] ${label} corner recorded at machine X${x.toFixed(1)} Y${y.toFixed(1)}`);
  }

  function resetCorners() {
    clearCorners();
    setSkipMapping(false);
    pushConsole("[travel] mapped corners cleared");
  }

  async function useAsBedSize() {
    if (!box || !machine) return;
    const w = Math.round((box.xmax - box.xmin) * 10) / 10;
    const h = Math.round((box.ymax - box.ymin) * 10) / 10;
    try {
      const cfg = await saveMachine({ ...machine, bedW: w, bedH: h });
      setConfig(cfg);
      pushConsole(`[travel] bed size updated to the area you mapped: ${w} × ${h} mm`);
      pushConsole("[travel] now jog to the corner your design should start from and set job zero");
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
        setZeroSet(false);
        setSkipMapping(false);
        clearCorners();
      } else if (selectedPort) {
        await connect(selectedPort, baud);
        setConnected(true);
        pushConsole(`[serial] connected to ${selectedPort} at ${baud} baud`);
      }
    } catch (e) {
      pushConsole(`[error] ${e}`);
    }
  }

  const guardStatus = mapped
    ? "using the four corners you mapped"
    : zeroSet
      ? "using your bed size, measured out from job zero"
      : "waiting — map the corners or set job zero to give it a reference";

  return (
    <aside className="panel panel--device">
      <h2>Machine</h2>

      <div className="device__conn">
        <select
          value={selectedPort ?? ""}
          onChange={(e) => setSelectedPort(e.target.value)}
          disabled={connected}
          title="The USB serial port your controller shows up on"
        >
          <option value="">— choose a port —</option>
          {ports.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          className="device__refresh"
          onClick={refresh}
          disabled={connected}
          title="Look for ports again"
        >
          ⟳
        </button>
        <select
          value={baud}
          onChange={(e) => setBaud(Number(e.target.value))}
          disabled={connected}
          title="Connection speed — 115200 for most GRBL boards"
        >
          {[115200, 250000, 57600].map((b) => (
            <option key={b} value={b}>
              {b} baud
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

      <div className={`device__guide${g.warn ? " device__guide--warn" : ""}`}>
        <span className="device__guide-step">Step {g.n} of 5</span>
        <span className="device__guide-text">{g.text}</span>
      </div>

      <div className="device__dro" title="Position relative to job zero — this is what your design is placed against">
        <div>
          <label>X</label>
          <span>{status.wpos[0].toFixed(2)}</span>
        </div>
        <div>
          <label>Y</label>
          <span>{status.wpos[1].toFixed(2)}</span>
        </div>
        <div>
          <label>Speed</label>
          <span>{status.feed.toFixed(0)}</span>
        </div>
        <div>
          <label>Power</label>
          <span>{status.power.toFixed(0)}</span>
        </div>
      </div>
      <div
        className="device__mpos"
        title="Position as the controller counts it, independent of job zero. This is what mapping the travel area records."
      >
        <span>controller</span>
        <span>X {status.mpos[0].toFixed(1)}</span>
        <span>Y {status.mpos[1].toFixed(1)}</span>
      </div>

      <div className="device__jog">
        <div className="device__section">Move the head</div>
        <div className="jog__steps" title="How far one press of an arrow moves the head">
          {JOG_STEPS.map((s) => (
            <button
              key={s}
              className={step === s ? "btn--on" : ""}
              onClick={() => setStep(s)}
            >
              {s} mm
            </button>
          ))}
        </div>
        <div className="jog__pad">
          <button style={{ gridArea: "u" }} disabled={!connected} onClick={() => jogBy(0, step)} title="Move away from you, toward the back (+Y)">↑</button>
          <button style={{ gridArea: "l" }} disabled={!connected} onClick={() => jogBy(-step, 0)} title="Move left (−X)">←</button>
          <button className="jog__home" style={{ gridArea: "h" }} disabled={!connected} onClick={goZero} title="Go back to job zero">⌂</button>
          <button style={{ gridArea: "r" }} disabled={!connected} onClick={() => jogBy(step, 0)} title="Move right (+X)">→</button>
          <button style={{ gridArea: "d" }} disabled={!connected} onClick={() => jogBy(0, -step)} title="Move toward you, toward the front (−Y)">↓</button>
        </div>
        <button
          className="jog__origin"
          disabled={!connected}
          onClick={markZero}
          title="Make the head's current position X0 Y0 for the job (G10 L20)"
        >
          Set job zero here
        </button>
        <label className="jog__soft" title={guardStatus}>
          <input
            type="checkbox"
            checked={guard}
            onChange={(e) => setGuard(e.target.checked)}
          />
          <span>Stop jogs at the edge of the bed</span>
        </label>

        <div className="jog__cal">
          <div className="device__section">
            Travel area
            <span className="device__section-tag">
              {mapped ? "4/4 ✓" : `${mappedCount}/4`}
            </span>
          </div>
          <div className="jog__cal-bed" title="Jog the head as far as it will go toward a corner, then press that corner">
            <div className="jog__cal-edge">back</div>
            <div className="jog__cal-grid">
            {CORNERS.map((c) => (
              <button
                key={c.key}
                className={
                  corners[c.key]
                    ? "btn--on"
                    : c.key === nextCorner
                      ? "jog__cal-next"
                      : ""
                }
                disabled={!connected}
                onClick={() => captureCorner(c.key, c.label)}
                title={`Record the head's current position as the ${c.label.toLowerCase()} limit of travel`}
              >
                {corners[c.key] ? "✓ " : ""}
                {c.label}
              </button>
            ))}
            </div>
            <div className="jog__cal-edge">front — nearest you</div>
          </div>
          <button
            className="jog__cal-fit"
            disabled={!mapped || !machine}
            onClick={useAsBedSize}
            title="Replace the bed size in your machine profile with the area you just measured"
          >
            Use this as my bed size
          </button>
          {!mapped && !skipMapping && connected && (
            <button
              className="jog__cal-skip"
              onClick={() => {
                setSkipMapping(true);
                pushConsole("[travel] mapping skipped — the edge guard will use your bed size instead");
              }}
              title="Carry on without mapping. The edge guard falls back to your configured bed size."
            >
              Skip for now
            </button>
          )}
          <button
            className="jog__cal-clear"
            disabled={!Object.keys(corners).length && !skipMapping}
            onClick={resetCorners}
          >
            Start over
          </button>
        </div>

        <button
          className="jog__unlock"
          disabled={!connected}
          onClick={() => unlock()}
          title="Clear a GRBL alarm so the machine will move again ($X)"
        >
          Clear alarm
        </button>
      </div>

      {progress && (
        <div className="device__progress">
          <div
            className="device__progress-bar"
            style={{ width: `${(progress.sent / Math.max(1, progress.total)) * 100}%` }}
          />
          <span>
            {progress.sent} of {progress.total} lines · {progress.elapsed.toFixed(0)}s
          </span>
        </div>
      )}

      <div className="device__section device__section--log">Controller log</div>
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
          placeholder="Send a raw command — $$, $H, G0 X10…"
          disabled={!connected}
          title="For GRBL commands FluidBurn has no button for"
        />
        <button type="submit" disabled={!connected}>
          Send
        </button>
      </form>
    </aside>
  );
}
