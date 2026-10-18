// OptImageEditor — Rust side.
mod comfy;
mod composite;
mod hdr;
mod psd_save;
mod update;
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
    let size = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?.len();
    let start = offset.min(size);
    let len = length.min(size - start);
    if len == 0 {
        return Ok(false);
    }
    let t0 = std::time::Instant::now();
    let posted = shared::post_shared(&webview, len, id, move |dst| {
        let mut f = File::open(&path).map_err(|e| format!("{path}: {e}"))?;
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        f.read_exact(dst).map_err(|e| e.to_string())
    })
    .await?;
    #[cfg(debug_assertions)]
    eprintln!("[read_range_shared] {:>8.1} MB  {:>6.1} ms  offset {}", len as f64 / 1048576.0, t0.elapsed().as_secs_f64() * 1000.0, start);
    let _ = t0;
    Ok(posted.is_some())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompositeLoad {
    /// true: premultiplied RGBA8 pixels were posted as a shared buffer (event "sharedbufferreceived" with oieId = id)
    posted: bool,
    /// set when the file cannot be handled here (the page then uses its own decoder)
    unsupported: Option<String>,
    info: Option<composite::CompositeInfo>,
    read_ms: f64,
    decode_ms: f64,
}

/// Viewer fast path: decodes the PSD/PSB composite in parallel (Rust) straight into shared memory as RGBA8.
#[tauri::command]
async fn load_composite_shared(webview: tauri::Webview, path: String, id: u32) -> Result<CompositeLoad, String> {
    let p2 = path.clone();
    let info = tauri::async_runtime::spawn_blocking(move || -> Result<composite::CompositeInfo, composite::CompositeError> {
        let mut f = File::open(&p2)?;
        composite::read_info(&mut f)
    })
    .await
    .map_err(|e| e.to_string())?;
    let info = match info {
        Ok(i) => i,
        Err(composite::CompositeError::Unsupported(m)) => {
            return Ok(CompositeLoad { posted: false, unsupported: Some(m), info: None, read_ms: 0.0, decode_ms: 0.0 })
        }
        Err(e) => return Err(format!("{path}: {e}")),
    };
    // reject what decode_rgba cannot handle before allocating shared memory
    if !matches!(info.color_mode, 1 | 3) || !matches!(info.depth, 8 | 16) {
        let m = format!("color mode {} / {} bit", info.color_mode, info.depth);
        return Ok(CompositeLoad { posted: false, unsupported: Some(m), info: Some(info), read_ms: 0.0, decode_ms: 0.0 });
    }
    let len = info.width as u64 * info.height as u64 * 4;
    let info2 = info.clone();
    let result = shared::post_shared(&webview, len, id, move |dst| -> Result<(f64, f64), String> {
        let t0 = std::time::Instant::now();
        let mut f = File::open(&path).map_err(|e| format!("{path}: {e}"))?;
        f.seek(SeekFrom::Start(info2.image_data_offset)).map_err(|e| e.to_string())?;
        let mut data = vec![0u8; info2.image_data_len as usize];
        f.read_exact(&mut data).map_err(|e| e.to_string())?;
        let read_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = std::time::Instant::now();
        composite::decode_rgba(&info2, &data, dst, true).map_err(|e| e.to_string())?;
        Ok((read_ms, t1.elapsed().as_secs_f64() * 1000.0))
    })
    .await;
    match result {
        Ok(Some((read_ms, decode_ms))) => {
            #[cfg(debug_assertions)]
            eprintln!("[load_composite_shared] {}x{}  read {:>6.1} ms  decode {:>6.1} ms", info.width, info.height, read_ms, decode_ms);
            Ok(CompositeLoad { posted: true, unsupported: None, info: Some(info), read_ms, decode_ms })
        }
        Ok(None) => Ok(CompositeLoad { posted: false, unsupported: None, info: Some(info), read_ms: 0.0, decode_ms: 0.0 }),
        Err(e) if e.starts_with("unsupported") => {
            Ok(CompositeLoad { posted: false, unsupported: Some(e), info: Some(info), read_ms: 0.0, decode_ms: 0.0 })
        }
        Err(e) => Err(e),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HdrLoad {
    /// pixels were posted as a shared buffer; otherwise fetch them with `take_buffer(id)`
    posted: bool,
    info: hdr::HdrInfo,
    layer: usize,
    width: u32,
    height: u32,
    decode_ms: f64,
}

/// Decoded pixels waiting for `take_buffer` (IPC fallback when shared buffers are not available).
fn stash() -> &'static std::sync::Mutex<std::collections::HashMap<u32, Vec<u8>>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, Vec<u8>>>> = std::sync::OnceLock::new();
    S.get_or_init(Default::default)
}

/// EXR / Radiance HDR: decodes `layer` to half-float RGBA (8 bytes / pixel) into shared memory,
/// or into the stash for `take_buffer` when shared memory is not available.
#[tauri::command]
async fn load_hdr(webview: tauri::Webview, path: String, layer: usize, id: u32) -> Result<HdrLoad, String> {
    let p = PathBuf::from(&path);
    let p2 = p.clone();
    let info = tauri::async_runtime::spawn_blocking(move || hdr::probe(&p2))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{path}: {e}"))?;
    let layer = layer.min(info.layers.len() - 1);
    let (w, h) = (info.layers[layer].width, info.layers[layer].height);
    let len = w as u64 * h as u64 * 8;
    let (p3, i3) = (p.clone(), info.clone());
    let shared = shared::post_shared(&webview, len, id, move |dst| -> Result<f64, String> {
        let t = std::time::Instant::now();
        hdr::decode(&p3, &i3, layer, dst).map_err(|e| e.to_string())?;
        Ok(t.elapsed().as_secs_f64() * 1000.0)
    })
    .await?;
    let (posted, decode_ms) = match shared {
        Some(ms) => (true, ms),
        None => {
            let (p4, i4) = (p.clone(), info.clone());
            let (buf, ms) = tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<u8>, f64), String> {
                let t = std::time::Instant::now();
                let mut v = vec![0u8; len as usize];
                hdr::decode(&p4, &i4, layer, &mut v).map_err(|e| e.to_string())?;
                Ok((v, t.elapsed().as_secs_f64() * 1000.0))
            })
            .await
            .map_err(|e| e.to_string())??;
            stash().lock().map_err(|e| e.to_string())?.insert(id, buf);
            (false, ms)
        }
    };
    #[cfg(debug_assertions)]
    eprintln!("[load_hdr] {w}x{h} layer {layer} ({})  decode {decode_ms:>6.1} ms  {}", info.layers[layer].name, if posted { "shared" } else { "ipc" });
    Ok(HdrLoad { posted, info, layer, width: w, height: h, decode_ms })
}

/// Pixels left by `load_hdr` when they could not be posted as a shared buffer (raw bytes, no JSON).
#[tauri::command]
fn take_buffer(id: u32) -> Result<Response, String> {
    stash().lock().map_err(|e| e.to_string())?.remove(&id).map(Response::new).ok_or_else(|| format!("buffer {id} not found"))
}

/// Percent-decoding of a header value written with encodeURIComponent (UTF-8).
fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(h, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// Saves raw bytes (request body) to the path in header `x-path` (percent-encoded).
/// Written to `<path>.tmp` first and then moved over the target, so a failed save never leaves a broken file.
/// With header `x-backup: 1` the existing file is kept as `<path>.bak` (an older .bak is replaced).
#[tauri::command]
// async: a sync command runs on the main (window) thread, and writing hundreds of MB there froze the window
async fn write_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let t0 = std::time::Instant::now();
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let path = percent_decode(&header("x-path").ok_or("x-path header missing")?)?;
    let backup = header("x-backup").as_deref() == Some("1");
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("raw body expected".into());
    };
    let target = PathBuf::from(&path);
    let tmp = PathBuf::from(format!("{path}.tmp"));
    {
        use std::io::Write;
        let mut f = File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(data).map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    if backup && target.exists() {
        let bak = PathBuf::from(format!("{path}.bak"));
        if bak.exists() {
            std::fs::remove_file(&bak).map_err(|e| format!("{}: {e}", bak.display()))?;
        }
        std::fs::rename(&target, &bak).map_err(|e| format!("{}: {e}", bak.display()))?;
    }
    std::fs::rename(&tmp, &target).map_err(|e| format!("{}: {e}", target.display()))?;
    eprintln!("write_file {} ({} MB) in {} ms", target.display(), data.len() >> 20, t0.elapsed().as_millis());
    Ok(())
}

/// Saves an edited PSD / PSB (save method B: layer records rebuilt, channel data copied from the original).
/// Body: u32 (little endian) JSON length, the JSON `SaveRequest`, then the premultiplied RGBA composite.
#[tauri::command]
async fn save_psd(request: tauri::ipc::Request<'_>) -> Result<psd_save::SaveResult, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("raw body expected".into());
    };
    if body.len() < 4 { return Err("empty request".into()); }
    let n = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
    if body.len() < 4 + n { return Err("truncated request".into()); }
    let req: psd_save::SaveRequest = serde_json::from_slice(&body[4..4 + n]).map_err(|e| e.to_string())?;
    let rest = &body[4 + n..];
    let size = req.width as usize * req.height as usize * 4;
    if rest.len() < size { return Err("composite missing".into()); }
    let r = psd_save::save(&req, &rest[..size], &rest[size..])?;
    eprintln!(
        "save_psd {} ({} MB) in {:.0} ms (parse {:.0}, composite {:.0}, write {:.0})",
        req.dst, r.bytes >> 20, r.ms, r.parse_ms, r.composite_ms, r.write_ms
    );
    Ok(r)
}

/// Puts an image on the clipboard (fallback for navigator.clipboard.write).
/// Body: u32 width, u32 height (little endian), then straight RGBA.
#[tauri::command]
async fn copy_image(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("raw body expected".into());
    };
    if body.len() < 8 { return Err("empty request".into()); }
    let w = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
    let h = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
    if body.len() != 8 + w * h * 4 { return Err("bad image size".into()); }
    let img = arboard::ImageData { width: w, height: h, bytes: std::borrow::Cow::Borrowed(&body[8..]) };
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(img).map_err(|e| e.to_string())
}

/// WebView2 SharedBuffer helper. `post_shared` returns Ok(None) when shared buffers are not available.
#[cfg(windows)]
mod shared {
    use std::cell::RefCell;
    use std::collections::HashMap;

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

    /// Creates a shared buffer of `len` bytes, lets `fill` write into it on a worker thread,
    /// then posts it to the page with additional data `{"oieId": id}`.
    pub async fn post_shared<T: Send + 'static>(
        webview: &tauri::Webview,
        len: u64,
        id: u32,
        fill: impl FnOnce(&mut [u8]) -> Result<T, String> + Send + 'static,
    ) -> Result<Option<T>, String> {
        // 1) create the shared buffer on the UI thread; None = API not supported by this WebView2 runtime
        let ptr: Option<usize> = on_ui(webview, move |pw| unsafe {
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
        let Some(ptr) = ptr else { return Ok(None) };

        // 2) fill it off the UI thread
        let filled = tauri::async_runtime::spawn_blocking(move || {
            // SAFETY: the buffer stays mapped until it is closed in step 3 (or by `discard`)
            let dst = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u8, len as usize) };
            fill(dst)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        let value = match filled {
            Ok(v) => v,
            Err(e) => {
                let _ = on_ui(webview, move |_| { discard(id); Ok(()) }).await;
                return Err(e);
            }
        };

        // 3) post it to the page, then close our native view of it (the page keeps its own mapping)
        on_ui(webview, move |pw| unsafe {
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
        Ok(Some(value))
    }
}

/// Other platforms: no shared buffers (callers fall back to IPC / the JS decoder).
#[cfg(not(windows))]
mod shared {
    pub async fn post_shared<T: Send + 'static>(
        _webview: &tauri::Webview,
        _len: u64,
        _id: u32,
        _fill: impl FnOnce(&mut [u8]) -> Result<T, String> + Send + 'static,
    ) -> Result<Option<T>, String> {
        Ok(None)
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
    let cwd = std::env::current_dir().unwrap_or_default();
    file_args(std::env::args().skip(1), &cwd)
}

/// Command-line arguments that are existing files, resolved against `cwd`.
fn file_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = Path::new(&a);
            if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) }
        })
        .filter(|p| p.is_file())
        .filter_map(|p| p.to_str().map(str::to_owned))
        .collect()
}

/// Development builds run under their own identifier (separate app data, WebView storage and single-instance lock).
fn is_dev_identifier(identifier: &str) -> bool {
    identifier.ends_with(".dev")
}

/// Registers / unregisters the app in Explorer's "Open with" list for `extensions` (HKCU only, no admin rights).
/// Returns the registered exe path.
/// Dev builds (identifier ending in ".dev", see tauri.dev.conf.json) use their own ProgID and leave the
/// shared Applications\optimageeditor.exe key alone, so they never take over the installed build's entry.
#[tauri::command]
fn register_open_with(app: tauri::AppHandle, register: bool, extensions: Vec<String>) -> Result<String, String> {
    let dev = is_dev_identifier(&app.config().identifier);
    #[cfg(windows)]
    {
        openwith::apply(register, &extensions, dev)
    }
    #[cfg(not(windows))]
    {
        let _ = (register, extensions, dev);
        Err("Windows のみ対応".into())
    }
}

/// Opens the app's page on the web site (About / update dialog). The URL is fixed here, not given by the page.
#[tauri::command]
fn open_web_page() -> Result<(), String> {
    const URL: &str = "https://oputo.com/apps/#optimageeditor";
    #[cfg(windows)]
    {
        // rundll32 + url.dll hands the whole URL (with the #fragment) to the default browser
        std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", URL]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = URL;
    }
    Ok(())
}

/// Opens Windows Settings > Default apps.
#[tauri::command]
fn open_default_apps_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe").arg("ms-settings:defaultapps").spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
mod openwith {
    use std::borrow::Cow;
    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::{RegKey, RegValue};

    const PROG_ID: &str = "OptImageEditor.Image";
    const PROG_ID_DEV: &str = "OptImageEditor.Dev.Image";
    const APP_KEY: &str = r"Software\Classes\Applications\optimageeditor.exe";

    #[link(name = "shell32")]
    extern "system" {
        fn SHChangeNotify(event_id: i32, flags: u32, item1: *const core::ffi::c_void, item2: *const core::ffi::c_void);
    }
    const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;

    pub fn apply(register: bool, exts: &[String], dev: bool) -> Result<String, String> {
        let (prog_id, label) = if dev { (PROG_ID_DEV, "画像 (OptImageEditor Dev)") } else { (PROG_ID, "画像 (OptImageEditor)") };
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_string_lossy().to_string();
        let exe = exe.strip_prefix(r"\\?\").unwrap_or(&exe).to_string();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let err = |e: std::io::Error| e.to_string();
        let command = format!("\"{exe}\" \"%1\"");
        if register {
            // ProgID with icon and open command
            let (k, _) = hkcu.create_subkey(format!(r"Software\Classes\{prog_id}")).map_err(err)?;
            k.set_value("", &label).map_err(err)?;
            let (icon, _) = k.create_subkey("DefaultIcon").map_err(err)?;
            icon.set_value("", &format!("\"{exe}\",0")).map_err(err)?;
            let (cmd, _) = k.create_subkey(r"shell\open\command").map_err(err)?;
            cmd.set_value("", &command).map_err(err)?;
            // .ext\OpenWithProgids -> ProgID (REG_NONE, like Explorer itself writes)
            for e in exts {
                let (ow, _) = hkcu.create_subkey(format!(r"Software\Classes\.{e}\OpenWithProgids")).map_err(err)?;
                ow.set_raw_value(prog_id, &RegValue { bytes: Cow::Borrowed(&[]), vtype: RegType::REG_NONE }).map_err(err)?;
            }
            // Applications\optimageeditor.exe: friendly name + supported types for the "Open with" dialog.
            // The dev build has the same exe name, so it must not overwrite the installed build's key.
            if dev {
                unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, 0, std::ptr::null(), std::ptr::null()) };
                return Ok(exe);
            }
            let (app, _) = hkcu.create_subkey(APP_KEY).map_err(err)?;
            app.set_value("FriendlyAppName", &"OptImageEditor").map_err(err)?;
            let (st, _) = app.create_subkey("SupportedTypes").map_err(err)?;
            for e in exts {
                st.set_value(format!(".{e}"), &"").map_err(err)?;
            }
            let (cmd, _) = app.create_subkey(r"shell\open\command").map_err(err)?;
            cmd.set_value("", &command).map_err(err)?;
        } else {
            let _ = hkcu.delete_subkey_all(format!(r"Software\Classes\{prog_id}"));
            if !dev {
                let _ = hkcu.delete_subkey_all(APP_KEY);
            }
            for e in exts {
                if let Ok(ow) = hkcu.open_subkey_with_flags(format!(r"Software\Classes\.{e}\OpenWithProgids"), KEY_SET_VALUE) {
                    let _ = ow.delete_value(prog_id);
                }
            }
        }
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, 0, std::ptr::null(), std::ptr::null()) };
        Ok(exe)
    }
}

// ---------------------------------------------------------------- window close guard
//
// Unsaved edits: closing the window asks the page first. The page must acknowledge the request within
// CLOSE_ACK_TIMEOUT; if it does not (the WebView hung or crashed), the window is closed anyway so that it
// can never get stuck (a JS-only onCloseRequested handler leaves the window unclosable when the page is dead).
static CLOSE_GUARD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static CLOSE_REQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CLOSE_ACK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const CLOSE_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// The page has unsaved edits (closing the window asks first).
#[tauri::command]
fn set_close_guard(on: bool) {
    CLOSE_GUARD.store(on, std::sync::atomic::Ordering::SeqCst);
}

/// The page received close request `seq` and is asking the user.
#[tauri::command]
fn close_ack(seq: u64) {
    CLOSE_ACK.fetch_max(seq, std::sync::atomic::Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{Emitter, Manager};
    let context = tauri::generate_context!();
    if cfg!(debug_assertions) && !is_dev_identifier(&context.config().identifier) {
        // `npm run tauri dev` shares app data and the single-instance lock with the installed build
        eprintln!("warning: debug build with the release identifier; use `npm run app` (tauri.dev.conf.json)");
    }
    tauri::Builder::default()
        // must be the first plugin: a second launch forwards its files to this window (opened as tabs) and exits
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = file_args(args.into_iter().skip(1), Path::new(&cwd));
            if !paths.is_empty() {
                let _ = app.emit("oie://open-paths", paths);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::PendingUpdate::default())
        .manage(comfy::ComfyWs::default())
        .on_window_event(|window, event| {
            use std::sync::atomic::Ordering::SeqCst;
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !CLOSE_GUARD.load(SeqCst) {
                    return;
                }
                api.prevent_close();
                let seq = CLOSE_REQ.fetch_add(1, SeqCst) + 1;
                let _ = window.emit("oie://close-requested", seq);
                let w = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(CLOSE_ACK_TIMEOUT);
                    if CLOSE_ACK.load(SeqCst) < seq {
                        eprintln!("close request {seq} not acknowledged by the page: closing anyway");
                        let _ = w.destroy();
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            file_info,
            read_range,
            read_range_shared,
            load_composite_shared,
            load_hdr,
            take_buffer,
            write_file,
            save_psd,
            copy_image,
            set_close_guard,
            close_ack,
            list_images,
            startup_paths,
            register_open_with,
            open_default_apps_settings,
            comfy::comfy_http,
            comfy::comfy_ws_open,
            comfy::comfy_ws_close,
            update::update_check,
            update::update_install,
            open_web_page
        ])
        .run(context)
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
