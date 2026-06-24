/// CoreXY forward kinematics: cartesian (x, y) -> motor words (A, B).
/// Matches GRBL's built-in `#define COREXY`, so a cartesian GRBL fed these
/// values moves identically to a CoreXY-firmware machine fed plain x/y.
#[inline]
pub fn corexy_fwd(p: [f64; 2]) -> [f64; 2] {
    [p[0] + p[1], p[0] - p[1]]
}

/// CoreXY inverse kinematics: motor position (A, B) -> cartesian (x, y).
/// Used to turn the motor-space position GRBL reports back into true x/y.
#[inline]
pub fn corexy_inv(p: [f64; 2]) -> [f64; 2] {
    [(p[0] + p[1]) / 2.0, (p[0] - p[1]) / 2.0]
}

pub struct GcodeBuilder {
    out: String,
    lines: usize,

    cut_secs: f64,
    travel_mm: f64,
    travel_feed: f64,
    last: Option<[f64; 2]>,
    corexy: bool,
}

impl GcodeBuilder {
    pub fn new(travel_feed: f64) -> Self {
        let mut b = Self {
            out: String::new(),
            lines: 0,
            cut_secs: 0.0,
            travel_mm: 0.0,
            travel_feed: travel_feed.max(1.0),
            last: None,
            corexy: false,
        };
        b.raw("; FluidBurn G-code");
        b.raw("G21");
        b.raw("G90");
        b.raw("G17");
        b.raw("M5 S0");
        b
    }

    pub fn set_corexy(&mut self, on: bool) {
        self.corexy = on;
    }

    /// Map a cartesian point to the coordinates actually emitted in G-code.
    fn emit(&self, p: [f64; 2]) -> [f64; 2] {
        if self.corexy {
            corexy_fwd(p)
        } else {
            p
        }
    }

    pub fn raw(&mut self, line: &str) {
        self.out.push_str(line);
        self.out.push('\n');
        self.lines += 1;
    }

    pub fn comment(&mut self, c: &str) {
        self.raw(&format!("; {c}"));
    }

    pub fn layer_header(&mut self, name: &str, dynamic: bool, s: f64) {
        self.comment(&format!("layer: {name}"));
        let m = if dynamic { "M4" } else { "M3" };
        self.raw(&format!("{m} S{}", fmt(s.round())));
    }

    pub fn travel(&mut self, p: [f64; 2]) {
        if let Some(last) = self.last {
            self.travel_mm += dist(last, p);
        }
        let e = self.emit(p);
        self.raw(&format!("G0 X{} Y{}", fmt(e[0]), fmt(e[1])));
        self.last = Some(p);
    }

    pub fn cut_to(&mut self, p: [f64; 2], f: f64, emit_feed: bool) {
        if let Some(last) = self.last {
            self.cut_secs += dist(last, p) / f.max(1.0) * 60.0;
        }
        let e = self.emit(p);
        if emit_feed {
            self.raw(&format!("G1 X{} Y{} F{}", fmt(e[0]), fmt(e[1]), fmt(f)));
        } else {
            self.raw(&format!("G1 X{} Y{}", fmt(e[0]), fmt(e[1])));
        }
        self.last = Some(p);
    }

    pub fn laser_off(&mut self) {
        self.raw("M5 S0");
    }

    pub fn finish(mut self) -> (String, usize, f64) {
        self.laser_off();
        self.raw("G0 X0 Y0");
        let est = self.cut_secs + self.travel_mm / self.travel_feed * 60.0;
        (self.out, self.lines, est)
    }
}

pub fn fmt(v: f64) -> String {
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-0" {
        "0".to_string()
    } else {
        s.to_string()
    }
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}
