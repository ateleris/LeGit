fn main() {
    // The bundled themes (tauri.conf.json `resources`) are copied into the
    // build output by tauri_build. Cargo only re-runs this script when a
    // tracked input changes, and theme JSONs are not part of the Rust build
    // graph - without this, adding or editing a theme in themes/ is invisible
    // to a dev build until something else forces a rebuild.
    println!("cargo:rerun-if-changed=../themes");
    tauri_build::build()
}
