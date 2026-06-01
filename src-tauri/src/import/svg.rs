use std::collections::BTreeMap;

use crate::model::Polyline;

const BEZIER_STEPS: usize = 24;

#[derive(Clone, Copy)]
struct Affine {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Affine {
    fn id() -> Self {
        Self { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 }
    }
    fn mul(&self, o: &Affine) -> Affine {

        Affine {
            a: self.a * o.a + self.c * o.b,
            b: self.b * o.a + self.d * o.b,
            c: self.a * o.c + self.c * o.d,
            d: self.b * o.c + self.d * o.d,
            e: self.a * o.e + self.c * o.f + self.e,
            f: self.b * o.e + self.d * o.f + self.f,
        }
    }
    fn apply(&self, x: f64, y: f64) -> [f64; 2] {
        [self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f]
    }
    fn scale(sx: f64, sy: f64) -> Affine {
        Affine { a: sx, b: 0.0, c: 0.0, d: sy, e: 0.0, f: 0.0 }
    }
    fn translate(tx: f64, ty: f64) -> Affine {
        Affine { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: tx, f: ty }
    }
    fn rotate(deg: f64) -> Affine {
        let r = deg.to_radians();
        Affine { a: r.cos(), b: r.sin(), c: -r.sin(), d: r.cos(), e: 0.0, f: 0.0 }
    }
}

pub struct SvgObject {
    pub color: String,
    pub polylines: Vec<Polyline>,
}

pub fn parse(svg: &str) -> anyhow::Result<Vec<SvgObject>> {
    let doc = roxmltree::Document::parse(svg)?;
    let root = doc.root_element();

    let view = parse_viewbox(root.attribute("viewBox"));
    let root_ctm = root_transform(root, view);

    let styles = collect_css(root);
    let mut objects: Vec<SvgObject> = Vec::new();
    walk(root, root_ctm, "#000000", &styles, &mut objects);
    Ok(objects)
}

fn root_transform(root: roxmltree::Node, view: Option<[f64; 4]>) -> Affine {

    let phys_w = root.attribute("width").and_then(parse_len_mm);
    let phys_h = root.attribute("height").and_then(parse_len_mm);

    match (view, phys_w, phys_h) {
        (Some([_, _, vw, vh]), Some(pw), Some(ph)) if vw > 0.0 && vh > 0.0 => {
            Affine::scale(pw / vw, ph / vh)
        }

        _ => Affine::scale(25.4 / 96.0, 25.4 / 96.0),
    }
}

fn walk(
    node: roxmltree::Node,
    parent_ctm: Affine,
    inherited_stroke: &str,
    styles: &BTreeMap<String, String>,
    objects: &mut Vec<SvgObject>,
) {
    let ctm = match node.attribute("transform") {
        Some(t) => parent_ctm.mul(&parse_transform(t)),
        None => parent_ctm,
    };
    let stroke = resolve_stroke(node, inherited_stroke, styles);

    let emit = |polys: Vec<Polyline>, objects: &mut Vec<SvgObject>| {
        let polys: Vec<Polyline> = polys.into_iter().filter(|p| p.len() >= 2).collect();
        if !polys.is_empty() {
            objects.push(SvgObject { color: stroke.clone(), polylines: polys });
        }
    };

    match node.tag_name().name() {
        "path" => {
            if let Some(d) = node.attribute("d") {
                emit(flatten_path(d, &ctm), objects);
            }
        }
        "line" => {
            let (x1, y1, x2, y2) = (
                num(node, "x1"),
                num(node, "y1"),
                num(node, "x2"),
                num(node, "y2"),
            );
            emit(vec![vec![ctm.apply(x1, y1), ctm.apply(x2, y2)]], objects);
        }
        "polyline" | "polygon" => {
            let mut pts = parse_points(node.attribute("points").unwrap_or(""), &ctm);
            if node.tag_name().name() == "polygon" && pts.len() > 1 {
                pts.push(pts[0]);
            }
            emit(vec![pts], objects);
        }
        "rect" => {
            let (x, y, w, h) = (num(node, "x"), num(node, "y"), num(node, "width"), num(node, "height"));
            emit(
                vec![vec![
                    ctm.apply(x, y),
                    ctm.apply(x + w, y),
                    ctm.apply(x + w, y + h),
                    ctm.apply(x, y + h),
                    ctm.apply(x, y),
                ]],
                objects,
            );
        }
        "circle" | "ellipse" => {
            let cx = num(node, "cx");
            let cy = num(node, "cy");
            let (rx, ry) = if node.tag_name().name() == "circle" {
                let r = num(node, "r");
                (r, r)
            } else {
                (num(node, "rx"), num(node, "ry"))
            };
            let mut poly = Vec::with_capacity(49);
            for i in 0..=48 {
                let t = i as f64 / 48.0 * std::f64::consts::TAU;
                poly.push(ctm.apply(cx + rx * t.cos(), cy + ry * t.sin()));
            }
            emit(vec![poly], objects);
        }
        _ => {}
    }

    for child in node.children().filter(|n| n.is_element()) {
        walk(child, ctm, &stroke, styles, objects);
    }
}

fn resolve_stroke(
    node: roxmltree::Node,
    inherited: &str,
    styles: &BTreeMap<String, String>,
) -> String {
    if let Some(v) = node.attribute("style").and_then(|s| style_prop(s, "stroke")) {
        if let Some(c) = norm_color(&v) {
            return c;
        }
    }
    if let Some(v) = node.attribute("stroke") {
        if let Some(c) = norm_color(v) {
            return c;
        }
    }
    if let Some(cls) = node.attribute("class") {
        for c in cls.split_whitespace() {
            if let Some(v) = styles.get(&format!(".{c}")) {
                if let Some(c) = norm_color(v) {
                    return c;
                }
            }
        }
    }
    if let Some(v) = styles.get(node.tag_name().name()) {
        if let Some(c) = norm_color(v) {
            return c;
        }
    }
    if let Some(v) = node.attribute("id").and_then(|id| styles.get(&format!("#{id}"))) {
        if let Some(c) = norm_color(v) {
            return c;
        }
    }
    inherited.to_string()
}

fn collect_css(root: roxmltree::Node) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for style in root.descendants().filter(|n| n.tag_name().name() == "style") {
        let css = match style.text() {
            Some(t) => t,
            None => continue,
        };
        for rule in css.split('}') {
            let (selectors, body) = match rule.split_once('{') {
                Some(sb) => sb,
                None => continue,
            };
            let stroke = match style_prop(body, "stroke") {
                Some(s) => s,
                None => continue,
            };
            for sel in selectors.split(',') {
                let sel = sel.trim();
                if !sel.is_empty() {
                    map.insert(sel.to_string(), stroke.clone());
                }
            }
        }
    }
    map
}

fn style_prop(decls: &str, prop: &str) -> Option<String> {
    for decl in decls.split(';') {
        if let Some((k, v)) = decl.split_once(':') {
            if k.trim().eq_ignore_ascii_case(prop) {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

fn norm_color(v: &str) -> Option<String> {
    let v = v.trim();
    if v.is_empty() || v.eq_ignore_ascii_case("none") {
        return None;
    }
    let lower = v.to_ascii_lowercase();
    Some(match lower.as_str() {
        "black" => "#000000".into(),
        "white" => "#ffffff".into(),
        "red" => "#ff0000".into(),
        "green" => "#008000".into(),
        "lime" => "#00ff00".into(),
        "blue" => "#0000ff".into(),
        "yellow" => "#ffff00".into(),
        "cyan" | "aqua" => "#00ffff".into(),
        "magenta" | "fuchsia" => "#ff00ff".into(),

        _ if lower.starts_with('#') && lower.len() == 4 => {
            let b = lower.as_bytes();
            format!(
                "#{0}{0}{1}{1}{2}{2}",
                b[1] as char, b[2] as char, b[3] as char
            )
        }
        _ => lower,
    })
}

fn num(node: roxmltree::Node, attr: &str) -> f64 {
    node.attribute(attr).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0)
}

fn parse_points(s: &str, ctm: &Affine) -> Polyline {
    let nums: Vec<f64> = s
        .split([',', ' ', '\n', '\t', '\r'])
        .filter(|t| !t.is_empty())
        .filter_map(|t| t.parse().ok())
        .collect();
    nums.chunks_exact(2).map(|c| ctm.apply(c[0], c[1])).collect()
}

fn parse_viewbox(s: Option<&str>) -> Option<[f64; 4]> {
    let s = s?;
    let v: Vec<f64> = s
        .split([',', ' '])
        .filter(|t| !t.is_empty())
        .filter_map(|t| t.parse().ok())
        .collect();
    if v.len() == 4 {
        Some([v[0], v[1], v[2], v[3]])
    } else {
        None
    }
}

fn parse_len_mm(s: &str) -> Option<f64> {
    let s = s.trim();
    let (num, unit) = s.split_at(s.find(|c: char| c.is_alphabetic() || c == '%').unwrap_or(s.len()));
    let v: f64 = num.trim().parse().ok()?;
    Some(match unit.trim() {
        "mm" => v,
        "cm" => v * 10.0,
        "in" => v * 25.4,
        "pt" => v * 25.4 / 72.0,
        "pc" => v * 25.4 / 6.0,
        "px" | "" => v * 25.4 / 96.0,
        _ => return None,
    })
}

fn parse_transform(s: &str) -> Affine {
    let mut m = Affine::id();
    let mut rest = s;
    while let Some(open) = rest.find('(') {
        let name = rest[..open].trim().rsplit(|c: char| !c.is_alphabetic()).next().unwrap_or("");
        let close = match rest[open..].find(')') {
            Some(i) => open + i,
            None => break,
        };
        let args: Vec<f64> = rest[open + 1..close]
            .split([',', ' '])
            .filter(|t| !t.is_empty())
            .filter_map(|t| t.parse().ok())
            .collect();
        let t = match name {
            "translate" => Affine::translate(*args.first().unwrap_or(&0.0), *args.get(1).unwrap_or(&0.0)),
            "scale" => {
                let sx = *args.first().unwrap_or(&1.0);
                Affine::scale(sx, *args.get(1).unwrap_or(&sx))
            }
            "rotate" => Affine::rotate(*args.first().unwrap_or(&0.0)),
            "matrix" if args.len() == 6 => Affine {
                a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5],
            },
            _ => Affine::id(),
        };
        m = m.mul(&t);
        rest = &rest[close + 1..];
    }
    m
}

fn flatten_path(d: &str, ctm: &Affine) -> Vec<Polyline> {
    let tokens = tokenize_path(d);
    let mut out: Vec<Polyline> = Vec::new();
    let mut cur: Polyline = Vec::new();
    let mut pos = [0.0f64, 0.0];
    let mut start = [0.0f64, 0.0];
    let mut prev_ctrl: Option<[f64; 2]> = None;

    let mut i = 0;
    let mut cmd = ' ';
    while i < tokens.len() {
        if let Token::Cmd(c) = tokens[i] {
            cmd = c;
            i += 1;
        }
        let rel = cmd.is_ascii_lowercase();
        let up = cmd.to_ascii_uppercase();

        let read = |n: usize, i: &mut usize| -> Option<Vec<f64>> {
            let mut v = Vec::with_capacity(n);
            for _ in 0..n {
                match tokens.get(*i) {
                    Some(Token::Num(x)) => {
                        v.push(*x);
                        *i += 1;
                    }
                    _ => return None,
                }
            }
            Some(v)
        };

        match up {
            'M' => {
                if let Some(v) = read(2, &mut i) {
                    let p = pt(rel, pos, v[0], v[1]);
                    if !cur.is_empty() {
                        out.push(std::mem::take(&mut cur));
                    }
                    pos = p;
                    start = p;
                    cur.push(ctm.apply(p[0], p[1]));
                    cmd = if rel { 'l' } else { 'L' };
                    prev_ctrl = None;
                } else {
                    break;
                }
            }
            'L' => {
                if let Some(v) = read(2, &mut i) {
                    pos = pt(rel, pos, v[0], v[1]);
                    cur.push(ctm.apply(pos[0], pos[1]));
                    prev_ctrl = None;
                } else {
                    break;
                }
            }
            'H' => {
                if let Some(v) = read(1, &mut i) {
                    pos = [if rel { pos[0] + v[0] } else { v[0] }, pos[1]];
                    cur.push(ctm.apply(pos[0], pos[1]));
                    prev_ctrl = None;
                } else {
                    break;
                }
            }
            'V' => {
                if let Some(v) = read(1, &mut i) {
                    pos = [pos[0], if rel { pos[1] + v[0] } else { v[0] }];
                    cur.push(ctm.apply(pos[0], pos[1]));
                    prev_ctrl = None;
                } else {
                    break;
                }
            }
            'C' => {
                if let Some(v) = read(6, &mut i) {
                    let c1 = pt(rel, pos, v[0], v[1]);
                    let c2 = pt(rel, pos, v[2], v[3]);
                    let end = pt(rel, pos, v[4], v[5]);
                    cubic(&mut cur, ctm, pos, c1, c2, end);
                    prev_ctrl = Some(c2);
                    pos = end;
                } else {
                    break;
                }
            }
            'S' => {
                if let Some(v) = read(4, &mut i) {
                    let c1 = reflect(prev_ctrl, pos);
                    let c2 = pt(rel, pos, v[0], v[1]);
                    let end = pt(rel, pos, v[2], v[3]);
                    cubic(&mut cur, ctm, pos, c1, c2, end);
                    prev_ctrl = Some(c2);
                    pos = end;
                } else {
                    break;
                }
            }
            'Q' => {
                if let Some(v) = read(4, &mut i) {
                    let c = pt(rel, pos, v[0], v[1]);
                    let end = pt(rel, pos, v[2], v[3]);
                    quad(&mut cur, ctm, pos, c, end);
                    prev_ctrl = Some(c);
                    pos = end;
                } else {
                    break;
                }
            }
            'T' => {
                if let Some(v) = read(2, &mut i) {
                    let c = reflect(prev_ctrl, pos);
                    let end = pt(rel, pos, v[0], v[1]);
                    quad(&mut cur, ctm, pos, c, end);
                    prev_ctrl = Some(c);
                    pos = end;
                } else {
                    break;
                }
            }
            'A' => {

                if let Some(v) = read(7, &mut i) {
                    let end = pt(rel, pos, v[5], v[6]);
                    arc(&mut cur, ctm, pos, v[0], v[1], v[2], v[3] != 0.0, v[4] != 0.0, end);
                    pos = end;
                    prev_ctrl = None;
                } else {
                    break;
                }
            }
            'Z' => {
                cur.push(ctm.apply(start[0], start[1]));
                pos = start;
                out.push(std::mem::take(&mut cur));
                prev_ctrl = None;
            }
            _ => break,
        }
    }
    if cur.len() >= 2 {
        out.push(cur);
    }
    out
}

fn pt(rel: bool, pos: [f64; 2], x: f64, y: f64) -> [f64; 2] {
    if rel {
        [pos[0] + x, pos[1] + y]
    } else {
        [x, y]
    }
}

fn reflect(prev_ctrl: Option<[f64; 2]>, pos: [f64; 2]) -> [f64; 2] {
    match prev_ctrl {
        Some(c) => [2.0 * pos[0] - c[0], 2.0 * pos[1] - c[1]],
        None => pos,
    }
}

fn cubic(cur: &mut Polyline, ctm: &Affine, p0: [f64; 2], c1: [f64; 2], c2: [f64; 2], p3: [f64; 2]) {
    for s in 1..=BEZIER_STEPS {
        let t = s as f64 / BEZIER_STEPS as f64;
        let mt = 1.0 - t;
        let x = mt * mt * mt * p0[0]
            + 3.0 * mt * mt * t * c1[0]
            + 3.0 * mt * t * t * c2[0]
            + t * t * t * p3[0];
        let y = mt * mt * mt * p0[1]
            + 3.0 * mt * mt * t * c1[1]
            + 3.0 * mt * t * t * c2[1]
            + t * t * t * p3[1];
        cur.push(ctm.apply(x, y));
    }
}

#[allow(clippy::too_many_arguments)]
fn arc(
    cur: &mut Polyline,
    ctm: &Affine,
    p0: [f64; 2],
    mut rx: f64,
    mut ry: f64,
    phi_deg: f64,
    large: bool,
    sweep: bool,
    p1: [f64; 2],
) {
    rx = rx.abs();
    ry = ry.abs();
    if rx < 1e-9 || ry < 1e-9 || (p0[0] == p1[0] && p0[1] == p1[1]) {
        cur.push(ctm.apply(p1[0], p1[1]));
        return;
    }
    let phi = phi_deg.to_radians();
    let (cosp, sinp) = (phi.cos(), phi.sin());

    let dx = (p0[0] - p1[0]) / 2.0;
    let dy = (p0[1] - p1[1]) / 2.0;
    let x1p = cosp * dx + sinp * dy;
    let y1p = -sinp * dx + cosp * dy;

    let lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }

    let sign = if large != sweep { 1.0 } else { -1.0 };
    let num = (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p).max(0.0);
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = sign * (num / den).sqrt();
    let cxp = co * rx * y1p / ry;
    let cyp = -co * ry * x1p / rx;

    let cx = cosp * cxp - sinp * cyp + (p0[0] + p1[0]) / 2.0;
    let cy = sinp * cxp + cosp * cyp + (p0[1] + p1[1]) / 2.0;

    let angle = |ux: f64, uy: f64, vx: f64, vy: f64| -> f64 {
        let dot = ux * vx + uy * vy;
        let len = ((ux * ux + uy * uy) * (vx * vx + vy * vy)).sqrt();
        let mut a = (dot / len).clamp(-1.0, 1.0).acos();
        if ux * vy - uy * vx < 0.0 {
            a = -a;
        }
        a
    };
    let theta1 = angle(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut dtheta = angle(
        (x1p - cxp) / rx,
        (y1p - cyp) / ry,
        (-x1p - cxp) / rx,
        (-y1p - cyp) / ry,
    );
    use std::f64::consts::TAU;
    if !sweep && dtheta > 0.0 {
        dtheta -= TAU;
    } else if sweep && dtheta < 0.0 {
        dtheta += TAU;
    }

    let steps = ((dtheta.abs() / TAU) * (BEZIER_STEPS as f64) * 2.0).ceil().max(2.0) as usize;
    for s in 1..=steps {
        let t = theta1 + dtheta * (s as f64 / steps as f64);
        let x = cx + rx * t.cos() * cosp - ry * t.sin() * sinp;
        let y = cy + rx * t.cos() * sinp + ry * t.sin() * cosp;
        cur.push(ctm.apply(x, y));
    }
}

fn quad(cur: &mut Polyline, ctm: &Affine, p0: [f64; 2], c: [f64; 2], p2: [f64; 2]) {
    for s in 1..=BEZIER_STEPS {
        let t = s as f64 / BEZIER_STEPS as f64;
        let mt = 1.0 - t;
        let x = mt * mt * p0[0] + 2.0 * mt * t * c[0] + t * t * p2[0];
        let y = mt * mt * p0[1] + 2.0 * mt * t * c[1] + t * t * p2[1];
        cur.push(ctm.apply(x, y));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_in_mm_via_viewbox() {

        let svg = r##"<svg width="100mm" height="50mm" viewBox="0 0 100 50">
            <rect x="0" y="0" width="100" height="50" stroke="#000000"/></svg>"##;
        let groups = parse(svg).unwrap();
        assert_eq!(groups.len(), 1);
        let poly = &groups[0].polylines[0];

        assert_eq!(poly.len(), 5);
        assert!((poly[2][0] - 100.0).abs() < 1e-6);
        assert!((poly[2][1] - 50.0).abs() < 1e-6);
    }

    #[test]
    fn css_class_drives_stroke_grouping() {
        let svg = r##"<svg viewBox="0 0 10 10" width="10mm" height="10mm">
            <style>.cut{stroke:#000000;} .score{stroke:red;}</style>
            <rect class="cut" x="0" y="0" width="5" height="5"/>
            <rect class="score" x="0" y="0" width="3" height="3"/></svg>"##;
        let groups = parse(svg).unwrap();
        let colors: Vec<&str> = groups.iter().map(|g| g.color.as_str()).collect();
        assert!(colors.contains(&"#000000"));
        assert!(colors.contains(&"#ff0000"), "named red → hex");
    }

    #[test]
    fn fill_only_shape_defaults_to_black_cut() {
        let svg = r##"<svg viewBox="0 0 10 10" width="10mm" height="10mm">
            <rect x="0" y="0" width="5" height="5" fill="#00f"/></svg>"##;
        let groups = parse(svg).unwrap();
        assert_eq!(groups[0].color, "#000000");
    }

    #[test]
    fn arc_flattens_to_many_points() {
        let svg = r#"<svg viewBox="0 0 10 10" width="10mm" height="10mm">
            <path d="M0 5 A5 5 0 0 1 10 5" stroke="black"/></svg>"#;
        let groups = parse(svg).unwrap();
        assert!(groups[0].polylines[0].len() > 6, "semicircle subdivided");
    }

    #[test]
    fn path_with_curve_flattens() {
        let svg = r#"<svg viewBox="0 0 10 10" width="10mm" height="10mm">
            <path d="M0 0 L10 0 C10 5 5 10 0 10 Z" stroke="red"/></svg>"#;
        let groups = parse(svg).unwrap();
        let polys = &groups[0].polylines;
        assert!(!polys.is_empty());
        assert!(polys[0].len() > 4, "curve should be subdivided");
    }
}

#[derive(Clone, Copy)]
enum Token {
    Cmd(char),
    Num(f64),
}

fn tokenize_path(d: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let bytes = d.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_ascii_alphabetic() {
            tokens.push(Token::Cmd(c));
            i += 1;
        } else if c.is_ascii_digit() || c == '-' || c == '+' || c == '.' {
            let start = i;
            let mut seen_dot = false;
            let mut seen_e = false;

            if bytes[i] == b'-' || bytes[i] == b'+' {
                i += 1;
            }
            while i < bytes.len() {
                let ch = bytes[i];
                if ch.is_ascii_digit() {
                    i += 1;
                } else if ch == b'.' && !seen_dot && !seen_e {
                    seen_dot = true;
                    i += 1;
                } else if (ch == b'e' || ch == b'E') && !seen_e {
                    seen_e = true;
                    i += 1;
                    if i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+') {
                        i += 1;
                    }
                } else {
                    break;
                }
            }
            if let Ok(v) = d[start..i].parse::<f64>() {
                tokens.push(Token::Num(v));
            }
        } else {
            i += 1;
        }
    }
    tokens
}
