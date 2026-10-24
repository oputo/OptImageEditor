//! Resampling for the document image size (B-2b): separable filters on 8-bit planes.
//!
//! Used for the display (the `resample` command: the app scales its layer textures with it) and when saving
//! (psd_save.rs scales the file's channels), so what is shown and what is saved are made the same way.
//!
//! One axis maps output sample i (0 ≤ i < n_out) to the input position p(i) = (i + 0.5) / k + c, where input sample
//! j covers [j, j + 1). Shrinking (k < 1) widens the filter by 1 / k (area-correct, no aliasing).
//! Colour is filtered premultiplied by alpha (no dark / light fringes at transparent edges).

use rayon::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Filter {
    Nearest,
    Bilinear,
    /// Keys cubic, a = -0.5 (as Pillow / most "bicubic" resizers)
    Bicubic,
}

impl Filter {
    pub fn from_name(s: &str) -> Filter {
        match s {
            "nearest" => Filter::Nearest,
            "bilinear" => Filter::Bilinear,
            _ => Filter::Bicubic,
        }
    }
    fn support(self) -> f64 {
        match self { Filter::Nearest => 0.5, Filter::Bilinear => 1.0, Filter::Bicubic => 2.0 }
    }
    fn weight(self, x: f64) -> f64 {
        let x = x.abs();
        match self {
            Filter::Nearest => if x <= 0.5 { 1.0 } else { 0.0 },
            Filter::Bilinear => (1.0 - x).max(0.0),
            Filter::Bicubic => {
                const A: f64 = -0.5;
                if x < 1.0 { ((A + 2.0) * x - (A + 3.0)) * x * x + 1.0 }
                else if x < 2.0 { ((A * x - 5.0 * A) * x + 8.0 * A) * x - 4.0 * A }
                else { 0.0 }
            }
        }
    }
}

/// Values outside the input plane.
#[derive(Clone, Copy, Debug)]
pub enum Edge {
    /// a constant (0: transparent, or a layer mask's default colour)
    Const(f32),
    /// the nearest edge sample (planes that cover their whole area: a background layer, the canvas)
    Clamp,
}

/// One axis of a resampling: see the module comment.
#[derive(Clone, Copy, Debug)]
pub struct Axis {
    pub n_in: usize,
    pub n_out: usize,
    /// scale (output samples per input sample)
    pub k: f64,
    pub c: f64,
}

/// the input samples (from `start`) and weights making one output sample
struct Taps { start: isize, w: Vec<f32> }

fn taps(a: &Axis, f: Filter) -> Vec<Taps> {
    (0..a.n_out)
        .map(|i| {
            let p = (i as f64 + 0.5) / a.k + a.c;
            if f == Filter::Nearest {
                return Taps { start: p.floor() as isize, w: vec![1.0] };
            }
            let s = (1.0 / a.k).max(1.0);
            let r = f.support() * s;
            let j0 = (p - r).floor() as isize;
            let j1 = (p + r).ceil() as isize;
            let mut w: Vec<f64> = (j0..=j1).map(|j| f.weight((j as f64 + 0.5 - p) / s)).collect();
            let sum: f64 = w.iter().sum();
            if sum.abs() < 1e-12 { return Taps { start: p.floor() as isize, w: vec![1.0] }; }
            for x in &mut w { *x /= sum; }
            Taps { start: j0, w: w.into_iter().map(|x| x as f32).collect() }
        })
        .collect()
}

#[inline]
fn at(row: &[f32], j: isize, edge: Edge) -> f32 {
    if j >= 0 && (j as usize) < row.len() { return row[j as usize]; }
    match edge {
        Edge::Const(c) => c,
        Edge::Clamp => if row.is_empty() { 0.0 } else { row[(j.max(0) as usize).min(row.len() - 1)] },
    }
}

#[inline]
fn apply(row: &[f32], t: &Taps, edge: Edge) -> f32 {
    let mut v = 0.0f32;
    for (q, w) in t.w.iter().enumerate() { v += w * at(row, t.start + q as isize, edge); }
    v
}

/// One w x h plane resampled to (ax.n_out x ay.n_out) as floats. `mul`: multiply each input sample by this
/// plane / 255 first (premultiplying a colour plane by its alpha).
#[allow(clippy::too_many_arguments)]
fn resample_f32(src: &[u8], w: usize, h: usize, ax: &Axis, ay: &Axis, f: Filter, edge: Edge, mul: Option<&[u8]>) -> Vec<f32> {
    debug_assert!(ax.n_in == w && ay.n_in == h, "axis does not match the plane");
    let (nw, nh) = (ax.n_out, ay.n_out);
    if nw == 0 || nh == 0 { return vec![]; }
    if w == 0 || h == 0 {
        let v = match edge { Edge::Const(c) => c, Edge::Clamp => 0.0 };
        return vec![v; nw * nh];
    }
    let tx = taps(ax, f);
    let ty = taps(ay, f);
    // horizontal: h rows of nw
    let mut mid = vec![0f32; nw * h];
    mid.par_chunks_mut(nw).enumerate().for_each(|(y, out)| {
        let row: Vec<f32> = match mul {
            Some(m) => (0..w).map(|x| src[y * w + x] as f32 * m[y * w + x] as f32 / 255.0).collect(),
            None => src[y * w..(y + 1) * w].iter().map(|&v| v as f32).collect(),
        };
        for (i, t) in tx.iter().enumerate() { out[i] = apply(&row, t, edge); }
    });
    // vertical: per output row, the weighted input rows
    let mut out = vec![0f32; nw * nh];
    out.par_chunks_mut(nw).enumerate().for_each(|(i, o)| {
        let t = &ty[i];
        for (q, wt) in t.w.iter().enumerate() {
            let j = t.start + q as isize;
            if j >= 0 && (j as usize) < h {
                let r = &mid[j as usize * nw..(j as usize + 1) * nw];
                for x in 0..nw { o[x] += wt * r[x]; }
            } else {
                match edge {
                    Edge::Const(c) => { for v in o.iter_mut() { *v += wt * c; } }
                    Edge::Clamp => {
                        let jj = (j.max(0) as usize).min(h - 1);
                        let r = &mid[jj * nw..(jj + 1) * nw];
                        for x in 0..nw { o[x] += wt * r[x]; }
                    }
                }
            }
        }
    });
    out
}

fn to_u8(v: &[f32]) -> Vec<u8> {
    v.par_iter().map(|&x| x.round().clamp(0.0, 255.0) as u8).collect()
}

/// One grey plane (a layer mask, a colour plane of a layer without transparency, an alpha channel ...).
pub fn plane(src: &[u8], w: usize, h: usize, ax: &Axis, ay: &Axis, f: Filter, edge: Edge) -> Vec<u8> {
    to_u8(&resample_f32(src, w, h, ax, ay, f, edge, None))
}

/// A transparency plane and the colour planes it applies to (filtered premultiplied, transparent outside).
/// Returns (alpha, colours) as straight values.
pub fn with_alpha(alpha: &[u8], colors: &[&[u8]], w: usize, h: usize, ax: &Axis, ay: &Axis, f: Filter) -> (Vec<u8>, Vec<Vec<u8>>) {
    let a = resample_f32(alpha, w, h, ax, ay, f, Edge::Const(0.0), None);
    let cs = colors
        .iter()
        .map(|c| {
            let p = resample_f32(c, w, h, ax, ay, f, Edge::Const(0.0), Some(alpha));
            p.par_iter()
                .zip(a.par_iter())
                .map(|(&p, &a)| {
                    let a = a.clamp(0.0, 255.0);
                    if a < 0.5 { 0 } else { (p.clamp(0.0, a) * 255.0 / a).round().clamp(0.0, 255.0) as u8 }
                })
                .collect()
        })
        .collect();
    (to_u8(&a), cs)
}

/// Interleaved straight RGBA (for the `resample` command).
pub fn rgba(src: &[u8], w: usize, h: usize, ax: &Axis, ay: &Axis, f: Filter) -> Vec<u8> {
    let n = w * h;
    let plane_of = |c: usize| -> Vec<u8> { (0..n).into_par_iter().map(|i| src[i * 4 + c]).collect() };
    let (r, g, b, a) = (plane_of(0), plane_of(1), plane_of(2), plane_of(3));
    let (na, cs) = with_alpha(&a, &[&r, &g, &b], w, h, ax, ay, f);
    let m = ax.n_out * ay.n_out;
    let mut out = vec![0u8; m * 4];
    out.par_chunks_mut(4).enumerate().for_each(|(i, p)| { p[0] = cs[0][i]; p[1] = cs[1][i]; p[2] = cs[2][i]; p[3] = na[i]; });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn axis(n_in: usize, n_out: usize) -> Axis { Axis { n_in, n_out, k: n_out as f64 / n_in as f64, c: 0.0 } }

    #[test]
    fn identity_is_exact() {
        let src: Vec<u8> = (0..64u32).map(|v| (v * 4) as u8).collect();
        for f in [Filter::Nearest, Filter::Bilinear, Filter::Bicubic] {
            let out = plane(&src, 8, 8, &axis(8, 8), &axis(8, 8), f, Edge::Clamp);
            assert_eq!(out, src, "{f:?}");
        }
    }

    #[test]
    fn flat_stays_flat() {
        let src = vec![200u8; 30 * 20];
        for (nw, nh) in [(15, 10), (61, 39), (7, 3)] {
            let out = plane(&src, 30, 20, &axis(30, nw), &axis(20, nh), Filter::Bicubic, Edge::Clamp);
            assert!(out.iter().all(|&v| v == 200), "{nw}x{nh}");
        }
    }

    #[test]
    fn halving_nearest() {
        // halving with nearest neighbour takes every second sample
        let mut src = vec![0u8; 4 * 4];
        for y in 0..4 { for x in 0..4 { src[y * 4 + x] = if x < 2 { 0 } else { 100 }; } }
        let out = plane(&src, 4, 4, &axis(4, 2), &axis(4, 2), Filter::Nearest, Edge::Clamp);
        assert_eq!(out, vec![0, 100, 0, 100]);
    }

    #[test]
    fn transparent_edge_keeps_colour() {
        // an opaque red square on transparent (colour black there): no dark fringe after scaling
        let (w, h) = (8, 8);
        let mut px = vec![0u8; w * h * 4];
        for y in 2..6 { for x in 2..6 { let i = (y * w + x) * 4; px[i] = 255; px[i + 3] = 255; } }
        let out = rgba(&px, w, h, &axis(8, 13), &axis(8, 13), Filter::Bicubic);
        for p in out.chunks_exact(4) {
            if p[3] > 8 { assert!(p[0] >= 250 && p[1] == 0 && p[2] == 0, "{p:?}"); }
        }
    }
}
