//! Saving an edited PSD / PSB (phase 2-b, save method "B").
//!
//! The layer *structure* changes (order, groups, names, visibility, opacity, fill, blend mode, clipping,
//! mask on/off, new empty layers / groups, duplicates, deletions) but no layer pixels do. So instead of decoding
//! and re-encoding the whole document, the original file is parsed down to the layer records only, the records
//! are rebuilt from the edit plan, and every layer's channel image data is copied byte for byte from the
//! original. Everything else (image resources, global layer mask, global tagged blocks such as the embedded
//! smart object files) is copied as is, except the resources that refer to layers by index. The stored composite
//! ("merged image") is replaced by the composite the app rendered on the GPU.
//!
//! Memory use is the layer records plus the composite; the channel data is streamed from the original file.
//! Only 8 bit RGB documents are handled (the layers panel loads nothing else).

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// One node of the edited layer tree, bottom -> top (same shape as `PlanNode` in psdDoc.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    /// post-order index (1-based) of the source layer among the file's layers, dividers not counted
    pub orig_id: Option<u32>,
    pub dup: bool,
    pub group: bool,
    pub name: String,
    pub hidden: bool,
    pub opacity: f32,
    pub fill: f32,
    pub blend_mode: String,
    pub clipping: bool,
    pub mask_disabled: Option<bool>,
    pub open: bool,
    pub children: Option<Vec<PlanNode>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub src: String,
    pub dst: String,
    /// keep the replaced file as `<dst>.bak`
    pub backup: bool,
    pub width: u32,
    pub height: u32,
    /// number of layers (groups included, dividers not) the app read from `src`: guards against a file changed on disk
    pub layer_count: u32,
    pub plan: Vec<PlanNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub bytes: u64,
    pub ms: f64,
    pub parse_ms: f64,
    pub composite_ms: f64,
    pub write_ms: f64,
}

/// image resources that list layers by index or are previews of the old composite
const DROP_RESOURCES: [u16; 6] = [
    1024, // layer state (index of the target layer)
    1026, // layer group information (one entry per layer)
    1069, // layer selection ids
    1072, // layer group(s) enabled id
    1033, // thumbnail (old format)
    1036, // thumbnail
];

/// additional layer info keys whose length is 8 bytes in PSB files
const PSB_LONG_KEYS: [&[u8; 4]; 13] = [
    b"LMsk", b"Lr16", b"Lr32", b"Layr", b"Mt16", b"Mt32", b"Mtrn", b"Alph", b"FMsk", b"lnk2", b"FEid", b"FXid", b"PxSD",
];

fn err<T>(s: impl Into<String>) -> Result<T, String> { Err(s.into()) }

pub fn blend_key(mode: &str) -> Result<[u8; 4], String> {
    let k: &[u8; 4] = match mode {
        "pass through" => b"pass", "normal" => b"norm", "dissolve" => b"diss",
        "darken" => b"dark", "multiply" => b"mul ", "color burn" => b"idiv", "linear burn" => b"lbrn", "darker color" => b"dkCl",
        "lighten" => b"lite", "screen" => b"scrn", "color dodge" => b"div ", "linear dodge" => b"lddg", "lighter color" => b"lgCl",
        "overlay" => b"over", "soft light" => b"sLit", "hard light" => b"hLit", "vivid light" => b"vLit",
        "linear light" => b"lLit", "pin light" => b"pLit", "hard mix" => b"hMix",
        "difference" => b"diff", "exclusion" => b"smud", "subtract" => b"fsub", "divide" => b"fdiv",
        "hue" => b"hue ", "saturation" => b"sat ", "color" => b"colr", "luminosity" => b"lum ",
        m => return err(format!("unknown blend mode {m}")),
    };
    Ok(*k)
}

// ------------------------------------------------------------------ reading

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn need(&self, n: usize) -> Result<(), String> {
        if self.p + n > self.b.len() { err("unexpected end of the layer records") } else { Ok(()) }
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        self.need(n)?;
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> { Ok(self.bytes(1)?[0]) }
    fn u16(&mut self) -> Result<u16, String> { Ok(u16::from_be_bytes(self.bytes(2)?.try_into().unwrap())) }
    fn i16(&mut self) -> Result<i16, String> { Ok(i16::from_be_bytes(self.bytes(2)?.try_into().unwrap())) }
    fn u32(&mut self) -> Result<u32, String> { Ok(u32::from_be_bytes(self.bytes(4)?.try_into().unwrap())) }
    fn u64(&mut self) -> Result<u64, String> { Ok(u64::from_be_bytes(self.bytes(8)?.try_into().unwrap())) }
    fn len(&mut self, long: bool) -> Result<u64, String> { if long { self.u64() } else { Ok(self.u32()? as u64) } }
}

#[derive(Clone)]
struct Block {
    sig: [u8; 4],
    key: [u8; 4],
    data: Vec<u8>,
}

#[derive(Clone)]
struct Record {
    rect: [u8; 16],
    channels: Vec<(i16, u64)>,
    blend: [u8; 4],
    opacity: u8,
    clipping: u8,
    flags: u8,
    /// layer mask data without its length prefix
    mask: Vec<u8>,
    blend_ranges: Vec<u8>,
    /// pascal name bytes (without the length byte)
    name: Vec<u8>,
    blocks: Vec<Block>,
    /// where this layer's channel image data is in the original file
    data_off: u64,
    data_len: u64,
}

impl Record {
    fn block(&self, key: &[u8; 4]) -> Option<&Block> { self.blocks.iter().find(|b| &b.key == key) }
    fn block_mut(&mut self, key: &[u8; 4]) -> Option<&mut Block> { self.blocks.iter_mut().find(|b| &b.key == key) }
    /// lsct / lsdk type: 0 other, 1 open folder, 2 closed folder, 3 bounding divider
    fn section(&self) -> Option<u32> {
        let b = self.block(b"lsct").or_else(|| self.block(b"lsdk"))?;
        (b.data.len() >= 4).then(|| u32::from_be_bytes(b.data[0..4].try_into().unwrap()))
    }
    fn set_block(&mut self, key: &[u8; 4], data: Vec<u8>, front: bool) {
        if let Some(b) = self.block_mut(key) {
            b.data = data;
        } else {
            let b = Block { sig: *b"8BIM", key: *key, data };
            if front { self.blocks.insert(0, b) } else { self.blocks.push(b) }
        }
    }
    fn layer_id(&self) -> Option<u32> {
        self.block(b"lyid").filter(|b| b.data.len() >= 4).map(|b| u32::from_be_bytes(b.data[0..4].try_into().unwrap()))
    }

    /// empty record: no pixels, 4 channels of zero length (raw compression), like Photoshop writes
    fn empty(flags: u8) -> Record {
        Record {
            rect: [0; 16],
            channels: vec![(-1, 2), (0, 2), (1, 2), (2, 2)],
            blend: *b"norm",
            opacity: 255,
            clipping: 0,
            flags,
            mask: vec![],
            blend_ranges: vec![],
            name: vec![],
            blocks: vec![],
            data_off: 0,
            data_len: 0,
        }
    }

    /// A duplicated smart object gets its own instance id (like Ctrl+J in Photoshop); the embedded / linked file
    /// it shows (the "placed" id) stays shared. The id is in "PlLd" (ASCII) and in the "SoLd" descriptor (UTF-16).
    fn new_smart_object_instance(&mut self) {
        let Some(old) = self.block(b"PlLd").and_then(|b| {
            let d = &b.data;
            if d.len() < 9 || &d[0..4] != b"plcL" { return None; }
            let n = d[8] as usize;
            (d.len() >= 9 + n).then(|| d[9..9 + n].to_vec())
        }) else { return };
        if old.is_empty() { return; }
        let new = random_uuid_like(&old);
        let old16: Vec<u8> = old.iter().flat_map(|&c| [0u8, c]).collect();
        let new16: Vec<u8> = new.iter().flat_map(|&c| [0u8, c]).collect();
        for b in &mut self.blocks {
            if &b.key == b"PlLd" { replace_all(&mut b.data, &old, &new); }
            if &b.key == b"SoLd" || &b.key == b"SoLE" { replace_all(&mut b.data, &old16, &new16); }
        }
    }

    fn divider() -> Record {
        let mut r = Record::empty(0x18);
        r.set_name("</Layer group>");
        r.set_block(b"lsct", 3u32.to_be_bytes().to_vec(), false);
        r
    }

    fn set_name(&mut self, name: &str) {
        // the pascal name is a legacy (system code page) string: Photoshop writes "?" for what it cannot encode;
        // the real name is the unicode one ("luni")
        let mut ascii: Vec<u8> = name.chars().map(|c| if c.is_ascii() && !c.is_ascii_control() { c as u8 } else { b'?' }).collect();
        ascii.truncate(255);
        self.name = ascii;
        let units: Vec<u16> = name.encode_utf16().collect();
        let mut d = Vec::with_capacity(4 + units.len() * 2);
        d.extend_from_slice(&(units.len() as u32).to_be_bytes());
        for u in units { d.extend_from_slice(&u.to_be_bytes()); }
        while d.len() % 4 != 0 { d.push(0); } // as Photoshop pads it
        self.set_block(b"luni", d, true);
    }
}

fn replace_all(data: &mut [u8], from: &[u8], to: &[u8]) {
    if from.is_empty() || from.len() != to.len() { return; }
    let mut i = 0;
    while i + from.len() <= data.len() {
        if &data[i..i + from.len()] == from {
            data[i..i + from.len()].copy_from_slice(to);
            i += from.len();
        } else {
            i += 1;
        }
    }
}

/// new random id with the same shape as `like` (hex digits replaced, separators kept)
fn random_uuid_like(like: &[u8]) -> Vec<u8> {
    use std::hash::{BuildHasher, Hasher};
    let mut bits = 0u64;
    let mut left = 0;
    let mut seed = 0u64;
    like.iter()
        .map(|&c| {
            if !c.is_ascii_hexdigit() { return c; }
            if left == 0 {
                let mut h = std::collections::hash_map::RandomState::new().build_hasher();
                h.write_u64(seed);
                h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
                bits = h.finish();
                seed = seed.wrapping_add(bits | 1);
                left = 16;
            }
            let v = (bits & 15) as u8;
            bits >>= 4;
            left -= 1;
            let upper = c.is_ascii_uppercase();
            let ch = b"0123456789abcdef"[v as usize];
            if upper { ch.to_ascii_uppercase() } else { ch }
        })
        .collect()
}

fn read_blocks(r: &mut Reader, end: usize, psb: bool) -> Result<Vec<Block>, String> {
    let mut out = vec![];
    while r.p + 12 <= end {
        let sig: [u8; 4] = r.bytes(4)?.try_into().unwrap();
        if &sig != b"8BIM" && &sig != b"8B64" { return err(format!("bad tagged block signature at {}", r.p - 4)); }
        let key: [u8; 4] = r.bytes(4)?.try_into().unwrap();
        let long = psb && PSB_LONG_KEYS.iter().any(|k| **k == key);
        let len = r.len(long)? as usize;
        let data = r.bytes(len)?.to_vec();
        out.push(Block { sig, key, data });
    }
    r.p = end;
    Ok(out)
}

fn read_record(r: &mut Reader, psb: bool) -> Result<Record, String> {
    let rect: [u8; 16] = r.bytes(16)?.try_into().unwrap();
    let nc = r.u16()? as usize;
    let mut channels = Vec::with_capacity(nc);
    for _ in 0..nc {
        let id = r.i16()?;
        let len = r.len(psb)?;
        channels.push((id, len));
    }
    if r.bytes(4)? != b"8BIM" { return err("bad blend mode signature"); }
    let blend: [u8; 4] = r.bytes(4)?.try_into().unwrap();
    let opacity = r.u8()?;
    let clipping = r.u8()?;
    let flags = r.u8()?;
    r.u8()?; // filler
    let extra = r.u32()? as usize;
    let end = r.p + extra;
    r.need(extra)?;
    let ml = r.u32()? as usize;
    let mask = r.bytes(ml)?.to_vec();
    let bl = r.u32()? as usize;
    let blend_ranges = r.bytes(bl)?.to_vec();
    let nl = r.u8()? as usize;
    let name = r.bytes(nl)?.to_vec();
    let padded = (nl + 1 + 3) & !3; // the pascal string is padded to a multiple of 4 (length byte included)
    r.bytes(padded - nl - 1)?;
    let blocks = read_blocks(r, end, psb)?;
    Ok(Record { rect, channels, blend, opacity, clipping, flags, mask, blend_ranges, name, blocks, data_off: 0, data_len: 0 })
}

fn read_at(f: &mut File, off: u64, len: usize) -> Result<Vec<u8>, String> {
    let mut b = vec![0u8; len];
    f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
    f.read_exact(&mut b).map_err(|e| e.to_string())?;
    Ok(b)
}

fn read_len_at(f: &mut File, off: u64, long: bool) -> Result<u64, String> {
    let b = read_at(f, off, if long { 8 } else { 4 })?;
    Ok(if long { u64::from_be_bytes(b.try_into().unwrap()) } else { u32::from_be_bytes(b.try_into().unwrap()) as u64 })
}

struct Source {
    psb: bool,
    header: Vec<u8>,
    color_mode_data: Vec<u8>,
    /// raw resource blocks (signature .. padded data) with their ids
    resources: Vec<(u16, Vec<u8>)>,
    records: Vec<Record>,
    /// merged image has a transparency channel (negative layer count)
    had_transparency: bool,
    global_mask: Vec<u8>,
    /// global additional layer info: [offset, offset + len) in the file, copied as is
    tagged: (u64, u64),
    image_data: (u64, u64),
    channels: u16,
    width: u32,
    height: u32,
}

fn parse(f: &mut File) -> Result<Source, String> {
    let file_len = f.metadata().map_err(|e| e.to_string())?.len();
    let header = read_at(f, 0, 26)?;
    if &header[0..4] != b"8BPS" { return err("PSD ではありません"); }
    let psb = match u16::from_be_bytes([header[4], header[5]]) { 1 => false, 2 => true, v => return err(format!("version {v}")) };
    let channels = u16::from_be_bytes([header[12], header[13]]);
    let height = u32::from_be_bytes(header[14..18].try_into().unwrap());
    let width = u32::from_be_bytes(header[18..22].try_into().unwrap());
    let depth = u16::from_be_bytes([header[22], header[23]]);
    let mode = u16::from_be_bytes([header[24], header[25]]);
    if depth != 8 || mode != 3 { return err("保存できるのは 8bit RGB の PSD / PSB だけです"); }

    let mut pos = 26u64;
    let cm_len = read_len_at(f, pos, false)?;
    let color_mode_data = read_at(f, pos + 4, cm_len as usize)?;
    pos += 4 + cm_len;

    let res_len = read_len_at(f, pos, false)?;
    let res = read_at(f, pos + 4, res_len as usize)?;
    pos += 4 + res_len;
    let mut resources = vec![];
    let mut p = 0usize;
    while p + 12 <= res.len() {
        let start = p;
        if &res[p..p + 4] != b"8BIM" && &res[p..p + 4] != b"MeSa" && &res[p..p + 4] != b"AgHg" && &res[p..p + 4] != b"PHUT" && &res[p..p + 4] != b"DCSR" {
            return err(format!("bad image resource signature at {}", p));
        }
        let id = u16::from_be_bytes([res[p + 4], res[p + 5]]);
        let nl = res[p + 6] as usize;
        p += 6 + ((nl + 2) & !1);
        let size = u32::from_be_bytes(res[p..p + 4].try_into().unwrap()) as usize;
        p += 4 + ((size + 1) & !1);
        if p > res.len() { return err("image resources are truncated"); }
        resources.push((id, res[start..p].to_vec()));
    }

    let lm_len = read_len_at(f, pos, psb)?;
    let l = if psb { 8 } else { 4 };
    let lm_start = pos + l;
    let lm_end = lm_start + lm_len;
    let image_data = (lm_end, file_len);
    if lm_len == 0 {
        return Ok(Source {
            psb, header, color_mode_data, resources, records: vec![], had_transparency: false, global_mask: vec![],
            tagged: (lm_end, lm_end), image_data, channels, width, height,
        });
    }
    let li_len = read_len_at(f, lm_start, psb)?;
    let li_start = lm_start + l;
    let mut records = vec![];
    let mut had_transparency = false;
    if li_len > 0 {
        let count = i16::from_be_bytes(read_at(f, li_start, 2)?.try_into().unwrap());
        had_transparency = count < 0;
        // the records are small; read generously and parse (channel data follows them)
        let mut want = (li_len.min(64 << 20)) as usize;
        loop {
            let buf = read_at(f, li_start + 2, want.min((li_len - 2) as usize))?;
            let mut r = Reader { b: &buf, p: 0 };
            let mut out = vec![];
            let mut ok = true;
            for _ in 0..count.unsigned_abs() {
                match read_record(&mut r, psb) {
                    Ok(rec) => out.push(rec),
                    Err(e) => {
                        if want as u64 >= li_len - 2 { return Err(e); }
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                let mut off = li_start + 2 + r.p as u64;
                for rec in &mut out {
                    rec.data_off = off;
                    rec.data_len = rec.channels.iter().map(|c| c.1).sum();
                    off += rec.data_len;
                }
                if off > li_start + li_len { return err("layer channel data runs past the layer info"); }
                records = out;
                break;
            }
            want = (want * 4).min((li_len - 2) as usize);
        }
    } else {
        // 16 / 32 bit documents keep the layers in an "Lr16" / "Lr32" block: not handled (8 bit only)
    }
    let gm_pos = li_start + li_len;
    let gm_len = if gm_pos + 4 <= lm_end { read_len_at(f, gm_pos, false)? } else { 0 };
    let global_mask = if gm_pos + 4 <= lm_end { read_at(f, gm_pos + 4, gm_len as usize)? } else { vec![] };
    let tagged_start = (gm_pos + 4 + gm_len).min(lm_end);
    if records.is_empty() {
        // layers stored elsewhere (Lr16 etc.): refuse rather than lose them
        let tagged = read_at(f, tagged_start, ((lm_end - tagged_start) as usize).min(1 << 20))?;
        if tagged.windows(4).any(|w| w == b"Lr16" || w == b"Lr32" || w == b"Layr") {
            return err("この形式のレイヤー（Lr16 / Lr32 / Layr）は保存に未対応です");
        }
    }
    Ok(Source {
        psb, header, color_mode_data, resources, records, had_transparency, global_mask,
        tagged: (tagged_start, lm_end), image_data, channels, width, height,
    })
}

// ------------------------------------------------------------------ building the new layer list

enum Data {
    Copy(u64, u64),
    Empty,
}

struct Builder<'a> {
    src: &'a Source,
    /// post-order index (1-based, dividers not counted) -> record index
    by_id: HashMap<u32, usize>,
    /// group record index -> its bounding divider record index
    divider_of: HashMap<usize, usize>,
    next_layer_id: u32,
    out: Vec<(Record, Data)>,
}

impl<'a> Builder<'a> {
    fn new(src: &'a Source) -> Result<Self, String> {
        let mut by_id = HashMap::new();
        let mut divider_of = HashMap::new();
        let mut stack = vec![];
        let mut n = 0u32;
        let mut max_id = 0u32;
        for (i, r) in src.records.iter().enumerate() {
            max_id = max_id.max(r.layer_id().unwrap_or(0));
            match r.section() {
                Some(3) => stack.push(i),
                s => {
                    if matches!(s, Some(1) | Some(2)) {
                        if let Some(d) = stack.pop() { divider_of.insert(i, d); }
                    }
                    n += 1;
                    by_id.insert(n, i);
                }
            }
        }
        Ok(Builder { src, by_id, divider_of, next_layer_id: max_id + 1, out: vec![] })
    }

    fn layer_count(&self) -> u32 { self.by_id.len() as u32 }

    fn new_layer_id(&mut self) -> Vec<u8> {
        let id = self.next_layer_id;
        self.next_layer_id += 1;
        id.to_be_bytes().to_vec()
    }

    fn apply(&mut self, rec: &mut Record, q: &PlanNode) -> Result<(), String> {
        rec.set_name(&q.name);
        rec.opacity = (q.opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
        if q.hidden { rec.flags |= 0x02 } else { rec.flags &= !0x02 }
        let key = blend_key(&q.blend_mode)?;
        if q.group {
            rec.blend = if &key == b"pass" { *b"norm" } else { key };
            let t: u32 = if q.open { 1 } else { 2 };
            let mut d = Vec::with_capacity(16);
            d.extend_from_slice(&t.to_be_bytes());
            d.extend_from_slice(b"8BIM");
            d.extend_from_slice(&key);
            // keep the sub type (scene group) when present
            let sub = rec.block(b"lsct").filter(|b| b.data.len() >= 16).map(|b| b.data[12..16].to_vec()).unwrap_or(vec![0; 4]);
            d.extend_from_slice(&sub);
            if rec.block(b"lsdk").is_some() && rec.block(b"lsct").is_none() {
                rec.set_block(b"lsdk", d, false);
            } else {
                rec.set_block(b"lsct", d, false);
            }
            rec.clipping = 0;
        } else {
            rec.blend = key;
            rec.clipping = q.clipping as u8;
            let fill = (q.fill.clamp(0.0, 1.0) * 255.0).round() as u8;
            if let Some(b) = rec.block_mut(b"iOpa") {
                if !b.data.is_empty() { b.data[0] = fill; }
            } else if fill != 255 {
                rec.set_block(b"iOpa", vec![fill, 0, 0, 0], false);
            }
        }
        if let Some(d) = q.mask_disabled {
            if rec.mask.len() >= 18 {
                if d { rec.mask[17] |= 0x02 } else { rec.mask[17] &= !0x02 }
            }
        }
        Ok(())
    }

    fn emit(&mut self, nodes: &[PlanNode]) -> Result<(), String> {
        for q in nodes {
            let src_index = match q.orig_id {
                Some(id) => Some(*self.by_id.get(&id).ok_or_else(|| format!("layer {id} not found in the file"))?),
                None => None,
            };
            if q.group {
                // bounding divider (bottom of the group), then the children, then the group record itself
                match src_index.and_then(|i| self.divider_of.get(&i)) {
                    Some(&d) if !q.dup => {
                        let r = self.src.records[d].clone();
                        let data = Data::Copy(r.data_off, r.data_len);
                        self.out.push((r, data));
                    }
                    _ => {
                        let mut d = Record::divider();
                        let id = self.new_layer_id();
                        d.set_block(b"lyid", id, false);
                        self.out.push((d, Data::Empty));
                    }
                }
                self.emit(q.children.as_deref().unwrap_or(&[]))?;
                let (mut rec, data) = match src_index {
                    Some(i) => {
                        let r = self.src.records[i].clone();
                        let d = Data::Copy(r.data_off, r.data_len);
                        (r, d)
                    }
                    None => (Record::empty(0x18), Data::Empty),
                };
                if src_index.is_none() || q.dup {
                    let id = self.new_layer_id();
                    rec.set_block(b"lyid", id, false);
                }
                self.apply(&mut rec, q)?;
                self.out.push((rec, data));
            } else {
                let (mut rec, data) = match src_index {
                    Some(i) => {
                        let r = self.src.records[i].clone();
                        let d = Data::Copy(r.data_off, r.data_len);
                        (r, d)
                    }
                    None => (Record::empty(0x08), Data::Empty),
                };
                if src_index.is_none() || q.dup {
                    let id = self.new_layer_id();
                    rec.set_block(b"lyid", id, false);
                }
                if q.dup { rec.new_smart_object_instance(); }
                self.apply(&mut rec, q)?;
                self.out.push((rec, data));
            }
        }
        Ok(())
    }
}

// ------------------------------------------------------------------ writing

fn put_len(v: &mut Vec<u8>, n: u64, long: bool) {
    if long { v.extend_from_slice(&n.to_be_bytes()) } else { v.extend_from_slice(&(n as u32).to_be_bytes()) }
}

fn serialize_record(rec: &Record, psb: bool, v: &mut Vec<u8>) {
    v.extend_from_slice(&rec.rect);
    v.extend_from_slice(&(rec.channels.len() as u16).to_be_bytes());
    for (id, len) in &rec.channels {
        v.extend_from_slice(&id.to_be_bytes());
        put_len(v, *len, psb);
    }
    v.extend_from_slice(b"8BIM");
    v.extend_from_slice(&rec.blend);
    v.extend_from_slice(&[rec.opacity, rec.clipping, rec.flags, 0]);
    let mut extra = Vec::with_capacity(64 + rec.mask.len());
    extra.extend_from_slice(&(rec.mask.len() as u32).to_be_bytes());
    extra.extend_from_slice(&rec.mask);
    extra.extend_from_slice(&(rec.blend_ranges.len() as u32).to_be_bytes());
    extra.extend_from_slice(&rec.blend_ranges);
    extra.push(rec.name.len() as u8);
    extra.extend_from_slice(&rec.name);
    let pad = (4 - (1 + rec.name.len()) % 4) % 4; // pascal string padded to a multiple of 4 (length byte included)
    extra.extend(std::iter::repeat(0u8).take(pad));
    for b in &rec.blocks {
        extra.extend_from_slice(&b.sig);
        extra.extend_from_slice(&b.key);
        let long = psb && PSB_LONG_KEYS.iter().any(|k| **k == b.key);
        // blocks we build are padded to a multiple of 4 (as Photoshop does); copied ones keep their length
        let mut data = b.data.clone();
        if data.len() % 2 == 1 { data.push(0); }
        put_len(&mut extra, data.len() as u64, long);
        extra.extend_from_slice(&data);
    }
    v.extend_from_slice(&(extra.len() as u32).to_be_bytes());
    v.extend_from_slice(&extra);
}

/// PackBits (Photoshop RLE) of one row
fn pack_bits(src: &[u8], out: &mut Vec<u8>) {
    let n = src.len();
    let mut i = 0;
    while i < n {
        // run of identical bytes?
        let mut run = 1;
        while i + run < n && run < 128 && src[i + run] == src[i] { run += 1; }
        if run >= 3 || (run == 2 && i + run == n) {
            out.push((257 - run) as u8);
            out.push(src[i]);
            i += run;
            continue;
        }
        // literal: until a run of 3 starts or 128 bytes
        let start = i;
        let mut len = 0;
        while i < n && len < 128 {
            if i + 2 < n && src[i] == src[i + 1] && src[i] == src[i + 2] { break; }
            i += 1;
            len += 1;
        }
        out.push((len - 1) as u8);
        out.extend_from_slice(&src[start..start + len]);
    }
}

fn unpack_bits(src: &[u8], dst: &mut [u8]) -> Result<(), String> {
    let (mut i, mut o) = (0, 0);
    while i < src.len() && o < dst.len() {
        let n = src[i] as i8;
        i += 1;
        if n >= 0 {
            let l = n as usize + 1;
            if i + l > src.len() || o + l > dst.len() { return err("bad RLE data"); }
            dst[o..o + l].copy_from_slice(&src[i..i + l]);
            i += l;
            o += l;
        } else if n != -128 {
            let l = 1 - n as isize;
            let l = l as usize;
            if i >= src.len() || o + l > dst.len() { return err("bad RLE data"); }
            dst[o..o + l].fill(src[i]);
            i += 1;
            o += l;
        }
    }
    Ok(())
}

/// Composite planes, RLE-compressed: (byte counts per row, row data) in plane order.
fn composite_rows(rgba: &[u8], w: usize, h: usize, transparency: bool) -> Vec<Vec<u8>> {
    let planes = if transparency { 4 } else { 3 };
    (0..planes * h)
        .into_par_iter()
        .map(|i| {
            let (c, y) = (i / h, i % h);
            let px = &rgba[y * w * 4..(y + 1) * w * 4];
            let row: Vec<u8> = if c == 3 {
                px.chunks_exact(4).map(|p| p[3]).collect()
            } else if transparency {
                // the GPU composite is premultiplied: matte against white = Cp + (255 - a)
                px.chunks_exact(4).map(|p| (p[c] as u16 + 255 - p[3] as u16).min(255) as u8).collect()
            } else {
                px.chunks_exact(4).map(|p| p[c]).collect()
            };
            let mut out = Vec::with_capacity(w + w / 64 + 2);
            pack_bits(&row, &mut out);
            out
        })
        .collect()
}

/// Extra channels (alpha / spot) of the original merged image, as RLE rows.
fn extra_rows(f: &mut File, src: &Source, first: usize) -> Result<Vec<Vec<u8>>, String> {
    let (w, h) = (src.width as usize, src.height as usize);
    let total = src.channels as usize;
    if first >= total { return Ok(vec![]); }
    let (start, end) = src.image_data;
    if end < start + 2 { return err("merged image data is missing"); }
    let comp = u16::from_be_bytes(read_at(f, start, 2)?.try_into().unwrap());
    let mut out = vec![];
    match comp {
        0 => {
            for c in first..total {
                let plane = read_at(f, start + 2 + (c * w * h) as u64, w * h)?;
                for y in 0..h {
                    let mut r = vec![];
                    pack_bits(&plane[y * w..(y + 1) * w], &mut r);
                    out.push(r);
                }
            }
        }
        1 => {
            let cb = if src.psb { 4 } else { 2 };
            let table = read_at(f, start + 2, total * h * cb)?;
            let count = |i: usize| -> u64 {
                if cb == 4 { u32::from_be_bytes(table[i * 4..i * 4 + 4].try_into().unwrap()) as u64 } else { u16::from_be_bytes([table[i * 2], table[i * 2 + 1]]) as u64 }
            };
            let mut off = start + 2 + (total * h * cb) as u64;
            for i in 0..first * h { off += count(i); }
            for i in first * h..total * h {
                let n = count(i);
                let row = read_at(f, off, n as usize)?;
                // validate the row (cheap) so a damaged source does not produce a damaged file silently
                let mut tmp = vec![0u8; w];
                unpack_bits(&row, &mut tmp)?;
                out.push(row);
                off += n;
            }
        }
        c => return err(format!("merged image compression {c} is not supported")),
    }
    Ok(out)
}

fn copy_range(src: &mut File, off: u64, len: u64, w: &mut impl Write) -> Result<(), String> {
    src.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
    let n = std::io::copy(&mut (&*src).take(len), w).map_err(|e| e.to_string())?;
    if n != len { return err("the source file ended early"); }
    Ok(())
}

fn is_psb_path(p: &str) -> bool { p.to_ascii_lowercase().ends_with(".psb") }

/// Writes the edited document to `req.dst` (via `<dst>.tmp`). `rgba`: premultiplied composite, width * height * 4.
pub fn save(req: &SaveRequest, rgba: &[u8]) -> Result<SaveResult, String> {
    let t0 = std::time::Instant::now();
    let (w, h) = (req.width as usize, req.height as usize);
    if rgba.len() != w * h * 4 { return err(format!("composite size {} != {}x{}x4", rgba.len(), w, h)); }
    let tmp = PathBuf::from(format!("{}.tmp", req.dst));
    let parse_ms;
    let composite_ms;
    let written;
    {
        let mut f = File::open(&req.src).map_err(|e| format!("{}: {e}", req.src))?;
        let src = parse(&mut f)?;
        if src.width != req.width || src.height != req.height { return err("画像サイズがファイルと一致しません"); }
        if src.psb != is_psb_path(&req.dst) {
            return err("PSD と PSB の相互変換は未対応です（拡張子を元と同じにしてください）");
        }
        let mut b = Builder::new(&src)?;
        if b.layer_count() != req.layer_count {
            return err(format!(
                "ファイルのレイヤー数（{}）が読み込み時（{}）と違います。読み込んだ後にファイルが変更された可能性があります（F5 で読み直してください）",
                b.layer_count(), req.layer_count
            ));
        }
        b.emit(&req.plan)?;
        let out = std::mem::take(&mut b.out);
        parse_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // composite: transparency channel when the old one had it or the new composite is not opaque
        let t1 = std::time::Instant::now();
        let opaque = rgba.par_chunks(4 * 4096).all(|c| c.chunks_exact(4).all(|p| p[3] == 255));
        let transparency = src.had_transparency || !opaque;
        let extras_from = if src.had_transparency { 4 } else { 3 };
        let mut rows = composite_rows(rgba, w, h, transparency);
        rows.extend(extra_rows(&mut f, &src, extras_from)?);
        let planes = rows.len() / h.max(1);
        composite_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let psb = src.psb;
        let l = if psb { 8 } else { 4 };
        let file = File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        let mut o = BufWriter::with_capacity(8 << 20, file);
        let wr = |o: &mut BufWriter<File>, b: &[u8]| o.write_all(b).map_err(|e| e.to_string());

        // header (channel count = composite planes)
        let mut header = src.header.clone();
        header[12..14].copy_from_slice(&(planes as u16).to_be_bytes());
        wr(&mut o, &header)?;
        wr(&mut o, &(src.color_mode_data.len() as u32).to_be_bytes())?;
        wr(&mut o, &src.color_mode_data)?;
        let res: Vec<&Vec<u8>> = src.resources.iter().filter(|(id, _)| !DROP_RESOURCES.contains(id)).map(|(_, d)| d).collect();
        wr(&mut o, &(res.iter().map(|d| d.len()).sum::<usize>() as u32).to_be_bytes())?;
        for d in res { wr(&mut o, d)?; }

        // layer and mask information
        let mut recs = Vec::new();
        let count = out.len() as i16;
        recs.extend_from_slice(&(if transparency { -count } else { count }).to_be_bytes());
        for (r, _) in &out { serialize_record(r, psb, &mut recs); }
        let data_len: u64 = out.iter().map(|(r, d)| match d { Data::Copy(_, n) => *n, Data::Empty => r.channels.iter().map(|c| c.1).sum() }).sum();
        let mut li_len = recs.len() as u64 + data_len;
        let li_pad = (4 - li_len % 4) % 4;
        li_len += li_pad;
        let tagged_len = src.tagged.1 - src.tagged.0;
        let lm_len = if out.is_empty() && src.records.is_empty() && src.global_mask.is_empty() && tagged_len == 0 {
            0
        } else {
            l + li_len + 4 + src.global_mask.len() as u64 + tagged_len
        };
        let mut v = vec![];
        put_len(&mut v, lm_len, psb);
        wr(&mut o, &v)?;
        if lm_len > 0 {
            let mut v = vec![];
            put_len(&mut v, if out.is_empty() { 0 } else { li_len }, psb);
            wr(&mut o, &v)?;
            if !out.is_empty() {
                wr(&mut o, &recs)?;
                for (r, d) in &out {
                    match d {
                        Data::Copy(off, n) => copy_range(&mut f, *off, *n, &mut o)?,
                        Data::Empty => {
                            // each channel: compression 0, no pixels
                            for c in &r.channels { wr(&mut o, &vec![0u8; c.1 as usize])?; }
                        }
                    }
                }
                wr(&mut o, &vec![0u8; li_pad as usize])?;
            }
            wr(&mut o, &(src.global_mask.len() as u32).to_be_bytes())?;
            wr(&mut o, &src.global_mask)?;
            copy_range(&mut f, src.tagged.0, tagged_len, &mut o)?;
        }

        // merged image: RLE
        wr(&mut o, &1u16.to_be_bytes())?;
        let mut table = Vec::with_capacity(rows.len() * l as usize / 2);
        for r in &rows {
            if psb { table.extend_from_slice(&(r.len() as u32).to_be_bytes()) } else {
                if r.len() > u16::MAX as usize { return err("row too long for PSD RLE"); }
                table.extend_from_slice(&(r.len() as u16).to_be_bytes())
            }
        }
        wr(&mut o, &table)?;
        for r in &rows { wr(&mut o, r)?; }
        let file = o.into_inner().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        written = file.metadata().map_err(|e| e.to_string())?.len();
        // `f` (the source) is closed here: on Windows a file that is still open cannot be renamed
    }
    let tw = std::time::Instant::now();
    replace_file(Path::new(&req.dst), &tmp, req.backup)?;
    let _ = tw;
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    Ok(SaveResult { bytes: written, ms, parse_ms, composite_ms, write_ms: ms - parse_ms - composite_ms })
}

/// `tmp` -> `target`, keeping the old target as `<target>.bak` when `backup`.
pub fn replace_file(target: &Path, tmp: &Path, backup: bool) -> Result<(), String> {
    if backup && target.exists() {
        let bak = PathBuf::from(format!("{}.bak", target.display()));
        if bak.exists() { std::fs::remove_file(&bak).map_err(|e| format!("{}: {e}", bak.display()))?; }
        std::fs::rename(target, &bak).map_err(|e| format!("{}: {e}", bak.display()))?;
    }
    std::fs::rename(tmp, target).map_err(|e| format!("{}: {e}", target.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packbits_roundtrip() {
        let rows: Vec<Vec<u8>> = vec![
            vec![], vec![1], vec![1, 1], vec![1, 2], vec![5; 300], (0..=255).collect(),
            [vec![1, 2, 3], vec![9; 5], vec![4, 4], vec![7; 130], vec![1, 2]].concat(),
        ];
        for r in rows {
            let mut p = vec![];
            pack_bits(&r, &mut p);
            let mut u = vec![0u8; r.len()];
            unpack_bits(&p, &mut u).unwrap();
            assert_eq!(u, r);
        }
    }

    /// OIE_SAVE_TEST=<dir> with <dir>/req.json (SaveRequest) and <dir>/composite.rgba
    #[test]
    fn save_from_env() {
        let Ok(dir) = std::env::var("OIE_SAVE_TEST") else { return };
        let req: SaveRequest = serde_json::from_slice(&std::fs::read(format!("{dir}/req.json")).unwrap()).unwrap();
        let rgba = std::fs::read(format!("{dir}/composite.rgba")).unwrap();
        let r = save(&req, &rgba).unwrap();
        println!("saved {} bytes in {:.0} ms (parse {:.0}, composite {:.0}, write {:.0})", r.bytes, r.ms, r.parse_ms, r.composite_ms, r.write_ms);
    }
}
