use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

pub async fn request(app: AppHandle, method: &str, params: Value) -> Result<Value, String> {
    if std::env::var_os("PIX_DEBUG_NATIVE").is_some() {
        eprintln!("[pix-native] {method}");
    }
    let window = app.get_webview_window("main").ok_or("Main window closed")?;
    match method {
        "dialog.open" | "dialog.save" => {
            let save = method == "dialog.save";
            tauri::async_runtime::spawn_blocking(move || {
                let mut dialog = app.dialog().file().set_parent(&window);
                if let Some(title) = params["title"].as_str() {
                    dialog = dialog.set_title(title);
                }
                if let Some(path) = params["defaultPath"].as_str() {
                    let path = std::path::Path::new(path);
                    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                        dialog = dialog.set_directory(parent);
                    }
                    if let Some(name) = path.file_name() {
                        dialog = dialog.set_file_name(name.to_string_lossy());
                    }
                }
                if let Some(filters) = params["filters"].as_array() {
                    for filter in filters {
                        let extensions: Vec<&str> = filter["extensions"]
                            .as_array()
                            .map(|items| items.iter().filter_map(Value::as_str).collect())
                            .unwrap_or_default();
                        dialog = dialog
                            .add_filter(filter["name"].as_str().unwrap_or("Files"), &extensions);
                    }
                }
                if save {
                    let path = dialog.blocking_save_file().map(|p| p.to_string());
                    return Ok(json!({"canceled":path.is_none(),"filePath":path}));
                }
                let properties = params["properties"].as_array().cloned().unwrap_or_default();
                let directory = properties.iter().any(|p| p == "openDirectory");
                let multi = properties.iter().any(|p| p == "multiSelections");
                let files = match (directory, multi) {
                    (true, true) => dialog.blocking_pick_folders(),
                    (true, false) => dialog.blocking_pick_folder().map(|p| vec![p]),
                    (false, true) => dialog.blocking_pick_files(),
                    (false, false) => dialog.blocking_pick_file().map(|p| vec![p]),
                };
                let paths: Vec<String> = files
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| p.to_string())
                    .collect();
                Ok(json!({"canceled":paths.is_empty(),"filePaths":paths}))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "shell.open-external" => {
            let url = params["url"].as_str().ok_or("Missing URL")?;
            let scheme = url.split(':').next().unwrap_or("");
            if ![
                "http",
                "https",
                "mailto",
                "x-apple.systempreferences",
                "ms-settings",
            ]
            .contains(&scheme)
            {
                return Err("Unsupported external URL scheme".into());
            }
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "shell.open-path" => {
            let path = params["path"].as_str().ok_or("Missing path")?;
            app.opener()
                .open_path(path, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(json!(""))
        }
        "shell.reveal" => {
            app.opener()
                .reveal_item_in_dir(params["path"].as_str().ok_or("Missing path")?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "window.scale" => {
            let scale = params["scale"]
                .as_f64()
                .ok_or("Missing scale")?
                .clamp(0.75, 1.5);
            window.set_zoom(scale).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "window.theme" => {
            let theme = match params["source"].as_str() {
                Some("light") => Some(tauri::Theme::Light),
                Some("dark") => Some(tauri::Theme::Dark),
                Some("system") => None,
                _ => return Err("Invalid theme".into()),
            };
            window.set_theme(theme).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "notifications.show" => {
            let title = params["title"].as_str().unwrap_or("").trim();
            if title.is_empty() {
                return Ok(json!(false));
            }
            if params["requireUnfocused"] == true
                && params["force"] != true
                && window.is_focused().unwrap_or(false)
            {
                return Ok(json!(false));
            }
            let mut notification = app
                .notification()
                .builder()
                .title(title)
                .body(params["body"].as_str().unwrap_or(title));
            if params["silent"] == true {
                notification = notification.silent();
            }
            notification.show().map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "clipboard.read-image" => {
            let image = app.clipboard().read_image().map_err(|e| e.to_string())?;
            let rgba =
                image::RgbaImage::from_raw(image.width(), image.height(), image.rgba().to_vec())
                    .ok_or("Invalid clipboard image")?;
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(rgba)
                .write_to(&mut bytes, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            Ok(json!(bytes.into_inner()))
        }
        _ => Err(format!("Unknown native method: {method}")),
    }
}
