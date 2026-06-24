pub mod boolean;

use crate::gcode::GcodeBuilder;
use crate::model::{
    CutKind, DocBounds, GcodeResult, GenerateInput, Layer, Polyline, RasterImage,
};

pub fn generate(input: &GenerateInput, raster: Option<&RasterImage>, corexy: bool) -> GcodeResult {
    let mut g = GcodeBuilder::new(input.travel_feed);
    g.set_corexy(corexy);
    let mut all_pts: Vec<Polyline> = Vec::new();

    for layer in input.layers.iter().filter(|l| l.enabled) {
        if layer.id == "raster" {
            if let (Some(img), Some(place)) = (raster, &input.raster) {
                engrave_raster(&mut g, img, layer, input, place.x, place.y, place.scale);
                let w = img.width as f64 / img.dpmm * place.scale;
                let h = img.height as f64 / img.dpmm * place.scale;
                all_pts.push(vec![[place.x, place.y], [place.x + w, place.y + h]]);
            }
        } else if let Some(grp) = input.vectors.iter().find(|v| v.layer_id == layer.id) {
            cut_vector(&mut g, &grp.polylines, layer, input);
            all_pts.extend(grp.polylines.iter().cloned());
        }
    }

    let (gcode, line_count, est_seconds) = g.finish();
    GcodeResult {
        gcode,
        line_count,
        est_seconds,
        bounds: DocBounds::of(&all_pts),
    }
}

fn power_s(layer: &Layer, input: &GenerateInput) -> f64 {
    (input.max_power * layer.power_pct / 100.0).clamp(0.0, input.max_power)
}

fn cut_vector(g: &mut GcodeBuilder, polys: &[Polyline], layer: &Layer, input: &GenerateInput) {
    let s = power_s(layer, input);
    let _ = CutKind::Cut;
    g.layer_header(&layer.name, input.dynamic_power, s);
    for pass in 0..layer.passes.max(1) {
        if layer.passes > 1 {
            g.comment(&format!("pass {}/{}", pass + 1, layer.passes));
        }
        for poly in polys {
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

#[allow(clippy::too_many_arguments)]
fn engrave_raster(
    g: &mut GcodeBuilder,
    raster: &RasterImage,
    layer: &Layer,
    input: &GenerateInput,
    x_off: f64,
    y_off: f64,
    scale: f64,
) {
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

    for row in (0..raster.height).step_by(row_step as usize) {
        let img_y = raster.height - 1 - row;
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
        g.travel([x_off + lead_col as f64 * px_mm, y_mm]);
        g.raw(&format!("G1 F{}", crate::gcode::fmt(layer.feed)));

        for run in ordered {
            let (start, end, s) = *run;
            let x_col = if left_to_right { end } else { start };

            g.raw(&format!(
                "G1 X{} S{}",
                crate::gcode::fmt(x_off + x_col as f64 * px_mm),
                crate::gcode::fmt(s.round())
            ));
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
        };
        let r = generate(&input, None, false);
        assert!(r.gcode.contains("M4 S800"), "dynamic power at 80%");
        assert!(r.gcode.contains("G1 X10 Y0 F600"));
        assert!(r.gcode.contains("G0 X0 Y0"), "parks at origin");
        assert!(r.est_seconds > 0.0);
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
        };
        let r = generate(&input, None, true);
        // (10,0) -> A=x+y=10, B=x-y=10
        assert!(r.gcode.contains("G1 X10 Y10 F600"), "corexy maps (10,0)->(10,10)");
        // (10,10) -> A=20, B=0
        assert!(r.gcode.contains("G1 X20 Y0"), "corexy maps (10,10)->(20,0)");
    }
}
