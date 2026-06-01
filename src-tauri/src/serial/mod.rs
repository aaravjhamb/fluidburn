pub mod grbl;

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use grbl::{is_ack, parse_status};

const RX_LIMIT: usize = 127;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    sent: usize,
    total: usize,
    elapsed: f64,
}

enum Cmd {

    Line(String, bool),

    Job(Vec<String>),

    Realtime(u8),
    Pause,
    Resume,
    Cancel,

    Ack(#[allow(dead_code)] bool),
    Shutdown,
}

pub struct Device {
    conn: Mutex<Option<Sender<Cmd>>>,
}

impl Device {
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }

    pub fn connect(&self, app: AppHandle, port: &str, baud: u32) -> anyhow::Result<()> {
        self.disconnect();

        let port_handle = serialport::new(port, baud)
            .timeout(Duration::from_millis(50))
            .open()?;
        let reader_handle = port_handle.try_clone()?;

        let (tx, rx) = mpsc::channel::<Cmd>();

        {
            let app = app.clone();
            let tx = tx.clone();
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
                                    if let Some(ok) = is_ack(&s) {
                                        let _ = tx.send(Cmd::Ack(ok));
                                    }
                                    if s.starts_with('<') {
                                        if let Some(st) = parse_status(&s, &mut wco) {
                                            let _ = app.emit("grbl:status", st);
                                            continue;
                                        }
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
                let mut job_done = 0usize;
                let mut job_start = Instant::now();
                let mut job_active = false;

                let flush = |port: &mut Box<dyn serialport::SerialPort>,
                             queue: &mut VecDeque<(String, bool)>,
                             pending: &mut VecDeque<(usize, bool)>,
                             used: &mut usize| {
                    while let Some((line, _)) = queue.front() {
                        let need = line.len() + 1;
                        if *used + need > RX_LIMIT && !pending.is_empty() {
                            break;
                        }
                        let (line, is_job) = queue.pop_front().unwrap();
                        if port.write_all(line.as_bytes()).is_err()
                            || port.write_all(b"\n").is_err()
                        {
                            return;
                        }
                        let _ = port.flush();
                        pending.push_back((need, is_job));
                        *used += need;
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
                            job_done = 0;
                            job_active = true;
                            job_start = Instant::now();
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
                        }
                        Cmd::Pause => {
                            let _ = port.write_all(&[0x21]);
                            let _ = port.flush();
                        }
                        Cmd::Resume => {
                            let _ = port.write_all(&[0x7e]);
                            let _ = port.flush();
                        }
                        Cmd::Cancel => {
                            queue.clear();
                            pending.clear();
                            used = 0;
                            job_active = false;
                            let _ = port.write_all(&[0x18]);
                            let _ = port.flush();
                            let _ = app.emit("grbl:console", "[job cancelled]".to_string());
                        }
                        Cmd::Ack(_) => {
                            if let Some((len, is_job)) = pending.pop_front() {
                                used = used.saturating_sub(len);
                                if is_job && job_active {
                                    job_done += 1;
                                    let _ = app.emit(
                                        "job:progress",
                                        JobProgress {
                                            sent: job_done,
                                            total: job_total,
                                            elapsed: job_start.elapsed().as_secs_f64(),
                                        },
                                    );
                                    if job_done >= job_total {
                                        job_active = false;
                                        let _ = app.emit(
                                            "grbl:console",
                                            format!(
                                                "[job complete in {:.0}s]",
                                                job_start.elapsed().as_secs_f64()
                                            ),
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
