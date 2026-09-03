fn main() {
    // The bundled themes (tauri.conf.json `resources`) are copied into the
    // build output by tauri_build. Cargo only re-runs this script when a
    // tracked input changes, and theme JSONs are not part of the Rust build
    // graph - without this, adding or editing a theme in themes/ is invisible
    // to a dev build until something else forces a rebuild.
    println!("cargo:rerun-if-changed=../themes");
    emit_build_hash();
    tauri_build::build()
}

/// Bake the short commit hash into non-release builds (`LEGIT_BUILD_HASH`,
/// read via `option_env!`) so dev/PR artifacts identify their exact commit
/// in About and the log banner - with a `.wip` suffix when tracked files
/// have uncommitted changes (the `git describe --dirty` convention), since
/// a bare hash would falsely claim "built from this commit". Official
/// releases set `LEGIT_RELEASE_BUILD` to keep the clean version; a build
/// without git (source tarball) is silently clean too. The bundle version
/// itself is never touched: MSI rejects `+metadata` and the updater
/// compares it.
fn emit_build_hash() {
    println!("cargo:rerun-if-env-changed=LEGIT_RELEASE_BUILD");
    // A stale baked value is worse than none: HEAD changes on checkout, the
    // ref directory on commit, and DIRTINESS changes on Rust edits - the
    // Rust trees are watched so the `.wip` flag re-evaluates exactly when
    // those edits force an app recompile anyway. The frontend tree is
    // deliberately NOT watched: a build-script rerun recompiles the whole
    // app crate even with unchanged output (measured ~35-50s), which would
    // tax every dev launch after frontend-only edits. Accepted blind spots:
    // dirtiness from frontend/docs/workflow edits flips the flag only on
    // the next Rust change or checkout.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../crates");
    if std::env::var_os("LEGIT_RELEASE_BUILD").is_some() {
        return;
    }
    let git = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("git").args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let Some(hash) = git(&["rev-parse", "--short", "HEAD"]).filter(|h| !h.is_empty()) else {
        return;
    };
    // Tracked modifications only (-uno): untracked scratch files must not
    // permanently mark every dev build dirty.
    let dirty = match git(&["status", "--porcelain", "-uno"]) {
        Some(status) => !status.is_empty(),
        // Unknown state: claiming a clean commit would be the misleading
        // direction, so flag it.
        None => true,
    };
    let suffix = if dirty { ".wip" } else { "" };
    println!("cargo:rustc-env=LEGIT_BUILD_HASH={hash}{suffix}");
}
