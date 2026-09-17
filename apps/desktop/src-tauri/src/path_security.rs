use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Default)]
pub struct DroppedPaths(Mutex<HashSet<PathBuf>>);

impl DroppedPaths {
    pub fn record(&self, paths: &[PathBuf]) {
        if let Ok(mut allowed) = self.0.lock() {
            for path in paths {
                if let Ok(path) = dunce::canonicalize(path) {
                    allowed.insert(path);
                }
            }
        }
    }
    pub fn contains(&self, path: &str) -> bool {
        let Ok(path) = dunce::canonicalize(path) else {
            return false;
        };
        self.0.lock().is_ok_and(|allowed| allowed.contains(&path))
    }
}

pub fn validate_file(path: &str, passive_only: bool) -> Result<String, String> {
    let path = dunce::canonicalize(Path::new(path)).map_err(|e| e.to_string())?;
    if !path.is_file() {
        return Err("Only ordinary files may be opened".into());
    }
    for part in path.components() {
        let ext = Path::new(part.as_os_str())
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if [
            "app", "command", "terminal", "exe", "com", "bat", "cmd", "msi", "msix", "scr", "pif",
            "lnk", "desktop", "appimage", "jar", "workflow", "scpt", "scptd", "webloc", "url",
        ]
        .contains(&ext.as_str())
        {
            return Err(
                "Executable files and application bundles cannot be opened from content links"
                    .into(),
            );
        }
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut magic = [0; 4];
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let count = file.read(&mut magic).map_err(|e| e.to_string())?;
    if magic.starts_with(b"MZ")
        || (count == 4
            && [
                [0x7f, b'E', b'L', b'F'],
                [0xfe, 0xed, 0xfa, 0xce],
                [0xfe, 0xed, 0xfa, 0xcf],
                [0xce, 0xfa, 0xed, 0xfe],
                [0xcf, 0xfa, 0xed, 0xfe],
                [0xca, 0xfe, 0xba, 0xbe],
                [0xbe, 0xba, 0xfe, 0xca],
                [0xca, 0xfe, 0xba, 0xbf],
                [0xbf, 0xba, 0xfe, 0xca],
            ]
            .contains(&magic))
    {
        return Err("Executable content cannot be opened from content links".into());
    }
    if passive_only && magic.starts_with(b"#!") {
        return Err("Scripts must be opened in a text editor".into());
    }
    if passive_only
        && ![
            "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "heic", "tif", "tiff", "pdf",
            "mp3", "wav", "ogg", "flac", "m4a", "mp4", "mov", "webm", "docx", "xlsx", "pptx",
            "odt", "ods", "odp", "rtf", "csv", "tsv",
        ]
        .contains(&ext.as_str())
    {
        return Err("This file must be opened in a text editor".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

pub fn updater_settings<'a>(
    key: Option<&'a str>,
    endpoint: Option<&'a str>,
) -> Option<(&'a str, &'a str)> {
    let key = key.filter(|key| !key.trim().is_empty())?;
    let endpoint = endpoint?;
    let url = tauri::Url::parse(endpoint).ok()?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return None;
    }
    Some((key, endpoint))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn updater_requires_both_key_and_explicit_https_endpoint() {
        assert!(updater_settings(Some("key"), None).is_none());
        assert!(updater_settings(None, Some("https://example.com/feed")).is_none());
        assert!(updater_settings(Some("key"), Some("http://example.com/feed")).is_none());
        assert!(updater_settings(Some("key"), Some("https://")).is_none());
        assert!(updater_settings(Some("key"), Some("https://example.com/feed")).is_some());
    }

    #[test]
    fn native_file_open_rejects_programs_and_disguised_programs() {
        let root = std::env::temp_dir().join(format!(
            "pix-native-security-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let check = |name: &str, bytes: &[u8], passive| {
            let path = root.join(name);
            std::fs::write(&path, bytes).unwrap();
            validate_file(path.to_str().unwrap(), passive)
        };
        assert!(check("evil.exe", b"test", true).is_err());
        assert!(check("photo.jpg", b"MZfake executable", true).is_err());
        assert!(check("elf.png", b"\x7fELF", true).is_err());
        assert!(check("macho.pdf", b"\xcf\xfa\xed\xfe", true).is_err());
        assert!(check("fat-macho.png", b"\xbf\xba\xfe\xca", true).is_err());
        assert!(check("script.pdf", b"#!/bin/sh", true).is_err());
        assert!(check("source.ts", b"const n = 1", true).is_err());
        assert!(check("source.ts", b"const n = 1", false).is_ok());
        assert!(check("image.png", b"\x89PNG", true).is_ok());
        for ext in [
            "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "csv", "tsv",
        ] {
            assert!(check(&format!("report.{ext}"), b"document", true).is_ok());
            assert!(check(&format!("disguised.{ext}"), b"MZprogram", true).is_err());
        }
        assert!(check("macro.docm", b"document", true).is_err());
        assert!(check("macro.xlsm", b"document", true).is_err());
        let drops = DroppedPaths::default();
        let image = root.join("image.png");
        assert!(!drops.contains(image.to_str().unwrap()));
        drops.record(&[image.clone()]);
        assert!(drops.contains(image.to_str().unwrap()));
        assert!(!drops.contains(root.join("source.ts").to_str().unwrap()));
        std::fs::remove_dir_all(root).unwrap();
    }
}
