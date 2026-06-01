use serde::{Deserialize, Serialize};

pub type Point = [f64; 2];
pub type Polyline = Vec<Point>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum CutKind {
    Cut,
    Engrave,
    Score,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: String,
    pub name: String,
    pub kind: CutKind,
    pub enabled: bool,

    pub feed: f64,

    pub power_pct: f64,
    pub passes: u32,
    pub color: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl DocBounds {
    pub fn of(polys: &[Polyline]) -> Self {
        let mut b = DocBounds {
            min_x: f64::MAX,
            min_y: f64::MAX,
            max_x: f64::MIN,
            max_y: f64::MIN,
        };
        for p in polys {
            for &[x, y] in p {
                b.min_x = b.min_x.min(x);
                b.min_y = b.min_y.min(y);
                b.max_x = b.max_x.max(x);
                b.max_y = b.max_y.max(y);
            }
        }
        if b.min_x > b.max_x {
            b = DocBounds::default();
        }
        b
    }
}

#[derive(Debug, Clone, Default)]
pub struct Document {

    #[allow(dead_code)]
    pub id: String,

    pub raster: Option<RasterImage>,
    #[allow(dead_code)]
    pub bounds: DocBounds,
}

#[derive(Debug, Clone)]
pub struct RasterImage {
    pub width: u32,
    pub height: u32,

    pub gray: Vec<u8>,

    pub mm_w: f64,
    pub mm_h: f64,

    pub dpmm: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneObject {
    pub id: String,
    pub layer_id: String,
    pub polylines: Vec<Polyline>,
    pub raster: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub doc_id: String,
    pub bounds: DocBounds,
    pub layers: Vec<Layer>,
    pub objects: Vec<SceneObject>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorGroup {
    pub layer_id: String,

    pub polylines: Vec<Polyline>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterPlacement {
    pub doc_id: String,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateInput {
    pub layers: Vec<Layer>,
    pub vectors: Vec<VectorGroup>,
    pub raster: Option<RasterPlacement>,
    pub travel_feed: f64,
    pub dynamic_power: bool,

    pub max_power: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcodeResult {
    pub gcode: String,
    pub line_count: usize,
    pub est_seconds: f64,
    pub bounds: DocBounds,
}
