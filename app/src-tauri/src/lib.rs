// OptImageEditor — Rust side.
// File access is done here so the WebView can read byte ranges of large files (PSD composite-only reads)
// and list sibling images for folder navigation.

use std::cmp::Ordering;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::ipc::Response;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileInfo {
    size: u64,
    modified_ms: f64,
}

#[tauri::command]
fn file_info(path: String) -> Result<FileInfo, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Ok(FileInfo { size: meta.len(), modified_ms })
}

/// Reads `length` bytes starting at `offset`. Returned as raw bytes (ArrayBuffer on the JS side).
#[tauri::command]
async fn read_range(path: String, offset: u64, length: u64) -> Result<Response, String> {
    // run the blocking file IO off the async runtime's worker threads
    tauri::async_runtime::spawn_blocking(move || -> Result<Response, String> {
        let t0 = std::time::Instant::now();
        let mut f = File::open(&path).map_err(|e| format!("{path}: {e}"))?;
        let size = f.metadata().map_err(|e| e.to_string())?.len();
        let start = offset.min(size);
        let len = length.min(size - start) as usize;
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; len];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        // diagnostics: disk read time on the Rust side (shown in the `tauri dev` terminal)
        #[cfg(debug_assertions)]
        eprintln!(
            "[read_range] {:>8.1} MB  disk {:>6.1} ms  offset {}",
            len as f64 / 1048576.0,
            t0.elapsed().as_secs_f64() * 1000.0,
            start
        );
        #[cfg(not(debug_assertions))]
        let _ = t0;
        Ok(Response::new(buf))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Natural ordering: "img2" < "img10", case-insensitive (similar to Windows Explorer).
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut ia, mut ib) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ia.peek().copied(), ib.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) if ca.is_ascii_digit() && cb.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ia.peek().copied().filter(|c| c.is_ascii_digit()) { na.push(c); ia.next(); }
                let mut nb = String::new();
                while let Some(c) = ib.peek().copied().filter(|c| c.is_ascii_digit()) { nb.push(c); ib.next(); }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb)).then_with(|| na.len().cmp(&nb.len()));
                if ord != Ordering::Equal { return ord; }
            }
            (Some(ca), Some(cb)) => {
                if ca != cb { return ca.cmp(&cb); }
                ia.next();
                ib.next();
            }
        }
    }
}

/// Image files (by extension) in the folder of `path` (or in `path` itself when it is a folder).
#[tauri::command]
fn list_images(path: String, extensions: Vec<String>) -> Result<Vec<String>, String> {
    let p = Path::new(&path);
    let dir: PathBuf = if p.is_dir() { p.to_path_buf() } else { p.parent().map(Path::to_path_buf).unwrap_or_default() };
    let exts: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| exts.contains(&x.to_lowercase()))
                .unwrap_or(false)
        })
        .filter_map(|p| p.to_str().map(str::to_owned))
        .collect();
    files.sort_by(|a, b| {
        let fa = Path::new(a).file_name().and_then(|s| s.to_str()).unwrap_or(a);
        let fb = Path::new(b).file_name().and_then(|s| s.to_str()).unwrap_or(b);
        natural_cmp(fa, fb)
    });
    Ok(files)
}

/// Existing files passed on the command line ("Open with", double-click on an associated file).
#[tauri::command]
fn startup_paths() -> Vec<String> {
    std::env::args().skip(1).filter(|a| !a.starts_with('-') && Path::new(a).is_file()).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![file_info, read_range, list_images, startup_paths])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::natural_cmp;
    use std::cmp::Ordering::*;

    #[test]
    fn natural_order() {
        assert_eq!(natural_cmp("img2.png", "img10.png"), Less);
        assert_eq!(natural_cmp("IMG_010.psd", "img_9.psd"), Greater);
        assert_eq!(natural_cmp("a.png", "A.png"), Equal);
        assert_eq!(natural_cmp("v1.2", "v1.10"), Less);
        let mut v = vec!["10.jpg", "2.jpg", "1.jpg", "b.jpg", "a10.jpg", "a2.jpg"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["1.jpg", "2.jpg", "10.jpg", "a2.jpg", "a10.jpg", "b.jpg"]);
    }
}
