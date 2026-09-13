#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod native;
mod path_security;
mod sidecar;
mod tray;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

#[tauri::command]
async fn pix_invoke(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, sidecar::Sidecar>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Unknown window".into());
    }
    state.request(channel, args).await
}

#[tauri::command]
fn pix_update_configured() -> bool {
    path_security::updater_settings(
        option_env!("PIX_UPDATER_PUBLIC_KEY"),
        option_env!("PIX_UPDATER_ENDPOINT"),
    )
    .is_some()
}

fn main() {
    let mut context = tauri::generate_context!();
    let mut window_state_flags = tauri_plugin_window_state::StateFlags::default();
    if cfg!(windows) {
        // A window hidden to the tray must be visible again on the next launch.
        window_state_flags.remove(tauri_plugin_window_state::StateFlags::VISIBLE);
    }
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .build(),
        )
        .plugin(tauri_plugin_process::init());
    if let Some((key, endpoint)) = path_security::updater_settings(
        option_env!("PIX_UPDATER_PUBLIC_KEY"),
        option_env!("PIX_UPDATER_ENDPOINT"),
    ) {
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({"pubkey":key,"endpoints":[endpoint]}),
        );
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    let application = builder
        .invoke_handler(tauri::generate_handler![pix_invoke, pix_update_configured, tray::pix_window_resolve_close])
        .setup(|app| {
            app.manage(path_security::DroppedPaths::default());
            let state = sidecar::Sidecar::start(app.handle().clone())?;
            app.manage(state);
            if cfg!(windows) {
                if let Err(error) = tray::setup(app.handle()) {
                    // Keep the app usable; hiding refuses when no tray exists.
                    eprintln!("Unable to create Pix tray icon: {error}");
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        handle.state::<path_security::DroppedPaths>().record(paths);
                    }
                    if matches!(event, tauri::WindowEvent::Resized(_)) {
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = handle.emit("pix:event", json!({"channel":"pix:window:state", "payload": {"isMaximized":window.is_maximized().unwrap_or(false)}}));
                        }
                    }
                });
            }
            Ok(())
        })
        .build(context)
        .expect("Unable to initialize Pix");
    application.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<sidecar::Sidecar>().shutdown();
        }
    });
}
