//! Fast decoder for the stored composite ("merged") image of PSD / PSB files.
//!
//! Only what a viewer needs: RGB / Grayscale, 8 / 16 bit, raw or RLE (PackBits) compression.
//! Rows are decoded in parallel (rayon) straight into an RGBA8 buffer. Anything else returns
//! `Err(Unsupported)` so the caller can fall back to the JS decoder (ag-psd).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use rayon::prelude::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositeInfo {
    pub width: u32,
    pub height: u32,
    pub channels: u16,
    pub depth: u16,
    pub color_mode: u16,
    pub psb: bool,
    /// signed layer count from the layer info (negative = the merged image has a transparency channel)
    pub layer_count: i32,
    pub has_alpha: bool,
    /// absolute file offset of the image data section
    pub image_data_offset: u64,
    pub image_data_len: u64,
}

#[derive(Debug)]
pub enum CompositeError {
    /// format is valid but not handled here -> use the JS decoder
    Unsupported(String),
    Invalid(String),
    Io(String),
}

impl std::fmt::Display for CompositeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(s) => write!(f, "unsupported: {s}"),
            Self::Invalid(s) => write!(f, "invalid PSD: {s}"),
            Self::Io(s) => write!(f, "io: {s}"),
        }
    }
}

impl From<std::io::Error> for CompositeError {
    fn from(e: std::io::Error) -> Self { Self::Io(e.to_string()) }
}

fn be_u16(b: &[u8], o: usize) -> u16 { u16::from_be_bytes([b[o], b[o + 1]]) }
fn be_u32(b: &[u8], o: usize) -> u32 { u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) }

fn read_at(f: &mut File, offset: u64, len: usize) -> Result<Vec<u8>, CompositeError> {
    let mut buf = vec![0u8; len];
    f.seek(SeekFrom::Start(offset))?;
    f.read_exact(&mut buf)?;
    Ok(buf)
}

fn read_len(f: &mut File, offset: u64, psb: bool) -> Result<u64, CompositeError> {
    let b = read_at(f, offset, if psb { 8 } else { 4 })?;
    Ok(if psb { u64::from_be_bytes(b.try_into().unwrap()) } else { be_u32(&b, 0) as u64 })
}

/// Parses the header and locates the image data section without reading the (large) layer section.
pub fn read_info(f: &mut File) -> Result<CompositeInfo, CompositeError> {
    let file_len = f.metadata()?.len();
    let h = read_at(f, 0, 26)?;
    if &h[0..4] != b"8BPS" { return Err(CompositeError::Invalid("signature".into())); }
    let version = be_u16(&h, 4);
    let psb = match version { 1 => false, 2 => true, v => return Err(CompositeError::Invalid(format!("version {v}"))) };
    let channels = be_u16(&h, 12);
    let height = be_u32(&h, 14);
    let width = be_u32(&h, 18);
    let depth = be_u16(&h, 22);
    let color_mode = be_u16(&h, 24);

    let mut pos: u64 = 26;
    pos += 4 + read_len(f, pos, false)?; // color mode data (always 4-byte length)
    pos += 4 + read_len(f, pos, false)?; // image resources (always 4-byte length)
    let lsize = if psb { 8 } else { 4 };
    let layer_section_len = read_len(f, pos, psb)?;
    let mut layer_count: i32 = 0;
    if layer_section_len >= lsize + 2 {
        let layer_info_len = read_len(f, pos + lsize, psb)?;
        if layer_info_len >= 2 {
            let b = read_at(f, pos + 2 * lsize, 2)?;
            layer_count = i16::from_be_bytes([b[0], b[1]]) as i32;
        }
    }
    let image_data_offset = pos + lsize + layer_section_len;
    if image_data_offset + 2 > file_len {
        return Err(CompositeError::Unsupported("no composite image data".into()));
    }
    // the merged image has a transparency channel when the layer count is negative (RGB: 4th, Gray: 2nd channel)
    let base_channels = match color_mode { 3 => Some(3u16), 1 => Some(1), _ => None };
    let has_alpha = layer_count < 0 && base_channels.is_some_and(|b| channels > b);
    Ok(CompositeInfo {
        width, height, channels, depth, color_mode, psb, layer_count, has_alpha,
        image_data_offset,
        image_data_len: file_len - image_data_offset,
    })
}

/// PackBits decode of one row into `dst` (exactly dst.len() bytes expected).
fn unpack_bits(src: &[u8], dst: &mut [u8]) -> Result<(), CompositeError> {
    let (mut i, mut o) = (0usize, 0usize);
    while o < dst.len() {
        if i >= src.len() { return Err(CompositeError::Invalid("RLE row truncated".into())); }
        let n = src[i] as i8;
        i += 1;
        if n >= 0 {
            let cnt = n as usize + 1;
            if i + cnt > src.len() || o + cnt > dst.len() { return Err(CompositeError::Invalid("RLE literal overflow".into())); }
            dst[o..o + cnt].copy_from_slice(&src[i..i + cnt]);
            i += cnt;
            o += cnt;
        } else if n != -128 {
            let cnt = (1 - n as isize) as usize;
            if i >= src.len() || o + cnt > dst.len() { return Err(CompositeError::Invalid("RLE run overflow".into())); }
            dst[o..o + cnt].fill(src[i]);
            i += 1;
            o += cnt;
        }
    }
    Ok(())
}

/// Decodes the image data section (`data` = bytes from `info.image_data_offset` to EOF) into RGBA8 `out`
/// (straight / non-premultiplied alpha, length = width * height * 4).
pub fn decode_rgba(info: &CompositeInfo, data: &[u8], out: &mut [u8]) -> Result<(), CompositeError> {
    let (w, h) = (info.width as usize, info.height as usize);
    if out.len() != w * h * 4 { return Err(CompositeError::Invalid("output size".into())); }
    let gray = match info.color_mode {
        3 => false,
        1 => true,
        m => return Err(CompositeError::Unsupported(format!("color mode {m}"))),
    };
    let bps = match info.depth {
        8 => 1usize,
        16 => 2,
        d => return Err(CompositeError::Unsupported(format!("{d} bit"))),
    };
    let base = if gray { 1usize } else { 3 };
    if (info.channels as usize) < base { return Err(CompositeError::Invalid("channel count".into())); }
    // source channel feeding each RGBA slot
    let srcs: Vec<(usize, usize)> = if gray {
        let mut v = vec![(0, 0)];
        if info.has_alpha { v.push((1, 3)); }
        v
    } else {
        let mut v = vec![(0, 0), (1, 1), (2, 2)];
        if info.has_alpha { v.push((3, 3)); }
        v
    };
    if data.len() < 2 { return Err(CompositeError::Invalid("image data".into())); }
    let compression = be_u16(data, 0);
    let row_bytes = w * bps;
    let total_ch = info.channels as usize;

    // per (channel,row): byte range inside `data`
    let ranges: Vec<(usize, usize)> = match compression {
        0 => {
            let planes_needed = srcs.iter().map(|s| s.0 + 1).max().unwrap_or(1);
            if data.len() < 2 + row_bytes * h * planes_needed {
                return Err(CompositeError::Invalid("raw data truncated".into()));
            }
            (0..total_ch * h).map(|i| (2 + i * row_bytes, row_bytes)).collect()
        }
        1 => {
            let cw = if info.psb { 4 } else { 2 };
            let n = total_ch * h;
            let table_end = 2 + n * cw;
            if data.len() < table_end { return Err(CompositeError::Invalid("RLE table truncated".into())); }
            let mut v = Vec::with_capacity(n);
            let mut off = table_end;
            for i in 0..n {
                let len = if cw == 4 { be_u32(data, 2 + i * 4) as usize } else { be_u16(data, 2 + i * 2) as usize };
                v.push((off, len));
                off += len;
            }
            if off > data.len() { return Err(CompositeError::Invalid("RLE data truncated".into())); }
            v
        }
        c => return Err(CompositeError::Unsupported(format!("compression {c}"))),
    };

    out.par_chunks_mut(w * 4).enumerate().try_for_each_init(
        || vec![0u8; row_bytes],
        |row_buf, (y, dst)| -> Result<(), CompositeError> {
            if !info.has_alpha {
                for px in dst.chunks_exact_mut(4) { px[3] = 255; }
            }
            for &(ch, slot) in &srcs {
                let (off, len) = ranges[ch * h + y];
                let src = &data[off..off + len];
                let row: &[u8] = if compression == 0 {
                    src
                } else {
                    unpack_bits(src, row_buf)?;
                    row_buf
                };
                if bps == 1 {
                    for (x, &v) in row.iter().enumerate() { dst[x * 4 + slot] = v; }
                } else {
                    for x in 0..w {
                        let v = u16::from_be_bytes([row[x * 2], row[x * 2 + 1]]) as u32;
                        dst[x * 4 + slot] = ((v * 255 + 32767) / 65535) as u8;
                    }
                }
            }
            if gray {
                for px in dst.chunks_exact_mut(4) { px[1] = px[0]; px[2] = px[0]; }
            }
            if info.has_alpha {
                // Photoshop stores the merged image matted against white: undo it
                for px in dst.chunks_exact_mut(4) {
                    let a = px[3] as f32;
                    if a > 0.0 && a < 255.0 {
                        let k = 255.0 / a;
                        for c in 0..3 {
                            let v = (px[c] as f32 - 255.0) * k + 255.0;
                            px[c] = v.round().clamp(0.0, 255.0) as u8;
                        }
                    }
                }
            }
            Ok(())
        },
    )
}

/// Reads the composite of `path` into a new RGBA8 buffer (used by tests).
#[cfg_attr(not(test), allow(dead_code))]
pub fn load_rgba(path: &str) -> Result<(CompositeInfo, Vec<u8>), CompositeError> {
    let mut f = File::open(path)?;
    let info = read_info(&mut f)?;
    let data = read_at(&mut f, info.image_data_offset, info.image_data_len as usize)?;
    let mut out = vec![0u8; info.width as usize * info.height as usize * 4];
    decode_rgba(&info, &data, &mut out)?;
    Ok((info, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packbits() {
        // literal 3 bytes, run of 4 x 0xAA, no-op, literal 1
        let src = [2u8, 1, 2, 3, (-3i8) as u8, 0xAA, 0x80, 0, 9];
        let mut dst = [0u8; 8];
        unpack_bits(&src, &mut dst).unwrap();
        assert_eq!(dst, [1, 2, 3, 0xAA, 0xAA, 0xAA, 0xAA, 9]);
    }

    /// Compares against reference RGBA dumps produced by `tools/composite_ref.py` (psd-tools).
    /// Run with: OIE_SAMPLES=<dir with *.psd and *.rgba> cargo test --release -- --nocapture samples
    #[test]
    fn samples() {
        let Ok(dir) = std::env::var("OIE_SAMPLES") else { eprintln!("OIE_SAMPLES not set, skipped"); return };
        let mut n = 0;
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            if p.extension().map(|x| x == "psd" || x == "psb").unwrap_or(false) {
                let reference = p.with_extension("rgba");
                if !reference.exists() { continue; }
                let t0 = std::time::Instant::now();
                let (info, rgba) = load_rgba(p.to_str().unwrap()).unwrap();
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                let want = std::fs::read(&reference).unwrap();
                assert_eq!(rgba.len(), want.len(), "{}", p.display());
                let mut max = 0u8;
                let mut diff_px = 0usize;
                for (a, b) in rgba.iter().zip(want.iter()) {
                    let d = a.abs_diff(*b);
                    if d > 0 { diff_px += 1; }
                    max = max.max(d);
                }
                eprintln!(
                    "{:<40} {}x{} ch{} {}bit alpha={} layers={}  {:>7.1} ms  max diff {}  diff bytes {}",
                    p.file_name().unwrap().to_string_lossy(), info.width, info.height, info.channels, info.depth,
                    info.has_alpha, info.layer_count, ms, max, diff_px
                );
                // opaque images must match exactly; un-matting can differ by rounding on semi-transparent pixels
                if !info.has_alpha { assert_eq!(max, 0, "{}", p.display()); }
                n += 1;
            }
        }
        assert!(n > 0, "no samples with .rgba references in {dir}");
    }
}
