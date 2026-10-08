pub mod grbl;

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::gcode::corexy_inv;
use grbl::{error_message, is_ack, parse_status, AckKind};

const RX_LIMIT: usize = 127;

/// `1h 02m 05s`, `4m 05s` or `42s`, matching the frontend's formatDuration.
fn fmt_duration(secs: f64) -> String {
    let total = secs.max(0.0).round() as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}h {m:02}m {s:02}s")
    } else if m > 0 {
        format!("{m}m {s:02}s")
    } else {
        format!("{s}s")
    }
}

/// How long to wait for a welcome banner before pushing init lines anyway.
const INIT_FALLBACK_MS: u64 = 2500;

/// Drain the pending init lines and queue them. A no-op once emptied, so the
/// banner and the fallback timer can both call it safely.
fn send_init(app: &AppHandle, tx: &Sender<Cmd>, init: &Arc<Mutex<Vec<String>>>) {
    let lines: Vec<String> = {
        let mut guard = match init.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.drain(..).collect()
    };
    for l in lines {
        let _ = app.emit("grbl:console", format!("[serial] {l}"));
        let _ = tx.send(Cmd::Line(l, false));
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    sent: usize,
    total: usize,
    elapsed: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobError {
    code: Option<u32>,
    message: String,
}

enum Cmd {

    Line(String, bool),

    Job(Vec<String>),

    Realtime(u8),
    Pause,
    Resume,
    Cancel,

    Ack(AckKind),
    Shutdown,
}

pub struct Device {
    conn: Mutex<Option<Sender<Cmd>>>,
    corexy: Arc<AtomicBool>,
}

impl Device {
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
            corexy: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Set whether reported position should be inverse-transformed from
    /// CoreXY motor space back to cartesian. Shared live with the reader.
    pub fn set_corexy(&self, on: bool) {
        self.corexy.store(on, Ordering::Relaxed);
    }

    /// Open `port` and start the reader/writer threads. `init` holds lines to
    /// push once the controller announces itself (see `INIT_FALLBACK_MS`).
    pub fn connect(
        &self,
        app: AppHandle,
        port: &str,
        baud: u32,
        init: Vec<String>,
    ) -> anyhow::Result<()> {
        self.disconnect();

        let port_handle = serialport::new(port, baud)
            .timeout(Duration::from_millis(50))
            .open()?;
        let reader_handle = port_handle.try_clone()?;

        let (tx, rx) = mpsc::channel::<Cmd>();

        // Init lines are drained exactly once, whichever comes first: the
        // controller's welcome banner, or the fallback timer below for boards
        // that don't reset when the port opens.
        let init = Arc::new(Mutex::new(init));

        {
            let app = app.clone();
            let tx = tx.clone();
            let init = init.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(INIT_FALLBACK_MS));
                send_init(&app, &tx, &init);
            });
        }

        {
            let app = app.clone();
            let tx = tx.clone();
            let corexy = self.corexy.clone();
            let init = init.clone();
            let mut reader = reader_handle;
            thread::spawn(move || {
                let mut buf = [0u8; 512];
                let mut line = Vec::<u8>::with_capacity(128);
                let mut wco = [0.0f64; 3];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            for &b in &buf[..n] {
                                if b == b'\n' {
                                    let s = String::from_utf8_lossy(&line).trim().to_string();
                                    line.clear();
                                    if s.is_empty() {
                                        continue;
                                    }
                                    if let Some(ack) = is_ack(&s) {
                                        let _ = tx.send(Cmd::Ack(ack));
                                    }
                                    if s.starts_with('<') {
                                        if let Some(mut st) = parse_status(&s, &mut wco) {
                                            if corexy.load(Ordering::Relaxed) {
                                                let inv = |p: [f64; 3]| {
                                                    let c = corexy_inv([p[0], p[1]]);
                                                    [c[0], c[1], p[2]]
                                                };
                                                st.mpos = inv(st.mpos);
                                                st.wpos = inv(st.wpos);
                                            }
                                            let _ = app.emit("grbl:status", st);
                                            continue;
                                        }
                                    }
                                    // "Grbl 1.1f ..." / "Grbl 3.7 [FluidNC ...]"
                                    if s.starts_with("Grbl") {
                                        send_init(&app, &tx, &init);
                                    }
                                    let _ = app.emit("grbl:console", s);
                                } else if b != b'\r' {
                                    line.push(b);
                                }
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                        Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            });
        }

        {
            let app = app.clone();
            let mut port = port_handle;
            thread::spawn(move || {
                let mut queue: VecDeque<(String, bool)> = VecDeque::new();
                let mut pending: VecDeque<(usize, bool)> = VecDeque::new();
                let mut used = 0usize;
                let mut job_total = 0usize;
                let mut job_bytes = 0usize;
                let mut job_done = 0usize;
                let mut job_start = Instant::now();
                let mut job_active = false;
                // Feed-hold time is taken out of `elapsed`, otherwise a pause
                // would drag the remaining-time estimate with it.
                let mut paused_at: Option<Instant> = None;
                let mut paused_total = Duration::ZERO;
                let mut last_progress = Instant::now();
                let elapsed_secs = |start: Instant, paused_at: Option<Instant>, paused_total: Duration| {
                    let paused = paused_total + paused_at.map(|p| p.elapsed()).unwrap_or_default();
                    start.elapsed().saturating_sub(paused).as_secs_f64()
                };

                // Character-counting stream: keep GRBL's RX buffer as full as
                // it can be (RX_LIMIT bytes in flight, newline included), and
                // hand everything that fits to the OS in one write. Each
                // write() is a USB CDC transfer, so one per window rather than
                // one per line. There is deliberately no flush/tcdrain either:
                // that blocks until the driver has clocked the bytes out, and
                // the byte count already bounds what can sit in the OS buffer.
                let flush = |port: &mut Box<dyn serialport::SerialPort>,
                             queue: &mut VecDeque<(String, bool)>,
                             pending: &mut VecDeque<(usize, bool)>,
                             used: &mut usize| {
                    let mut batch: Vec<u8> = Vec::new();
                    while let Some((line, _)) = queue.front() {
                        let need = line.len() + 1;
                        if *used + need > RX_LIMIT && !pending.is_empty() {
                            break;
                        }
                        let (line, is_job) = queue.pop_front().unwrap();
                        batch.extend_from_slice(line.as_bytes());
                        batch.push(b'\n');
                        pending.push_back((need, is_job));
                        *used += need;
                    }
                    if !batch.is_empty() {
                        let _ = port.write_all(&batch);
                    }
                };

                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        Cmd::Line(l, is_job) => {
                            queue.push_back((l, is_job));
                            flush(&mut port, &mut queue, &mut pending, &mut used);
                        }
                        Cmd::Job(lines) => {
                            queue.clear();
                            job_total = lines.len();
                            job_bytes = lines.iter().map(|l| l.len() + 1).sum();
                            job_done = 0;
                            job_active = true;
                            job_start = Instant::now();
                            paused_at = None;
                            paused_total = Duration::ZERO;
                            last_progress = Instant::now();
                            for l in lines {
                                queue.push_back((l, true));
                            }
                            let _ = app.emit(
                                "job:progress",
                                JobProgress { sent: 0, total: job_total, elapsed: 0.0 },
                            );
                            flush(&mut port, &mut queue, &mut pending, &mut used);
                        }
                        Cmd::Realtime(b) => {
                            let _ = port.write_all(&[b]);
                            let _ = port.flush();
                            match b {
                                0x21 if paused_at.is_none() => paused_at = Some(Instant::now()),
                                0x7e => {
                                    if let Some(p) = paused_at.take() {
                                        paused_total += p.elapsed();
                                    }
                                }
                                _ => {}
                            }
                        }
                        Cmd::Pause => {
                            let _ = port.write_all(&[0x21]);
                            let _ = port.flush();
                            if paused_at.is_none() {
                                paused_at = Some(Instant::now());
                            }
                        }
                        Cmd::Resume => {
                            let _ = port.write_all(&[0x7e]);
                            let _ = port.flush();
                            if let Some(p) = paused_at.take() {
                                paused_total += p.elapsed();
                            }
                        }
                        Cmd::Cancel => {
                            queue.clear();
                            pending.clear();
                            used = 0;
                            job_active = false;
                            let _ = port.write_all(&[0x18]);
                            let _ = port.flush();
                            let _ = app.emit("grbl:console", "[job] stopped — the rest of the job was thrown away".to_string());
                        }
                        Cmd::Ack(ack) => {
                            if let Some((len, is_job)) = pending.pop_front() {
                                used = used.saturating_sub(len);
                                if let AckKind::Error(code) = ack {
                                    // GRBL/FluidNC rejected a line (error:N). Halt the
                                    // job and kill the laser rather than streaming on.
                                    queue.clear();
                                    pending.clear();
                                    used = 0;
                                    if job_active {
                                        job_active = false;
                                        let _ = port.write_all(b"M5 S0\n");
                                        let _ = port.flush();
                                        let message = error_message(code);
                                        let _ = app.emit(
                                            "grbl:console",
                                            format!("[job] stopped by the controller — {message}"),
                                        );
                                        let _ = app.emit("job:error", JobError { code, message });
                                    }
                                    continue;
                                }
                                if is_job && job_active {
                                    job_done += 1;
                                    let finished = job_done >= job_total;
                                    // A raster job acks hundreds of lines a second; the
                                    // UI only needs a handful of updates in that time.
                                    if finished || last_progress.elapsed() >= Duration::from_millis(100) {
                                        last_progress = Instant::now();
                                        let _ = app.emit(
                                            "job:progress",
                                            JobProgress {
                                                sent: job_done,
                                                total: job_total,
                                                elapsed: elapsed_secs(job_start, paused_at, paused_total),
                                            },
                                        );
                                    }
                                    if finished {
                                        job_active = false;
                                        // Throughput goes in the log on purpose: an
                                        // 8-bit GRBL tops out around 400 lines/s, so
                                        // a curvy job averaging more than that is
                                        // starving the planner no matter how it is
                                        // sent.
                                        let secs = elapsed_secs(job_start, paused_at, paused_total);
                                        let rate = if secs > 0.0 {
                                            format!(
                                                " · {:.0} lines/s · {:.1} KB/s",
                                                job_total as f64 / secs,
                                                job_bytes as f64 / secs / 1000.0
                                            )
                                        } else {
                                            String::new()
                                        };
                                        let _ = app.emit(
                                            "grbl:console",
                                            format!("[job] finished in {}{rate}", fmt_duration(secs)),
                                        );
                                    }
                                }
                            }
                            flush(&mut port, &mut queue, &mut pending, &mut used);
                        }
                        Cmd::Shutdown => break,
                    }
                }
            });
        }

        *self.conn.lock().unwrap() = Some(tx);
        Ok(())
    }

    pub fn disconnect(&self) {
        if let Some(tx) = self.conn.lock().unwrap().take() {
            let _ = tx.send(Cmd::Shutdown);
        }
    }

    fn send(&self, cmd: Cmd) -> anyhow::Result<()> {
        let guard = self.conn.lock().unwrap();
        let tx = guard.as_ref().ok_or_else(|| anyhow::anyhow!("not connected"))?;
        tx.send(cmd).map_err(|_| anyhow::anyhow!("device disconnected"))?;
        Ok(())
    }

    pub fn send_line(&self, line: &str) -> anyhow::Result<()> {
        self.send(Cmd::Line(line.to_string(), false))
    }

    pub fn send_realtime(&self, byte: u8) -> anyhow::Result<()> {
        self.send(Cmd::Realtime(byte))
    }

    pub fn start_job(&self, gcode: &str) -> anyhow::Result<()> {
        let lines: Vec<String> = gcode
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        self.send(Cmd::Job(lines))
    }

    pub fn pause(&self) -> anyhow::Result<()> {
        self.send(Cmd::Pause)
    }
    pub fn resume(&self) -> anyhow::Result<()> {
        self.send(Cmd::Resume)
    }
    pub fn cancel(&self) -> anyhow::Result<()> {
        self.send(Cmd::Cancel)
    }
}

impl Default for Device {
    fn default() -> Self {
        Self::new()
    }
}

pub fn list_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|ports| {
            let mut names: Vec<String> = ports
                .into_iter()
                .map(|p| p.port_name)

                .filter(|n| !n.starts_with("/dev/tty.") || cfg!(not(target_os = "macos")))
                .collect();
            names.sort();
            names
        })
        .unwrap_or_default()
}
