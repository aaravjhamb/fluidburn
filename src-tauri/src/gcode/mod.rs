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

/// GRBL's default junction deviation ($11). Sets how fast the planner lets
/// the head round a corner before it has to slow down.
const JUNCTION_DEVIATION_MM: f64 = 0.01;
/// Fallback axis acceleration ($120/$121) when a machine has none saved.
pub const DEFAULT_ACCEL: f64 = 500.0;
pub const DEFAULT_BAUD: u32 = 115_200;
/// Upper bound on `est_profile` samples; enough for a smooth remaining-time
/// readout without shipping one float per line of a raster job.
const PROFILE_SAMPLES: usize = 1024;

/// One planner block: a straight move, in the coordinates actually sent to
/// GRBL (motor space on CoreXY, where a cartesian X move is longer and the
/// feed applies to the motor-space length).
struct Move {
    line: usize,
    dist: f64,
    dir: [f64; 2],
    /// mm/s
    vmax: f64,
    /// A spindle mode change (M3/M4/M5) sits before this move; GRBL syncs the
    /// planner there, so the move starts from rest.
    stop_before: bool,
}

pub struct Finished {
    pub gcode: String,
    pub lines: usize,
    pub est_seconds: f64,
    /// Cumulative estimated seconds sampled at evenly spaced line indices:
    /// `est_profile[k]` is the time to finish the first `k/(len-1)` of the
    /// lines. The last entry equals `est_seconds`.
    pub est_profile: Vec<f64>,
}

pub struct GcodeBuilder {
    out: String,
    lines: usize,

    travel_feed: f64,
    cur_feed: f64,
    accel: f64,
    baud: u32,
    /// Bytes per emitted line (with newline), for the serial-link floor.
    line_bytes: Vec<u32>,
    moves: Vec<Move>,
    barrier_pending: bool,
    last: Option<[f64; 2]>,
    corexy: bool,
    /// Modal motion group GRBL is in after the last line: 0 = G0, 1 = G1.
    /// Lets cut lines drop the `G1` word while it is already in effect.
    motion: Option<u8>,
}

impl GcodeBuilder {
    pub fn new(travel_feed: f64) -> Self {
        let mut b = Self {
            out: String::new(),
            lines: 0,
            travel_feed: travel_feed.max(1.0),
            cur_feed: travel_feed.max(1.0),
            accel: DEFAULT_ACCEL,
            baud: DEFAULT_BAUD,
            line_bytes: Vec::new(),
            moves: Vec::new(),
            barrier_pending: true,
            last: None,
            corexy: false,
            motion: None,
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

    /// Machine parameters the time estimate depends on: axis acceleration in
    /// mm/s² and the serial baud rate the job will stream over.
    pub fn set_timing(&mut self, accel: f64, baud: u32) {
        self.accel = accel.max(1.0);
        self.baud = baud.max(1200);
    }

    /// Record the planner block for a move to `p` at `feed` mm/min and return
    /// the emitted coordinates. Call before `raw`, so `line` is this line.
    fn record_move(&mut self, p: [f64; 2], feed: f64) -> [f64; 2] {
        let e = self.emit(p);
        if let Some(last) = self.last {
            let le = self.emit(last);
            let d = dist(le, e);
            if d > 0.0 {
                self.moves.push(Move {
                    line: self.lines,
                    dist: d,
                    dir: [(e[0] - le[0]) / d, (e[1] - le[1]) / d],
                    vmax: feed.max(1.0) / 60.0,
                    stop_before: self.barrier_pending,
                });
                self.barrier_pending = false;
            }
        }
        self.last = Some(p);
        e
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
        self.line_bytes.push(line.len() as u32 + 1);
    }

    pub fn comment(&mut self, c: &str) {
        self.raw(&format!("; {c}"));
    }

    pub fn layer_header(&mut self, name: &str, dynamic: bool, s: f64) {
        self.comment(&format!("layer: {name}"));
        let m = if dynamic { "M4" } else { "M3" };
        self.raw(&format!("{m} S{}", fmt(s.round())));
        // GRBL synchronises the planner on a spindle mode change.
        self.barrier_pending = true;
    }

    // Motion lines are the bulk of a job and every byte of them crosses the
    // serial link, so they are written tight: no spaces (GRBL discards them
    // before parsing anyway) and no `G1` once G1 is already the modal motion.
    // `G1X10Y0F600` then `X10Y10` is what a 328P gets through fastest.

    pub fn travel(&mut self, p: [f64; 2]) {
        let e = self.record_move(p, self.travel_feed);
        self.raw(&format!("G0X{}Y{}", fmt(e[0]), fmt(e[1])));
        self.motion = Some(0);
    }

    /// `G1` unless G1 is already modal.
    fn g1(&mut self) -> &'static str {
        if self.motion == Some(1) {
            ""
        } else {
            self.motion = Some(1);
            "G1"
        }
    }

    pub fn cut_to(&mut self, p: [f64; 2], f: f64, emit_feed: bool) {
        self.cur_feed = f.max(1.0);
        let e = self.record_move(p, f);
        let g = self.g1();
        if emit_feed {
            self.raw(&format!("{g}X{}Y{}F{}", fmt(e[0]), fmt(e[1]), fmt(f)));
        } else {
            self.raw(&format!("{g}X{}Y{}", fmt(e[0]), fmt(e[1])));
        }
    }

    /// Set the modal feed without moving (`G1F…`), as raster rows do once
    /// per scan line.
    pub fn set_feed(&mut self, f: f64) {
        self.cur_feed = f.max(1.0);
        self.raw(&format!("G1F{}", fmt(f)));
        self.motion = Some(1);
    }

    /// One raster run: cut along the current row to `x` at power `s`, at the
    /// modal feed. Y stays modal on a cartesian machine; on CoreXY both motor
    /// words change for a pure X move, so both are emitted.
    pub fn raster_run(&mut self, x: f64, s: f64) {
        let y = self.last.map(|l| l[1]).unwrap_or(0.0);
        let e = self.record_move([x, y], self.cur_feed);
        let g = self.g1();
        if self.corexy {
            self.raw(&format!("{g}X{}Y{}S{}", fmt(e[0]), fmt(e[1]), fmt(s)));
        } else {
            self.raw(&format!("{g}X{}S{}", fmt(e[0]), fmt(s)));
        }
    }

    pub fn laser_off(&mut self) {
        self.raw("M5 S0");
        self.barrier_pending = true;
    }

    pub fn finish(mut self) -> Finished {
        self.laser_off();
        self.travel([0.0, 0.0]);

        // Two things bound how fast GRBL gets through a line: the motion
        // itself (planned below with acceleration and cornering) and simply
        // receiving the characters over serial, which dominates raster jobs
        // where every pixel run is a line. The sender keeps GRBL's RX buffer
        // full, so each line costs at least its bytes at the link rate.
        let bytes_per_sec = self.baud as f64 / 10.0;
        let mut secs: Vec<f64> = self
            .line_bytes
            .iter()
            .map(|&b| b as f64 / bytes_per_sec)
            .collect();
        for (m, t) in self.moves.iter().zip(plan_times(&self.moves, self.accel)) {
            secs[m.line] = secs[m.line].max(t);
        }

        let mut cum = Vec::with_capacity(secs.len() + 1);
        let mut acc = 0.0;
        cum.push(0.0);
        for s in &secs {
            acc += s;
            cum.push(acc);
        }
        let n = self.lines;
        let k = n.min(PROFILE_SAMPLES).max(1);
        let est_profile: Vec<f64> = (0..=k).map(|j| cum[j * n / k]).collect();

        Finished {
            gcode: self.out,
            lines: n,
            est_seconds: acc,
            est_profile,
        }
    }
}

/// Seconds each move takes once GRBL's planner has run over the whole job:
/// speed through a corner is capped by the junction-deviation rule, and the
/// backward/forward passes make sure every block can brake for the next one
/// and can actually reach its entry speed. Then each block is a trapezoid
/// (or triangle, if it never reaches cruise) in speed over distance.
fn plan_times(moves: &[Move], accel: f64) -> Vec<f64> {
    let n = moves.len();
    // entry[i] is the speed entering move i; entry[n] is the final stop.
    let mut entry = vec![0.0; n + 1];
    for i in 1..n {
        let (p, m) = (&moves[i - 1], &moves[i]);
        if m.stop_before {
            continue;
        }
        let lim = p.vmax.min(m.vmax);
        // GRBL measures the angle against the reversed incoming direction:
        // straight on gives cos = -1, a full reversal gives cos = +1.
        let cos_theta = -(p.dir[0] * m.dir[0] + p.dir[1] * m.dir[1]);
        entry[i] = if cos_theta < -0.999_999 {
            lim
        } else if cos_theta > 0.999_999 {
            0.0
        } else {
            let sin_half = (0.5 * (1.0 - cos_theta)).sqrt();
            (accel * JUNCTION_DEVIATION_MM * sin_half / (1.0 - sin_half))
                .sqrt()
                .min(lim)
        };
    }
    // Backward: a block must be able to decelerate to the next entry speed.
    for i in (0..n).rev() {
        let reach = (entry[i + 1].powi(2) + 2.0 * accel * moves[i].dist).sqrt();
        entry[i] = entry[i].min(reach);
    }
    // Forward: a block can only enter as fast as the previous one got it.
    for i in 1..n {
        let p = &moves[i - 1];
        let reach = (entry[i - 1].powi(2) + 2.0 * accel * p.dist).sqrt();
        entry[i] = entry[i].min(reach).min(p.vmax);
    }
    (0..n)
        .map(|i| block_time(moves[i].dist, entry[i], entry[i + 1], moves[i].vmax, accel))
        .collect()
}

fn block_time(d: f64, v_in: f64, v_out: f64, v_max: f64, a: f64) -> f64 {
    if d <= 0.0 {
        return 0.0;
    }
    let v_max = v_max.max(1e-6);
    // Highest speed reachable if we accelerate then brake within d.
    let peak = ((2.0 * a * d + v_in * v_in + v_out * v_out) / 2.0).sqrt();
    if peak <= v_max {
        (peak - v_in).max(0.0) / a + (peak - v_out).max(0.0) / a
    } else {
        let d_acc = (v_max * v_max - v_in * v_in) / (2.0 * a);
        let d_dec = (v_max * v_max - v_out * v_out) / (2.0 * a);
        (v_max - v_in) / a + (v_max - v_out) / a + (d - d_acc - d_dec).max(0.0) / v_max
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

#[cfg(test)]
mod tests {
    use super::*;

    fn job(points: &[[f64; 2]], feed: f64) -> Finished {
        let mut g = GcodeBuilder::new(6000.0);
        g.set_timing(500.0, 115_200);
        g.layer_header("t", true, 500.0);
        g.travel(points[0]);
        for (i, &p) in points.iter().enumerate().skip(1) {
            g.cut_to(p, feed, i == 1);
        }
        g.finish()
    }

    #[test]
    fn straight_cut_matches_trapezoid() {
        // 100 mm at 10 mm/s with 500 mm/s²: 0.02 s to accelerate, 0.02 s to
        // brake, 99.8 mm of cruise. The park move home at 100 mm/s adds its
        // own trapezoid: 0.2 s up, 0.2 s down, 80 mm cruise.
        let f = job(&[[0.0, 0.0], [100.0, 0.0]], 600.0);
        let cut = 0.02 + 0.02 + 99.8 / 10.0;
        let park = 0.2 + 0.2 + 80.0 / 100.0;
        assert!((f.est_seconds - (cut + park)).abs() < 0.05, "got {}", f.est_seconds);
    }

    #[test]
    fn corners_cost_more_than_a_straight_line() {
        // At 50 mm/s a 1 mm segment can't even reach feed before it has to
        // brake for the reversal, so 100 of them take far longer than one
        // straight 100 mm cut plus its park move (about 8.9 s against 3.3 s).
        let straight = job(&[[0.0, 0.0], [100.0, 0.0]], 3000.0);
        let mut zig = vec![[0.0, 0.0]];
        for i in 1..=100 {
            zig.push([if i % 2 == 1 { 1.0 } else { 0.0 }, 0.0]);
        }
        let zag = job(&zig, 3000.0);
        assert!(zag.est_seconds > straight.est_seconds * 2.0, "{} vs {}", zag.est_seconds, straight.est_seconds);
    }

    #[test]
    fn profile_is_monotonic_and_ends_at_total() {
        let f = job(&[[0.0, 0.0], [50.0, 0.0], [50.0, 50.0], [0.0, 50.0]], 600.0);
        assert_eq!(f.est_profile[0], 0.0);
        assert!(f.est_profile.windows(2).all(|w| w[1] >= w[0]));
        assert_eq!(*f.est_profile.last().unwrap(), f.est_seconds);
        assert_eq!(f.est_profile.len(), f.lines + 1);
    }

    #[test]
    fn serial_rate_floors_short_lines() {
        let mut slow = GcodeBuilder::new(6000.0);
        slow.set_timing(500.0, 9_600);
        let mut fast = GcodeBuilder::new(6000.0);
        fast.set_timing(500.0, 115_200);
        for g in [&mut slow, &mut fast] {
            g.set_feed(3000.0);
            g.travel([0.0, 0.0]);
            for i in 1..=200 {
                g.raster_run(i as f64 * 0.1, 500.0);
            }
        }
        // 200 runs of ~9 bytes: motion-bound at 115200 (about 0.9 s with the
        // park move) but link-bound at 9600 (about 2.3 s).
        let (s, f) = (slow.finish(), fast.finish());
        assert!(s.est_seconds > f.est_seconds * 2.0, "{} vs {}", s.est_seconds, f.est_seconds);
    }
}
