use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum MachineState {
    Disconnected,
    Idle,
    Run,
    Hold,
    Jog,
    Alarm,
    Door,
    Home,
    Sleep,
    Check,
}

impl MachineState {
    fn parse(s: &str) -> Self {

        match s.split(':').next().unwrap_or(s) {
            "Idle" => Self::Idle,
            "Run" => Self::Run,
            "Hold" => Self::Hold,
            "Jog" => Self::Jog,
            "Alarm" => Self::Alarm,
            "Door" => Self::Door,
            "Home" => Self::Home,
            "Sleep" => Self::Sleep,
            "Check" => Self::Check,
            _ => Self::Idle,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrblStatus {
    pub state: MachineState,
    pub wpos: [f64; 3],
    pub mpos: [f64; 3],
    pub feed: f64,
    pub power: f64,
}

impl Default for GrblStatus {
    fn default() -> Self {
        Self {
            state: MachineState::Disconnected,
            wpos: [0.0; 3],
            mpos: [0.0; 3],
            feed: 0.0,
            power: 0.0,
        }
    }
}

pub fn parse_status(line: &str, wco: &mut [f64; 3]) -> Option<GrblStatus> {
    let line = line.trim();
    let inner = line.strip_prefix('<')?.strip_suffix('>')?;
    let mut fields = inner.split('|');

    let mut st = GrblStatus {
        state: MachineState::parse(fields.next()?),
        ..Default::default()
    };
    let mut mpos: Option<[f64; 3]> = None;
    let mut wpos: Option<[f64; 3]> = None;

    for field in fields {
        let (key, val) = match field.split_once(':') {
            Some(kv) => kv,
            None => continue,
        };
        match key {
            "MPos" => mpos = parse_vec3(val),
            "WPos" => wpos = parse_vec3(val),
            "WCO" => {
                if let Some(v) = parse_vec3(val) {
                    *wco = v;
                }
            }
            "FS" => {
                let mut it = val.split(',');
                st.feed = it.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                st.power = it.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            }
            "F" => st.feed = val.parse().unwrap_or(0.0),
            _ => {}
        }
    }

    match (mpos, wpos) {
        (Some(m), Some(w)) => {
            st.mpos = m;
            st.wpos = w;
        }
        (Some(m), None) => {
            st.mpos = m;
            st.wpos = [m[0] - wco[0], m[1] - wco[1], m[2] - wco[2]];
        }
        (None, Some(w)) => {
            st.wpos = w;
            st.mpos = [w[0] + wco[0], w[1] + wco[1], w[2] + wco[2]];
        }
        (None, None) => {}
    }
    Some(st)
}

fn parse_vec3(s: &str) -> Option<[f64; 3]> {
    let mut it = s.split(',');
    Some([
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    ])
}

pub fn is_ack(line: &str) -> Option<bool> {
    let l = line.trim();
    if l == "ok" {
        Some(true)
    } else if l.starts_with("error") {
        Some(false)
    } else {
        None
    }
}
