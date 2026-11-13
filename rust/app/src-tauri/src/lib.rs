//! Tauri shell around `follow-core`.
//!
//! Two kinds of web view talk to this code:
//! - the app's own window (`main`, the `ui/` folder), which starts scans and
//!   shows results;
//! - the Instagram window (`instagram`), where `scraper.js` is injected on
//!   every page load. It asks [`scan_next`] what to do and reports back with
//!   [`scan_progress`], [`scan_report`] and [`scan_error`].
//!
//! All scan logic lives in `follow_core::ScanSession`; this file only routes
//! calls, saves results and opens or closes the Instagram window.

use follow_core::{csv, ListKind, Report, ScanSession, SnapshotStore, Status, Task};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, Webview, WindowEvent};

/// Injected into every page of the Instagram window.
const SCRAPER_JS: &str = include_str!("../scraper.js");
const INSTAGRAM_LABEL: &str = "instagram";
const MAIN_LABEL: &str = "main";

struct AppState {
    session: Mutex<Option<ScanSession>>,
    store: SnapshotStore,
}

impl AppState {
    /// A panic while the lock was held shouldn't make every later call fail.
    fn session(&self) -> MutexGuard<'_, Option<ScanSession>> {
        self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn status(&self) -> Status {
        self.session().as_ref().map_or_else(Status::idle, ScanSession::status)
    }
}

fn emit_status(app: &AppHandle, status: &Status) {
    let _ = app.emit_to(MAIN_LABEL, "scan-status", status);
}

/// The scan commands are only granted to the Instagram window (see
/// `capabilities/instagram.json`); this is a second check in code.
fn ensure_instagram(webview: &Webview) -> Result<(), String> {
    if webview.label() == INSTAGRAM_LABEL {
        Ok(())
    } else {
        Err("scan commands are only accepted from the Instagram window".into())
    }
}

// ---- Commands for the app's own window -------------------------------------

/// Async because opening a window from a synchronous command can deadlock on
/// Windows.
#[tauri::command]
async fn start_scan(app: AppHandle, state: State<'_, AppState>, username: String) -> Result<Status, String> {
    let session = ScanSession::start(&username).map_err(|e| e.to_string())?;
    let status = session.status();
    *state.session() = Some(session);
    if let Err(e) = open_instagram(&app) {
        if let Some(s) = state.session().as_mut() {
            s.fail(format!("Couldn't open the Instagram window: {e}"));
        }
        let status = state.status();
        emit_status(&app, &status);
        return Ok(status);
    }
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
fn cancel_scan(app: AppHandle, state: State<'_, AppState>) -> Status {
    if let Some(s) = state.session().as_mut() {
        s.cancel("Cancelled.");
    }
    let status = state.status();
    emit_status(&app, &status);
    close_instagram(&app, Duration::ZERO);
    status
}

#[tauri::command]
fn get_status(state: State<'_, AppState>) -> Status {
    state.status()
}

#[tauri::command]
fn latest_report(state: State<'_, AppState>) -> Result<Option<Report>, String> {
    state.store.latest_report(None).map_err(|e| e.to_string())
}

/// Writes the latest scan as CSV to the Downloads folder (or the app's data
/// folder if there isn't one) and returns the file's path.
#[tauri::command]
fn save_csv(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let user = state
        .store
        .last_scanned_user()
        .map_err(|e| e.to_string())?
        .ok_or("No scan to export yet.")?;
    let analysis = state
        .store
        .latest(&user)
        .map_err(|e| e.to_string())?
        .ok_or("No scan to export yet.")?;
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(csv::file_name(&analysis));
    std::fs::write(&path, csv::to_csv(&analysis)).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

// ---- Commands for the injected Instagram script ----------------------------

#[tauri::command]
fn scan_next(app: AppHandle, webview: Webview, state: State<'_, AppState>, url: String) -> Result<Task, String> {
    ensure_instagram(&webview)?;
    let (task, before, after) = {
        let mut guard = state.session();
        let Some(session) = guard.as_mut() else {
            return Ok(Task::Idle);
        };
        let before = session.status();
        let task = session.next_task(&url);
        (task, before, session.status())
    };
    if before != after {
        emit_status(&app, &after);
    }
    Ok(task)
}

#[tauri::command]
fn scan_progress(app: AppHandle, webview: Webview, state: State<'_, AppState>, list: ListKind, count: usize) -> Result<(), String> {
    ensure_instagram(&webview)?;
    let status = {
        let mut guard = state.session();
        let Some(session) = guard.as_mut() else {
            return Ok(());
        };
        session.progress(list, count);
        session.status()
    };
    emit_status(&app, &status);
    Ok(())
}

#[tauri::command]
fn scan_report(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    list: ListKind,
    usernames: Vec<String>,
    expected: Option<u64>,
) -> Result<(), String> {
    ensure_instagram(&webview)?;
    let (finished, status) = {
        let mut guard = state.session();
        let session = guard.as_mut().ok_or("No scan is running.")?;
        let finished = session.report(list, usernames, expected).map_err(|e| e.to_string())?;
        (finished, session.status())
    };
    emit_status(&app, &status);

    let Some(analysis) = finished else {
        return Ok(());
    };
    let previous = state.store.latest(&analysis.username).ok().flatten();
    let saved = state.store.save(&analysis);
    let report = Report::build(&analysis, previous.as_ref());
    let _ = app.emit_to(MAIN_LABEL, "scan-finished", &report);
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.set_focus();
    }
    // Give the page a moment to receive this command's response first.
    close_instagram(&app, Duration::from_millis(1500));
    saved.map(|_| ()).map_err(|e| format!("Scan finished but couldn't be saved: {e}"))
}

/// Largest diagnostics file accepted from the page.
const MAX_DIAGNOSTICS_BYTES: usize = 512 * 1024;

/// `details` is a JSON description of the page's structure (see
/// `diagnostics()` in scraper.js). It's saved to
/// `<app data>/diagnostics/last-failure.json` for troubleshooting.
#[tauri::command]
fn scan_error(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    message: String,
    details: Option<String>,
) -> Result<(), String> {
    ensure_instagram(&webview)?;
    let mut message: String = message.chars().take(500).collect();
    if let Some(details) = details.filter(|d| d.len() <= MAX_DIAGNOSTICS_BYTES) {
        match save_diagnostics(&app, &details) {
            Ok(path) => message.push_str(&format!(" Page details saved to {}", path.display())),
            Err(e) => message.push_str(&format!(" (Couldn't save page details: {e})")),
        }
    }
    if let Some(s) = state.session().as_mut() {
        s.fail(message);
    }
    emit_status(&app, &state.status());
    Ok(())
}

fn save_diagnostics(app: &AppHandle, details: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("diagnostics");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("last-failure.json");
    std::fs::write(&path, details).map_err(|e| e.to_string())?;
    Ok(path)
}

// ---- The Instagram window --------------------------------------------------

/// Opens the Instagram window, or brings it forward if it's already open.
/// Its cookies are kept between runs, so the person logs in only once.
#[cfg(desktop)]
fn open_instagram(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(INSTAGRAM_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let url: tauri::Url = "https://www.instagram.com/".parse().expect("static URL is valid");
    tauri::WebviewWindowBuilder::new(app, INSTAGRAM_LABEL, tauri::WebviewUrl::External(url))
        .title("Instagram — keep this window open while scanning")
        // Wide enough for Instagram's desktop layout, where lists open in a pop-up.
        .inner_size(1100.0, 860.0)
        .initialization_script(SCRAPER_JS)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Phones get a single web view, so the scan has to run in the main window.
/// That's step 3 of the plan; until then the mobile build says so plainly.
#[cfg(mobile)]
fn open_instagram(_app: &AppHandle) -> Result<(), String> {
    Err("scanning isn't available on mobile yet".into())
}

fn close_instagram(app: &AppHandle, delay: Duration) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if let Some(window) = app.get_webview_window(INSTAGRAM_LABEL) {
            let _ = window.close();
        }
    });
}

// ---- Entry point -----------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState {
                session: Mutex::new(None),
                store: SnapshotStore::new(data_dir.join("snapshots")),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the Instagram window mid-scan cancels the scan.
            if window.label() == INSTAGRAM_LABEL && matches!(event, WindowEvent::Destroyed) {
                let state = window.state::<AppState>();
                let status = {
                    let mut guard = state.session();
                    let Some(session) = guard.as_mut() else {
                        return;
                    };
                    if !session.is_running() {
                        return;
                    }
                    session.cancel("The Instagram window was closed before the scan finished.");
                    session.status()
                };
                emit_status(window.app_handle(), &status);
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_scan,
            cancel_scan,
            get_status,
            latest_report,
            save_csv,
            scan_next,
            scan_progress,
            scan_report,
            scan_error,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Follow Analyser");
}
