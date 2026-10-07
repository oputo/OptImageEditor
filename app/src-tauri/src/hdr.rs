// High dynamic range images (OpenEXR, Radiance .hdr) decoded to half-float RGBA for display.
//
// Output: width * height * 4 half floats (little-endian u16 bits), linear light, RGB premultiplied by
// alpha (the OpenEXR convention; Radiance files are opaque). The page applies exposure + sRGB on the GPU.
//
// EXR "layers" shown to the user are channel groups: per part (header), channels are grouped by the
// prefix before the last '.' ("diffuse.R" -> group "diffuse"). A group maps to RGBA like this:
//   R / G / B / A present -> used as is (missing colour channels = 0, missing alpha = 1)
//   otherwise Y           -> grey
//   otherwise             -> the first three channels (alphabetically) as RGB, or one channel as grey
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use half::f16;
use rayon::prelude::*;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HdrLayer {
    /// name shown to the user
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// channels used for R, G, B, A (None = constant); for display / diagnostics
    pub mapping: [Option<String>; 4],
    /// all channels of the group with their sample type, e.g. "R:f16"
    pub channels: Vec<String>,
    #[serde(skip)]
    part: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HdrInfo {
    /// "EXR" or "HDR"
    pub format: String,
    pub compression: String,
    pub layers: Vec<HdrLayer>,
}

#[derive(Debug)]
pub enum HdrError {
    Io(std::io::Error),
    Format(String),
}
impl std::fmt::Display for HdrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HdrError::Io(e) => write!(f, "{e}"),
            HdrError::Format(m) => write!(f, "{m}"),
        }
    }
}
impl From<std::io::Error> for HdrError {
    fn from(e: std::io::Error) -> Self { HdrError::Io(e) }
}
impl From<exr::error::Error> for HdrError {
    fn from(e: exr::error::Error) -> Self { HdrError::Format(format!("EXR: {e}")) }
}
type Result<T> = std::result::Result<T, HdrError>;

fn is_exr(path: &Path) -> bool {
    path.extension().map(|e| e.eq_ignore_ascii_case("exr")).unwrap_or(false)
}

/// Header only: size, compression and the displayable layers.
pub fn probe(path: &Path) -> Result<HdrInfo> {
    if is_exr(path) { probe_exr(path) } else { probe_radiance(path) }
}

/// Decodes `layer` into `dst` (width * height * 8 bytes).
pub fn decode(path: &Path, info: &HdrInfo, layer: usize, dst: &mut [u8]) -> Result<()> {
    let l = info.layers.get(layer).ok_or_else(|| HdrError::Format(format!("layer {layer} does not exist")))?;
    let need = l.width as usize * l.height as usize * 8;
    if dst.len() != need {
        return Err(HdrError::Format(format!("buffer size {} != {}", dst.len(), need)));
    }
    if is_exr(path) { decode_exr(path, l, dst) } else { decode_radiance(path, dst) }
}

// ---------------------------------------------------------------- OpenEXR

fn sample_type_name(t: exr::meta::attribute::SampleType) -> &'static str {
    match t {
        exr::meta::attribute::SampleType::F16 => "f16",
        exr::meta::attribute::SampleType::F32 => "f32",
        exr::meta::attribute::SampleType::U32 => "u32",
    }
}

/// (group prefix, channel name without prefix)
fn split_channel(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) => (&name[..i], &name[i + 1..]),
        None => ("", name),
    }
}

/// Chooses the channels (full names) used for R, G, B, A from the channel names of one group.
fn map_group(names: &[String]) -> [Option<String>; 4] {
    let find = |want: &[&str]| {
        names.iter().find(|n| want.iter().any(|w| split_channel(n).1.eq_ignore_ascii_case(w))).cloned()
    };
    let (r, g, b, a) = (find(&["R", "red"]), find(&["G", "green"]), find(&["B", "blue"]), find(&["A", "alpha"]));
    if r.is_some() || g.is_some() || b.is_some() {
        return [r, g, b, a];
    }
    if let Some(y) = find(&["Y"]) {
        return [Some(y.clone()), Some(y.clone()), Some(y), a];
    }
    let rest: Vec<&String> = names.iter().filter(|n| Some(*n) != a.as_ref()).collect();
    match rest.len() {
        0 => [None, None, None, a],
        1 | 2 => [Some(rest[0].clone()), Some(rest[0].clone()), Some(rest[0].clone()), a],
        _ => [Some(rest[0].clone()), Some(rest[1].clone()), Some(rest[2].clone()), a],
    }
}

fn probe_exr(path: &Path) -> Result<HdrInfo> {
    let meta = exr::meta::MetaData::read_from_file(path, false)?;
    let mut layers = Vec::new();
    let multi_part = meta.headers.len() > 1;
    let mut compression = String::new();
    for (pi, h) in meta.headers.iter().enumerate() {
        if h.deep {
            continue; // deep data is not supported
        }
        if compression.is_empty() {
            compression = format!("{:?}", h.compression);
        }
        let size = h.layer_size;
        let part_name = h.own_attributes.layer_name.as_ref().map(|t| t.to_string()).unwrap_or_default();
        // groups in order of first appearance (channels are sorted by name in EXR)
        let mut groups: Vec<(String, Vec<String>, Vec<String>)> = Vec::new();
        for c in h.channels.list.iter() {
            let full = c.name.to_string();
            let (prefix, _) = split_channel(&full);
            let typed = format!("{}:{}", full, sample_type_name(c.sample_type));
            match groups.iter_mut().find(|g| g.0 == prefix) {
                Some(g) => { g.1.push(full.clone()); g.2.push(typed); }
                None => groups.push((prefix.to_string(), vec![full.clone()], vec![typed])),
            }
        }
        // unprefixed channels: R/G/B/A form the main group, every other one (Z, depth, ...) is its own group
        let is_rgba = |n: &str| ["r", "g", "b", "a", "red", "green", "blue", "alpha"].contains(&n.to_ascii_lowercase().as_str());
        let mut split: Vec<(String, Vec<String>, Vec<String>)> = Vec::new();
        for (prefix, names, typed) in groups {
            if !prefix.is_empty() || names.iter().all(|n| is_rgba(n)) {
                split.push((prefix, names, typed));
                continue;
            }
            let (mut main_n, mut main_t) = (Vec::new(), Vec::new());
            let mut singles = Vec::new();
            for (n, t) in names.into_iter().zip(typed) {
                if is_rgba(&n) { main_n.push(n); main_t.push(t); } else { singles.push((n.clone(), vec![n], vec![t])); }
            }
            if !main_n.is_empty() { split.push((String::new(), main_n, main_t)); }
            split.extend(singles);
        }
        // the main RGBA group first
        split.sort_by_key(|g| if g.0.is_empty() { 0 } else { 1 });
        for (prefix, names, typed) in split {
            let mapping = map_group(&names);
            let group_name = if prefix.is_empty() {
                let has = |c: &str| names.iter().any(|n| n.eq_ignore_ascii_case(c));
                let mut s = String::new();
                for c in ["R", "G", "B", "A"] { if has(c) { s.push_str(c); } }
                if s.is_empty() { names.join(",") } else { s }
            } else {
                prefix.clone()
            };
            let name = match (multi_part, part_name.is_empty()) {
                (true, false) => format!("{part_name} / {group_name}"),
                (true, true) => format!("part {pi} / {group_name}"),
                _ => group_name,
            };
            layers.push(HdrLayer { name, width: size.0 as u32, height: size.1 as u32, mapping, channels: typed, part: pi });
        }
    }
    if layers.is_empty() {
        return Err(HdrError::Format("表示できるチャンネルがありません（deep データのみ）".into()));
    }
    Ok(HdrInfo { format: "EXR".into(), compression, layers })
}

fn decode_exr(path: &Path, layer: &HdrLayer, dst: &mut [u8]) -> Result<()> {
    use exr::prelude::*;
    let image = read()
        .no_deep_data()
        .largest_resolution_level()
        .all_channels()
        .all_layers()
        .all_attributes()
        .from_file(path)?;
    // deep parts are skipped by the reader, so map the header index to the decoded layer by name / order
    let meta = exr::meta::MetaData::read_from_file(path, false)?;
    let flat_index = meta.headers.iter().take(layer.part).filter(|h| !h.deep).count();
    let part = image.layer_data.get(flat_index).ok_or_else(|| HdrError::Format("part not found".into()))?;
    let (w, h) = (part.size.0, part.size.1);
    if w as u32 != layer.width || h as u32 != layer.height {
        return Err(HdrError::Format("layer size mismatch".into()));
    }
    let find = |name: &Option<String>| -> Option<&FlatSamples> {
        let n = name.as_ref()?;
        part.channel_data.list.iter().find(|c| c.name.to_string() == *n).map(|c| &c.sample_data)
    };
    let chans = [find(&layer.mapping[0]), find(&layer.mapping[1]), find(&layer.mapping[2]), find(&layer.mapping[3])];
    let one = f16::ONE.to_bits();
    dst.par_chunks_mut(w * 8).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let i = y * w + x;
            for (c, ch) in chans.iter().enumerate() {
                let bits = match ch {
                    Some(FlatSamples::F16(v)) => v[i].to_bits(),
                    Some(FlatSamples::F32(v)) => f16::from_f32(v[i]).to_bits(),
                    Some(FlatSamples::U32(v)) => f16::from_f32(v[i] as f32).to_bits(),
                    None => if c == 3 { one } else { 0 },
                };
                let o = x * 8 + c * 2;
                row[o..o + 2].copy_from_slice(&bits.to_le_bytes());
            }
        }
    });
    Ok(())
}

// ---------------------------------------------------------------- Radiance RGBE (.hdr)

struct RadianceHeader {
    width: usize,
    height: usize,
    /// byte offset of the pixel data
    data_offset: u64,
}

fn read_radiance_header(r: &mut impl BufRead) -> Result<RadianceHeader> {
    let mut offset = 0u64;
    let mut line = String::new();
    let mut first = true;
    loop {
        line.clear();
        let n = r.read_line(&mut line)?;
        if n == 0 {
            return Err(HdrError::Format("HDR: ヘッダーが途中で終わっています".into()));
        }
        offset += n as u64;
        let t = line.trim_end_matches(['\r', '\n']);
        if first {
            if !t.starts_with("#?") {
                return Err(HdrError::Format("HDR: Radiance 形式ではありません".into()));
            }
            first = false;
            continue;
        }
        if t.is_empty() {
            break;
        }
        if let Some(fmt) = t.strip_prefix("FORMAT=") {
            if fmt != "32-bit_rle_rgbe" {
                return Err(HdrError::Format(format!("HDR: 未対応の形式 {fmt}")));
            }
        }
    }
    line.clear();
    let n = r.read_line(&mut line)?;
    offset += n as u64;
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() != 4 || parts[0] != "-Y" || parts[2] != "+X" {
        return Err(HdrError::Format(format!("HDR: 未対応の向き「{}」", line.trim())));
    }
    let height: usize = parts[1].parse().map_err(|_| HdrError::Format("HDR: 高さが不正".into()))?;
    let width: usize = parts[3].parse().map_err(|_| HdrError::Format("HDR: 幅が不正".into()))?;
    Ok(RadianceHeader { width, height, data_offset: offset })
}

fn probe_radiance(path: &Path) -> Result<HdrInfo> {
    let mut r = BufReader::new(File::open(path)?);
    let h = read_radiance_header(&mut r)?;
    Ok(HdrInfo {
        format: "HDR".into(),
        compression: "RLE (RGBE)".into(),
        layers: vec![HdrLayer {
            name: "RGB".into(), width: h.width as u32, height: h.height as u32,
            mapping: [Some("R".into()), Some("G".into()), Some("B".into()), None],
            channels: vec!["R:rgbe".into(), "G:rgbe".into(), "B:rgbe".into()], part: 0,
        }],
    })
}

/// Decodes one scanline of RGBE pixels from `src` (adaptive RLE or flat), returns bytes consumed.
fn radiance_scanline(src: &[u8], width: usize, out: &mut [u8]) -> Result<usize> {
    let err = || HdrError::Format("HDR: データが壊れています".into());
    let new_rle = width >= 8 && width < 0x8000 && src.len() >= 4 && src[0] == 2 && src[1] == 2 && src[2] & 0x80 == 0;
    if !new_rle || ((src[2] as usize) << 8 | src[3] as usize) != width {
        // flat (or old-style RLE with repeat markers 1,1,1,n)
        let mut p = 0;
        let mut x = 0;
        let mut shift = 0;
        while x < width {
            let px = src.get(p..p + 4).ok_or_else(err)?;
            p += 4;
            if px[0] == 1 && px[1] == 1 && px[2] == 1 && x > 0 {
                let count = (px[3] as usize) << shift;
                for _ in 0..count.min(width - x) {
                    out.copy_within((x - 1) * 4..x * 4, x * 4);
                    x += 1;
                }
                shift += 8;
            } else {
                out[x * 4..x * 4 + 4].copy_from_slice(px);
                x += 1;
                shift = 0;
            }
        }
        return Ok(p);
    }
    let mut p = 4;
    for c in 0..4 {
        let mut x = 0;
        while x < width {
            let n = *src.get(p).ok_or_else(err)? as usize;
            p += 1;
            if n > 128 {
                let run = n - 128;
                let v = *src.get(p).ok_or_else(err)?;
                p += 1;
                if x + run > width { return Err(err()); }
                for i in 0..run { out[(x + i) * 4 + c] = v; }
                x += run;
            } else {
                if n == 0 || x + n > width { return Err(err()); }
                let lit = src.get(p..p + n).ok_or_else(err)?;
                for (i, v) in lit.iter().enumerate() { out[(x + i) * 4 + c] = *v; }
                p += n;
                x += n;
            }
        }
    }
    Ok(p)
}

fn rgbe_to_f32(m: u8, e: u8) -> f32 {
    if e == 0 { 0.0 } else { (m as f32 + 0.5) * 2f32.powi(e as i32 - 136) }
}

fn decode_radiance(path: &Path, dst: &mut [u8]) -> Result<()> {
    let mut r = BufReader::new(File::open(path)?);
    let h = read_radiance_header(&mut r)?;
    let mut data = Vec::new();
    r.read_to_end(&mut data)?;
    let _ = h.data_offset;
    // scanlines are variable-length: decode sequentially into RGBE, then convert in parallel
    let mut rgbe = vec![0u8; h.width * h.height * 4];
    let mut p = 0;
    for row in rgbe.chunks_mut(h.width * 4) {
        p += radiance_scanline(&data[p..], h.width, row)?;
    }
    let one = f16::ONE.to_bits().to_le_bytes();
    dst.par_chunks_mut(h.width * 8).zip(rgbe.par_chunks(h.width * 4)).for_each(|(out, src)| {
        for x in 0..h.width {
            let px = &src[x * 4..x * 4 + 4];
            for c in 0..3 {
                let v = f16::from_f32(rgbe_to_f32(px[c], px[3])).to_bits().to_le_bytes();
                out[x * 8 + c * 2..x * 8 + c * 2 + 2].copy_from_slice(&v);
            }
            out[x * 8 + 6..x * 8 + 8].copy_from_slice(&one);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use exr::prelude::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("oie_test_{}_{name}", std::process::id()))
    }

    fn read_px(dst: &[u8], w: usize, x: usize, y: usize) -> [f32; 4] {
        let o = (y * w + x) * 8;
        let g = |i: usize| f16::from_bits(u16::from_le_bytes([dst[o + i * 2], dst[o + i * 2 + 1]])).to_f32();
        [g(0), g(1), g(2), g(3)]
    }

    #[test]
    fn exr_compressions_roundtrip() {
        let (w, h) = (67usize, 41usize);
        let value = |x: usize, y: usize| (x as f32 / 10.0, y as f32 * 3.5, (x + y) as f32 * 0.01, 0.5f32);
        for comp in [Compression::Uncompressed, Compression::RLE, Compression::ZIP1, Compression::ZIP16, Compression::PIZ, Compression::PXR24, Compression::B44] {
            let path = tmp(&format!("{comp:?}.exr"));
            let pixels = SpecificChannels::rgba(|Vec2(x, y)| {
                let (r, g, b, a) = value(x, y);
                (f16::from_f32(r), f16::from_f32(g), f16::from_f32(b), f16::from_f32(a))
            });
            let mut img = Image::from_channels((w, h), pixels);
            img.layer_data.encoding.compression = comp;
            img.write().to_file(&path).unwrap();

            let info = probe(&path).unwrap();
            assert_eq!(info.layers.len(), 1, "{comp:?}");
            assert_eq!(info.layers[0].name, "RGBA");
            let mut dst = vec![0u8; w * h * 8];
            decode(&path, &info, 0, &mut dst).unwrap();
            for (x, y) in [(0, 0), (66, 40), (13, 29)] {
                let got = read_px(&dst, w, x, y);
                let (r, g, b, a) = value(x, y);
                let tol = if matches!(comp, Compression::B44) { 0.02 } else { 0.001 };
                for (gv, ev) in got.iter().zip([r, g, b, a]) {
                    let ev16 = f16::from_f32(ev).to_f32();
                    assert!((gv - ev16).abs() <= tol * ev16.abs().max(1.0), "{comp:?} ({x},{y}) {got:?} vs {:?}", (r, g, b, a));
                }
            }
            std::fs::remove_file(&path).ok();
        }
    }

    #[test]
    fn exr_aov_groups_and_f32() {
        let (w, h) = (16usize, 8usize);
        let path = tmp("aov.exr");
        let ch = |name: &str, f: fn(usize, usize) -> f32| {
            AnyChannel::new(name, FlatSamples::F32((0..w * h).map(|i| f(i % w, i / w)).collect()))
        };
        let channels = AnyChannels::sort(vec![
            ch("R", |x, _| x as f32), ch("G", |_, y| y as f32), ch("B", |_, _| 2.0),
            ch("diffuse.R", |_, _| 0.25), ch("diffuse.G", |_, _| 0.5), ch("diffuse.B", |_, _| 0.75),
            ch("Z", |x, y| (x * y) as f32),
        ].into());
        let img = Image::from_channels((w, h), channels);
        img.write().to_file(&path).unwrap();
        let info = probe(&path).unwrap();
        let names: Vec<&str> = info.layers.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["RGB", "Z", "diffuse"], "{info:?}");
        let mut dst = vec![0u8; w * h * 8];
        decode(&path, &info, 0, &mut dst).unwrap();
        assert_eq!(read_px(&dst, w, 5, 3), [5.0, 3.0, 2.0, 1.0]);
        decode(&path, &info, 1, &mut dst).unwrap();
        assert_eq!(read_px(&dst, w, 5, 3), [15.0, 15.0, 15.0, 1.0]); // Z as grey
        decode(&path, &info, 2, &mut dst).unwrap();
        assert_eq!(read_px(&dst, w, 5, 3), [0.25, 0.5, 0.75, 1.0]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn radiance_rle_and_flat() {
        let (w, h) = (20usize, 3usize);
        // RGBE for value v in [0.5, 1): mantissa = v * 256, exponent 128
        let rgbe = |x: usize, y: usize| [(128 + x) as u8, (200 - y * 10) as u8, 140u8, 128u8];
        for rle in [true, false] {
            let mut f = b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n".to_vec();
            f.extend_from_slice(format!("-Y {h} +X {w}\n").as_bytes());
            for y in 0..h {
                if rle {
                    f.extend_from_slice(&[2, 2, 0, w as u8]);
                    for c in 0..4 {
                        // channel 2 and 3 are constant -> one run; others literal
                        let vals: Vec<u8> = (0..w).map(|x| rgbe(x, y)[c]).collect();
                        if vals.iter().all(|v| *v == vals[0]) {
                            f.extend_from_slice(&[128 + w as u8, vals[0]]);
                        } else {
                            f.push(w as u8);
                            f.extend_from_slice(&vals);
                        }
                    }
                } else {
                    for x in 0..w { f.extend_from_slice(&rgbe(x, y)); }
                }
            }
            let path = tmp(if rle { "rle.hdr" } else { "flat.hdr" });
            std::fs::write(&path, &f).unwrap();
            let info = probe(&path).unwrap();
            assert_eq!((info.layers[0].width, info.layers[0].height), (w as u32, h as u32));
            let mut dst = vec![0u8; w * h * 8];
            decode(&path, &info, 0, &mut dst).unwrap();
            for (x, y) in [(0, 0), (19, 2), (7, 1)] {
                let p = rgbe(x, y);
                let got = read_px(&dst, w, x, y);
                for c in 0..3 {
                    let ev = f16::from_f32(rgbe_to_f32(p[c], p[3])).to_f32();
                    assert_eq!(got[c], ev, "rle={rle} ({x},{y}) c{c}");
                }
                assert_eq!(got[3], 1.0);
            }
            std::fs::remove_file(&path).ok();
        }
    }
}
