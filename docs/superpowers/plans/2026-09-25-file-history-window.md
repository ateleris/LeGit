# File History Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Do NOT use subagent-driven-development (excluded by the user's
> global rules). Do NOT commit at any point: leave all changes uncommitted.

**Goal:** An opt-in global setting that makes every file-history summon open a
separate OS window (history list left, that file's commit diff right), fully
disconnected from the main window, SourceTree-style.

**Architecture:** A Rust command creates/focuses a `WebviewWindow` labeled
`fh-<repo_id>-<hash>`; the frontend entry branches on the window label and
mounts a `HistoryWindowShell` (SplitviewReact) instead of `App`. The window is
pinned to (repo, file, rev) handed over via a per-label context map; the
summon store consults the setting and redirects. Lifetime cascades (main
close, repo close) live in Rust window events.

**Tech Stack:** Tauri 2 (WebviewWindowBuilder, window events), React 19,
dockview-react 7 (`SplitviewReact`), zustand, TanStack Query, vitest, cargo.

**Spec:** `docs/superpowers/specs/2026-09-25-file-history-window-design.md`

## Global Constraints

- NEVER commit or push. All work stays uncommitted for review.
- No em-dashes anywhere (prose, comments, strings): use `-` or restructure.
- Comments only for non-derivable constraints, one short line, present tense,
  no names/dates/history.
- Every colour via `var(--token)`; a new token goes in 4 places
  (`src/theme/tokens.ts`, `src/theme/defaults.ts`, `src/styles/theme.css`,
  every `themes/*.legit-theme.json`) plus a `CONTRAST_PAIRS` entry when it is
  text on a background.
- No fixed-px chrome: sizes derive from `--ui-font-size` / `em`; hairlines
  (1px) and window geometry are the only exceptions.
- After ANY Rust type/command change: regenerate bindings with
  `LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings` (run from
  `/mnt/c/NOT_WORK/LeGit`); `cargo test -p legit-app` fails while stale.
- Setting checkbox copy: "Open file history in a separate window".
- Rust tests: `cargo test -p legit-app` from the repo root (WSL is fine).
  TypeScript check: `npx tsc --noEmit` (WSL is fine). Vitest MUST run via
  PowerShell interop, e.g.
  `powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run <path>"`.
  Never `npm install` from WSL.
- `store/`, `keys/`, `lib/`, `layout/` never import from `panels/` or
  `windows/` (pinned by `src/layering.test.ts`).
- Every user-visible change gets one bullet in CHANGELOG.md `## [Unreleased]`.

## Review Focus

1. Malformed or empty summon payload with the setting ON must fall through to
   the docked behaviour, never open a file-less window. (Tests in Task 6.)
2. A summon carrying `rev` (browse-at-commit mode) must pin the window to
   that rev and be a DIFFERENT window from the HEAD-walk of the same file.
   (Tests in Tasks 2 and 6.)
3. A watcher refresh that removes the selected commit (amend, rebase) must
   move the selection to the newest entry instead of showing a dead diff.
   (Test in Task 9, `nextSelection`.)
4. A rename entry must feed `old_path` into the diff request so the window
   shows a real diff, not delete + add. (Test in Task 8,
   `commitDiffRequest`.)
5. Toggling the setting OFF while windows are open must leave those windows
   working and route the next summon to the dock. (Setting is read per
   summon call, Test in Task 6; window self-containment checked manually in
   Task 10.)

---

### Task 1: The global setting (`file_history_opens_window`)

**Files:**
- Modify: `src-tauri/src/state.rs` (GlobalSettings struct ~line 247, its
  `impl Default` ~line 462, tests mod ~line 1235)
- Modify: `src/store/settings.ts`
- Modify: `src/panels/settings/BehaviorSections.tsx`
- Modify: `src/panels/settings/globalSettingsManifest.tsx` (~line 155,
  "application" group)
- Generated: `src/lib/bindings.ts` (regenerate, do not hand-edit)
- Test: `src-tauri/src/state.rs` (inline), `src/panels/settings/settingsManifest.test.ts` (update if it pins section ids)

**Interfaces:**
- Consumes: existing `patch_global_settings` plumbing.
- Produces: `GlobalSettings.file_history_opens_window: bool` (TS:
  `file_history_opens_window: boolean` in bindings), store setter
  `setFileHistoryOpensWindow(enabled: boolean)`. Task 6 reads
  `useSettingsStore.getState().settings?.file_history_opens_window`.

- [ ] **Step 1: Write the failing Rust test** in the existing `mod tests` of
  `state.rs`:

```rust
#[test]
fn file_history_opens_window_is_patchable() {
    let merged = GlobalSettings::default()
        .with_patch(&serde_json::json!({ "file_history_opens_window": true }))
        .unwrap();
    assert!(merged.file_history_opens_window);
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test -p legit-app file_history_opens_window`
Expected: compile error (no such field).

- [ ] **Step 3: Add the field.** In `GlobalSettings`, next to the other
  behaviour toggles (e.g. after `stash_include_untracked`):

```rust
    /// Open file-history summons in a separate OS window (history + diff)
    /// instead of the docked panel.
    #[serde(default)]
    pub file_history_opens_window: bool,
```

Add `file_history_opens_window: false,` to `impl Default for GlobalSettings`.
Do NOT add it to `GLOBAL_SETTINGS_COMMAND_OWNED` (it is patchable).

- [ ] **Step 4: Run the test, then regenerate bindings**

Run: `cargo test -p legit-app file_history_opens_window` -> PASS, then
`LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings`, then
`cargo test -p legit-app` -> all PASS.

- [ ] **Step 5: Frontend setter.** In `src/store/settings.ts` add to the
  `SettingsStore` interface and the store body (mirror `setStashIncludeUntracked`):

```ts
setFileHistoryOpensWindow: (enabled: boolean) => Promise<void>;
// ...
async setFileHistoryOpensWindow(enabled) {
  await patch({ file_history_opens_window: enabled });
},
```

- [ ] **Step 6: Settings section.** In `BehaviorSections.tsx` (reuse the
  file's `Section`, `WritesTo`, `FieldNote`, `useDelayedBusy` imports; match
  the checkbox-label markup of `AutoOpenPanelsSection`):

```tsx
export function FileHistoryWindowSection() {
  const enabled = useSettingsStore((s) => s.settings?.file_history_opens_window ?? false);
  const setEnabled = useSettingsStore((s) => s.setFileHistoryOpensWindow);
  const { busy, run } = useDelayedBusy();
  return (
    <Section title="File history window">
      <WritesTo note="applies to all repos" />
      <FieldNote>
        Show a file's history in its own window - commits on the left, that
        file's diff on the right - instead of the docked File History panel.
        The window is independent of the main window and can sit on another
        monitor. The View menu still opens the docked panel.
      </FieldNote>
      <label style={{ display: "flex", alignItems: "center", gap: "0.5em", fontSize: "var(--fz-lg)", cursor: "pointer", marginTop: "0.667em" }}>
        <input type="checkbox" checked={enabled} disabled={busy} onChange={() => run(() => setEnabled(!enabled))} />
        Open file history in a separate window
      </label>
    </Section>
  );
}
```

- [ ] **Step 7: Manifest entry.** In `globalSettingsManifest.tsx`, in the
  `application` group after `auto-open-panels`:

```tsx
{
  id: "file-history-window",
  title: "File history window",
  keywords: ["history", "window", "popup", "detach", "monitor", "sourcetree"],
  render: () => <FileHistoryWindowSection />,
},
```

- [ ] **Step 8: Run the settings suites and typecheck**

Run: `npx tsc --noEmit` and
`powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run src/panels/settings"`.
If `settingsManifest.test.ts` pins section ids, add the new id there.
Expected: PASS.

---

### Task 2: Rust pure helpers - window label and title

**Files:**
- Create: `src-tauri/src/commands/panel_window.rs`
- Modify: `src-tauri/src/commands/mod.rs` (declare + re-export, matching the
  file's existing `pub mod x; pub use x::*;` style)
- Test: inline `mod tests` in the new file

**Interfaces:**
- Produces: `pub const FILE_HISTORY_LABEL_PREFIX: &str = "fh-"`,
  `pub fn file_history_window_label(repo_id: &str, path: &str, rev: Option<&str>) -> String`,
  `pub fn history_window_title(path: &str, rev: Option<&str>, repo_name: &str) -> String`.
  Tasks 3 and 4 consume all three.

- [ ] **Step 1: Write the failing tests** (new file, tests first):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_stable_and_distinguishes_path_and_rev() {
        let a = file_history_window_label("abc123", "src/foo.ts", None);
        assert_eq!(a, file_history_window_label("abc123", "src/foo.ts", None));
        assert!(a.starts_with("fh-abc123-"));
        assert_ne!(a, file_history_window_label("abc123", "src/bar.ts", None));
        assert_ne!(a, file_history_window_label("abc123", "src/foo.ts", Some("deadbeef")));
        assert_ne!(a, file_history_window_label("other", "src/foo.ts", None));
    }

    // Concatenation must not collide: ("a", rev "b") vs ("ab", no rev).
    #[test]
    fn label_hash_separates_path_from_rev() {
        assert_ne!(
            file_history_window_label("r", "a", Some("b")),
            file_history_window_label("r", "ab", None)
        );
    }

    #[test]
    fn title_shows_file_rev_and_repo() {
        assert_eq!(history_window_title("src/foo.ts", None, "LeGit"), "foo.ts - History (LeGit)");
        assert_eq!(
            history_window_title("foo.ts", Some("deadbeefcafe"), "LeGit"),
            "foo.ts - History from deadbeef (LeGit)"
        );
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p legit-app panel_window`
Expected: compile error (functions not defined).

- [ ] **Step 3: Implement** (top of the same file):

```rust
//! File-history popup windows: labels, titles, creation, per-window context.

/// Label prefix for every file-history window; the lifecycle cascades in
/// `lib.rs` and `close_repo` match on it.
pub const FILE_HISTORY_LABEL_PREFIX: &str = "fh-";

// FNV-1a 64-bit: deterministic within a run so re-summoning the same
// (path, rev) focuses the existing window instead of spawning a duplicate.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

pub fn file_history_window_label(repo_id: &str, path: &str, rev: Option<&str>) -> String {
    let mut key = path.as_bytes().to_vec();
    key.push(0);
    key.extend_from_slice(rev.unwrap_or("").as_bytes());
    format!("{FILE_HISTORY_LABEL_PREFIX}{repo_id}-{:016x}", fnv1a(&key))
}

pub fn history_window_title(path: &str, rev: Option<&str>, repo_name: &str) -> String {
    let file = path.rsplit('/').next().unwrap_or(path);
    match rev {
        Some(r) => {
            let short: String = r.chars().take(8).collect();
            format!("{file} - History from {short} ({repo_name})")
        }
        None => format!("{file} - History ({repo_name})"),
    }
}
```

Add to `commands/mod.rs`: `pub mod panel_window;` plus the re-export line in
the file's existing style.

- [ ] **Step 4: Run tests**

Run: `cargo test -p legit-app panel_window`
Expected: PASS.

---

### Task 3: Window creation and context commands

**Files:**
- Modify: `src-tauri/src/commands/panel_window.rs`
- Modify: `src-tauri/src/lib.rs` (`collect_commands!` list ~line 239; `setup`
  closure: `app.manage(...)`)
- Modify: `src-tauri/capabilities/default.json`
- Generated: `src/lib/bindings.ts` (regenerate)

**Interfaces:**
- Consumes: Task 2's label/title functions; `AppState::get_session`
  (`state.get_session(&repo_id).await?`), `RepoSession::summary().name`.
- Produces: commands `open_file_history_window(repo_id: String, path: String, rev: Option<String>)`
  and `history_window_context() -> HistoryWindowContext`; managed state
  `HistoryWindows`. TS (after regen): `api.openFileHistoryWindow(repoId, path, rev)`
  and `api.historyWindowContext()` plus the `HistoryWindowContext` type
  `{ repo_id: string; path: string; rev: string | null; repo_name: string }`.
  Task 6 calls the first, Task 9 the second.

- [ ] **Step 1: Add the context type and managed map** to `panel_window.rs`:

```rust
use crate::error::AppError;
use crate::state::AppState;
use serde::Serialize;
use specta::Type;

/// What a history window shows, handed to its frontend on boot (keyed by
/// window label; the label itself carries no decodable payload).
#[derive(Debug, Clone, Serialize, Type)]
pub struct HistoryWindowContext {
    pub repo_id: String,
    pub path: String,
    pub rev: Option<String>,
    pub repo_name: String,
}

#[derive(Default)]
pub struct HistoryWindows(
    pub std::sync::Mutex<std::collections::HashMap<String, HistoryWindowContext>>,
);
```

- [ ] **Step 2: Implement the open command** (same file):

```rust
pub const FILE_HISTORY_DEFAULT_SIZE: (f64, f64) = (1000.0, 650.0);

#[tauri::command]
#[specta::specta]
pub async fn open_file_history_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    windows: tauri::State<'_, HistoryWindows>,
    repo_id: String,
    path: String,
    rev: Option<String>,
) -> Result<(), AppError> {
    use tauri::Manager;
    let session = state.get_session(&repo_id).await?;
    let repo_name = session.summary().name;

    let label = file_history_window_label(&repo_id, &path, rev.as_deref());
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    windows.0.lock().unwrap().insert(
        label.clone(),
        HistoryWindowContext {
            repo_id: repo_id.clone(),
            path: path.clone(),
            rev: rev.clone(),
            repo_name: repo_name.clone(),
        },
    );

    let (w, h) = FILE_HISTORY_DEFAULT_SIZE;
    let win = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(history_window_title(&path, rev.as_deref(), &repo_name))
    .inner_size(w, h)
    .min_inner_size(500.0, 300.0)
    .visible(false)
    .build()
    .map_err(|e| AppError::Io(format!("failed to open the history window: {e}")))?;

    // Main-window pattern: hidden until the frontend applied the theme, with
    // a failsafe show so a broken frontend never leaves an invisible window.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        if !win.is_visible().unwrap_or(true) {
            let _ = win.show();
        }
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn history_window_context(
    window: tauri::WebviewWindow,
    windows: tauri::State<'_, HistoryWindows>,
) -> Result<HistoryWindowContext, AppError> {
    windows
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or_else(|| AppError::Io(format!("no history-window context for '{}'", window.label())))
}
```

- [ ] **Step 3: Register.** In `lib.rs`: add
  `commands::open_file_history_window,` and `commands::history_window_context,`
  to `collect_commands![...]`; in `setup`, next to the other `app.manage`
  calls: `app.manage(commands::HistoryWindows::default());`.

- [ ] **Step 4: Grant the capability.** In `capabilities/default.json`:

```json
"windows": ["main", "fh-*"],
```

- [ ] **Step 5: Regenerate bindings and run the suite**

Run: `LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings`, then
`cargo test -p legit-app`.
Expected: PASS; `bindings.ts` now contains `openFileHistoryWindow`,
`historyWindowContext`, and the `HistoryWindowContext` type.

---

### Task 4: Lifecycle - close cascades and remembered window size

**Files:**
- Modify: `src-tauri/src/state.rs` (new `WindowSize` type + field +
  `GLOBAL_SETTINGS_COMMAND_OWNED` + Default impl + test)
- Modify: `src-tauri/src/lib.rs` (`.on_window_event(...)` on the builder)
- Modify: `src-tauri/src/commands/repo.rs` (`close_repo` ~line 753)
- Modify: `src-tauri/src/commands/panel_window.rs` (read the remembered size)
- Generated: `src/lib/bindings.ts` (regenerate)
- Test: inline in `state.rs`

**Interfaces:**
- Consumes: `FILE_HISTORY_LABEL_PREFIX`, `HistoryWindows` (Tasks 2-3),
  `AppState::mutate_global`.
- Produces: `GlobalSettings.file_history_window_size: Option<WindowSize>`
  (command-owned), `WindowSize { width: f64, height: f64 }`; cascades that
  Tasks 9-10 rely on behaviourally.

- [ ] **Step 1: Write the failing command-owned test** in `state.rs` tests:

```rust
#[test]
fn file_history_window_size_is_command_owned() {
    assert!(GlobalSettings::default()
        .with_patch(&serde_json::json!({
            "file_history_window_size": { "width": 1.0, "height": 1.0 }
        }))
        .is_err());
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p legit-app file_history_window_size`
Expected: compile error (no such field).

- [ ] **Step 3: Add the type and field** in `state.rs`:

```rust
/// Logical (DPI-independent) window size.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
}
```

In `GlobalSettings`, next to `file_history_opens_window`:

```rust
    /// Last-used history-window size; new history windows reuse it.
    /// Written by the window-close handler, never by a settings patch.
    #[serde(default)]
    pub file_history_window_size: Option<WindowSize>,
```

Add `file_history_window_size: None,` to the Default impl. Add
`"file_history_window_size"` to `GLOBAL_SETTINGS_COMMAND_OWNED` and bump its
array length (`[&str; 10]`).

- [ ] **Step 4: Run the test** -> PASS, then regenerate bindings
  (`LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings`).

- [ ] **Step 5: Window-event hook.** In `lib.rs`, on the builder chain (after
  `.invoke_handler(...)`, before `.setup(...)`):

```rust
.on_window_event(|window, event| {
    use tauri::{Manager, WindowEvent};
    let label = window.label();
    if label == "main" {
        // History windows are unusable without the main window: close them
        // with it so the process can exit.
        if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
            for win in window.app_handle().webview_windows().values() {
                if win.label().starts_with(commands::FILE_HISTORY_LABEL_PREFIX) {
                    let _ = win.close();
                }
            }
        }
        return;
    }
    if !label.starts_with(commands::FILE_HISTORY_LABEL_PREFIX) {
        return;
    }
    match event {
        WindowEvent::CloseRequested { .. } => {
            if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
                let logical = size.to_logical::<f64>(scale);
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let _ = state
                        .mutate_global(|s| {
                            s.file_history_window_size = Some(state::WindowSize {
                                width: logical.width,
                                height: logical.height,
                            });
                        })
                        .await;
                });
            }
        }
        WindowEvent::Destroyed => {
            let windows = window.app_handle().state::<commands::HistoryWindows>();
            windows.0.lock().unwrap().remove(label);
        }
        _ => {}
    }
})
```

(Adjust paths/visibility as the compiler demands: `state::WindowSize` needs
`pub` items, `commands::FILE_HISTORY_LABEL_PREFIX` comes from Task 2's
re-export.)

- [ ] **Step 6: Use the remembered size.** In `open_file_history_window`
  replace the fixed-size line:

```rust
    let size = state.global_settings.read().await.file_history_window_size.clone();
    let (w, h) = size.map(|s| (s.width, s.height)).unwrap_or(FILE_HISTORY_DEFAULT_SIZE);
```

- [ ] **Step 7: Repo-close cascade.** In `close_repo` add an
  `app: tauri::AppHandle` parameter and, after the session is removed:

```rust
    // A history window is pinned to this repo: close its windows with it.
    let prefix = format!("{}{}-", crate::commands::FILE_HISTORY_LABEL_PREFIX, repo_id);
    for win in app.webview_windows().values() {
        if win.label().starts_with(&prefix) {
            let _ = win.close();
        }
    }
```

(`use tauri::Manager;` where needed. Injected params do not change bindings.)

- [ ] **Step 8: Full Rust suite**

Run: `cargo test -p legit-app`
Expected: PASS (bindings unchanged by injected params; regen from Step 4
already committed the new type to the file).

---

### Task 5: Settings-changed broadcast

**Files:**
- Modify: `src-tauri/src/commands/persistence.rs`
  (`patch_global_settings`, `set_active_theme`, `save_theme`)
- Modify: `src/lib/events.ts`

**Interfaces:**
- Produces: event channel `legit://global-settings-changed` (unit payload);
  `onGlobalSettingsChanged(handler: () => void): Promise<() => void>` in
  `events.ts`. Task 9's shell subscribes.

- [ ] **Step 1: Emit on the Rust side.** In `persistence.rs`:

```rust
/// Broadcast after any persisted settings/theme change so secondary windows
/// re-apply theme and font. Matches `GLOBAL_SETTINGS_CHANGED_EVENT` in
/// `src/lib/events.ts`.
pub(crate) const GLOBAL_SETTINGS_CHANGED_EVENT: &str = "legit://global-settings-changed";
```

Add `app: tauri::AppHandle` to `patch_global_settings`, `set_active_theme`
and `save_theme`; after each one's successful persist add:

```rust
    use tauri::Emitter;
    let _ = app.emit(GLOBAL_SETTINGS_CHANGED_EVENT, ());
```

- [ ] **Step 2: Frontend subscription.** In `events.ts` (follow the file's
  pattern):

```ts
/** Tauri event channel fired after any persisted global-settings or theme
 *  change. Matches `GLOBAL_SETTINGS_CHANGED_EVENT` in
 *  `src-tauri/src/commands/persistence.rs`. */
export const GLOBAL_SETTINGS_CHANGED_EVENT = "legit://global-settings-changed";

/** Subscribe to settings-changed broadcasts. Returns an unsubscribe function. */
export async function onGlobalSettingsChanged(handler: () => void): Promise<() => void> {
  return listen<null>(GLOBAL_SETTINGS_CHANGED_EVENT, () => handler());
}
```

- [ ] **Step 3: Verify**

Run: `cargo test -p legit-app` and `npx tsc --noEmit`
Expected: PASS (injected `AppHandle` params leave bindings unchanged).

---

### Task 6: Summon redirect

**Files:**
- Modify: `src/lib/types.ts` (take over `FileHistoryRequest`)
- Modify: `src/panels/FileHistory/FileHistoryPanel.tsx` (import the moved type)
- Modify: `src/store/summon.ts`
- Test: `src/store/summon.test.ts`

**Interfaces:**
- Consumes: `api.openFileHistoryWindow` (Task 3),
  `settings?.file_history_opens_window` (Task 1), `useRepoStore` for the
  active repo id.
- Produces: `fileHistoryWindowRequest(targetId: string, payload: unknown, opensWindow: boolean): { path: string; rev: string | null } | null`
  exported from `store/summon.ts`; `FileHistoryRequest` exported from
  `lib/types.ts`.

- [ ] **Step 1: Move the payload type.** Cut `FileHistoryRequest` from
  `FileHistoryPanel.tsx` into `src/lib/types.ts` (it is a frontend-owned
  summon payload, which is exactly what `types.ts` holds), keeping its doc
  comment. Update every importer (`grep -rn "FileHistoryRequest" src/`).
  Layering: `store/` may import `lib/`, never `panels/`.

- [ ] **Step 2: Write the failing tests** in `src/store/summon.test.ts`:

```ts
import { fileHistoryWindowRequest } from "./summon";

describe("fileHistoryWindowRequest", () => {
  it("routes a string payload when the setting is on", () => {
    expect(fileHistoryWindowRequest("file-history", "src/a.ts", true))
      .toEqual({ path: "src/a.ts", rev: null });
  });
  it("carries rev from a request payload", () => {
    expect(fileHistoryWindowRequest("file-history", { path: "a.ts", rev: "deadbeef" }, true))
      .toEqual({ path: "a.ts", rev: "deadbeef" });
  });
  it("never routes when the setting is off", () => {
    expect(fileHistoryWindowRequest("file-history", "src/a.ts", false)).toBeNull();
  });
  it("ignores other panels and malformed payloads", () => {
    expect(fileHistoryWindowRequest("diff", "src/a.ts", true)).toBeNull();
    expect(fileHistoryWindowRequest("file-history", undefined, true)).toBeNull();
    expect(fileHistoryWindowRequest("file-history", { rev: "x" }, true)).toBeNull();
    expect(fileHistoryWindowRequest("file-history", 42, true)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run src/store/summon.test.ts"`
Expected: FAIL (export missing).

- [ ] **Step 4: Implement the pure function** in `summon.ts`:

```ts
/**
 * When the "file history in a separate window" setting is on, a file-history
 * summon that carries a file is routed to an OS window instead of the dock.
 * Null = keep the docked path (setting off, other panel, or no usable file).
 */
export function fileHistoryWindowRequest(
  targetId: string,
  payload: unknown,
  opensWindow: boolean,
): { path: string; rev: string | null } | null {
  if (targetId !== "file-history" || !opensWindow) return null;
  if (typeof payload === "string") return { path: payload, rev: null };
  if (payload && typeof payload === "object") {
    const p = payload as Partial<FileHistoryRequest>;
    if (typeof p.path === "string") {
      return { path: p.path, rev: typeof p.rev === "string" ? p.rev : null };
    }
  }
  return null;
}
```

- [ ] **Step 5: Wire it.** At the top of `summon()` in the store (before the
  suppression check), with imports for `useRepoStore`, `api`, `notify`,
  `formatAppError`:

```ts
  summon(targetId, payload) {
    const windowed = fileHistoryWindowRequest(
      targetId,
      payload,
      useSettingsStore.getState().settings?.file_history_opens_window ?? false,
    );
    if (windowed) {
      const repoId = useRepoStore.getState().activeRepoId;
      if (repoId) {
        void api
          .openFileHistoryWindow(repoId, windowed.path, windowed.rev)
          .catch((e) => notify.error(formatAppError(e)));
      }
      return;
    }
    // ... existing body unchanged
```

The View menu opens panels through `openRepoPanel` /
`addRepoPanelWithoutSplitting`, not `summon()`, so it keeps opening the
docked placeholder - verify by reading `ViewMenu.tsx`, change nothing there.

- [ ] **Step 6: Run tests and layering**

Run: `powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run src/store/summon.test.ts src/layering.test.ts"`
and `npx tsc --noEmit`.
Expected: PASS.

---

### Task 7: Extract the shared history list

**Files:**
- Create: `src/panels/FileHistory/FileHistoryList.tsx`
- Modify: `src/panels/FileHistory/FileHistoryPanel.tsx`
- Test: `src/panels/FileHistory/fileHistoryList.test.tsx`

**Interfaces:**
- Produces (all exported from `FileHistoryList.tsx`):
  - `FILE_HISTORY_PAGE_SIZE = 200`
  - `useFileHistoryQuery(repoId: string | undefined, path: string | null, rev: string | null, pageCount: number)` -
    the exact query from today's panel (key
    `[repoId, "log", "file-history", path, rev, pageCount]`, `STALE.live`).
  - `FileHistoryList({ entries, busy, error, maybeMore, onLoadMore, selectedSha?, onActivate, renderMenu })` -
    presentational rows + empty/error states + Load more button.
  - `restoreFileAtRevision(queryClient: QueryClient, repoId: string, entry: FileHistoryEntry): Promise<void>` -
    today's `restore` body (restore command, invalidate
    `["status","log","diff"]`, success/error toasts).
- The docked panel keeps: summon target, `usePanelViewState` keys, toolbar,
  placeholder states, its full row menu, `openCommit` summons. Task 9's
  window consumes the same exports.

- [ ] **Step 1: Write the failing component test**
  (`fileHistoryList.test.tsx`; mirror the setup style of an existing panel
  test such as `src/panels/Refs/refsPaneview.test.tsx` for render helpers):

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { FileHistoryList } from "./FileHistoryList";
import type { FileHistoryEntry } from "../../lib/types";

const entry = (sha: string): FileHistoryEntry => ({
  commit_id: sha,
  path: "src/a.ts",
  old_path: null,
  author: "ada",
  summary: `commit ${sha}`,
  timestamp: 1700000000,
});

const noMenu = () => null;

describe("FileHistoryList", () => {
  it("activates a row on click", () => {
    const onActivate = vi.fn();
    render(
      <FileHistoryList entries={[entry("aaa111"), entry("bbb222")]} busy={false}
        error={null} maybeMore={false} onLoadMore={() => {}}
        onActivate={onActivate} renderMenu={noMenu} />
    );
    fireEvent.click(screen.getByText("commit bbb222"));
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ commit_id: "bbb222" }));
  });

  it("marks the selected row", () => {
    render(
      <FileHistoryList entries={[entry("aaa111")]} busy={false} error={null}
        maybeMore={false} onLoadMore={() => {}} selectedSha="aaa111"
        onActivate={() => {}} renderMenu={noMenu} />
    );
    expect(screen.getByText("commit aaa111").closest("[aria-current]")).toBeTruthy();
  });

  it("shows Load more only when a full page arrived", () => {
    const { rerender } = render(
      <FileHistoryList entries={[entry("a")]} busy={false} error={null}
        maybeMore={false} onLoadMore={() => {}} onActivate={() => {}} renderMenu={noMenu} />
    );
    expect(screen.queryByText("Load more")).toBeNull();
    rerender(
      <FileHistoryList entries={[entry("a")]} busy={false} error={null}
        maybeMore={true} onLoadMore={() => {}} onActivate={() => {}} renderMenu={noMenu} />
    );
    expect(screen.getByText("Load more")).toBeTruthy();
  });
});
```

Wrap renders in the providers the row needs (`PanelContextMenuProvider`); if
the context-menu hook makes bare rendering impossible, provide the wrapper in
the test's render helper.

- [ ] **Step 2: Run to verify failure**

Run: `powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run src/panels/FileHistory"`
Expected: FAIL (module missing).

- [ ] **Step 3: Extract.** Move `HistoryRow`, the query, `PAGE_SIZE` and the
  restore logic out of `FileHistoryPanel.tsx` into `FileHistoryList.tsx` per
  the Interfaces block. Changes to the moved code:
  - `HistoryRow` takes `selected: boolean` and `menu: React.ReactNode`
    (built by the host's `renderMenu(entry, closeMenu)`); it keeps
    `usePanelContextMenu` for `openMenu`/`closeMenu`.
  - Selected row: set `aria-current="true"` and a background from an
    existing selection token. Find the token the Changed Files /
    Working Changes rows use for their selected state
    (`grep -rn "selected" src/panels/WorkingChanges src/panels/ChangedFiles | grep -i "var(--"`)
    and reuse exactly that; only if none exists add a new token in the 4
    places plus a `CONTRAST_PAIRS` entry.
  - `restoreFileAtRevision` is a plain async function (no hooks) so both
    hosts share it.
- [ ] **Step 4: Refit the docked panel.** `FileHistoryPanel.tsx` keeps its
  summon target, view state (`path`, `rev`, `pageCount`), toolbar and
  placeholders, and now renders:

```tsx
  const { data: entries = [], isFetching, isError, error, refetch } =
    useFileHistoryQuery(repo?.id, path, rev, pageCount);
  // ...
  <FileHistoryList
    entries={entries}
    busy={isFetching}
    error={isError ? error : null}
    maybeMore={entries.length === FILE_HISTORY_PAGE_SIZE * pageCount}
    onLoadMore={() => setPageCount((n) => n + 1)}
    onActivate={(entry) => openCommit(entry.commit_id, entry.path)}
    renderMenu={renderDockedMenu}
  />
```

where `renderDockedMenu(entry, closeMenu)` returns exactly today's menu JSX
(FileRowMenuSection, "Diff in this commit", restore with confirm). No
`selectedSha` (docked behaviour today has no selection highlight). Export the
summon fan-out for the regression pin:

```tsx
/** Row-activation fan-out of the DOCKED panel (the window deliberately
 *  does not use it). */
export function openCommitFromHistory(sha: string, path: string) {
  const summon = useSummonStore.getState();
  summon.summon("commit-details", sha);
  summon.swapSummon("changed-files", "working-changes", { commitId: sha, selectPath: path });
  summon.notifyIfOpen("log", sha);
  summon.notifyIfOpen("files", { rev: sha });
}
```

and use it as `openCommit`.

- [ ] **Step 5: Pin the docked fan-out.** Append to
  `fileHistoryList.test.tsx`:

```tsx
import { openCommitFromHistory } from "./FileHistoryPanel";
import { useSummonStore } from "../../store/summon";

it("docked activation drives the four main-window panels", () => {
  const summon = vi.fn();
  const swapSummon = vi.fn();
  const notifyIfOpen = vi.fn();
  useSummonStore.setState({ summon, swapSummon, notifyIfOpen });
  openCommitFromHistory("abc123", "src/a.ts");
  expect(summon).toHaveBeenCalledWith("commit-details", "abc123");
  expect(swapSummon).toHaveBeenCalledWith("changed-files", "working-changes",
    { commitId: "abc123", selectPath: "src/a.ts" });
  expect(notifyIfOpen).toHaveBeenCalledWith("log", "abc123");
  expect(notifyIfOpen).toHaveBeenCalledWith("files", { rev: "abc123" });
});
```

- [ ] **Step 6: Run the suites**

Run: `powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run src/panels/FileHistory src/theme/noLiteralColors.test.ts"`
and `npx tsc --noEmit`.
Expected: PASS.

---

### Task 8: Extract DiffBody and build CommitFileDiff

**Files:**
- Create: `src/panels/Diff/DiffBody.tsx` (moved code)
- Create: `src/panels/Diff/viewPrefs.ts`
- Create: `src/panels/Diff/CommitFileDiff.tsx`
- Modify: `src/panels/Diff/DiffPanel.tsx` (imports only; no behaviour change)
- Test: `src/panels/Diff/commitFileDiff.test.ts`

**Interfaces:**
- Consumes: `FileHistoryEntry`, `DiffRequest`, `DiffEntry` from `lib/types`;
  `api.repoDiff`; `DiffEditorHandle`.
- Produces:
  - `DiffBody` (the component currently private in `DiffPanel.tsx` at ~line
    478, moved verbatim with its helpers `ACTION_TITLE`, `lineActionLabel`,
    `binarySizes`, `SubmoduleDirtyNotice` and their imports).
  - `viewPrefs.ts`: `MODE_KEY`, `CONTEXT_KEY`, `loadPref`, `segStyle`,
    `FULL_FILE_CONTEXT`, `CHUNKED_CONTEXT` (moved from `DiffPanel.tsx`,
    same names/values so the user's stored prefs carry over).
  - `commitDiffRequest(repoId: string, entry: FileHistoryEntry): DiffRequest`
    (exported from `CommitFileDiff.tsx`).
  - `CommitFileDiff({ repoId, entry }: { repoId: string; entry: FileHistoryEntry })` -
    read-only commit diff with Inline/Split and Chunks/Full toggles.
    Task 9 renders it.

- [ ] **Step 1: Write the failing mapping test**
  (`commitFileDiff.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { commitDiffRequest } from "./CommitFileDiff";
import type { FileHistoryEntry } from "../../lib/types";

const entry: FileHistoryEntry = {
  commit_id: "abc123def",
  path: "src/new-name.ts",
  old_path: "src/old-name.ts",
  author: "ada",
  summary: "rename",
  timestamp: 1700000000,
};

describe("commitDiffRequest", () => {
  it("targets the commit and pairs the rename sides", () => {
    expect(commitDiffRequest("repo1", entry)).toEqual({
      repoId: "repo1",
      path: "src/new-name.ts",
      oldPath: "src/old-name.ts",
      source: { kind: "commit", commit_id: "abc123def" },
    });
  });
  it("omits oldPath for a plain entry", () => {
    const req = commitDiffRequest("repo1", { ...entry, old_path: null });
    expect(req.oldPath ?? null).toBeNull();
  });
});
```

(Match the exact `FileHistoryEntry`/`DiffRequest` field shapes in
`bindings.ts`; adjust the literal if `oldPath` is `string | null`.)

- [ ] **Step 2: Run to verify failure** (same vitest interop command, path
  `src/panels/Diff/commitFileDiff.test.ts`). Expected: FAIL.

- [ ] **Step 3: Mechanical extraction.** Move `DiffBody` + helpers to
  `DiffBody.tsx` and the pref constants/helpers to `viewPrefs.ts`; update
  `DiffPanel.tsx` imports. Zero logic changes: `git diff` on `DiffPanel.tsx`
  should show only deletions and import lines.

- [ ] **Step 4: Implement `CommitFileDiff`:**

```tsx
export function commitDiffRequest(repoId: string, entry: FileHistoryEntry): DiffRequest {
  return {
    repoId,
    path: entry.path,
    oldPath: entry.old_path,
    source: { kind: "commit", commit_id: entry.commit_id },
  };
}

/** Read-only diff of one file in one commit - the history window's right
 *  pane. Shares view prefs (inline/split, chunks/full) with the Diff panel. */
export function CommitFileDiff({ repoId, entry }: { repoId: string; entry: FileHistoryEntry }) {
  const request = useMemo(() => commitDiffRequest(repoId, entry), [repoId, entry]);
  const [mode, setMode] = useState<DiffViewMode>(() => loadPref(MODE_KEY, "inline"));
  const [contextMode, setContextMode] = useState<ContextMode>(() => loadPref(CONTEXT_KEY, "chunked"));
  const context = contextMode === "full" ? FULL_FILE_CONTEXT : CHUNKED_CONTEXT;
  const editorRef = useRef<DiffEditorHandle | null>(null);
  const syntaxEnabled = useSettingsStore((s) => s.settings?.diff_syntax_highlighting ?? false);

  const { data, isFetching, isError, error } = useQuery<DiffEntry>({
    queryKey: [repoId, "diff", request.source, request.path, request.oldPath, context],
    queryFn: () => api.repoDiff(repoId, request.source, request.path, request.oldPath ?? null, context),
    staleTime: STALE.live,
  });

  const chooseMode = (next: DiffViewMode) => { setMode(next); localStorage.setItem(MODE_KEY, next); };
  const chooseContext = (next: ContextMode) => { setContextMode(next); localStorage.setItem(CONTEXT_KEY, next); };
  const noop = () => {};

  return (
    <PanelContextMenuProvider baseline={[]}>
      <div className="legit-panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <PanelLoadingBar active={isFetching} />
        <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: "0.667em" }}>
          {/* same two segmented toggles as DiffPanel, via segStyle */}
        </div>
        {isError && <PanelError error={error} />}
        <div style={{ flex: 1, minHeight: 0 }}>
          <DiffBody
            data={data}
            mode={mode}
            actions={[]}
            onAction={noop}
            request={request}
            lineActionOp={null}
            onLineAction={noop}
            editable={false}
            dirty={false}
            onDirty={noop}
            onSaveRequest={noop}
            editorRef={editorRef}
            rebuildKey={0}
            syntaxPath={syntaxEnabled ? request.path : null}
          />
        </div>
      </div>
    </PanelContextMenuProvider>
  );
}
```

Fill the toolbar with the Inline/Split and Chunks/Full button pairs copied
from `DiffPanel.tsx` (they use `segStyle` from `viewPrefs.ts`). Import types
(`DiffViewMode`, `ContextMode`, `LineActionOp`) from wherever `DiffPanel.tsx`
gets them. Per-hunk context expansion stays out (full-file mode covers it);
`DiffBody` renders no expanders when `onExpandHunk` is omitted.

- [ ] **Step 5: Run tests and the diff suites**

Run: `powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run src/panels/Diff src/theme/noLiteralColors.test.ts src/styles/toolbarControls.test.ts"`
and `npx tsc --noEmit`.
Expected: PASS (existing diff model tests prove the extraction broke nothing).

---

### Task 9: The history window shell

**Files:**
- Create: `src/windows/HistoryWindowShell.tsx`
- Create: `src/windows/historySelection.ts`
- Modify: `src/main.tsx`
- Modify: `src/store/settings.ts` (add `reload`)
- Modify: `src/store/themes.ts` (add `reload`)
- Test: `src/windows/historySelection.test.ts`

**Interfaces:**
- Consumes: `api.historyWindowContext` + `HistoryWindowContext` (Task 3),
  `onGlobalSettingsChanged` (Task 5), `useFileHistoryQuery` /
  `FileHistoryList` / `restoreFileAtRevision` / `FILE_HISTORY_PAGE_SIZE`
  (Task 7), `CommitFileDiff` (Task 8), `useRepoChangeListener`,
  `revealAndSignal`, `ConfirmDialogHost`, `Toasts`, `ErrorBoundary`.
- Produces: `HistoryWindowShell` (mounted by `main.tsx`),
  `nextSelection(entries: FileHistoryEntry[], current: FileHistoryEntry | null): FileHistoryEntry | null`.

- [ ] **Step 1: Write the failing selection tests**
  (`historySelection.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { nextSelection } from "./historySelection";
import type { FileHistoryEntry } from "../lib/types";

const e = (sha: string, path = "a.ts"): FileHistoryEntry => ({
  commit_id: sha, path, old_path: null, author: "x", summary: sha, timestamp: 1,
});

describe("nextSelection", () => {
  it("selects the first entry initially", () => {
    expect(nextSelection([e("a"), e("b")], null)?.commit_id).toBe("a");
  });
  it("keeps the current entry while it still exists", () => {
    expect(nextSelection([e("a"), e("b")], e("b"))?.commit_id).toBe("b");
  });
  it("falls back to the newest entry when the current one vanished", () => {
    expect(nextSelection([e("c"), e("a")], e("b"))?.commit_id).toBe("c");
  });
  it("returns null for an empty history", () => {
    expect(nextSelection([], e("a"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** (vitest interop, path
  `src/windows/historySelection.test.ts`). Expected: FAIL.

- [ ] **Step 3: Implement `historySelection.ts`:**

```ts
import type { FileHistoryEntry } from "../lib/types";

/** Which history entry the window shows after a (re)load: the current one
 *  while it still exists (matched by sha + path, both shift on rewrites),
 *  else the newest. */
export function nextSelection(
  entries: FileHistoryEntry[],
  current: FileHistoryEntry | null,
): FileHistoryEntry | null {
  if (entries.length === 0) return null;
  if (current) {
    const still = entries.find(
      (x) => x.commit_id === current.commit_id && x.path === current.path,
    );
    if (still) return still;
  }
  return entries[0];
}
```

Run the test -> PASS.

- [ ] **Step 4: Store reloads.** In `store/settings.ts` add
  `reload: () => Promise<void>` doing exactly what `init` does but without
  the `if (get().settings) return;` guard (fetch, `applyUiFontSize`,
  `applyPanelChrome`, `set`). In `store/themes.ts` add a `reload` the same
  way (read `init` at ~line 81 first; same body, no early-return). One-line
  doc comment each: "Refetch and re-apply; for secondary windows reacting to
  the settings-changed broadcast."

- [ ] **Step 5: Entry branch.** In `main.tsx`:

```tsx
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HistoryWindowShell } from "./windows/HistoryWindowShell";

// A history window boots the same bundle; the label decides which root
// mounts (outside Tauri, e.g. vitest, there is no label - always main).
function isHistoryWindow(): boolean {
  try {
    return getCurrentWindow().label.startsWith("fh-");
  } catch {
    return false;
  }
}
```

and in the render swap `<App />` for
`{isHistoryWindow() ? <HistoryWindowShell /> : <App />}`. Everything else in
`main.tsx` (context-menu suppression, focus tracking, crash logging, the
shared `QueryClient`) stays and now serves both windows.

- [ ] **Step 6: Implement the shell.** `HistoryWindowShell.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Orientation, SplitviewReact, type SplitviewReadyEvent } from "dockview-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/commands";
import type { FileHistoryEntry, HistoryWindowContext } from "../lib/types";
import { formatAppError } from "../lib/errors";
import { onGlobalSettingsChanged } from "../lib/events";
import { useRepoChangeListener } from "../lib/useRepoChangeListener";
import { revealAndSignal } from "../lib/windowReveal";
import { useSettingsStore, UI_FONT_SIZE_DEFAULT } from "../store/settings";
import { useThemeStore } from "../store/themes";
import { useConfirmDestructive } from "../store/settings";
import {
  FileHistoryList, FILE_HISTORY_PAGE_SIZE, restoreFileAtRevision, useFileHistoryQuery,
} from "../panels/FileHistory/FileHistoryList";
import { CommitFileDiff } from "../panels/Diff/CommitFileDiff";
import { nextSelection } from "./historySelection";
import { ErrorBoundary } from "../panels/ErrorBoundary";
import { ConfirmDialogHost } from "../panels/ConfirmDialogHost";
import { Toasts } from "../panels/Toasts";
```

Shell responsibilities (write them in this order):

1. Boot effect: `await useSettingsStore.getState().init();`
   `await useThemeStore.getState().init();` then (in a `finally`) the
   double-rAF + `revealAndSignal(getCurrentWindow())` sequence from
   `App.tsx` (copy the small helper, catch and `console.warn` on failure);
   then `setCtx(await api.historyWindowContext())`; a failure sets an error
   string rendered as the whole window's content (message text, `legit-panel`
   styling, never a blank page).
2. `useRepoChangeListener();` at the top of the component (watcher freshness).
3. Settings-broadcast effect: subscribe `onGlobalSettingsChanged`, handler
   calls `useSettingsStore.getState().reload()` and
   `useThemeStore.getState().reload()`; unsubscribe on unmount with the
   disposed-flag pattern used in `useRepoChangeListener`.
4. State: `pageCount` (`useState(1)`), `selected`
   (`useState<FileHistoryEntry | null>(null)`);
   `const q = useFileHistoryQuery(ctx?.repo_id, ctx?.path ?? null, ctx?.rev ?? null, pageCount);`
   and a selection-sync effect:

```tsx
  const entries = q.data ?? [];
  useEffect(() => {
    setSelected((cur) => nextSelection(entries, cur));
  }, [entries]);
```

5. The window row menu (reduced; disjointed by design, so no cross-window
   jumps):

```tsx
  const renderMenu = useCallback((entry: FileHistoryEntry, closeMenu: () => void) => (
    <>
      <MenuItem onClick={() => { void navigator.clipboard.writeText(entry.commit_id); closeMenu(); }}>
        Copy commit SHA
      </MenuItem>
      <MenuItem onClick={() => { void navigator.clipboard.writeText(entry.path); closeMenu(); }}>
        Copy path
      </MenuItem>
      <MenuItem onClick={() => { void api.repoOpenFileInEditor(ctx!.repo_id, entry.path).catch((e) => notify.error(formatAppError(e))); closeMenu(); }}>
        Open in external editor
      </MenuItem>
      <Separator />
      <MenuItem onClick={() =>
        destructiveMenuConfirm(`Restore ${entry.path} to its content at ${entry.commit_id.slice(0, 8)}?`, () => {
          closeMenu();
          void restoreFileAtRevision(queryClient, ctx!.repo_id, entry);
        })
      }>
        {confirmDestructive ? "Restore file to this commit…" : "Restore file to this commit"}
      </MenuItem>
    </>
  ), [ctx, queryClient, confirmDestructive, destructiveMenuConfirm]);
```

(`MenuItem`/`Separator` from `panels/shared/menu/primitives`,
`useDestructiveMenuConfirm` from `panels/shared/menu/PanelContextMenu`; check
`repoOpenFileInEditor`'s exact name/signature in `bindings.ts` and adapt.)

6. Layout: a React context `HistoryWindowState` carrying
   `{ ctx, q, pageCount, setPageCount, selected, setSelected, renderMenu }`
   provided ABOVE the splitview (dockview-react portals keep React context,
   proven by dock panels using the root `QueryClientProvider`), then:

```tsx
  const base = useSettingsStore((s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
  const SPLIT_KEY = "legit.historyWindow.split";
  const onReady = (e: SplitviewReadyEvent) => {
    let restored = false;
    try {
      const saved = localStorage.getItem(SPLIT_KEY);
      if (saved) { e.api.fromJSON(JSON.parse(saved)); restored = true; }
    } catch { /* corrupt snapshot: fall through to defaults */ }
    if (!restored) {
      e.api.addPanel({ id: "list", component: "list", size: Math.round(base * 30), minimumSize: Math.round(base * 14) });
      e.api.addPanel({ id: "diff", component: "diff", minimumSize: Math.round(base * 20) });
    }
    e.api.onDidLayoutChange(() => {
      try { localStorage.setItem(SPLIT_KEY, JSON.stringify(e.api.toJSON())); } catch { /* storage unavailable */ }
    });
  };
  // ...
  <SplitviewReact orientation={Orientation.HORIZONTAL} components={{ list: ListPane, diff: DiffPane }} onReady={onReady} />
```

`ListPane` reads the context and renders `PanelContextMenuProvider` wrapping
`PanelLoadingBar` + `FileHistoryList` with
`maybeMore={entries.length === FILE_HISTORY_PAGE_SIZE * pageCount}`,
`selectedSha={selected?.commit_id ?? null}`, `onActivate={setSelected}`,
`onLoadMore={() => setPageCount((n) => n + 1)}`. `DiffPane` renders
`<CommitFileDiff repoId={ctx.repo_id} entry={selected} />` when selected,
else the "Select a commit" `legit-subtle` placeholder. Mirror `RefsPanel`'s
mount-measurement note if the splitview renders 0-sized on first paint
(remount with a `key` after the container has a size, as `RefsPanel` does).

7. Root render:

```tsx
  return (
    <ErrorBoundary>
      {body /* error state | loading null | provider + splitview */}
      <ConfirmDialogHost />
      <Toasts />
    </ErrorBoundary>
  );
```

Also export `HistoryWindowContext` from `src/lib/types.ts` (re-export the
generated binding type, following the file's existing re-export pattern).

- [ ] **Step 7: Full frontend verification**

Run: `npx tsc --noEmit`, then
`powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run"`
(full suite: layering, theme contract, no-literal-colors, toolbar heights all
apply to the new files).
Expected: PASS.

---

### Task 10: Changelog, full verification, manual pass

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Changelog bullet** under `## [Unreleased]` / `### Added`:

```markdown
- File history can open in its own window (commits left, diff right) via the
  new "Open file history in a separate window" setting
```

- [ ] **Step 2: Full automated verification**

Run all of:
- `cargo test -p legit-app`
- `cargo test -p legit-core`
- `npx tsc --noEmit`
- `powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run"`

Expected: all PASS. Fix regressions before proceeding.

- [ ] **Step 3: Manual pass (needs the running app; Simon runs
  `npm run tauri dev` from PowerShell - note that workspace-crate changes
  need a dev-server restart).** Checklist to hand over:

1. Enable the setting; "File history" from a file's context menu opens a
   titled window, first commit selected, diff visible.
2. Same file again focuses the existing window; a different file opens a
   second window; a browse-at-commit history (Files panel at a rev) opens
   its own window titled "from <rev>".
3. Row clicks update the diff; Inline/Split and Chunks/Full work; rename
   entries show a real diff.
4. "Restore file to this commit" confirms inside the window (near the
   pointer) and toasts inside the window.
5. Committing in the main window refreshes the popup's list; selection
   survives; after an amend the selection moves to the new tip.
6. Closing the repo tab closes its history windows; closing the main window
   closes everything and the process exits.
7. Resize the window, close it, reopen: the size is remembered.
8. Switch theme and UI font size in the main window: the popup follows.
9. Disable the setting: summons dock again; an open popup keeps working.
10. Splitview divider drags, ratio survives reopening; check the divider is
    themed (extend the `--dv-*` mapping block in `global.css` if a new
    unthemed dockview surface shows).

Record the outcome; anything broken goes back to its owning task.
