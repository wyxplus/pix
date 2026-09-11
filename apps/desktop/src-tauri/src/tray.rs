use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};

const TRAY_ID: &str = "pix-main";

fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show-pix", "打开 Pix / Show Pix", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit-pix", "退出 Pix / Quit Pix", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = app
        .default_window_icon()
        .ok_or("Pix application icon is missing")?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon.clone())
        .tooltip("Pix")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show-pix" => {
                if let Err(error) = show_main_window(app) {
                    eprintln!("Unable to show Pix: {error}");
                }
            }
            // Explicit exit bypasses the window close prompt. RunEvent::Exit
            // still shuts down the Sidecar and its active/parked agent hosts.
            "quit-pix" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(error) = show_main_window(tray.app_handle()) {
                    eprintln!("Unable to show Pix: {error}");
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    Tray,
    Quit,
}

#[tauri::command]
pub fn pix_window_resolve_close(window: WebviewWindow, action: CloseAction) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Unknown window".into());
    }
    match action {
        CloseAction::Tray => {
            if window.app_handle().tray_by_id(TRAY_ID).is_none() {
                return Err("Pix tray icon is unavailable. The window has been kept open.".into());
            }
            window.hide().map_err(|error| error.to_string())
        }
        CloseAction::Quit => {
            window.app_handle().exit(0);
            Ok(())
        }
    }
}
