use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum Origin {
    FrontLeft,
    FrontRight,
    BackLeft,
    BackRight,
}

impl Default for Origin {
    fn default() -> Self {
        Self::FrontLeft
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    pub name: String,

    pub bed_w: f64,
    pub bed_h: f64,

    pub origin: Origin,

    pub max_feed: f64,

    pub max_power: f64,
    pub homing: bool,
    pub baud: u32,

    /// CoreXY / H-bot kinematics. When true, FluidBurn applies the CoreXY
    /// motor transform itself so a plain (cartesian) GRBL drives the machine
    /// correctly. Defaults to false so existing configs keep loading.
    #[serde(default)]
    pub corexy: bool,
}

impl Default for Machine {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New Laser".into(),
            bed_w: 400.0,
            bed_h: 400.0,
            origin: Origin::FrontLeft,
            max_feed: 6000.0,
            max_power: 1000.0,
            homing: false,
            baud: 115200,
            corexy: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub machines: Vec<Machine>,
    pub active_id: Option<String>,
    pub onboarded: bool,
}

impl Config {
    pub fn active(&self) -> Option<&Machine> {
        let id = self.active_id.as_ref()?;
        self.machines.iter().find(|m| &m.id == id)
    }

    pub fn upsert(&mut self, m: Machine) {
        match self.machines.iter_mut().find(|x| x.id == m.id) {
            Some(slot) => *slot = m,
            None => {
                if self.active_id.is_none() {
                    self.active_id = Some(m.id.clone());
                }
                self.machines.push(m);
            }
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.machines.retain(|m| m.id != id);
        if self.active_id.as_deref() == Some(id) {
            self.active_id = self.machines.first().map(|m| m.id.clone());
        }
    }
}

fn config_path(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("config.json"))
}

pub fn load(app: &AppHandle) -> Config {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, cfg: &Config) -> anyhow::Result<()> {
    let path = config_path(app)?;
    fs::write(path, serde_json::to_string_pretty(cfg)?)?;
    Ok(())
}
