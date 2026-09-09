fn main() {
    println!("cargo:rerun-if-env-changed=PIX_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=PIX_UPDATER_ENDPOINT");
    tauri_build::build()
}
