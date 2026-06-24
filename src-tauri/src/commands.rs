use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, State};

use crate::cam::boolean::{self, Op};
use crate::config::{self, Config, Machine};
use crate::gcode::fmt;
use crate::model::{Document, GcodeResult, GenerateInput, ImportResult, Polyline};
use crate::serial::{self, Device};
use crate::{cam, import};

#[derive(Default)]
pub struct AppState {
    pub device: Device,
    pub docs: Mutex<HashMap<String, Document>>,
    pub counter: AtomicU64,
    pub config: Mutex<Config>,
}

type CmdResult<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// CoreXY setting of the active machine (false if none selected).
fn active_corexy(state: &AppState) -> bool {
    state
        .config
        .lock()
        .unwrap()
        .active()
        .map(|m| m.corexy)
        .unwrap_or(false)
}

/// Push the active machine's CoreXY setting to the serial device so the
/// status reader can inverse-transform reported position.
fn sync_corexy(state: &AppState) {
    state.device.set_corexy(active_corexy(state));
}

#[tauri::command]
pub fn list_ports() -> Vec<String> {
    serial::list_ports()
}

#[tauri::command]
pub fn connect(app: AppHandle, state: State<AppState>, port: String, baud: u32) -> CmdResult<()> {
    sync_corexy(&state);
    state.device.connect(app, &port, baud).map_err(e)
}

#[tauri::command]
pub fn disconnect(state: State<AppState>) -> CmdResult<()> {
    state.device.disconnect();
    Ok(())
}

#[tauri::command]
pub fn send_line(state: State<AppState>, line: String) -> CmdResult<()> {
    state.device.send_line(&line).map_err(e)
}

#[tauri::command]
pub fn send_realtime(state: State<AppState>, byte: u8) -> CmdResult<()> {
    state.device.send_realtime(byte).map_err(e)
}

#[tauri::command]
pub fn jog(state: State<AppState>, dx: f64, dy: f64, feed: f64) -> CmdResult<()> {
    // Jog is a relative (G91) delta; the CoreXY transform is linear so the
    // same forward mapping applies to the delta as to absolute coordinates.
    let (mx, my) = if active_corexy(&state) {
        (dx + dy, dx - dy)
    } else {
        (dx, dy)
    };
    let line = format!("$J=G91 G21 X{} Y{} F{}", fmt(mx), fmt(my), fmt(feed));
    state.device.send_line(&line).map_err(e)
}

#[tauri::command]
pub fn start_job(state: State<AppState>, gcode: String) -> CmdResult<()> {
    state.device.start_job(&gcode).map_err(e)
}

#[tauri::command]
pub fn pause_job(state: State<AppState>) -> CmdResult<()> {
    state.device.pause().map_err(e)
}

#[tauri::command]
pub fn resume_job(state: State<AppState>) -> CmdResult<()> {
    state.device.resume().map_err(e)
}

#[tauri::command]
pub fn cancel_job(state: State<AppState>) -> CmdResult<()> {
    state.device.cancel().map_err(e)
}

#[tauri::command]
pub fn import_file(state: State<AppState>, path: String) -> CmdResult<ImportResult> {
    let id = format!("doc-{}", state.counter.fetch_add(1, Ordering::Relaxed));
    let (doc, result) = import::import(&path, id.clone()).map_err(e)?;
    state.docs.lock().unwrap().insert(id, doc);
    Ok(result)
}

#[tauri::command]
pub fn generate_gcode(state: State<AppState>, input: GenerateInput) -> CmdResult<GcodeResult> {
    let docs = state.docs.lock().unwrap();
    let raster = input
        .raster
        .as_ref()
        .and_then(|p| docs.get(&p.doc_id))
        .and_then(|d| d.raster.as_ref());
    let corexy = state
        .config
        .lock()
        .unwrap()
        .active()
        .map(|m| m.corexy)
        .unwrap_or(false);
    Ok(cam::generate(&input, raster, corexy))
}

#[tauri::command]
pub fn save_gcode(path: String, gcode: String) -> CmdResult<()> {
    std::fs::write(&path, gcode).map_err(e)
}

#[tauri::command]
pub fn boolean_op(op: String, objects: Vec<Vec<Polyline>>) -> CmdResult<Vec<Polyline>> {
    let op = Op::parse(&op).ok_or("unknown boolean op")?;
    Ok(boolean::apply(op, &objects))
}

#[tauri::command]
pub fn get_config(state: State<AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_machine(
    app: AppHandle,
    state: State<AppState>,
    machine: Machine,
) -> CmdResult<Config> {
    let mut cfg = state.config.lock().unwrap();
    let mut machine = machine;
    if machine.id.is_empty() {
        machine.id = format!("m-{}", state.counter.fetch_add(1, Ordering::Relaxed));
    }
    cfg.upsert(machine);
    config::save(&app, &cfg).map_err(e)?;
    let out = cfg.clone();
    drop(cfg);
    sync_corexy(&state);
    Ok(out)
}

#[tauri::command]
pub fn delete_machine(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<Config> {
    let mut cfg = state.config.lock().unwrap();
    cfg.remove(&id);
    config::save(&app, &cfg).map_err(e)?;
    Ok(cfg.clone())
}

#[tauri::command]
pub fn set_active_machine(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> CmdResult<Config> {
    let mut cfg = state.config.lock().unwrap();
    cfg.active_id = Some(id);
    config::save(&app, &cfg).map_err(e)?;
    let out = cfg.clone();
    drop(cfg);
    sync_corexy(&state);
    Ok(out)
}

#[tauri::command]
pub fn set_onboarded(app: AppHandle, state: State<AppState>, value: bool) -> CmdResult<Config> {
    let mut cfg = state.config.lock().unwrap();
    cfg.onboarded = value;
    config::save(&app, &cfg).map_err(e)?;
    Ok(cfg.clone())
}
