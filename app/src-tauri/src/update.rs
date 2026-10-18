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

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    done: u64,
    total: Option<u64>,
}

/// Returns the newer version on the update endpoints, or None when this build is the latest.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle, pending: tauri::State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater_builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let update = match updater.check().await {
        Ok(u) => u,
        // no endpoint has a release yet (all of them answered 404 etc.)
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => None,
        Err(e) => return Err(e.to_string()),
    };
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *pending.0.lock().unwrap() = update;
    Ok(info)
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
    update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                let _ = on_progress.send(DownloadProgress { done, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}
