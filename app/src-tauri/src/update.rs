//! In-app update (tauri-plugin-updater). The endpoints and the public key are in tauri.conf.json
//! (`plugins.updater`); the release steps are in docs/release.md.
//!
//! The plugin tries the endpoints in order: a failed request or a non-2xx status moves on to the next one, but a 2xx
//! answer that is not JSON fails the whole check (so an endpoint must never answer 200 with an HTML page).

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last `update_check`, installed by `update_install`.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

/// The result of `update_check`, as `{ status: "available", version, currentVersion, notes } | { status: "latest" }
/// | { status: "notFound" }`.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CheckResult {
    /// a newer version is on the endpoints
    Available(UpdateInfo),
    /// the endpoints have this version (or an older one)
    Latest,
    /// no endpoint had a release manifest (all of them answered 404 etc.)
    NotFound,
}

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    done: u64,
    total: Option<u64>,
    /// the download is complete and the installer starts in a moment (the app then exits)
    installing: bool,
}

/// how long "restarting for the installation" stays on screen before the installer starts and the app exits
const BEFORE_INSTALL: Duration = Duration::from_millis(1500);

/// Asks the update endpoints for a newer version.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle, pending: tauri::State<'_, PendingUpdate>) -> Result<CheckResult, String> {
    let updater = app.updater_builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let update = match updater.check().await {
        Ok(u) => u,
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => {
            *pending.0.lock().unwrap() = None;
            return Ok(CheckResult::NotFound);
        }
        Err(e) => return Err(e.to_string()),
    };
    let result = match &update {
        Some(u) => CheckResult::Available(UpdateInfo {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            notes: u.body.clone(),
        }),
        None => CheckResult::Latest,
    };
    *pending.0.lock().unwrap() = update;
    Ok(result)
}

/// Downloads the update found by `update_check`, checks its signature and runs the installer. On Windows the
/// plugin starts the installer and exits the app (`std::process::exit(0)`), so this does not return on success.
#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), String> {
    if crate::is_dev_identifier(&app.config().identifier) {
        return Err("dev 版には更新をインストールしません（インストールした配布版で試してください）".into());
    }
    let update = pending.0.lock().unwrap().take().ok_or("先に更新を確認してください")?;
    let mut done = 0u64;
    let mut size = None;
    // download (signature checked by install) and install in two steps, so the page can say that the app
    // restarts before it disappears
    let bytes = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                size = total;
                let _ = on_progress.send(DownloadProgress { done, total, installing: false });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = on_progress.send(DownloadProgress { done, total: size, installing: true });
    tokio::time::sleep(BEFORE_INSTALL).await;
    update.install(bytes).map_err(|e| e.to_string())
}
