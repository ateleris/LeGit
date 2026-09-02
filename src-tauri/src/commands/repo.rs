//! Multi-repo session commands.
//! Every repo command takes a `repo_id`; global scope takes none.
//! See DESIGN-v0.2.md §D.3.

use crate::error::AppError;
use crate::remote::RepoLocator;
use crate::state::{
    load_repo_settings_sync, AppState, LaneLock, RepoSession, RepoSettings,
    RepoSummary, TransientOp,
};
use legit_core::{classify_remote_error, FsError, GitError, HostPath, OperationId, RepoFs};
use legit_host::Host;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager as _;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve the git binary for a specific repo: repo override → global.
/// Falls back to `global_git_path` if the override path doesn't exist.
pub fn resolve_repo_git_path(
    repo_settings: &RepoSettings,
    global_git_path: &std::path::Path,
) -> PathBuf {
    if let Some(ref ov) = repo_settings.git_path_override {
        let p = PathBuf::from(ov);
        if p.exists() {
            return p;
        }
        tracing::warn!(
            override_path = ?p,
            "repo git path override does not exist — falling back to global"
        );
    }
    global_git_path.to_path_buf()
}

/// Session bookkeeping (open-repo list, active repo, tab order) is
/// deliberately best-effort: a failed settings persist must never fail the
/// primary operation. But it must not be silent either (house rule): log a
/// warning so "my tabs did not survive a restart" is diagnosable.
fn warn_if_bookkeeping_persist_failed(what: &str, result: Result<(), AppError>) {
    if let Err(e) = result {
        tracing::warn!(err = %e, what, "session bookkeeping persist failed");
    }
}

/// Open (or reuse) a session for the repo at `locator` (its resolved
/// TOPLEVEL, from `rev-parse --show-toplevel` on its host), loading its
/// `RepoSettings` and resolving the git binary through the scope hierarchy.
/// Starts a filesystem watcher (on the repo's host) when watching is enabled.
pub async fn open_session(
    state: &AppState,
    app: &tauri::AppHandle,
    global_git_path: PathBuf,
    host: Arc<dyn Host>,
    locator: RepoLocator,
) -> RepoSummary {
    // Host-level git override for remote locators — an async lookup, so it
    // must happen before the `repos` guard below (no await under the guard).
    let host_git = match &locator {
        RepoLocator::Wsl { distro, .. } => state.host_git_override(distro).await,
        RepoLocator::Local { .. } => None,
    };
    // Reuse-or-insert under ONE `repos` write guard: two concurrent opens of
    // the same directory (double-click, open racing restore) must never both
    // miss the lookup and create twin sessions + watchers. No await happens
    // while the guard is held; the watcher starts outside it (it runs git).
    let session = {
        let mut repos = state.repos.write().await;
        if let Some(existing) = repos.values().find(|s| sessions_match(s, &locator)) {
            tracing::info!(locator = %locator.to_persist_string(), id = %existing.id, "open: reusing existing session");
            return existing.summary();
        }
        let (_, settings_path) = state.repo_data_paths_locator(&locator);
        let repo_settings = load_repo_settings_sync(&settings_path);
        let resolved_git =
            resolve_git_for(&locator, &repo_settings, &global_git_path, host_git.as_deref());

        let runner = runner_for_locator(&host, &resolved_git, &locator);
        let session = Arc::new(RepoSession::new(
            locator,
            host,
            runner,
            repo_settings,
            settings_path,
        ));
        repos.insert(session.id.clone(), session.clone());
        session
    };
    tracing::info!(path = %session.path.display(), id = %session.id, "open: new session");
    let summary = session.summary();
    // Starting the watcher must never gate opening the repo. `notify`'s
    // recursive registration walks the ENTIRE worktree up front (on Linux one
    // inotify watch per directory), so a pathological tree - a home directory
    // opened as a repo - held the startup splash for 30s+ before failing with
    // "OS file watch limit reached", once per restored repo. In the background
    // the repo is fully usable meanwhile: data is fetched on demand, it just
    // isn't auto-refreshed until the watch is live (which `start_repo_watcher`
    // then announces with a catch-up refresh).
    let watcher_app = app.clone();
    let watcher_session = session.clone();
    tokio::spawn(async move {
        let state = watcher_app.state::<AppState>();
        start_repo_watcher(&state, &watcher_app, &watcher_session).await;
    });
    summary
}

/// The git binary a session on `locator`'s host should use: local repos go
/// through the local override→global hierarchy (with existence check);
/// remote repos use the repo override VERBATIM when set (it names a path on
/// the remote host — no local existence check applies), else the HOST
/// override (per-distro setting), else PATH `git` as resolved by the agent's
/// login-shell environment.
fn resolve_git_for(
    locator: &RepoLocator,
    repo_settings: &RepoSettings,
    global_git_path: &Path,
    host_git: Option<&str>,
) -> HostPath {
    match locator {
        RepoLocator::Local { .. } => {
            HostPath::from_path(&resolve_repo_git_path(repo_settings, global_git_path))
        }
        RepoLocator::Wsl { .. } => match &repo_settings.git_path_override {
            Some(ov) if !ov.trim().is_empty() => HostPath(ov.clone()),
            _ => HostPath(host_git.unwrap_or("git").to_string()),
        },
    }
}

fn runner_for_locator(
    host: &Arc<dyn Host>,
    git: &HostPath,
    locator: &RepoLocator,
) -> Arc<dyn legit_core::GitExecutor> {
    host.executor_for(git, Some(&HostPath(locator.display_path())))
}

/// `~`-expansion for a typed remote path against the host's home dir.
/// Accepts `~`, `~/x`, and the locator-prefixed `/~`, `/~/x` forms (the
/// `wsl://` scheme keeps its path component '/'-leading); anything else is
/// `None` (no expansion).
fn expand_tilde(path: &str, home: &str) -> Option<String> {
    let stripped = path.strip_prefix('/').unwrap_or(path);
    let rest = stripped.strip_prefix('~')?;
    if rest.is_empty() {
        return Some(home.to_string());
    }
    rest.starts_with('/').then(|| format!("{home}{rest}"))
}

/// Expand a typed `~/...` remote path against the agent's home directory
/// (`None`/empty home = no expansion). The locator scheme prefixes '/' to
/// keep the path component non-empty, so a typed `~/x` arrives as `/~/x`.
fn expand_remote_home(path: HostPath, home: Option<&str>) -> HostPath {
    match home.filter(|h| !h.is_empty()) {
        Some(home) => expand_tilde(&path.0, home).map(HostPath).unwrap_or(path),
        None => path,
    }
}

/// Where a NEW repository goes (init's directory, clone's parent dir): the
/// destination as its host sees it, and the git binary to run there.
struct NewRepoTarget {
    locator: RepoLocator,
    git: HostPath,
    dir: HostPath,
}

/// Pure core of `resolve_new_repo_target`. `host_git` is the distro's git
/// override and `home` the agent's home directory (for `~` expansion); both
/// are ignored for local destinations. Host-free so the routing decision is
/// unit-testable: a WSL destination (typed `wsl://…` or the
/// `\\wsl.localhost\…` UNC the folder picker returns) runs the DISTRO's git
/// on a posix path — never Windows git over the share, which fails with
/// "dubious ownership" and, worse, half-succeeds (init over the share
/// created the repo, then the probe rejected it).
fn new_repo_target(
    locator: RepoLocator,
    global_git: &Path,
    host_git: Option<&str>,
    home: Option<&str>,
) -> NewRepoTarget {
    match locator {
        RepoLocator::Local { path } => NewRepoTarget {
            git: HostPath::from_path(global_git),
            dir: HostPath::from_path(&path),
            locator: RepoLocator::Local { path },
        },
        RepoLocator::Wsl { distro, path } => {
            let dir = expand_remote_home(path, home);
            NewRepoTarget {
                git: HostPath(host_git.unwrap_or("git").to_string()),
                dir: dir.clone(),
                locator: RepoLocator::Wsl { distro, path: dir },
            }
        }
    }
}

/// Resolve a create-type command's destination string (a locator, like
/// `open_repo`'s argument) to its host plus the target on that host. Mirrors
/// `probe_and_open`'s host routing so init/clone land where open would look.
async fn resolve_new_repo_target(
    state: &AppState,
    app: &tauri::AppHandle,
    path: &str,
    global_git: &Path,
) -> Result<(Arc<dyn Host>, NewRepoTarget), AppError> {
    let locator = RepoLocator::parse(path);
    let (host, host_git, home): (Arc<dyn Host>, Option<String>, Option<String>) = match &locator {
        RepoLocator::Local { .. } => (state.local_host(), None, None),
        RepoLocator::Wsl { distro, .. } => {
            let host = crate::remote::connection::ensure_wsl_host(app, state, distro).await?;
            let home = host.conn().get().info().map(|i| i.home.clone());
            let host_git = state.host_git_override(distro).await;
            (host, host_git, home)
        }
    };
    let target = new_repo_target(locator, global_git, host_git.as_deref(), home.as_deref());
    Ok((host, target))
}

/// `dir` must be an existing directory on `host`; the failure text names it
/// as the user typed/picked it.
async fn require_existing_dir(host: &dyn Host, dir: &HostPath, what: &str) -> Result<(), AppError> {
    match host.fs().stat(dir).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(AppError::NotARepo(format!("{what} does not exist: {dir}"))),
        Err(e) => Err(AppError::NotARepo(format!("{what} is not accessible: {e}"))),
    }
}

/// Session-dedup predicate: same host identity AND same directory. Local
/// paths compare by filesystem identity (`same_dir`); remote toplevels come
/// from `rev-parse --show-toplevel` on the host and compare literally.
fn sessions_match(existing: &RepoSession, locator: &RepoLocator) -> bool {
    match (&existing.locator, locator) {
        (RepoLocator::Local { path: a }, RepoLocator::Local { path: b }) => same_dir(a, b),
        (a, b) => a == b,
    }
}

/// Start (and register) a filesystem watcher for `session`, unless watching is
/// disabled in global settings. Resolves the git dir so linked worktrees /
/// submodules (where `.git` is a file pointing elsewhere) are watched correctly.
/// Best-effort: a failure is logged, never fatal to opening the repo.
async fn start_repo_watcher(state: &AppState, app: &tauri::AppHandle, session: &Arc<RepoSession>) {
    if !state.global_settings.read().await.watcher_enabled {
        return;
    }
    let runner = session.runner.read().await.clone();
    let git_dir = match runner.run(&["rev-parse", "--absolute-git-dir"]).await {
        Ok(out) if out.success => PathBuf::from(out.stdout.trim()),
        _ => session.path.join(".git"),
    };
    let sink = crate::watcher::emit_sink(app.clone(), session.id.clone());
    match session
        .host
        .watch(
            &HostPath::from_path(&session.path),
            &HostPath::from_path(&git_dir),
            sink,
        )
        .await
    {
        Ok(w) => {
            // The repo can be closed while its watch is still starting. Hold
            // the `repos` read guard across the insert: `close_repo` needs the
            // write guard to drop the session, so it cannot slip between the
            // check and the insert and leave a watch parked for a dead repo.
            {
                let repos = state.repos.read().await;
                if !repos.contains_key(&session.id) {
                    tracing::info!(repo_id = %session.id, "repo closed while its watcher was starting - dropping the watch");
                    return;
                }
                state.watchers.lock().unwrap().insert(session.id.clone(), w);
            }
            // A watch only reports events from its registration onward, and the
            // repo has been on screen since before that: anything that changed
            // in between would never arrive. Refresh once, now.
            crate::watcher::emit_all_domains_changed(app, &session.id, "<watch-started>");
        }
        Err(e) => {
            tracing::warn!(repo_id = %session.id, err = %e, "failed to start repo watcher");
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Whether two paths name the same directory, regardless of spelling.
/// Session paths come from `git rev-parse --show-toplevel` output and
/// persisted settings, which can disagree in separator style or case (e.g. a
/// repo reached once via the file dialog and once through a submodule chain).
/// A literal `PathBuf` comparison then misses the match and a second session
/// opens for the same repo - so compare filesystem identity instead.
fn same_dir(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// Probe `probe` for its repo top-level (on its host), reuse-or-open a
/// session for it, and update the recent/open/active bookkeeping. Shared by
/// `open_repo`, `repo_init`, `repo_clone`, and the restore flow.
pub(crate) async fn probe_and_open(
    state: &AppState,
    app: &tauri::AppHandle,
    git_path: PathBuf,
    probe: RepoLocator,
) -> Result<RepoSummary, AppError> {
    let (host, toplevel_locator): (Arc<dyn Host>, RepoLocator) = match probe {
        RepoLocator::Local { path } => {
            let host = state.local_host();
            let exec = host.executor_for(
                &HostPath::from_path(&git_path),
                Some(&HostPath::from_path(&path)),
            );
            let out = exec
                .run(&["rev-parse", "--show-toplevel"])
                .await
                .map_err(AppError::from)?;
            if !out.success {
                return Err(AppError::NotARepo(out.stderr.trim().to_string()));
            }
            (host, RepoLocator::local(out.stdout.trim()))
        }
        RepoLocator::Wsl { distro, path } => {
            let host = crate::remote::connection::ensure_wsl_host(app, state, &distro).await?;
            let home = host.conn().get().info().map(|i| i.home.clone());
            let path = expand_remote_home(path, home.as_deref());
            // Remote git comes from the host override, else the agent's
            // PATH; the probe doubles as the "git exists on this host" check.
            let host_git = state
                .host_git_override(&distro)
                .await
                .unwrap_or_else(|| "git".into());
            let exec = host.executor_for(&HostPath(host_git), Some(&path));
            let out = exec
                .run(&["rev-parse", "--show-toplevel"])
                .await
                .map_err(|e| AppError::NotARepo(format!("git failed in '{distro}': {e}")))?;
            if !out.success {
                return Err(AppError::NotARepo(out.stderr.trim().to_string()));
            }
            let host: Arc<dyn Host> = host;
            (
                host,
                RepoLocator::Wsl {
                    distro,
                    path: HostPath(out.stdout.trim().to_string()),
                },
            )
        }
    };

    // open_session reuses an existing session for this directory (identity
    // comparison, atomically with the insert) or creates one.
    let summary = open_session(state, app, git_path, host, toplevel_locator).await;

    warn_if_bookkeeping_persist_failed(
        "record opened repo",
        state
            .mutate_global(|settings| {
                let p = summary.locator.clone();
                settings.last_open_repos.retain(|other| other != &p);
                settings.last_open_repos.insert(0, p.clone());
                settings.last_open_repos.truncate(20);
                if !settings.currently_open.iter().any(|x| x == &p) {
                    settings.currently_open.push(p.clone());
                }
                settings.active_open_repo = Some(p);
            })
            .await,
    );

    Ok(summary)
}

#[tauri::command]
#[specta::specta]
pub async fn open_repo(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    path: String,
) -> Result<RepoSummary, AppError> {
    // The argument is a repo LOCATOR string: a bare path for local repos,
    // `wsl://<distro>/<path>` for remote ones (remote::locator).
    let locator = RepoLocator::parse(&path);
    if let RepoLocator::Local { path } = &locator {
        if !path.exists() {
            return Err(AppError::NotARepo(format!(
                "path does not exist: {}",
                path.display()
            )));
        }
    }
    let git_path = state.git_path.read().await.clone();
    probe_and_open(&state, &app, git_path, locator).await
}

/// Build the `git init` argument list. Pure so the option handling is
/// unit-testable; blank branch names degrade to git's default.
fn build_init_args(bare: bool, initial_branch: Option<&str>) -> Vec<String> {
    let mut args = vec!["init".to_string()];
    if bare {
        args.push("--bare".into());
    }
    if let Some(branch) = initial_branch.map(str::trim).filter(|b| !b.is_empty()) {
        args.push("--initial-branch".into());
        args.push(branch.to_string());
    }
    args
}

/// Initialize a new repository in `path` (`git init`), open it, and optionally
/// apply (and select) a profile. `path` is a repo LOCATOR (bare path,
/// `wsl://…`, or a `\\wsl.localhost\…` UNC path) naming an existing
/// directory; a WSL destination is initialized inside the distro.
///
/// A `--bare` repository has no worktree, so it cannot become a session:
/// it is created but not opened, and the result is `None` (profiles are
/// session-scoped, so a profile selection is ignored for bare repos too).
#[tauri::command]
#[specta::specta]
pub async fn repo_init(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    path: String,
    profile_id: Option<String>,
    bare: bool,
    initial_branch: Option<String>,
) -> Result<Option<RepoSummary>, AppError> {
    let git_path = state.git_path.read().await.clone();
    let (host, target) = resolve_new_repo_target(&state, &app, &path, &git_path).await?;
    require_existing_dir(host.as_ref(), &target.dir, "path").await?;
    let runner = host.executor_for(&target.git, Some(&target.dir));
    let args = build_init_args(bare, initial_branch.as_deref());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = runner.run(&arg_refs).await.map_err(AppError::from)?;
    if !out.success {
        return Err(AppError::Git(GitError::CommandFailed {
            exit_code: out.exit_code.unwrap_or(-1),
            stderr: out.stderr.trim().to_string(),
        }));
    }
    if bare {
        return Ok(None);
    }
    let summary = probe_and_open(&state, &app, git_path, target.locator).await?;
    if let Some(pid) = profile_id {
        let session = state.get_session(&summary.id).await?;
        crate::commands::profiles::apply_profile_core(&state, &session, &pid).await?;
    }
    Ok(Some(summary))
}

/// Build the `git clone` argument list (auth `-c` overrides are spliced in
/// front by the caller). Pure so the option handling is unit-testable.
///
/// `--progress` forces the transfer meter onto our piped stderr; the runner
/// parses it into progress-observer updates and strips it from logged output.
fn build_clone_args(
    url: &str,
    name: &str,
    depth: Option<u32>,
    branch: Option<&str>,
    recurse_submodules: bool,
) -> Vec<String> {
    let mut args = vec!["clone".to_string(), "--progress".to_string()];
    if let Some(depth) = depth.filter(|d| *d > 0) {
        args.push("--depth".into());
        args.push(depth.to_string());
    }
    if let Some(branch) = branch.map(str::trim).filter(|b| !b.is_empty()) {
        args.push("--branch".into());
        args.push(branch.to_string());
    }
    if recurse_submodules {
        args.push("--recurse-submodules".into());
    }
    args.push(url.to_string());
    args.push(name.to_string());
    args
}

/// What a cancelled clone may delete. Decided BEFORE git runs, so the answer
/// cannot be confused by whatever the killed clone left behind - a kill gives
/// git no chance to clean up after itself. All filesystem access goes
/// through the repo host's `RepoFs` (the target may live inside a distro).
#[derive(Debug)]
enum CloneCleanup {
    /// The target did not exist: the clone created it, remove it whole.
    RemoveDir(HostPath),
    /// The target existed but was empty: remove what the clone put inside,
    /// keep the user's directory itself.
    RemoveContents(HostPath),
    /// The target existed with content: git refuses such a destination, so
    /// nothing inside is ours - a cancel racing that early failure must not
    /// touch the user's files.
    Nothing,
}

impl CloneCleanup {
    async fn plan(fs: &dyn RepoFs, target: &HostPath) -> Self {
        match fs.stat(target).await {
            Ok(None) => return Self::RemoveDir(target.clone()),
            Ok(Some(_)) => {}
            // Unreadable target: treat as occupied - deleting blind is worse
            // than leaving debris.
            Err(_) => return Self::Nothing,
        }
        match fs.read_dir(target).await {
            Ok(entries) if entries.is_empty() => Self::RemoveContents(target.clone()),
            _ => Self::Nothing,
        }
    }

    /// Execute the plan (best-effort). Returns a user-facing note when the
    /// removal failed (a failed cleanup must never be silent), None on
    /// success. `local` = the target is on the app's own machine (enables
    /// the Windows read-only workaround, which is meaningless remotely).
    async fn run(&self, fs: &dyn RepoFs, local: bool) -> Option<String> {
        let (dir, keep_root) = match self {
            Self::RemoveDir(p) => (p, false),
            Self::RemoveContents(p) => (p, true),
            Self::Nothing => return None,
        };
        remove_clone_debris(fs, dir, keep_root, local)
            .await
            .err()
            .map(|e| format!("The partial clone at '{dir}' could not be removed: {e}"))
    }
}

/// Remove a killed clone's debris: `remove_dir_all` (or, with `keep_root`,
/// of each entry inside) with the two twists a kill needs on Windows - git's
/// object files are read-only, which blocks plain deletion there, and the
/// killed clone's helper processes can hold handles for a moment after the
/// kill (they die on broken pipe, not synchronously). So failed attempts are
/// retried briefly, clearing read-only flags in between. Never touches
/// anything outside `dir`.
#[cfg_attr(not(windows), allow(unused_variables))]
async fn remove_clone_debris(
    fs: &dyn RepoFs,
    dir: &HostPath,
    keep_root: bool,
    local: bool,
) -> Result<(), FsError> {
    const ATTEMPTS: u32 = 10;
    let mut last_err = None;
    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            #[cfg(windows)]
            if local {
                let path = dir.as_local();
                let _ = tokio::task::spawn_blocking(move || clear_readonly_recursive(&path)).await;
            }
        }
        match try_remove(fs, dir, keep_root).await {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.expect("loop ran at least once"))
}

async fn try_remove(fs: &dyn RepoFs, dir: &HostPath, keep_root: bool) -> Result<(), FsError> {
    if !keep_root {
        return match fs.remove_dir_all(dir).await {
            // Already gone (a cancel can race the clone's own early
            // failure, before git created anything): that IS the goal state.
            Err(FsError::NotFound { .. }) => Ok(()),
            other => other,
        };
    }
    let entries = match fs.read_dir(dir).await {
        Ok(entries) => entries,
        Err(FsError::NotFound { .. }) => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let path = dir.join(&entry.name);
        if entry.is_dir {
            fs.remove_dir_all(&path).await?;
        } else {
            fs.remove_file(&path).await?;
        }
    }
    Ok(())
}

/// Windows only: deletion fails on read-only files (git object files are),
/// so clear the flag throughout the target before a retry. On Unix deletion
/// is governed by the parent directory's permissions instead, and we must
/// not "fix" permissions to force a removal through.
#[cfg(windows)]
fn clear_readonly_recursive(path: &Path) {
    let Ok(meta) = path.symlink_metadata() else {
        return;
    };
    let mut perms = meta.permissions();
    if perms.readonly() {
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(path, perms);
    }
    if meta.is_dir() {
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            clear_readonly_recursive(&entry.path());
        }
    }
}

/// Clone `url` into `parent_dir/name`, open it, and optionally apply (and select)
/// a profile. `parent_dir` is a repo LOCATOR (bare path, `wsl://…`, or a
/// `\\wsl.localhost\…` UNC path): a WSL destination is cloned by the distro's
/// git, and a cancelled clone's debris is removed through the distro's agent.
/// When a profile is given its auth is injected into the clone via
/// `-c` (so the clone authenticates with that identity) and then applied to the
/// new repo. Cancellable via `cancel_clone(op_id)`.
#[tauri::command]
#[specta::specta]
pub async fn repo_clone(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    url: String,
    parent_dir: String,
    name: String,
    profile_id: Option<String>,
    op_id: String,
    depth: Option<u32>,
    branch: Option<String>,
    recurse_submodules: bool,
) -> Result<RepoSummary, AppError> {
    let git_path = state.git_path.read().await.clone();
    let (host, target) = resolve_new_repo_target(&state, &app, &parent_dir, &git_path).await?;
    require_existing_dir(host.as_ref(), &target.dir, "directory").await?;
    let parent = target.dir;
    let local = matches!(target.locator, RepoLocator::Local { .. });

    // git-level `-c` auth overrides from the optional profile, then `clone`.
    let mut args: Vec<String> = Vec::new();
    if let Some(pid) = &profile_id {
        let profile = state
            .global_settings
            .read()
            .await
            .git_profiles_doc
            .profiles
            .iter()
            .find(|p| p.id == *pid)
            .cloned()
            .ok_or_else(|| AppError::UnknownProfile(pid.clone()))?;
        args.extend(crate::commands::profiles::clone_auth_config_args(&profile));
    }
    args.extend(build_clone_args(
        &url,
        &name,
        depth,
        branch.as_deref(),
        recurse_submodules,
    ));

    // Decide NOW what a cancelled clone may delete: after the kill, the
    // target's content says nothing about who created it (see CloneCleanup).
    let fs = host.fs();
    let cleanup = CloneCleanup::plan(fs.as_ref(), &parent.join(&name)).await;

    // Run on a transient runner registered for the op so cancel_clone can reach it.
    let oid = OperationId(op_id);
    let runner = host.executor_for(&target.git, Some(&parent));
    let op = Arc::new(TransientOp {
        runner: runner.clone(),
        cancelled: std::sync::atomic::AtomicBool::new(false),
    });
    state
        .transient_ops
        .lock()
        .unwrap()
        .insert(oid.clone(), op.clone());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = runner.run_with_op_progress(&arg_refs, oid.clone()).await;
    state.transient_ops.lock().unwrap().remove(&oid);

    let out = result.map_err(AppError::from)?;
    if !out.success {
        // Cancelled by the user: a kill gives git no chance to clean up its
        // partial target, so remove it ourselves (through the repo host's
        // fs). An expected outcome, not a remote error.
        if op.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            let cleanup_failed = cleanup.run(fs.as_ref(), local).await;
            return Err(AppError::Git(GitError::CloneCancelled { cleanup_failed }));
        }
        return Err(AppError::Git(classify_remote_error(
            out.exit_code.unwrap_or(-1),
            &out.stderr,
        )));
    }

    let summary = probe_and_open(&state, &app, git_path, target.locator.join(&name)).await?;
    // Remember where this clone went: the next clone dialog prefills its
    // folder field with it (session bookkeeping - never fails the clone).
    warn_if_bookkeeping_persist_failed(
        "remember clone parent dir",
        state
            .mutate_global(|s| s.last_clone_parent_dir = Some(parent_dir.clone()))
            .await,
    );
    if let Some(pid) = profile_id {
        let session = state.get_session(&summary.id).await?;
        crate::commands::profiles::apply_profile_core(&state, &session, &pid).await?;
    }
    Ok(summary)
}

/// Cancel an in-flight `repo_clone` by its `op_id`. Returns whether the op was found.
#[tauri::command]
#[specta::specta]
pub async fn cancel_clone(
    state: tauri::State<'_, AppState>,
    op_id: String,
) -> Result<bool, AppError> {
    let oid = OperationId(op_id);
    let op = state.transient_ops.lock().unwrap().get(&oid).cloned();
    Ok(match op {
        Some(op) => {
            // Order matters: mark cancelled first, then kill - when the kill
            // unblocks the clone's future, the flag must already be visible.
            op.cancelled
                .store(true, std::sync::atomic::Ordering::SeqCst);
            op.runner.cancel(&oid)
        }
        None => false,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn close_repo(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let locator = state
        .repos
        .write()
        .await
        .remove(&repo_id)
        .map(|s| s.locator.clone());

    // Stop and drop the repo's watcher (no-op if watching was disabled).
    state.watchers.lock().unwrap().remove(&repo_id);

    if let Some(locator) = locator {
        let key = locator.to_persist_string();
        warn_if_bookkeeping_persist_failed(
            "record closed repo",
            state
                .mutate_global(|settings| {
                    settings.currently_open.retain(|p| p != &key);
                    if settings.active_open_repo.as_deref() == Some(key.as_str()) {
                        settings.active_open_repo = settings.currently_open.last().cloned();
                    }
                })
                .await,
        );
        // Last tab of a WSL distro closed: release its agent so the WSL VM
        // can idle out.
        if let RepoLocator::Wsl { distro, .. } = locator {
            let still_used = state
                .repos
                .read()
                .await
                .values()
                .any(|s| matches!(&s.locator, RepoLocator::Wsl { distro: d, .. } if *d == distro));
            if !still_used {
                crate::remote::connection::release_wsl_host(&state, &distro).await;
            }
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn set_active_repo(
    state: tauri::State<'_, AppState>,
    repo_id: Option<String>,
) -> Result<(), AppError> {
    let path = if let Some(id) = repo_id {
        state
            .repos
            .read()
            .await
            .get(&id)
            .map(|s| s.locator.to_persist_string())
    } else {
        None
    };
    warn_if_bookkeeping_persist_failed(
        "record active repo",
        state
            .mutate_global(|settings| settings.active_open_repo = path)
            .await,
    );
    Ok(())
}

/// Toggle the filesystem watcher globally and apply it live: start watchers for
/// all open repos when enabling, drop them all when disabling. Persisted so the
/// choice survives restart.
#[tauri::command]
#[specta::specta]
pub async fn set_watcher_enabled(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), AppError> {
    warn_if_bookkeeping_persist_failed(
        "record watcher toggle",
        state
            .mutate_global(|s| {
                s.watcher_enabled = enabled;
            })
            .await,
    );

    if enabled {
        let sessions: Vec<Arc<RepoSession>> =
            state.repos.read().await.values().cloned().collect();
        for session in sessions {
            let already = state.watchers.lock().unwrap().contains_key(&session.id);
            if !already {
                start_repo_watcher(&state, &app, &session).await;
            }
        }
    } else {
        state.watchers.lock().unwrap().clear();
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn list_repos(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RepoSummary>, AppError> {
    let repos = state.repos.read().await;
    let mut out: Vec<RepoSummary> = repos.values().map(|s| s.summary()).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn recent_repos(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    let settings = state.global_settings.read().await;
    Ok(settings.last_open_repos.clone())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct RestoreResult {
    pub repos: Vec<RepoSummary>,
    pub active_id: Option<String>,
}

/// One persisted `currently_open` entry after the restore probe phase.
#[derive(Debug, Clone, PartialEq)]
enum ProbedEntry {
    /// Probed fine — open a session at this resolved toplevel.
    Open(RepoLocator),
    /// The entry's host is unavailable right now (WSL distro gone/asleep):
    /// keep the persisted string untouched so the tab returns next launch.
    Keep(String),
}

/// Compute the post-restore `currently_open` list and the persisted active
/// locator. Pure so the bookkeeping rules are pinned by unit tests:
/// - opened repos persist their session LOCATOR, never the bare host path
///   (a bare path would not match `RepoSummary.locator` on the next launch);
/// - `Keep` entries stay in the list, in their original position;
/// - an `Open` entry whose session failed to open (host lost mid-restore) is
///   kept as well rather than silently dropped;
/// - the active pointer prefers the opened active session's locator, else a
///   still-listed (kept) entry it already pointed at, else the list head.
fn restore_bookkeeping(
    entries: &[ProbedEntry],
    opened: &[(String, String)], // (locator string, session id) per opened repo
    persisted_active: Option<&str>,
) -> (Vec<String>, Option<String>, Option<String>) {
    let mut list: Vec<String> = Vec::new();
    for entry in entries {
        let s = match entry {
            ProbedEntry::Open(locator) => locator.to_persist_string(),
            ProbedEntry::Keep(raw) => raw.clone(),
        };
        if !list.contains(&s) {
            list.push(s);
        }
    }
    let active_id = persisted_active.and_then(|active| {
        opened
            .iter()
            .find(|(locator, _)| locator == active)
            .map(|(_, id)| id.clone())
    });
    let active_locator = match (&active_id, persisted_active) {
        (Some(id), _) => opened
            .iter()
            .find(|(_, oid)| oid == id)
            .map(|(locator, _)| locator.clone()),
        (None, Some(active)) if list.iter().any(|s| s == active) => Some(active.to_string()),
        _ => None,
    };
    let active_locator = active_locator.or_else(|| list.first().cloned());
    (list, active_locator, active_id)
}

#[tauri::command]
#[specta::specta]
pub async fn restore_open_repos(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<RestoreResult, AppError> {
    let (paths, persisted_active) = {
        let s = state.global_settings.read().await;
        (s.currently_open.clone(), s.active_open_repo.clone())
    };
    // Snapshot for the final merge: `currently_open` entries added while
    // restore runs (open_repo racing the splash) must not be clobbered.
    let snapshot: std::collections::HashSet<String> = paths.iter().cloned().collect();
    let git_path = state.git_path.read().await.clone();

    let mut summaries: Vec<RepoSummary> = Vec::new();

    // Probe phase: all persisted paths concurrently. This is the startup hot
    // path (the frontend holds the splash until restore completes): each repo
    // costs at least one process spawn, which dominates on Windows, so with
    // many repos sequential probing is the visible splash time.
    let local_host = state.local_host();
    let probe_handles: Vec<_> = paths
        .into_iter()
        .map(|raw| {
            let git_path = git_path.clone();
            let host = local_host.clone();
            let app = app.clone();
            tokio::spawn(async move {
                match RepoLocator::parse(&raw) {
                    RepoLocator::Local { path } => {
                        if !path.exists() {
                            tracing::info!(path = %raw, "restore: skipping missing path");
                            return None;
                        }
                        let probe = host.executor_for(
                            &HostPath::from_path(&git_path),
                            Some(&HostPath::from_path(&path)),
                        );
                        let Ok(out) = probe.run(&["rev-parse", "--show-toplevel"]).await else {
                            tracing::warn!(path = %raw, "restore: rev-parse spawn failed");
                            return None;
                        };
                        if !out.success {
                            tracing::info!(path = %raw, stderr = %out.stderr.trim(), "restore: not a repo");
                            return None;
                        }
                        Some(ProbedEntry::Open(RepoLocator::local(out.stdout.trim())))
                    }
                    RepoLocator::Wsl { distro, path } => {
                        // Connecting is serialized per distro inside
                        // ensure_wsl_host; concurrent probes are fine.
                        let state = app.state::<AppState>();
                        let host = match crate::remote::connection::ensure_wsl_host(
                            &app, &state, &distro,
                        )
                        .await
                        {
                            Ok(h) => h,
                            Err(e) => {
                                tracing::warn!(distro, err = %e, "restore: wsl host unavailable — keeping the entry for next launch");
                                return Some(ProbedEntry::Keep(raw));
                            }
                        };
                        let host_git = state
                            .host_git_override(&distro)
                            .await
                            .unwrap_or_else(|| "git".into());
                        let exec = host.executor_for(&HostPath(host_git), Some(&path));
                        match exec.run(&["rev-parse", "--show-toplevel"]).await {
                            Ok(out) if out.success => Some(ProbedEntry::Open(RepoLocator::Wsl {
                                distro,
                                path: HostPath(out.stdout.trim().to_string()),
                            })),
                            Ok(out) => {
                                tracing::info!(path = %raw, stderr = %out.stderr.trim(), "restore: remote path is not a repo");
                                None
                            }
                            Err(e) => {
                                // The connection died between handshake and
                                // probe: unavailable, not "gone" — keep it.
                                tracing::warn!(path = %raw, err = %e, "restore: remote probe failed — keeping the entry for next launch");
                                Some(ProbedEntry::Keep(raw))
                            }
                        }
                    }
                }
            })
        })
        .collect();

    // Await in submission order (keeps the user-controlled tab order) and
    // dedup by resolved toplevel BEFORE opening anything: two persisted paths
    // inside the same repo must not race to create two sessions for it.
    let mut entries: Vec<ProbedEntry> = Vec::new();
    let mut toplevels: Vec<RepoLocator> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for handle in probe_handles {
        match handle.await {
            Ok(Some(ProbedEntry::Open(locator))) => {
                // Key the dedup on filesystem identity, not spelling (see
                // `same_dir`): persisted entries can carry different forms of
                // the same directory. Remote toplevels are already resolved by
                // rev-parse on their host.
                let key = match &locator {
                    RepoLocator::Local { path } => std::fs::canonicalize(path)
                        .unwrap_or_else(|_| path.clone())
                        .to_string_lossy()
                        .into_owned(),
                    remote => remote.to_persist_string(),
                };
                if seen.insert(key) {
                    toplevels.push(locator.clone());
                    entries.push(ProbedEntry::Open(locator));
                }
            }
            Ok(Some(keep @ ProbedEntry::Keep(_))) => {
                if !entries.contains(&keep) {
                    entries.push(keep);
                }
            }
            _ => {}
        }
    }

    // Open phase: sessions concurrently (settings read + git spawn + watcher
    // each), reassembled in the persisted order below. The concurrent
    // sessions insert into the `repos` map behind its RwLock; the toplevels
    // are unique, so no two tasks open the same repo.
    let open_handles: Vec<_> = toplevels
        .into_iter()
        .map(|locator| {
            let app = app.clone();
            let git_path = git_path.clone();
            tokio::spawn(async move {
                let state = app.state::<AppState>();
                let host: Arc<dyn Host> = match &locator {
                    RepoLocator::Local { .. } => state.local_host(),
                    RepoLocator::Wsl { distro, .. } => {
                        match crate::remote::connection::ensure_wsl_host(&app, &state, distro)
                            .await
                        {
                            Ok(h) => h,
                            Err(e) => {
                                tracing::warn!(err = %e, "restore: wsl host lost between probe and open");
                                return None;
                            }
                        }
                    }
                };
                // open_session reuses-or-creates atomically, so a restore
                // racing a manual open of the same repo cannot double-open.
                Some(open_session(&state, &app, git_path, host, locator).await)
            })
        })
        .collect();

    for handle in open_handles {
        let Ok(Some(summary)) = handle.await else { continue };
        summaries.push(summary);
    }

    let opened: Vec<(String, String)> = summaries
        .iter()
        .map(|s| (s.locator.clone(), s.id.clone()))
        .collect();
    let (merged_list, active_locator, mut active_id) =
        restore_bookkeeping(&entries, &opened, persisted_active.as_deref());
    if active_id.is_none() {
        active_id = summaries.first().map(|s| s.id.clone());
    }

    warn_if_bookkeeping_persist_failed(
        "record restored repos",
        state
            .mutate_global(|settings| {
                // Merge instead of overwrite: keep any paths that were opened while
                // restore was running (they weren't in our snapshot), in their order.
                let mut merged = merged_list;
                for p in &settings.currently_open {
                    if !snapshot.contains(p) && !merged.contains(p) {
                        merged.push(p.clone());
                    }
                }
                settings.currently_open = merged;
                // Keep active consistent with the list: clear it when nothing
                // restored, rather than leaving a pointer at a repo that is gone.
                settings.active_open_repo = active_locator
                    .or_else(|| settings.currently_open.first().cloned());
            })
            .await,
    );

    Ok(RestoreResult {
        repos: summaries,
        active_id,
    })
}

/// Persist the repository tab order: reorder `currently_open` (paths) to match
/// the given repo-id order. Ids that aren't open are ignored; any open repo
/// missing from the list is kept at the end. Drives tab order on restore.
#[tauri::command]
#[specta::specta]
pub async fn set_open_repos_order(
    state: tauri::State<'_, AppState>,
    repo_ids: Vec<String>,
) -> Result<(), AppError> {
    let ordered_paths: Vec<String> = {
        let repos = state.repos.read().await;
        repo_ids
            .iter()
            .filter_map(|id| repos.get(id).map(|s| s.summary().path))
            .collect()
    };
    warn_if_bookkeeping_persist_failed(
        "record tab order",
        state
            .mutate_global(|settings| {
                let mut next = ordered_paths;
                for p in &settings.currently_open {
                    if !next.contains(p) {
                        next.push(p.clone());
                    }
                }
                settings.currently_open = next;
            })
            .await,
    );
    Ok(())
}

/// Read the repo-scoped settings for an open repo.
#[tauri::command]
#[specta::specta]
pub async fn get_repo_settings(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RepoSettings, AppError> {
    let session = state.get_session(&repo_id).await?;
    let s = session.settings.read().await.clone();
    Ok(s)
}

/// Replace the repo-scoped settings and persist them to disk.
#[tauri::command]
#[specta::specta]
pub async fn update_repo_settings(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    settings: RepoSettings,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    {
        let mut s = session.settings.write().await;
        *s = settings;
    }
    state.persist_session_settings(&session).await
}

/// Return all lane locks for an open repo.
#[tauri::command]
#[specta::specta]
pub async fn list_lane_locks(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<LaneLock>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let locks = session.settings.read().await.lane_locks_doc.locks.clone();
    Ok(locks)
}

/// Add or replace a lane lock. Returns the updated lock list.
/// Rejects lane_index > 64.
#[tauri::command]
#[specta::specta]
pub async fn set_lane_lock(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    ref_name: String,
    lane_index: u32,
) -> Result<Vec<LaneLock>, AppError> {
    if lane_index > 64 {
        return Err(AppError::InvalidLockIndex(lane_index));
    }
    let session = state.get_session(&repo_id).await?;
    let locks = {
        let mut s = session.settings.write().await;
        if let Some(existing) = s.lane_locks_doc.locks.iter_mut().find(|l| l.ref_name == ref_name) {
            existing.lane_index = lane_index;
        } else {
            s.lane_locks_doc.locks.push(LaneLock { ref_name, lane_index });
        }
        s.lane_locks_doc.locks.clone()
    };
    state.persist_session_settings(&session).await?;
    Ok(locks)
}

/// Remove a lane lock by ref name. Returns the updated lock list (no-op if not found).
#[tauri::command]
#[specta::specta]
pub async fn unset_lane_lock(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    ref_name: String,
) -> Result<Vec<LaneLock>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let locks = {
        let mut s = session.settings.write().await;
        s.lane_locks_doc.locks.retain(|l| l.ref_name != ref_name);
        s.lane_locks_doc.locks.clone()
    };
    state.persist_session_settings(&session).await?;
    Ok(locks)
}

#[cfg(test)]
mod tests {
    // The WSL open form's typed paths: `~` forms expand against the agent's
    // home; the `wsl://` locator scheme delivers them '/'-prefixed.
    #[test]
    fn tilde_expansion_covers_typed_and_locator_prefixed_forms() {
        let home = "/home/orell";
        for (input, expected) in [
            ("~", Some("/home/orell")),
            ("~/repo", Some("/home/orell/repo")),
            ("/~", Some("/home/orell")),
            ("/~/repo", Some("/home/orell/repo")),
            ("/home/other/repo", None),
            ("~oops", None),
        ] {
            assert_eq!(
                super::expand_tilde(input, home).as_deref(),
                expected,
                "{input}"
            );
        }
    }

    use super::{restore_bookkeeping, ProbedEntry, RepoLocator};

    // Regression: the persisted active pointer must be the session LOCATOR —
    // persisting the bare host path meant a WSL active tab never matched
    // `RepoSummary.locator` on the next launch.
    #[test]
    fn restore_persists_active_as_locator_not_bare_path() {
        let wsl = RepoLocator::parse("wsl://Ubuntu/home/u/repo");
        let entries = vec![ProbedEntry::Open(wsl.clone())];
        let opened = vec![("wsl://Ubuntu/home/u/repo".to_string(), "id-1".to_string())];
        let (list, active_locator, active_id) =
            restore_bookkeeping(&entries, &opened, Some("wsl://Ubuntu/home/u/repo"));
        assert_eq!(list, vec!["wsl://Ubuntu/home/u/repo"]);
        assert_eq!(active_id.as_deref(), Some("id-1"));
        assert_eq!(active_locator.as_deref(), Some("wsl://Ubuntu/home/u/repo"));
    }

    // Regression: a WSL entry whose distro is unavailable is KEPT in
    // `currently_open` (in place) instead of being dropped, and an active
    // pointer at it survives for the next launch.
    #[test]
    fn restore_keeps_unavailable_wsl_entries_and_their_active_pointer() {
        let local = RepoLocator::local("/x/repo");
        let entries = vec![
            ProbedEntry::Open(local.clone()),
            ProbedEntry::Keep("wsl://Ubuntu/home/u/repo".to_string()),
        ];
        let opened = vec![("/x/repo".to_string(), "id-local".to_string())];
        let (list, active_locator, active_id) =
            restore_bookkeeping(&entries, &opened, Some("wsl://Ubuntu/home/u/repo"));
        assert_eq!(list, vec!["/x/repo", "wsl://Ubuntu/home/u/repo"]);
        // No session opened for the kept entry, but the persisted active
        // pointer stays on it rather than being rewritten.
        assert_eq!(active_id, None);
        assert_eq!(active_locator.as_deref(), Some("wsl://Ubuntu/home/u/repo"));
    }

    #[test]
    fn restore_falls_back_to_list_head_when_active_is_gone() {
        let entries = vec![ProbedEntry::Open(RepoLocator::local("/x/repo"))];
        let opened = vec![("/x/repo".to_string(), "id-1".to_string())];
        let (list, active_locator, active_id) =
            restore_bookkeeping(&entries, &opened, Some("/gone/elsewhere"));
        assert_eq!(list, vec!["/x/repo"]);
        assert_eq!(active_id, None);
        assert_eq!(active_locator.as_deref(), Some("/x/repo"));
    }

    #[test]
    fn same_dir_matches_different_spellings_of_one_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = dir.path().to_path_buf();
        // A non-canonical spelling of the same directory (extra `.` hop).
        let b = a.join(".");
        assert!(super::same_dir(&a, &b));
        // A genuinely different (non-existent) path never matches.
        assert!(!super::same_dir(&a, &a.join("elsewhere")));
    }

    use super::{build_clone_args, build_init_args, new_repo_target, CloneCleanup};
    use legit_core::{HostPath, LocalFs};

    fn hp(p: &std::path::Path) -> HostPath {
        HostPath::from_path(p)
    }

    // Regression: `repo_init` / `repo_clone` took their destination as a bare
    // local path, so the `\\wsl.localhost\…` folder the picker returns for a
    // WSL directory ran WINDOWS git over the share (init half-succeeded, then
    // the probe failed with "dubious ownership"). The destination must route
    // like `open_repo`: distro host, posix path, the distro's git.
    #[test]
    fn new_repo_target_routes_wsl_unc_destination_to_the_distro() {
        let global_git = std::path::Path::new(r"C:\Program Files\Git\cmd\git.exe");
        let t = new_repo_target(
            RepoLocator::parse(r"\\wsl.localhost\Ubuntu\home\u\test-repo"),
            global_git,
            None,
            Some("/home/u"),
        );
        assert_eq!(t.git, HostPath("git".into()), "PATH git inside the distro, never the Windows git");
        assert_eq!(t.dir, HostPath("/home/u/test-repo".into()));
        assert_eq!(
            t.locator,
            RepoLocator::Wsl { distro: "Ubuntu".into(), path: HostPath("/home/u/test-repo".into()) }
        );
    }

    #[test]
    fn new_repo_target_uses_the_distro_git_override_and_expands_tilde() {
        let t = new_repo_target(
            RepoLocator::parse("wsl://Ubuntu/~/proj"),
            std::path::Path::new("/usr/bin/git"),
            Some("/opt/git/bin/git"),
            Some("/home/u"),
        );
        assert_eq!(t.git, HostPath("/opt/git/bin/git".into()));
        assert_eq!(t.dir, HostPath("/home/u/proj".into()));
        assert_eq!(t.locator.to_persist_string(), "wsl://Ubuntu/home/u/proj");
    }

    #[test]
    fn new_repo_target_keeps_local_destinations_on_the_global_git() {
        let t = new_repo_target(
            RepoLocator::parse("/x/proj"),
            std::path::Path::new("/usr/bin/git"),
            Some("ignored-for-local"),
            Some("/home/u"),
        );
        assert_eq!(t.git, HostPath("/usr/bin/git".into()));
        assert_eq!(t.dir, HostPath("/x/proj".into()));
        assert_eq!(t.locator, RepoLocator::local("/x/proj"));
    }

    #[tokio::test]
    async fn cleanup_plan_removes_whole_dir_when_target_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let target = hp(&dir.path().join("repo"));
        assert!(matches!(
            CloneCleanup::plan(&LocalFs, &target).await,
            CloneCleanup::RemoveDir(p) if p == target
        ));
    }

    #[tokio::test]
    async fn cleanup_plan_removes_contents_when_target_is_an_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        std::fs::create_dir(&target).unwrap();
        assert!(matches!(
            CloneCleanup::plan(&LocalFs, &hp(&target)).await,
            CloneCleanup::RemoveContents(p) if p == hp(&target)
        ));
    }

    #[tokio::test]
    async fn cleanup_plan_touches_nothing_when_target_has_content() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("precious.txt"), "user data").unwrap();
        assert!(matches!(
            CloneCleanup::plan(&LocalFs, &hp(&target)).await,
            CloneCleanup::Nothing
        ));
    }

    /// The debris of a killed clone includes read-only files (git object
    /// files); removal must handle them.
    #[tokio::test]
    async fn cleanup_remove_dir_deletes_readonly_debris() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        std::fs::create_dir_all(target.join(".git/objects/ab")).unwrap();
        let obj = target.join(".git/objects/ab/cdef");
        std::fs::write(&obj, "loose object").unwrap();
        let mut perms = std::fs::metadata(&obj).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&obj, perms).unwrap();

        assert_eq!(CloneCleanup::RemoveDir(hp(&target)).run(&LocalFs, true).await, None);
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn cleanup_remove_contents_keeps_the_users_directory() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        std::fs::create_dir_all(target.join(".git")).unwrap();
        std::fs::write(target.join(".git/HEAD"), "ref: x").unwrap();
        std::fs::write(target.join("partial.txt"), "x").unwrap();

        assert_eq!(CloneCleanup::RemoveContents(hp(&target)).run(&LocalFs, true).await, None);
        assert!(target.exists());
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn cleanup_nothing_leaves_files_alone() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("precious.txt"), "user data").unwrap();

        assert_eq!(CloneCleanup::Nothing.run(&LocalFs, true).await, None);
        assert!(target.join("precious.txt").exists());
    }

    /// A cancel can race the clone's own early failure, before git created
    /// anything: removing a target that is already gone is a success.
    #[tokio::test]
    async fn cleanup_remove_dir_of_already_missing_target_is_success() {
        let dir = tempfile::tempdir().unwrap();
        let target = hp(&dir.path().join("repo"));
        assert_eq!(CloneCleanup::RemoveDir(target).run(&LocalFs, true).await, None);
    }

    /// A cleanup that genuinely cannot remove the debris must say so (the
    /// note reaches the user), and must never fix permissions OUTSIDE the
    /// target to force the removal through.
    #[cfg(unix)]
    #[tokio::test]
    async fn cleanup_reports_a_note_when_removal_is_blocked() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("repo");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("debris"), "x").unwrap();
        // An unwritable parent blocks unlinking `repo` from it.
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();

        let note = CloneCleanup::RemoveDir(hp(&target)).run(&LocalFs, true).await;

        // Restore before asserting so the tempdir can always be dropped.
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let note = note.expect("blocked removal must produce a note");
        assert!(
            note.contains("repo"),
            "note should name the path, got: {note}"
        );
    }

    #[test]
    fn clone_args_default_is_progress_url_name() {
        assert_eq!(
            build_clone_args("https://x/y.git", "y", None, None, false),
            vec!["clone", "--progress", "https://x/y.git", "y"],
        );
    }

    #[test]
    fn clone_args_with_all_options() {
        assert_eq!(
            build_clone_args("https://x/y.git", "y", Some(1), Some("dev"), true),
            vec![
                "clone",
                "--progress",
                "--depth",
                "1",
                "--branch",
                "dev",
                "--recurse-submodules",
                "https://x/y.git",
                "y",
            ],
        );
    }

    #[test]
    fn clone_args_ignore_blank_branch_and_zero_depth() {
        assert_eq!(
            build_clone_args("u", "n", Some(0), Some("  "), false),
            vec!["clone", "--progress", "u", "n"],
        );
    }

    #[test]
    fn init_args_default_is_bare_init() {
        assert_eq!(build_init_args(false, None), vec!["init"]);
    }

    #[test]
    fn init_args_with_bare_and_initial_branch() {
        assert_eq!(
            build_init_args(true, Some("trunk")),
            vec!["init", "--bare", "--initial-branch", "trunk"],
        );
        assert_eq!(build_init_args(false, Some(" ")), vec!["init"]);
    }
}
