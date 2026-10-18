//! ComfyUI traffic (HTTP + WebSocket) goes through Rust instead of the WebView.
//!
//! Requests from the WebView carry `Origin: http://tauri.localhost`, which ComfyUI refuses unless it runs with
//! `--enable-cors-header` (and with that flag, any web page open in a browser could drive the user's ComfyUI).
//! Requests sent from here carry no Origin header, like a script on the same machine, so ComfyUI needs no flag.
//!
//! Only plain `http://` / `ws://` (a ComfyUI on this PC or the LAN); no TLS is compiled in.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response};
use tauri::Manager;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = reqwest::Client::builder()
        .no_proxy() // ComfyUI is local: never send it through a system / environment proxy
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| c))
}

fn check_scheme(url: &str, scheme: &str) -> Result<(), String> {
    if url.starts_with(&format!("{scheme}://")) {
        Ok(())
    } else {
        Err(format!("unsupported: {scheme}:// の URL だけに対応しています（{url}）"))
    }
}

/// Error strings the page maps to messages: "timeout", "connect: …", or anything else.
fn describe(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout".into()
    } else if e.is_connect() {
        format!("connect: {e}")
    } else {
        e.to_string()
    }
}

/// One HTTP request to ComfyUI. The raw IPC body is the request body; the headers `oie-method`, `oie-url`,
/// `oie-content-type` (optional) and `oie-timeout-ms` describe the request.
/// Returns `[status: u16 big-endian][response body]` (non-2xx statuses are returned, not raised).
#[tauri::command]
pub async fn comfy_http(request: Request<'_>) -> Result<Response, String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let method = header("oie-method").unwrap_or_else(|| "GET".into());
    let url = header("oie-url").ok_or("oie-url がありません")?;
    let content_type = header("oie-content-type");
    let timeout = header("oie-timeout-ms").and_then(|s| s.parse().ok()).unwrap_or(10_000u64);
    let body = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(_) => Vec::new(),
    };
    check_scheme(&url, "http")?;

    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client()?.request(method, &url).timeout(Duration::from_millis(timeout));
    if let Some(ct) = content_type {
        req = req.header(reqwest::header::CONTENT_TYPE, ct);
    }
    if !body.is_empty() {
        req = req.body(body);
    }
    let res = req.send().await.map_err(describe)?;
    let status = res.status().as_u16();
    let bytes = res.bytes().await.map_err(describe)?;
    let mut out = Vec::with_capacity(bytes.len() + 2);
    out.extend_from_slice(&status.to_be_bytes());
    out.extend_from_slice(&bytes);
    Ok(Response::new(out))
}

/// Open WebSockets: id -> stop signal.
#[derive(Default)]
pub struct ComfyWs {
    next: AtomicU32,
    open: Mutex<HashMap<u32, oneshot::Sender<()>>>,
}

const WS_TEXT: u8 = 0;
const WS_BINARY: u8 = 1;
const WS_CLOSED: u8 = 2;

/// Opens a WebSocket to ComfyUI. Every message arrives on `on_message` as an ArrayBuffer `[kind: u8][payload]`:
/// 0 = text (UTF-8), 1 = binary, 2 = closed by the server or an error (payload: the reason, UTF-8; may be empty).
/// Returns an id for `comfy_ws_close`.
#[tauri::command]
pub async fn comfy_ws_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, ComfyWs>,
    url: String,
    on_message: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    check_scheme(&url, "ws")?;
    let (ws, _) = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url.as_str()))
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| format!("connect: {e}"))?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    state.open.lock().unwrap().insert(id, stop_tx);

    tauri::async_runtime::spawn(async move {
        let (mut tx, mut rx) = ws.split();
        let send = |kind: u8, payload: &[u8]| {
            let mut v = Vec::with_capacity(payload.len() + 1);
            v.push(kind);
            v.extend_from_slice(payload);
            on_message.send(InvokeResponseBody::Raw(v))
        };
        // Some(reason): the connection ended on its own and the page is told; None: closed by the page
        let ended: Option<String> = loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    let _ = tx.send(Message::Close(None)).await;
                    break None;
                }
                m = rx.next() => match m {
                    Some(Ok(Message::Text(t))) => {
                        if send(WS_TEXT, t.as_str().as_bytes()).is_err() { break None; }
                    }
                    Some(Ok(Message::Binary(b))) => {
                        if send(WS_BINARY, &b).is_err() { break None; }
                    }
                    Some(Ok(Message::Ping(p))) => { let _ = tx.send(Message::Pong(p)).await; }
                    Some(Ok(Message::Close(f))) => break Some(f.map(|f| f.reason.as_str().to_owned()).unwrap_or_default()),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break Some(e.to_string()),
                    None => break Some(String::new()),
                }
            }
        };
        if let Some(reason) = ended {
            let _ = send(WS_CLOSED, reason.as_bytes());
        }
        app.state::<ComfyWs>().open.lock().unwrap().remove(&id);
    });
    Ok(id)
}

/// Closes a WebSocket opened by `comfy_ws_open` (no message is sent to the page for it).
#[tauri::command]
pub fn comfy_ws_close(state: tauri::State<'_, ComfyWs>, id: u32) {
    if let Some(stop) = state.open.lock().unwrap().remove(&id) {
        let _ = stop.send(());
    }
}
