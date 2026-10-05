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

/// Zero-copy read for Windows: the file range is read straight into a WebView2 shared buffer
/// (ICoreWebView2SharedBuffer) which is then posted to the page ("sharedbufferreceived" event).
/// Returns Ok(false) when not available (other OS / old WebView2 runtime) so the caller falls back to `read_range`.
#[tauri::command]
async fn read_range_shared(webview: tauri::Webview, path: String, offset: u64, length: u64, id: u32) -> Result<bool, String> {
    #[cfg(windows)]
    {
        shared::read_range_shared(webview, path, offset, length, id).await
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, path, offset, length, id);
        Ok(false)
    }
}

#[cfg(windows)]
mod shared {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment12, ICoreWebView2SharedBuffer, ICoreWebView2_17,
        COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
    };
    use windows_core::{Interface, PCWSTR};

    thread_local! {
        // shared buffers waiting to be posted; COM objects live on the UI thread only
        static PENDING: RefCell<HashMap<u32, ICoreWebView2SharedBuffer>> = RefCell::new(HashMap::new());
    }

    /// Runs `f` on the UI thread (where WebView2 COM objects live) and waits for its result.
    async fn on_ui<T: Send + 'static>(
        webview: &tauri::Webview,
        f: impl FnOnce(tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        webview
            .with_webview(move |pw| { let _ = tx.send(f(pw)); })
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
            .await
            .map_err(|e| e.to_string())?
    }

    fn discard(id: u32) {
        PENDING.with(|m| {
            if let Some(sb) = m.borrow_mut().remove(&id) {
                unsafe { let _ = sb.Close(); }
            }
        });
    }

    pub async fn read_range_shared(webview: tauri::Webview, path: String, offset: u64, length: u64, id: u32) -> Result<bool, String> {
        let size = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?.len();
        let start = offset.min(size);
        let len = length.min(size - start);
        if len == 0 {
            return Ok(false);
        }

        // 1) create the shared buffer on the UI thread; None = API not supported by this WebView2 runtime
        let ptr: Option<usize> = on_ui(&webview, move |pw| unsafe {
            let env12 = match pw.environment().cast::<ICoreWebView2Environment12>() {
                Ok(e) => e,
                Err(_) => return Ok(None),
            };
            let sb = env12.CreateSharedBuffer(len).map_err(|e| format!("CreateSharedBuffer: {e}"))?;
            let mut p: *mut u8 = std::ptr::null_mut();
            sb.Buffer(&mut p).map_err(|e| format!("SharedBuffer.Buffer: {e}"))?;
            PENDING.with(|m| m.borrow_mut().insert(id, sb));
            Ok(Some(p as usize))
        })
        .await?;
        let Some(ptr) = ptr else { return Ok(false) };

        // 2) read the file straight into the shared memory (off the UI thread)
        let t0 = std::time::Instant::now();
        let path2 = path.clone();
        let read = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            // SAFETY: the buffer stays mapped until it is closed in step 3 (or by `discard`)
            let dst = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u8, len as usize) };
            let mut f = File::open(&path2).map_err(|e| format!("{path2}: {e}"))?;
            f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
            f.read_exact(dst).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        if let Err(e) = read {
            let _ = on_ui(&webview, move |_| { discard(id); Ok(()) }).await;
            return Err(e);
        }
        #[cfg(debug_assertions)]
        eprintln!(
            "[read_range_shared] {:>8.1} MB  disk {:>6.1} ms  offset {}",
            len as f64 / 1048576.0,
            t0.elapsed().as_secs_f64() * 1000.0,
            start
        );
        #[cfg(not(debug_assertions))]
        let _ = t0;

        // 3) post it to the page, then close our native view of it (the page keeps its own mapping)
        on_ui(&webview, move |pw| unsafe {
            let sb = PENDING.with(|m| m.borrow_mut().remove(&id)).ok_or("shared buffer lost")?;
            let result = (|| -> Result<(), String> {
                let core = pw.controller().CoreWebView2().map_err(|e| e.to_string())?;
                let core17 = core.cast::<ICoreWebView2_17>().map_err(|e| format!("ICoreWebView2_17: {e}"))?;
                let json: Vec<u16> = format!("{{\"oieId\":{id}}}").encode_utf16().chain(std::iter::once(0)).collect();
                core17
                    .PostSharedBufferToScript(&sb, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, PCWSTR(json.as_ptr()))
                    .map_err(|e| format!("PostSharedBufferToScript: {e}"))
            })();
            let _ = sb.Close();
            result
        })
        .await?;
        Ok(true)
    }
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
        .invoke_handler(tauri::generate_handler![file_info, read_range, read_range_shared, list_images, startup_paths])
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
