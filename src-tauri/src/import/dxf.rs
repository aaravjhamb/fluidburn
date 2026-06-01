use crate::model::Polyline;

const ARC_STEPS_PER_TURN: f64 = 64.0;

pub struct DxfEntity {
    pub layer: String,
    pub polylines: Vec<Polyline>,
}

struct Pair {
    code: i32,
    val: String,
}

pub fn parse(text: &str) -> anyhow::Result<Vec<DxfEntity>> {
    let pairs = tokenize(text);

    let mut i = 0;
    while i + 1 < pairs.len() {
        if pairs[i].code == 0 && pairs[i].val == "SECTION" && pairs[i + 1].code == 2 {
            if pairs[i + 1].val == "ENTITIES" {
                i += 2;
                break;
            }
        }
        i += 1;
    }

    let mut out = Vec::new();

    while i < pairs.len() {
        if pairs[i].code != 0 {
            i += 1;
            continue;
        }
        let kind = pairs[i].val.clone();
        if kind == "ENDSEC" || kind == "EOF" {
            break;
        }

        let start = i + 1;
        let mut end = start;
        while end < pairs.len() && pairs[end].code != 0 {
            end += 1;
        }
        let body = &pairs[start..end];

        match kind.as_str() {
            "LINE" => push(&mut out, body, line_entity(body)),
            "LWPOLYLINE" => push(&mut out, body, lwpolyline(body)),
            "CIRCLE" => push(&mut out, body, circle(body)),
            "ARC" => push(&mut out, body, arc(body)),
            "POLYLINE" => {

                let (poly, next) = polyline(&pairs, end);
                let layer = layer_of(body);
                if poly.len() >= 2 {
                    out.push(DxfEntity { layer, polylines: vec![poly] });
                }
                i = next;
                continue;
            }
            _ => {}
        }
        i = end;
    }
    Ok(out)
}

fn push(out: &mut Vec<DxfEntity>, body: &[Pair], polys: Vec<Polyline>) {
    let polys: Vec<Polyline> = polys.into_iter().filter(|p| p.len() >= 2).collect();
    if !polys.is_empty() {
        out.push(DxfEntity { layer: layer_of(body), polylines: polys });
    }
}

fn tokenize(text: &str) -> Vec<Pair> {
    let mut lines = text.lines();
    let mut pairs = Vec::new();
    while let (Some(code_s), Some(val)) = (lines.next(), lines.next()) {
        if let Ok(code) = code_s.trim().parse::<i32>() {
            pairs.push(Pair { code, val: val.trim().to_string() });
        }
    }
    pairs
}

fn layer_of(body: &[Pair]) -> String {
    body.iter()
        .find(|p| p.code == 8)
        .map(|p| p.val.clone())
        .unwrap_or_else(|| "0".to_string())
}

fn f(body: &[Pair], code: i32) -> Option<f64> {
    body.iter().find(|p| p.code == code).and_then(|p| p.val.parse().ok())
}

fn line_entity(body: &[Pair]) -> Vec<Polyline> {
    match (f(body, 10), f(body, 20), f(body, 11), f(body, 21)) {
        (Some(x1), Some(y1), Some(x2), Some(y2)) => vec![vec![[x1, y1], [x2, y2]]],
        _ => vec![],
    }
}

fn lwpolyline(body: &[Pair]) -> Vec<Polyline> {

    let mut poly = Vec::new();
    let mut pending_x = None;
    for p in body {
        match p.code {
            10 => pending_x = p.val.parse::<f64>().ok(),
            20 => {
                if let (Some(x), Ok(y)) = (pending_x.take(), p.val.parse::<f64>()) {
                    poly.push([x, y]);
                }
            }
            _ => {}
        }
    }
    let closed = f(body, 70).map(|v| (v as i64) & 1 == 1).unwrap_or(false);
    if closed && poly.len() > 1 {
        poly.push(poly[0]);
    }
    vec![poly]
}

fn polyline(pairs: &[Pair], mut i: usize) -> (Polyline, usize) {

    let mut poly = Vec::new();
    while i < pairs.len() {
        if pairs[i].code == 0 {
            let kind = &pairs[i].val;
            if kind == "VERTEX" {
                let start = i + 1;
                let mut end = start;
                while end < pairs.len() && pairs[end].code != 0 {
                    end += 1;
                }
                let body = &pairs[start..end];
                if let (Some(x), Some(y)) = (f(body, 10), f(body, 20)) {
                    poly.push([x, y]);
                }
                i = end;
            } else {

                if kind == "SEQEND" {
                    let start = i + 1;
                    let mut end = start;
                    while end < pairs.len() && pairs[end].code != 0 {
                        end += 1;
                    }
                    i = end;
                }
                break;
            }
        } else {
            i += 1;
        }
    }
    (poly, i)
}

fn circle(body: &[Pair]) -> Vec<Polyline> {
    match (f(body, 10), f(body, 20), f(body, 40)) {
        (Some(cx), Some(cy), Some(r)) => {
            let n = 64;
            let mut poly = Vec::with_capacity(n + 1);
            for k in 0..=n {
                let t = k as f64 / n as f64 * std::f64::consts::TAU;
                poly.push([cx + r * t.cos(), cy + r * t.sin()]);
            }
            vec![poly]
        }
        _ => vec![],
    }
}

fn arc(body: &[Pair]) -> Vec<Polyline> {
    match (f(body, 10), f(body, 20), f(body, 40), f(body, 50), f(body, 51)) {
        (Some(cx), Some(cy), Some(r), Some(a0), Some(a1)) => {
            let start = a0.to_radians();
            let mut sweep = a1.to_radians() - start;

            if sweep <= 0.0 {
                sweep += std::f64::consts::TAU;
            }
            let steps = (ARC_STEPS_PER_TURN * sweep / std::f64::consts::TAU).ceil().max(2.0) as usize;
            let mut poly = Vec::with_capacity(steps + 1);
            for k in 0..=steps {
                let t = start + sweep * (k as f64 / steps as f64);
                poly.push([cx + r * t.cos(), cy + r * t.sin()]);
            }
            vec![poly]
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_line_and_circle_with_layers() {
        let dxf = "0\nSECTION\n2\nENTITIES\n\
                   0\nLINE\n8\ncut\n10\n0\n20\n0\n11\n10\n21\n5\n\
                   0\nCIRCLE\n8\nengrave\n10\n5\n20\n5\n40\n3\n\
                   0\nENDSEC\n0\nEOF\n";
        let ents = parse(dxf).unwrap();
        assert_eq!(ents.len(), 2);
        assert_eq!(ents[0].layer, "cut");
        assert_eq!(ents[0].polylines[0], vec![[0.0, 0.0], [10.0, 5.0]]);
        assert_eq!(ents[1].layer, "engrave");
        assert!(ents[1].polylines[0].len() > 10, "circle subdivided");
    }

    #[test]
    fn parses_closed_lwpolyline() {
        let dxf = "0\nSECTION\n2\nENTITIES\n\
                   0\nLWPOLYLINE\n8\n0\n90\n3\n70\n1\n\
                   10\n0\n20\n0\n10\n10\n20\n0\n10\n10\n20\n10\n\
                   0\nENDSEC\n0\nEOF\n";
        let ents = parse(dxf).unwrap();
        let poly = &ents[0].polylines[0];
        assert_eq!(poly.len(), 4, "3 verts + closing point");
        assert_eq!(poly[0], poly[3]);
    }
}
