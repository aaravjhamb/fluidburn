mod dxf;
mod svg;

use std::collections::HashMap;
use std::path::Path;

use crate::model::{
    CutKind, DocBounds, Document, ImportResult, Layer, Polyline, RasterImage, SceneObject,
};

const DEFAULT_DPMM: f64 = 8.0;

pub fn import(path: &str, doc_id: String) -> anyhow::Result<(Document, ImportResult)> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut doc = Document {
        id: doc_id.clone(),
        ..Default::default()
    };
    let mut objects: Vec<SceneObject> = Vec::new();
    let mut layers: Vec<Layer> = Vec::new();

    match ext.as_str() {
        "svg" => {
            let text = std::fs::read_to_string(path)?;
            let svg_objects = svg::parse(&text)?;

            for (i, o) in svg_objects.into_iter().enumerate() {
                if !layers.iter().any(|l| l.id == o.color) {
                    layers.push(vector_layer(&o.color));
                }
                objects.push(SceneObject {
                    id: format!("o-{i}"),
                    layer_id: o.color.clone(),
                    polylines: o.polylines,
                    raster: false,
                });
            }
        }
        "png" | "jpg" | "jpeg" | "bmp" => {
            let raster = load_raster(path)?;
            objects.push(SceneObject {
                id: "raster-0".into(),
                layer_id: "raster".into(),
                polylines: vec![footprint(raster.mm_w, raster.mm_h)],
                raster: true,
            });
            layers.push(raster_layer());
            doc.raster = Some(raster);
        }
        "dxf" => {
            let text = std::fs::read_to_string(path)?;
            let mut layer_color: HashMap<String, String> = HashMap::new();
            for (i, ent) in dxf::parse(&text)?.into_iter().enumerate() {
                let color = match layer_color.get(&ent.layer) {
                    Some(c) => c.clone(),
                    None => {
                        let c = PALETTE[layer_color.len() % PALETTE.len()].to_string();
                        layer_color.insert(ent.layer.clone(), c.clone());
                        c
                    }
                };
                if !layers.iter().any(|l| l.id == color) {
                    layers.push(named_layer(&color, &ent.layer));
                }
                objects.push(SceneObject {
                    id: format!("o-{i}"),
                    layer_id: color,
                    polylines: ent.polylines,
                    raster: false,
                });
            }
        }
        other => anyhow::bail!("unsupported file type: .{other}"),
    }

    let all: Vec<Polyline> = objects.iter().flat_map(|o| o.polylines.clone()).collect();
    let bounds = DocBounds::of(&all);
    doc.bounds = bounds;

    let result = ImportResult {
        doc_id,
        bounds,
        layers,
        objects,
    };
    Ok((doc, result))
}

fn footprint(w: f64, h: f64) -> Polyline {
    vec![[0.0, 0.0], [w, 0.0], [w, h], [0.0, h], [0.0, 0.0]]
}

fn load_raster(path: &str) -> anyhow::Result<RasterImage> {
    let img = image::open(path)?.to_luma8();
    let (w, h) = (img.width(), img.height());
    Ok(RasterImage {
        width: w,
        height: h,
        gray: img.into_raw(),
        mm_w: w as f64 / DEFAULT_DPMM,
        mm_h: h as f64 / DEFAULT_DPMM,
        dpmm: DEFAULT_DPMM,
    })
}

fn vector_layer(color: &str) -> Layer {
    let kind = if is_dark(color) {
        CutKind::Cut
    } else {
        CutKind::Score
    };
    Layer {
        id: color.to_string(),
        name: format!("{} {color}", kind_label(kind)),
        kind,
        enabled: true,
        feed: if kind == CutKind::Cut { 600.0 } else { 1200.0 },
        power_pct: if kind == CutKind::Cut { 90.0 } else { 40.0 },
        passes: 1,
        color: color.to_string(),
    }
}

const PALETTE: [&str; 6] = ["#000000", "#ff0000", "#0000ff", "#00aa00", "#aa00aa", "#ff8800"];

fn named_layer(color: &str, name: &str) -> Layer {
    let kind = if is_dark(color) {
        CutKind::Cut
    } else {
        CutKind::Score
    };
    Layer {
        id: color.to_string(),
        name: format!("{name} ({})", kind_label(kind)),
        kind,
        enabled: true,
        feed: if kind == CutKind::Cut { 600.0 } else { 1200.0 },
        power_pct: if kind == CutKind::Cut { 90.0 } else { 40.0 },
        passes: 1,
        color: color.to_string(),
    }
}

fn raster_layer() -> Layer {
    Layer {
        id: "raster".into(),
        name: "Engrave (image)".into(),
        kind: CutKind::Engrave,
        enabled: true,
        feed: 3000.0,
        power_pct: 60.0,
        passes: 1,
        color: "#888888".into(),
    }
}

fn kind_label(k: CutKind) -> &'static str {
    match k {
        CutKind::Cut => "Cut",
        CutKind::Engrave => "Engrave",
        CutKind::Score => "Score",
    }
}

fn is_dark(hex: &str) -> bool {
    let h = hex.trim_start_matches('#');
    if h.len() >= 6 {
        let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(0) as u32;
        let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(0) as u32;
        let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(0) as u32;
        (r + g + b) / 3 < 64
    } else {
        hex.eq_ignore_ascii_case("black") || hex == "#000"
    }
}
