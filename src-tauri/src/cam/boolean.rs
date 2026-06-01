use geo::{BooleanOps, Coord, LineString, MultiPolygon, Polygon};

use crate::model::Polyline;

#[derive(Debug, Clone, Copy)]
pub enum Op {
    Union,
    Difference,
    Intersection,
}

impl Op {
    pub fn parse(s: &str) -> Option<Op> {
        match s {
            "union" => Some(Op::Union),
            "difference" => Some(Op::Difference),
            "intersection" => Some(Op::Intersection),
            _ => None,
        }
    }
}

pub fn apply(op: Op, operands: &[Vec<Polyline>]) -> Vec<Polyline> {
    let mut it = operands.iter();
    let mut acc = match it.next() {
        Some(p) => to_multipolygon(p),
        None => return vec![],
    };
    for operand in it {
        let other = to_multipolygon(operand);
        acc = match op {
            Op::Union => acc.union(&other),
            Op::Difference => acc.difference(&other),
            Op::Intersection => acc.intersection(&other),
        };
    }
    from_multipolygon(&acc)
}

fn to_multipolygon(polys: &[Polyline]) -> MultiPolygon<f64> {

    let mut acc: Option<MultiPolygon<f64>> = None;
    for poly in polys {
        if poly.len() < 3 {
            continue;
        }
        let ring: Vec<Coord<f64>> = poly.iter().map(|p| Coord { x: p[0], y: p[1] }).collect();
        let mp = MultiPolygon::new(vec![Polygon::new(LineString::new(ring), vec![])]);
        acc = Some(match acc {
            Some(a) => a.union(&mp),
            None => mp,
        });
    }
    acc.unwrap_or_else(|| MultiPolygon::new(vec![]))
}

fn from_multipolygon(mp: &MultiPolygon<f64>) -> Vec<Polyline> {
    let mut out = Vec::new();
    for poly in &mp.0 {
        out.push(ring_to_polyline(poly.exterior()));
        for hole in poly.interiors() {
            out.push(ring_to_polyline(hole));
        }
    }
    out
}

fn ring_to_polyline(ring: &LineString<f64>) -> Polyline {
    ring.0.iter().map(|c| [c.x, c.y]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, s: f64) -> Vec<Polyline> {
        vec![vec![[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]]
    }

    #[test]
    fn union_of_overlapping_squares_is_one_ring() {
        let a = square(0.0, 0.0, 10.0);
        let b = square(5.0, 5.0, 10.0);
        let res = apply(Op::Union, &[a, b]);
        assert_eq!(res.len(), 1, "L-shaped union has a single outer ring");
        assert!(res[0].len() > 4, "union outline has more than 4 corners");
    }

    #[test]
    fn intersection_is_the_overlap() {
        let a = square(0.0, 0.0, 10.0);
        let b = square(5.0, 5.0, 10.0);
        let res = apply(Op::Intersection, &[a, b]);
        assert_eq!(res.len(), 1);

        let xs: Vec<f64> = res[0].iter().map(|p| p[0]).collect();
        assert!(xs.iter().all(|&x| (4.9..=10.1).contains(&x)));
    }
}
