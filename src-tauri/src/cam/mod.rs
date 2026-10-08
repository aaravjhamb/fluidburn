pub mod boolean;

use crate::gcode::GcodeBuilder;
use crate::model::{
    CutKind, DocBounds, GcodeResult, GenerateInput, Layer, Polyline, RasterImage,
    RasterPlacement,
};

pub fn generate(input: &GenerateInput, raster: Option<&RasterImage>, corexy: bool) -> GcodeResult {
    let mut g = GcodeBuilder::new(input.travel_feed);
    g.set_corexy(corexy);
    g.set_timing(input.accel, input.baud);
    let mut all_pts: Vec<Polyline> = Vec::new();

    for layer in input.layers.iter().filter(|l| l.enabled) {
        if layer.id == "raster" {
            if let (Some(img), Some(place)) = (raster, &input.raster) {
                engrave_raster(&mut g, img, layer, input, place);
                let w = img.width as f64 / img.dpmm * place.scale;
                let h = img.height as f64 / img.dpmm * place.scale;
                all_pts.push(vec![[place.x, place.y], [place.x + w, place.y + h]]);
            }
        } else if let Some(grp) = input.vectors.iter().find(|v| v.layer_id == layer.id) {
            cut_vector(&mut g, &grp.polylines, layer, input);
            all_pts.extend(grp.polylines.iter().cloned());
        }
    }

    let f = g.finish();
    GcodeResult {
        gcode: f.gcode,
        line_count: f.lines,
        est_seconds: f.est_seconds,
        est_profile: f.est_profile,
        bounds: DocBounds::of(&all_pts),
    }
}

/// Trace `b` with the beam off (G0 only) so the operator can watch where the
/// job will land before committing to a cut.
pub fn frame_gcode(b: &DocBounds, feed: f64, corexy: bool) -> String {
    let mut g = GcodeBuilder::new(feed);
    g.set_corexy(corexy);
    g.comment("frame preview - beam off");
    for p in [
        [b.min_x, b.min_y],
        [b.max_x, b.min_y],
        [b.max_x, b.max_y],
        [b.min_x, b.max_y],
        [b.min_x, b.min_y],
    ] {
        g.travel(p);
    }
    g.finish().gcode
}

/// Chord tolerance for thinning imported curves before they become G-code.
/// The importers flatten béziers with a fixed step count, so a small curve
/// turns into dozens of segments a few hundredths of a millimetre long. GRBL
/// on an 8-bit board only plans a few hundred blocks a second, and once lines
/// arrive slower than the head gets through them the planner starves and the
/// machine stutters to a stop mid-curve. Half a typical kerf: anything this
/// close to the true curve is invisible in the cut.
const CURVE_TOLERANCE_MM: f64 = 0.05;

/// Ramer–Douglas–Peucker: drop vertices that lie within `tol` of the chord
/// between their kept neighbours. Endpoints always survive, so closed shapes
/// stay closed and corners are never cut.
pub fn simplify(poly: &Polyline, tol: f64) -> Polyline {
    if poly.len() < 3 {
        return poly.clone();
    }
    let mut keep = vec![false; poly.len()];
    keep[0] = true;
    keep[poly.len() - 1] = true;
    let mut stack = vec![(0usize, poly.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (mut idx, mut max) = (a, 0.0);
        for i in a + 1..b {
            let d = point_segment_dist(poly[i], poly[a], poly[b]);
            if d > max {
                max = d;
                idx = i;
            }
        }
        if max > tol {
            keep[idx] = true;
            stack.push((a, idx));
            stack.push((idx, b));
        }
    }
    poly.iter()
        .zip(keep)
        .filter(|(_, k)| *k)
        .map(|(p, _)| *p)
        .collect()
}

fn point_segment_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    let (qx, qy) = (a[0] + t * dx, a[1] + t * dy);
    ((p[0] - qx).powi(2) + (p[1] - qy).powi(2)).sqrt()
}

fn power_s(layer: &Layer, input: &GenerateInput) -> f64 {
    (input.max_power * layer.power_pct / 100.0).clamp(0.0, input.max_power)
}

fn cut_vector(g: &mut GcodeBuilder, polys: &[Polyline], layer: &Layer, input: &GenerateInput) {
    let s = power_s(layer, input);
    let _ = CutKind::Cut;
    g.layer_header(&layer.name, input.dynamic_power, s);
    let polys: Vec<Polyline> = polys.iter().map(|p| simplify(p, CURVE_TOLERANCE_MM)).collect();
    for pass in 0..layer.passes.max(1) {
        if layer.passes > 1 {
            g.comment(&format!("pass {}/{}", pass + 1, layer.passes));
        }
        for poly in &polys {
            if poly.len() < 2 {
                continue;
            }
            g.travel(poly[0]);
            for (i, &p) in poly.iter().enumerate().skip(1) {
                g.cut_to(p, layer.feed, i == 1);
            }
        }
    }
    g.laser_off();
}

fn engrave_raster(
    g: &mut GcodeBuilder,
    raster: &RasterImage,
    layer: &Layer,
    input: &GenerateInput,
    place: &RasterPlacement,
) {
    let (x_off, y_off, scale) = (place.x, place.y, place.scale);
    let base_s = power_s(layer, input);
    g.layer_header(&layer.name, input.dynamic_power, base_s);

    let px_mm = scale / raster.dpmm.max(0.001);
    // Optional coarser scan pitch: subsample rows so the line interval can be
    // larger than the image's native pixel pitch (0 = every row).
    let row_step = if input.line_interval_mm > 0.0 {
        (input.line_interval_mm / px_mm).round().max(1.0) as u32
    } else {
        1
    };
    let mut left_to_right = true;

    // `left_to_right` tracks image-column order; with flip_x the physical
    // direction inverts, and the serpentine alternation still holds.
    let col_x = |c: u32| -> f64 {
        let c = if place.flip_x { raster.width - c } else { c };
        x_off + c as f64 * px_mm
    };

    // Image rows run top-down while the bed runs bottom-up, so an unflipped
    // engrave reads the image backwards; flip_y cancels that.
    for row in (0..raster.height).step_by(row_step as usize) {
        let img_y = if place.flip_y {
            row
        } else {
            raster.height - 1 - row
        };
        let y_mm = y_off + row as f64 * px_mm;

        let runs = encode_row(raster, img_y, base_s);
        if runs.iter().all(|r| r.2 <= 0.0) {
            continue;
        }

        let ordered: Vec<&(u32, u32, f64)> = if left_to_right {
            runs.iter().collect()
        } else {
            runs.iter().rev().collect()
        };

        let lead_col = if left_to_right { 0 } else { raster.width };
        g.travel([col_x(lead_col), y_mm]);
        g.set_feed(layer.feed);

        for run in ordered {
            let (start, end, s) = *run;
            let x_col = if left_to_right { end } else { start };
            g.raster_run(col_x(x_col), s.round());
        }
        left_to_right = !left_to_right;
    }
    g.laser_off();
}

fn encode_row(raster: &RasterImage, img_y: u32, base_s: f64) -> Vec<(u32, u32, f64)> {
    let mut runs = Vec::new();
    let row = img_y as usize * raster.width as usize;
    let mut start = 0u32;
    let mut cur_s = pixel_power(raster.gray[row], base_s);
    for x in 1..raster.width {
        let s = pixel_power(raster.gray[row + x as usize], base_s);
        if (s - cur_s).abs() > f64::EPSILON {
            runs.push((start, x, cur_s));
            start = x;
            cur_s = s;
        }
    }
    runs.push((start, raster.width, cur_s));
    runs
}

#[inline]
fn pixel_power(gray: u8, base_s: f64) -> f64 {

    let darkness = (255 - gray) as f64 / 255.0;
    (base_s * darkness).round()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::VectorGroup;

    fn layer(id: &str, kind: CutKind) -> Layer {
        Layer {
            id: id.into(),
            name: id.into(),
            kind,
            enabled: true,
            feed: 600.0,
            power_pct: 80.0,
            passes: 1,
            color: id.into(),
        }
    }

    #[test]
    fn vector_layer_emits_laser_gcode() {
        let input = GenerateInput {
            layers: vec![layer("#000000", CutKind::Cut)],
            vectors: vec![VectorGroup {
                layer_id: "#000000".into(),
                polylines: vec![vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]],
            }],
            raster: None,
            travel_feed: 6000.0,
            dynamic_power: true,
            max_power: 1000.0,
            line_interval_mm: 0.0,
            accel: 500.0,
            baud: 115_200,
        };
        let r = generate(&input, None, false);
        assert!(r.gcode.contains("M4 S800"), "dynamic power at 80%");
        assert!(r.gcode.contains("G1X10Y0F600"), "first cut carries G1 and F");
        assert!(r.gcode.contains("\nX10Y10\n"), "next cut is modal: no G1, no F");
        assert!(r.gcode.contains("G0X0Y0"), "parks at origin");
        assert!(r.est_seconds > 0.0);
    }

    #[test]
    fn simplify_thins_curves_but_keeps_corners_and_ends() {
        use std::f64::consts::TAU;
        // A 10 mm circle sampled 1000 times: at 0.05 mm chord error about
        // 32 segments reproduce it.
        let fine: Polyline = (0..=1000)
            .map(|i| {
                let t = i as f64 / 1000.0 * TAU;
                [10.0 * t.cos(), 10.0 * t.sin()]
            })
            .collect();
        let s = simplify(&fine, CURVE_TOLERANCE_MM);
        assert!(s.len() > 20 && s.len() < 60, "{} points", s.len());
        assert_eq!(s[0], fine[0]);
        assert_eq!(*s.last().unwrap(), *fine.last().unwrap());

        let line: Polyline = vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]];
        assert_eq!(simplify(&line, CURVE_TOLERANCE_MM).len(), 2, "collinear points go");

        let corner: Polyline = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]];
        assert_eq!(simplify(&corner, CURVE_TOLERANCE_MM), corner, "a real corner stays");
    }

    #[test]
    fn frame_traces_bounds_with_beam_off() {
        let b = DocBounds { min_x: 10.0, min_y: 20.0, max_x: 90.0, max_y: 60.0 };
        let g = frame_gcode(&b, 3000.0, false);
        for corner in ["G0X10Y20", "G0X90Y20", "G0X90Y60", "G0X10Y60"] {
            assert!(g.contains(corner), "frame visits {corner}");
        }
        // Match whole motion words: `G17` in the preamble also starts with
        // "G1", and modal cut lines start straight at the X word.
        let cuts = g.lines().any(|l| {
            l.starts_with("G1X") || l.starts_with("G1F") || l.starts_with('X') || l.starts_with("M4")
        });
        assert!(!cuts, "frame never cuts or enables the laser");
    }

    #[test]
    fn frame_respects_corexy() {
        let b = DocBounds { min_x: 0.0, min_y: 0.0, max_x: 10.0, max_y: 10.0 };
        let g = frame_gcode(&b, 3000.0, true);
        // (10,0) -> A=10, B=10 ; (10,10) -> A=20, B=0
        assert!(g.contains("G0X10Y10"));
        assert!(g.contains("G0X20Y0"));
    }

    #[test]
    fn corexy_transforms_coordinates() {
        let input = GenerateInput {
            layers: vec![layer("#000000", CutKind::Cut)],
            vectors: vec![VectorGroup {
                layer_id: "#000000".into(),
                polylines: vec![vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]],
            }],
            raster: None,
            travel_feed: 6000.0,
            dynamic_power: true,
            max_power: 1000.0,
            line_interval_mm: 0.0,
            accel: 500.0,
            baud: 115_200,
        };
        let r = generate(&input, None, true);
        // (10,0) -> A=x+y=10, B=x-y=10
        assert!(r.gcode.contains("G1X10Y10F600"), "corexy maps (10,0)->(10,10)");
        // (10,10) -> A=20, B=0
        assert!(r.gcode.contains("\nX20Y0\n"), "corexy maps (10,10)->(20,0)");
    }
}
