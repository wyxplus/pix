fn main() {
    // Icons live outside src-tauri; changing them must rebuild the Windows EXE
    // resource even when Cargo restores an otherwise current build from cache.
    for icon in [
        "../build/icon.ico",
        "../build/icon.png",
        "../build/icon.icns",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }
    println!("cargo:rerun-if-env-changed=PIX_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=PIX_UPDATER_ENDPOINT");
    tauri_build::build()
}
