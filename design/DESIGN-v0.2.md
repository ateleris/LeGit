# LeGit v0.2 — Foundation Hardening

> Addendum to the main design document. This is not the v1 work. v0.2 is a
> closed-dogfooding release whose job is to fix what v0.1 surfaced before any
> v1 panel work begins.

---

## A. Purpose and Framing

v0.1 validated that the one-path architecture, multi-repo session model,
panel shell, and theme system all hold together end-to-end. v0.1 also
surfaced a structural gap the original design did not name explicitly:

**LeGit has no first-class concept of *scope*.** There is "the app" and
there is "a repo session," but the boundary between them is implicit. State,
settings, UI containers, and panels each pick a side ad-hoc rather than
declaring one. This worked for v0.1's three panels and one settings field.
It will not work for v1, where settings, layouts, signing preferences,
Console history, and repo metadata all need a defined home.

**v0.2's job is to introduce scope as a first-class architectural concern**
— in the data model, in the settings system, and in the UI hierarchy — and
to prove the new model works end-to-end by migrating existing v0.1 state
into it and shipping one real per-repo setting on top.

v0.2 is **explicitly not** v1. No Status panel, no Branches panel, no Log
panel, no Diff panel, no commit graph. The discipline from §8 holds:
proving the foundation comes before building on it. v0.2 just expands what
"the foundation" means based on what v0.1 taught us.

---

## B. The Scope Concept

### B.1 Three Scopes, Mirroring `git config`

LeGit adopts the same scope taxonomy as `git config`: **system, global,
repo**. The mapping is intentional — users already understand it, and most
LeGit settings ultimately correspond to or compose with a Git config value
at the same scope.

| Scope    | Lifetime                          | Lives in                                       | Examples (current and near-future)                              |
| -------- | --------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| System   | The machine                       | OS-managed (read-only from LeGit's view)       | System `git` install location, OS theme preference              |
| Global   | The user, across all repos        | Tauri app data dir                             | Active theme, recent repos, default Git binary path, dock layout |
| Repo     | A specific repo, for this user    | App data dir, keyed on the repo's canonicalized absolute path (see B.5) | Per-repo Git binary override, per-repo Console history, future per-repo panel layout |

LeGit does **not** introduce a fourth "per-repo-per-user" scope distinct
from repo scope. Git itself doesn't, and the distinction is more confusing
than useful at LeGit's scale. Repo-scope settings are always "this repo,
this user's LeGit install on this machine." Sharing them across users is
out of scope for v0.2 (and likely all of v1 — see §J).

### B.2 What "Scope" Means in Code

A piece of state has exactly one scope. The scope determines:

- **Where it persists.** Global → app data dir, in a single
  `global-settings.json`. Repo → app data dir, in a per-repo subdirectory
  keyed on the canonicalized absolute path (see B.5).
- **Who can read and write it.** Global state is accessible without a
  `RepoId`. Repo state requires a `RepoId` and is loaded into the
  `RepoSession` when the repo is opened.
- **When it's invalidated.** Global state lives for the app lifetime. Repo
  state lives for the session and is flushed on repo close.
- **Where it appears in the UI.** Global settings, global panels, global
  theme editing live in app-level UI. Repo settings, repo-scoped panel
  state, and repo-specific overrides live in repo-level UI.

Scope is **declared at the type level**, not inferred. Every settings
struct, every persisted blob, and every Tauri command annotates which
scope(s) it operates on.

### B.3 Settings Resolution

When a setting exists at multiple scopes (e.g., Git binary path), repo
beats global beats system, exactly as `git config` resolves. The resolution
is performed by a small `Settings` layer, not duplicated in every command.

```rust
pub trait ScopedSetting {
    type Value;
    fn resolve(&self, ctx: &ResolutionContext) -> Self::Value;
}

pub struct ResolutionContext<'a> {
    pub global: &'a GlobalSettings,
    pub repo: Option<&'a RepoSettings>,   // None for global-only ops
    pub system: &'a SystemInfo,
}
```

The resolved value is what `GitRunner` and panels see. The fact that it
came from a particular scope is metadata the Settings UI surfaces ("This
value is overridden at the repo scope") but business logic doesn't branch on.

### B.4 No Hidden Scope Coupling

The rule from §3.4 ("panels are wrappers, only over Git") gets a companion:

**Panels declare the scope they operate in.** A panel is either global,
repo-scoped, or composite (renders different things at different scopes).
The panel's declared scope determines where it can live in the UI
hierarchy (see §C) and what data it's allowed to read.

A global panel that secretly reads from the active `RepoSession` is the
same kind of architectural mistake as a panel that spawns `git` directly:
it works until it doesn't, and the failure mode is silent.

### B.5 Where Repo-Scope State Lives on Disk

Repo-scope state lives in **LeGit's app data directory**, alongside
global settings — not inside the repo's working tree. This follows the
convention of most desktop applications: settings the application
maintains about a workspace are stored by the application, not deposited
into the workspace itself.

```
<app-data-dir>/
  global-settings.json
  themes/*.legit-theme.json
  repos/
    <hash-of-absolute-path>/
      settings.json
      console-history.json
      ...
```

The trade-off (compared to the obvious alternative of `.legit/` inside
each repo):

| Concern                              | App-data location (chosen)                                | In-repo `.legit/` (rejected)                          |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------ |
| Pollutes the working tree            | No                                                        | Yes (and forces a `.gitignore` decision)               |
| Read-only repos                      | Works identically                                         | Needs an out-of-tree fallback (the same one anyway)    |
| Bare repos and submodules            | Works identically                                         | Submodules each get their own dir; bare needs fallback |
| Survives `git clean -fdx`            | Yes                                                       | No                                                     |
| Survives `rm -rf` and re-clone       | Yes                                                       | No                                                     |
| Survives moving the repo on disk     | No — settings keyed on path (see below)                   | Yes                                                    |
| Shareable across machines / teams    | No (not in v0.2; see §J)                                  | Yes if committed (but with privacy concerns)           |

The "moving the repo breaks settings" downside is real but small for
v0.2's actual repo-scope content (Git binary override, Console history) —
none of which is catastrophic to lose if the user moves a repo and
re-adds it. If repo-scope state grows to include things that *would* be
painful to lose on move, the right answer is a "rediscover by recent
path" UX, not changing the storage location.

**Repo identity.** Each repo gets a directory named by a hash of its
canonicalized absolute path. Canonicalization:

- Resolve symlinks (so the same repo accessed via different symlinked
  paths shares one entry).
- Lowercase on case-insensitive filesystems (Windows, macOS default).
- No trailing slash.
- Use SHA-256 of the canonicalized path, truncated to 16 hex characters,
  for the directory name. (Plenty of collision resistance for any realistic
  number of repos; short enough to be readable.)

A `repos/<hash>/path.txt` file inside each directory records the
canonical path that produced the hash. This makes the directory
contents inspectable ("which repo is this?") and lets LeGit detect a
moved repo when it's reopened from a different path.

**Created lazily.** `repos/<hash>/` is created on the first repo-scope
write, not on repo open. Repos with all-default settings produce no
disk footprint.

**Bare repos and submodules** work identically to regular repos under
this scheme — they each get their own `repos/<hash>/` entry keyed on
their on-disk path.

---

## C. UI Hierarchy

### C.1 The Problem v0.1 Surfaced

The v0.1 UI looks roughly like this:

```
+-----------------------------------------------------------+
| [Tab: repo A] [Tab: repo B] [+]                           |  <- repo selector (per-repo scope)
+-----------------------------------------------------------+
| +---------------+ +-----------------------------------+   |
| | Repositories  | | Git Console                       |   |  <- dock layout
| |               | |                                   |   |
| | (lists ALL    | | (runs against active repo)        |   |
| |  repos)       | |                                   |   |
| +---------------+ +-----------------------------------+   |
| | Theme Editor  |                                         |
| | (global!)     |                                         |
| +---------------+                                         |
+-----------------------------------------------------------+
```

The visual hierarchy says "everything below the tab strip belongs to the
active repo." The data hierarchy says otherwise: the Repositories panel
manages the set of all repos (which determines what tabs even exist), and
the Theme Editor is fully global. Both are rendered inside a container
that visually implies repo scope.

This isn't a v0.1 bug — v0.1 had three panels and the inconsistency was
livable. It becomes a real problem the moment v1 wants to ship a Status
panel (repo-scoped) and a Global Settings panel (global-scoped) in the
same dock.

### C.2 The v0.2 Hierarchy

v0.2 separates the UI into two layout regions with explicit scope. The
user picks which arrangement they want (top mode is the default):

**Top mode** (global region above repo region; tab strip sits between them):

```
+-----------------------------------------------------------+
| Top bar: [App menu]  [global dock toggle]  [other actions]|
+-----------------------------------------------------------+
| Global region (expanded)                                  |
| +-------------------+ +---------------------------------+ |
| | Repositories      | | Theme Editor                    | |
| +-------------------+ +---------------------------------+ |
+-----------------------------------------------------------+  <- draggable horizontal divider
| Repo tab strip: [Tab: repo A*] [Tab: repo B] [+]          |
+-----------------------------------------------------------+
| Repo region (renders the active repo's dock layout)       |
| +-------------------+ +---------------------------------+ |
| | (repo-scoped      | | Git Console                     | |
| |  panels live      | | (active repo)                   | |
| |  here)            | |                                 | |
| +-------------------+ +---------------------------------+ |
+-----------------------------------------------------------+
```

In top mode the tab strip sits directly above the repo region — the
thing whose content changes when a tab is clicked. This puts cause and
effect adjacent, matching the convention users expect from browser tabs,
IDE editor tabs, and so on. The draggable divider between regions sits
above the tab strip; dragging it resizes the global region, and the tab
strip moves with the repo region.

**Left mode** (global region to the left of repo region; tab strip at
window top above both):

```
+-----------------------------------------------------------+
| Top bar: [App menu]  [global dock toggle]  [other actions]|
| Repo tab strip: [Tab: repo A*] [Tab: repo B] [+]          |
+--------------------+|+------------------------------------+
| Global region      |||  Repo region                       |
| +----------------+ |||  +------------------------------+  |
| | Repositories   | |||  | Git Console                  |  |
| +----------------+ |||  | (active repo)                |  |
| +----------------+ |||  |                              |  |
| | Theme Editor   | |||  +------------------------------+  |
| +----------------+ |||                                    |
|                    |||                                    |
+--------------------+|+------------------------------------+
                      ^
                  draggable vertical divider
```

In left mode the tab strip stays at the window top spanning the full
width. There's no usable horizontal space between the two regions for a
horizontal tab strip, and a vertical tab strip is unconventional and
hard to scan. The trade-off: in left mode, cause and effect are not as
directly adjacent as in top mode, but the tab strip remains in a
predictable location across mode switches.

Concretely:

- The **top bar** sits at the top of the window in both modes.
- The **tab strip** is mode-dependent: between regions in top mode,
  pinned to the window top below the top bar in left mode. Its scope is
  global in both cases (it changes which repo is active).
- The **global region** owns the global dock (Repositories, Theme Editor,
  Settings, future global panels) and global modals. Its content does not
  change when the user switches tabs.
- The **repo region** owns the repo dock, which contains only repo-scoped
  panels. Switching tabs swaps the entire repo region for that repo's view.
- The **Repositories panel and the Theme Editor move out of the repo
  dock** and become global panels. They are still panels — show/hide,
  dock among themselves, float, persist their layout — but they live in
  the global region's own (separate) dock layout, not the repo region's.

This gives v0.2 two dock layouts where v0.1 had one:

| Layout            | Scope   | Contents (after v0.2)                        |
| ----------------- | ------- | -------------------------------------------- |
| Global layout     | Global  | Repositories, Theme Editor, Settings         |
| Repo layout       | Repo    | Git Console (only repo panel in v0.2)        |

Both are `dockview` instances. Both persist. The repo layout is currently
shared across all repos (matching the §5.1 "global layout" decision); see
C.4.

**Behavior of the split between the two regions:**

- **Placement is user-configurable: top or left.** A global setting
  controls whether the global region sits above the repo region or to its
  left. Top is the default. This is a layout preference (widescreens
  favor left; portrait monitors and laptops favor top) and does *not*
  affect scope hierarchy — in both modes the global region comes first
  in reading order (top-to-bottom or left-to-right). The tab strip
  position is mode-dependent (between the regions in top mode, at the
  window top in left mode) — see §C.5. The alternative ordering (repo
  region before global region) is not offered, for the reason in the
  next bullet.
- **Resizable, not reorderable.** The divider between the global region
  and the repo region can be dragged: vertically in top mode, horizontally
  in left mode. Their relative order within the chosen mode is fixed —
  letting the user put the repo region before the global region would
  put scope hierarchy back into question, which is the whole problem §C
  is solving.
- **Divider position is remembered per mode.** Switching from top to
  left and back restores the previous divider position for each mode
  rather than resetting it.
- **The global region's dock is collapsible.** Independent of the tab
  strip (which is always visible because it controls active state), the
  global dock area can be collapsed to zero size on its owning axis via
  a toggle in the top bar. Most users will work with it collapsed most
  of the time — Repositories, Theme Editor, and Settings aren't panels
  you stare at while coding; you open them on demand. Expanding the
  global dock pulls it back to its last-used size.
- **Global panels can float**, like any `dockview` panel. A user who
  wants Theme Editor visible alongside their repo work just floats it.
  Floating panels carry their own scope and can read global state
  regardless of which region they originated from.
- **The repo region cannot be collapsed.** It's the working surface;
  hiding it would leave the app with nothing useful displayed.

The placement mode, divider positions (one per mode), and collapsed state
all persist as global-scope settings.

### C.3 Where Each v0.1 Panel Ends Up

| Panel         | v0.1 location              | v0.2 location            | Reason                                                                                                  |
| ------------- | -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| Repositories  | Repo dock                  | Global region            | Manages the set of all repos. Doesn't depend on an active repo — actually decides what the active repo *is*. |
| Theme Editor  | Repo dock                  | Global region            | Theme is a global concern by design (§6.7). The v0.1 placement was incidental.                          |
| Git Console   | Repo dock                  | Repo dock (unchanged)    | Operates against the active repo. Repo-scoped both architecturally and visually.                        |

### C.4 Per-Repo Repo-Layout: Deferred

The original §5.1 decision was "global layout for the whole app." v0.2 does
**not** revisit that — the repo layout remains shared across all repos for
now. Splitting it into per-repo layouts is a natural follow-on once the
scope architecture is in place (it becomes a repo-scope piece of state
rather than a global one), but doing it in v0.2 mixes architectural change
with a UX shift. v0.2 keeps the shift small: introduce two layouts (global
vs. repo), keep the repo layout shared.

### C.5 Where the Repo Tab Strip Lives

The tab strip's scope is always global — it controls which repo is
active, and that's a global piece of state. But its *visual* position
depends on the placement mode:

- **Top mode:** the tab strip sits between the global region and the
  repo region, directly above the repo region. This puts cause and
  effect adjacent — clicking a tab visibly changes what's underneath it,
  matching the convention of browser tabs and IDE editor tabs.
- **Left mode:** the tab strip sits at the window top, below the top bar,
  spanning the full width above both regions. There's no usable
  horizontal slice between the regions for a horizontal tab strip in
  left mode, and a vertical tab strip would be unconventional and harder
  to scan.

This is a deliberate mode-dependent choice rather than a single rule
applied everywhere: each mode places the tab strip where it serves the
user best within that mode. The trade-off is that switching modes also
shifts the tab strip's position; the persisted divider state per mode
(§C.2) means most users will pick a mode and stay there, so the shift
happens rarely.

---

## D. Backend Changes

### D.1 RepoSession Gains Repo-Scoped Settings

```rust
pub struct RepoSession {
    pub id: RepoId,
    pub path: PathBuf,
    pub runner: Arc<GitRunner>,
    pub backend: Arc<dyn GitBackend>,
    pub opened_at: SystemTime,

    // New in v0.2:
    pub settings: Arc<RwLock<RepoSettings>>,
    pub settings_path: PathBuf,        // points to <app-data>/repos/<hash>/settings.json
}
```

`RepoSettings` is loaded on `open_repo`, written through on every change,
and dropped on `close_repo`. The runner is constructed using the resolved
Git binary path (which is now a per-scope setting — see E).

### D.2 AppState Gains GlobalSettings

```rust
pub struct AppState {
    pub repos: RwLock<HashMap<RepoId, Arc<RepoSession>>>,
    pub global_settings: Arc<RwLock<GlobalSettings>>,   // new
    pub system_info: Arc<SystemInfo>,                    // new (read-only at startup)
}
```

`GlobalSettings` absorbs everything that was previously persisted ad-hoc
in v0.1: active theme, recent repos, Git binary path (now as a *default*,
overridable per-repo), dock layout for the global region, dock layout for
the repo region. See §G for the on-disk layout.

### D.3 Tauri Command Surface Declares Scope

Every command's first argument continues to identify scope:

- **Global commands** take no `repo_id`. Examples: `list_repos`,
  `set_active_theme`, `update_global_settings`.
- **Repo commands** take `repo_id` as their first argument (unchanged from
  v0.1). They are now guaranteed to have a loaded `RepoSession` with
  `RepoSettings` available.
- **No command may "find the repo from somewhere."** If a command operates
  on a repo, the repo id is in the signature.

Scope is part of the command's name in `tracing` logs (`global.<name>`
vs. `repo.<name>`) for ease of grepping bug reports.

### D.4 Settings Schema and Validation

`GlobalSettings` and `RepoSettings` are typed structs with `Serialize +
Deserialize`. Both have format-versioned JSON files (same approach as the
theme format: top-level `format` and `formatVersion` fields, future-proof
unknown-field handling).

Validation rules mirror the theme rules (§6.5):

| Condition                                  | Behavior                          |
| ------------------------------------------ | --------------------------------- |
| Invalid JSON                               | Log warning, fall back to defaults |
| Missing `format` field                     | Treat as v0.1 migration candidate (see G) |
| `formatVersion` newer than known           | Warn, attempt load, preserve unknowns |
| Field missing                              | Fill from default                 |
| Unknown field                              | Preserve silently for round-trip  |
| Malformed value                            | Log warning, replace with default for that field |

Settings files are pretty-printed with stable key order for clean diffing
if users version-control them.

---

## E. The Proving Feature: Per-Repo Git Binary Override

v0.2 ships one real repo-scoped setting end-to-end: a per-repo override
of the Git binary path. This was chosen because:

- It's small and well-scoped.
- It exercises every layer: settings UI (global default + repo override),
  scoped resolution (`resolve`), `GitRunner` construction (which already
  takes a configurable path per §7.6), and the Settings panel.
- It has a real user motivation: the v0.1 design called out "Sourcetree's
  long history of 'found the wrong git'" issues — letting a power user
  point one specific repo at a different `git` is a legitimate niche need
  (e.g., a repo that requires a specific Git version, or a WSL repo on
  Windows that should use the Linux `git`).
- It's safe to misconfigure: the worst case is "this repo's `git` calls
  fail" and the fix is a single setting.

The flow:

1. **Global Settings panel** has a "Git executable" field (already in v0.1).
   This becomes the *default* Git binary path.
2. **Repo Settings panel** (new in v0.2) has a "Git executable" field
   labeled "Override for this repo" with an "Inherit from global" default.
3. When the repo is opened, `RepoSession::runner` is constructed with the
   resolved path (repo override → global default → system default).
4. Changing the repo override **rebuilds the `RepoSession`'s runner**,
   then runs `git --version` against the new binary to confirm it works,
   showing the same error UI as the startup check if it doesn't.
5. The Git Console picks up the new runner immediately because it always
   asks the session for the current runner — it doesn't cache it.

### Why this specific feature is the validation

If this works correctly, it's hard to construct a future per-repo setting
that *wouldn't* work the same way. The settings struct gains a field, the
UI gains a control, the resolution function picks the right value, and
the consumer (here, the runner constructor) takes the resolved value with
no knowledge of which scope it came from. Every future per-repo setting
follows this same shape.

---

## F. Frontend Changes

### F.1 Two Layouts Instead of One

`dockview` is instantiated twice. The global layout is mounted in the top
region; the repo layout in the bottom region. Each has its own panel
registry — global panels can't be added to the repo dock and vice versa.

This is enforced at the panel-registration level: panels declare their
scope in their registration metadata, and the corresponding dock instance
only accepts matching panels.

### F.2 Repo State Store Gains Settings Awareness

The existing `RepoState` Zustand store (§5.2) gains a way for repo panels
to read repo-scoped settings without re-fetching:

```ts
interface RepoState {
  openRepos: RepoSummary[];
  activeRepoId: RepoId | null;
  openRepo: (path: string) => Promise<void>;
  closeRepo: (id: RepoId) => Promise<void>;
  setActive: (id: RepoId) => void;

  // New in v0.2:
  repoSettings: Record<RepoId, RepoSettings>;
  updateRepoSetting: <K extends keyof RepoSettings>(
    id: RepoId, key: K, value: RepoSettings[K]
  ) => Promise<void>;
}
```

Global settings live in a separate `GlobalSettingsState` store. Panels
that need both pull from both — the stores don't try to present a unified
view.

### F.3 TanStack Query Keys Already Include RepoId

This is unchanged from v0.1 (§5.3) and is exactly why the scope change is
small on the query layer: switching tabs already invalidates repo-scoped
queries correctly. The Settings refactor doesn't disturb this.

### F.4 The Theme Editor Becomes a Global Panel

Mechanically: change its registration scope to `global`, move its
mount-point to the global dock. No internal changes — the editor was
already global in its data model (§6.7).

### F.5 The Repositories Panel Becomes a Global Panel

Same change as Theme Editor. Its function was always global; only its
location was wrong.

### F.6 Two Settings Panels, Scope-Obvious by Design

LeGit ships two separate Settings panels rather than one panel with
internal scope tabs:

- **Global Settings panel** — lives in the global region. Edits
  global-scope settings: active theme, default Git binary path, default
  line-ending values in `~/.gitconfig`, etc.
- **Repo Settings panel** — lives in the repo region. Edits repo-scope
  settings for the active repo: Git binary override, line-ending values
  in `.git/config`, future per-repo preferences.

Two panels rather than one tabbed panel for a simple reason: **the
panels are in different scope-regions of the UI, and that placement
itself communicates scope.** A user looking at the Repo Settings panel
can see it's docked in the repo region, can see the active repo's name
in the tab strip directly affecting it, and can reason that what they're
editing applies to that repo. A single panel with internal tabs would
have to communicate the same information twice — once visually (current
tab) and once verbally (panel header) — and the visual cue would be
weaker because the panel itself isn't placed differently for different
scopes.

To make scope unambiguous within each panel:

- **Each panel's title states the scope and the scope target.** Global
  Settings panel title: "Global Settings (this LeGit install)." Repo
  Settings panel title: "Repo Settings — `<repo-name>` (`<repo-path>`)".
  Both titles update live; the Repo Settings title changes when the
  active tab changes.
- **Every editable value shows its scope-of-effect on hover or in the
  field label.** A `core.autocrlf` control in the Repo Settings panel
  shows "writes to: `.git/config`"; the same control in the Global
  Settings panel shows "writes to: `~/.gitconfig`."
- **Confirmation dialogs name the file being written.** The line-endings
  confirmations in §H.4 already follow this rule; it generalizes to every
  scoped write LeGit makes.
- **The Repo Settings panel is hidden when no repo is active.** No
  ambiguous "Repo Settings (no repo selected)" state — if there's no
  repo, there's nothing to configure repo-scope, and the panel isn't
  available. (Showing it disabled was considered and rejected; an absent
  panel is clearer than a greyed-out one.)

Tabbed sub-sections within a single panel are fine for organizing
many settings at one scope (Line Endings, Git Binary, etc.) — that's
within-scope navigation, not between-scope. The point is that the
*scope* of what you're editing should never be ambiguous, and the
panel-per-scope split is what makes that automatic rather than
something the UI has to remember to communicate.

---

## G. Persistence Layout

v0.1 persisted state in a flat layout under Tauri's app data dir. v0.2
moves to a scoped layout. LeGit is in pre-release development with no
external users, so v0.1 files are replaced rather than migrated.

```
v0.1 (replaced):                   v0.2:
app-data/                          app-data/
  recent-repos.json                  global-settings.json
  layout.json                        themes/*.legit-theme.json
  themes/*.legit-theme.json          repos/<hash>/settings.json
  active-theme.json                  repos/<hash>/path.txt
                                     repos/<hash>/console-history.json
                                     ...
```

`global-settings.json` absorbs `recent-repos.json`, `layout.json`, and
`active-theme.json`. The themes directory keeps its location and format.
The `repos/<hash>/` layout is detailed in §B.5 — repo-scope state always
lives under the app data dir, never in the repo itself.

---

## H. Line Endings

Line endings are a known pain point — for the author and for most users
of cross-platform Git. Most Git GUIs either ignore the problem (silently
inheriting whatever `git config` says, never surfacing it) or get it
subtly wrong (introducing their own parallel "line endings setting" that
diverges from what Git actually does).

LeGit takes a third approach: **the Line Endings settings panel is a
direct editor for the relevant `git config` keys.** There is no
LeGit-specific concept of "line-ending strategy." There is `core.autocrlf`
and `core.eol` at global and repo scope, exactly as Git defines them, and
the panel is friendlier UI for editing those values. This means LeGit's
visible state and Git's actual state are the same thing by construction.

This section specifies that mirror.

### H.1 Why a Mirror, Not a Strategy

An earlier draft of this design introduced a LeGit-side `LineEndingStrategy`
enum (`RespectRepo`, `ForceLf`, …) that the user picked and then "applied"
to `git config`. That model was abandoned because it creates a second
source of truth: LeGit's strategy can be `ForceLf` while `core.autocrlf`
is `true`, and the UI then has to maintain a "divergence" state and an
"apply now" affordance to reconcile them.

The mirror model has no such gap. The Line Endings panel is a view over
`git config`. Editing a control in the panel is editing `git config`
(after confirmation; see §H.4). The user's `~/.gitconfig` and
`.git/config` are the only persistent state. LeGit does not store a
preferred strategy anywhere.

This also benefits power users: someone who already knows
`core.autocrlf=input` doesn't have to learn what LeGit calls that — they
see the key, they see the value, they can edit it.

### H.2 The Authority Hierarchy

```
.gitattributes      (highest authority — repo declares the rule)
       ↓
git config          (LeGit's editing target; what `git` will actually do)
```

**`.gitattributes` is sacrosanct.** If a repo has `.gitattributes` rules
covering line endings (e.g., `* text=auto`, `*.sh text eol=lf`,
`*.bat text eol=crlf`), those rules are authoritative for the files they
match. LeGit does not write `.gitattributes`, does not suggest changes to
it, and disables `core.autocrlf` editing for files covered by it (§H.5).

**`git config` is what LeGit edits.** LeGit reads `core.autocrlf` and
`core.eol` at every scope (`local`, `global`, `system`) and writes via
`git config --local` or `git config --global` depending on which control
the user is editing. System-scope is read-only — LeGit never writes
system Git config (consistent with §J).

### H.3 The Panels

Line Endings appears in two places:

- **Global Settings → Line Endings.** Edits `core.autocrlf` and
  `core.eol` in `~/.gitconfig`.
- **Repo Settings → Line Endings.** Edits the same keys in this repo's
  `.git/config`.

Both panels have the same structure. Each shows:

- **`core.autocrlf`** — radio buttons for `true`, `input`, `false`, plus
  an "Inherit" option (don't set this value at this scope; let it fall
  through to a wider scope's value, or to Git's default).
- **`core.eol`** — radio buttons for `lf`, `crlf`, `native`, plus "Inherit."
- **Current resolved value** — for each key, what `git` will actually use
  at this scope, with the source noted. Example: in the Repo Settings
  panel, "`core.autocrlf` resolved: `input` (from global config)" tells
  the user the repo doesn't override, the value comes from `~/.gitconfig`.

The panels never show a "LeGit strategy" field, because there isn't one.
Users edit the two underlying `git config` keys directly, which is the
whole point of the mirror approach. Higher-level convenience affordances
(presets, one-click "set to recommended cross-platform defaults") are
deliberately not in v0.2 — they would re-introduce the abstraction layer
this design rejects, and the panels are already not complicated enough
to need them.

### H.4 Editing Flow

Both panels follow a Save/Cancel pattern. Radio-button changes are held
in UI state — they don't write `git config` directly on every click. The
user clicks Save, sees a confirmation dialog summarizing the writes, and
the writes happen.

**Repo-scope Save dialog:**

> Save line-ending changes to this repo's `.git/config`?
>
> - `core.autocrlf`: `true` → `input`
> - `core.eol`: unset → `lf`
>
> These writes affect only this repo. Your global Git config and other
> repos are not affected.
>
> \[ Save \]  \[ Cancel \]

**Global-scope Save dialog:**

> ⚠ Save line-ending changes to your global Git config (`~/.gitconfig`)?
>
> - `core.autocrlf`: unset → `input`
> - `core.eol`: unset → `lf`
>
> These changes affect:
>
> - Every Git repository on this machine that doesn't override these
>   values locally.
> - Every tool that reads your global Git config — your terminal `git`,
>   other Git GUIs, CI scripts run locally, IDE integrations.
>
> If you only want this for one repo, cancel and edit that repo's
> settings instead.
>
> \[ Save globally \]  \[ Cancel \]

The dialog always shows **before → after** values, so the user sees what
changes (and importantly, sees if they're overwriting an existing value
versus setting one for the first time). Unchanged keys are not listed.

The global dialog carries a warning icon and an explicit blast-radius
enumeration. Repo dialogs are calmer because the blast radius is one
repo. Both require confirmation; only the framing differs.

**"Inherit" maps to `git config --unset`.** Switching a key from a
concrete value to "Inherit" calls `git config --local --unset` or
`git config --global --unset`. The Save dialog phrases this as
`true → unset` rather than hiding what's happening.

**No "apply later" affordance.** There's nothing to save without
applying — the panel *is* the editor, and Save *is* the write. The
in-flight radio-button state is just UI; closing the panel without
saving discards it (with a "discard unsaved changes?" prompt if any
changes are pending).

### H.5 What `.gitattributes` Does to the UI

When the user opens a repo's Line Endings panel:

1. **LeGit reads `.gitattributes` from the working tree** and any parent
   directories (Git's normal lookup), parsing entries that affect line
   endings (`text`, `text=auto`, `text eol=lf`, `text eol=crlf`, `binary`,
   `-text`).

2. **If `.gitattributes` declares a global rule** (`* text=auto` or
   similar that covers all files), the `core.autocrlf` and `core.eol`
   controls are **disabled** with the note: "This repo's `.gitattributes`
   declares line-ending rules that cover all files. `core.autocrlf` and
   `core.eol` have no effect for matching files. The `.gitattributes`
   rules are shown below." The current `git config` values are still
   displayed (read-only) for completeness.

3. **If `.gitattributes` declares partial rules**, the controls remain
   **enabled** with the note: "This repo's `.gitattributes` covers some
   files (see below); `core.autocrlf` and `core.eol` apply to the rest."

4. **If `.gitattributes` doesn't exist or doesn't mention line endings**,
   the controls are fully enabled.

`.gitattributes` is displayed read-only. v0.2 does not include an editor
for it — users edit `.gitattributes` as a normal file. (A proper editor
is a v1+ candidate.)

The Global Settings panel is **not** affected by `.gitattributes` —
global Git config applies to every repo on the machine, and any one
repo's `.gitattributes` doesn't override the user's intent for the global
default.

### H.6 Mixed-Ending Detection

Independent of `core.autocrlf`, LeGit can scan the working tree for files
with mixed CRLF/LF line endings and surface them. This is an
*observability* feature — it shows the user what's actually in their
files — and lives in the Repo Settings panel as a "Detected mixed-ending
files" section.

**The scan runs on demand only.** Specifically, when the user opens the
Repo Settings panel (and `warn_on_mixed_endings` is on), LeGit kicks off
the scan; results populate progressively. The scan does *not* run on repo
open, in the background, or proactively before commits. Eager scanning
would add startup cost on large repos for a feature most users won't look
at on most opens; on-demand makes the cost visible only when the user is
already in the relevant UI.

A separate toggle controls whether the scan runs at all:

- **`warn_on_mixed_endings`** — boolean LeGit setting (scoped: global
  default, repo override). Defaults to **on** at global scope. When off,
  the "Detected mixed-ending files" section is hidden and no scan runs
  even on panel open. This is a LeGit-side preference about LeGit
  behavior, not a `git config` value, so it persists in
  `global-settings.json` (global) or `repos/<hash>/settings.json` (repo
  override), per §B.5.

Implementation notes:

- **Read through `GitRunner`** using `git ls-files` to enumerate tracked
  files; LeGit reads file contents directly and counts CRLF vs. bare LF.
  No `git` subcommand surfaces this directly.
- **Respect `.gitignore` and binary detection** — don't warn about
  intentionally-binary files or ignored files.
- **Cache results within the session** per file by content hash; subsequent
  panel opens reuse the cache and recheck only files whose content changed.

Per-file normalization actions ("normalize this file to LF") and any
"normalize all" button are out of scope for v0.2 (see §J). When such a
button is added later, that's the right time to revisit whether the scan
should also run eagerly — a button that operates on the scan's output is
useful only if the scan has run.

### H.7 Repo State Display

The Repo Settings → Line Endings panel shows, at a glance:

- **`core.autocrlf` and `core.eol` controls** for the repo scope (§H.3).
- **Resolved values** with their source scope (`local`, `global`,
  `system`, or "unset").
- **`.gitattributes` rules** affecting line endings, if any (§H.5).
- **Detected mixed-ending files**, if `warn_on_mixed_endings` is on
  (§H.6).

A user should never have to leave LeGit and run `git check-attr` or
`git config --get core.autocrlf` to find out what will happen to their
line endings.

### H.8 Backend Surface

```rust
/// A single config value with its source scope.
#[derive(Serialize, Deserialize, Clone)]
pub struct ConfigValue {
    pub value: Option<String>,            // None means unset
    pub source: ConfigScope,              // Local, Global, System, or Unset
}

#[derive(Serialize, Deserialize, Clone, Copy)]
pub enum ConfigScope { Local, Global, System, Unset }

#[derive(Serialize, Deserialize)]
pub struct LineEndingsView {
    pub autocrlf_local: ConfigValue,      // from `git config --local`
    pub autocrlf_global: ConfigValue,     // from `git config --global`
    pub autocrlf_system: ConfigValue,     // from `git config --system`
    pub autocrlf_resolved: ConfigValue,   // what `git` will actually use
    pub eol_local: ConfigValue,
    pub eol_global: ConfigValue,
    pub eol_system: ConfigValue,
    pub eol_resolved: ConfigValue,

    pub gitattributes: Vec<GitAttrRule>,
    pub gitattributes_covers_all: bool,

    pub mixed_ending_files: Vec<PathBuf>,
}

// Tauri commands:
// Repo-scoped read of all the info above:
fn repo_line_endings_view(repo_id: RepoId) -> Result<LineEndingsView, AppError>;

// Global-scoped read (no repo_id; reads ~/.gitconfig and system, no .gitattributes):
fn global_line_endings_view() -> Result<LineEndingsView, AppError>;

// Writes. Each takes Option<String> — Some("input") to set, None to unset.
fn repo_write_line_endings(
    repo_id: RepoId,
    autocrlf: Option<String>,
    eol: Option<String>,
) -> Result<LineEndingsView, AppError>;

fn global_write_line_endings(
    autocrlf: Option<String>,
    eol: Option<String>,
) -> Result<LineEndingsView, AppError>;
```

All reads and writes go through `GitRunner` invoking
`git config --local|--global --get|--unset|set`. There is no separate
config path, no parallel state, and no LeGit-side persistence of
line-ending preferences. The write commands return the new
`LineEndingsView` so the UI can refresh from the source of truth rather
than assuming success.

### H.9 Watching for External Changes

`git config` and `.gitattributes` can both change outside LeGit — the
user edits `~/.gitconfig` in their dotfiles, a coworker adds
`.gitattributes` and the user pulls. v0.2 handles this minimally:

- The Line Endings view query is invalidated whenever the Git Console
  runs any command (already true per §7.4 — coarse but correct).
- A polling-on-focus check refreshes the view when the user focuses the
  panel.

The mirror model makes this far less painful than the strategy model
would have been: there's no LeGit-side state to drift, so a refresh just
re-reads from `git config` and `.gitattributes` and displays the truth.
A proper filesystem watcher is deferred to v1 alongside fs-watching for
the Status panel.

---

## I. v0.2 Success Criteria

v0.2 is done when:

1. The data model has explicit, type-level scope. Every persisted struct
   declares which scope it belongs to. Every Tauri command's signature
   makes its scope unambiguous.
2. The UI has two regions with their own dock instances. Global panels
   (Repositories, Theme Editor, Settings) live in the global region. The
   Git Console lives in the repo region. Switching tabs swaps only the
   repo region.
3. A Settings panel exists at each scope. The Global Settings panel shows
   global-scope settings (active theme, recent repos, default Git binary
   path, global Line Endings editor, ...). The Repo Settings panel shows
   repo-scope settings (Git binary override, repo Line Endings editor,
   `.gitattributes` display).
4. The per-repo Git binary override works end-to-end: setting it rebuilds
   the session's runner, the Console immediately uses the new binary,
   invalid paths surface the same error UI as startup, and the value
   persists across restarts.
5. Line endings work end-to-end per §H: the Repo and Global Line Endings
   panels read and write `core.autocrlf` and `core.eol` at the
   corresponding `git config` scope; `.gitattributes` is read and
   authoritative; every write requires confirmation, with global writes
   carrying a heightened warning; the view accurately reflects resolved
   values and source scopes; mixed-ending detection surfaces files when
   `warn_on_mixed_endings` is on.
6. Author dogfooding for at least one cycle on the v0.2 build confirms the
   ambiguity that motivated this milestone is gone — i.e., when a new
   setting or panel comes up in conversation, "what scope is it?" has an
   obvious answer.

---

## J. v0.2 Explicitly Not in Scope

- **Any v1 panel.** Status, Branches, Log, Diff, commit graph all wait.
  Building them on the new scope foundation is exactly what v1 is for;
  building them *during* the foundation change conflates milestones.
- **Per-repo dock layout.** Repo layout stays shared across repos (§C.4).
- **Sharing repo settings across users.** Repo-scope settings live in
  each user's app data directory (§B.5), not in the repo, so there's
  nothing to commit and nothing to share. A future "export/import repo
  settings" or "team-shared settings" feature is out of scope for v0.2.
- **System-scope writes.** LeGit reads system info; it does not modify
  system-level config. (This is unchanged from v0.1 — calling it out for
  completeness.)
- **A `.gitattributes` editor.** v0.2 reads and displays
  `.gitattributes`; editing it is a normal file-edit operation, not a
  LeGit feature. A proper editor is a v1+ candidate.
- **Per-file line-ending normalization actions.** v0.2 detects and
  displays mixed-ending files; one-click "normalize to LF" actions are
  deferred to v1.
- **Filesystem watching for `.gitattributes`.** Deferred to v1 alongside
  broader fs-watching for Status (§H.9).
- **A "settings sync" feature** (cloud sync, dotfile-style sync, etc.).
  Out of scope at every milestone until clear demand.

---

## K. Decision Log Additions

| Decision                            | Choice                                  | Why                                                                                              |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Scope taxonomy                      | System / Global / Repo (matches git)    | Users already understand it; most LeGit settings compose with `git config` at the same scope     |
| Repo-scope storage location         | App data dir, keyed on canonicalized absolute path hash | Doesn't pollute the working tree, survives `git clean`, no `.gitignore` choice forced on users; matches how desktop apps usually store workspace metadata |
| Repo identity                       | SHA-256 of canonicalized absolute path, truncated to 16 hex chars | Handles symlinks (resolve), case-insensitive FS (lowercase); short enough to be human-readable; `path.txt` next to each entry makes it inspectable |
| Settings resolution                 | Repo > Global > System                  | Same precedence as `git config`                                                                  |
| Settings UI                         | Two separate panels (Global Settings, Repo Settings), placed in their respective scope regions | Panel placement communicates scope automatically; titles and field-level "writes to" hints reinforce it |
| Mixed-ending detection trigger      | On-demand when Repo Settings opens (not on repo open, not in background) | Avoids startup cost on large repos for a feature most users won't look at; revisit when normalization actions arrive |
| Quick presets in Line Endings       | Not included                            | The mirror approach exposes the underlying keys directly; presets would reintroduce the abstraction the mirror rejects |
| UI scope split                      | Two dock layouts: global region + repo region | Eliminates the v0.1 mismatch between visual hierarchy and data hierarchy                  |
| Region resize behavior              | Resizable divider; global dock collapsible; relative order within mode fixed | Flexibility users expect from a desktop app, without letting the user invert the scope hierarchy |
| Region placement                    | User setting: top or left (default top) | Top suits portrait/laptop, left suits widescreens. Doesn't affect scope hierarchy — reading order still puts global first in both modes |
| Repositories + Theme Editor placement | Global region                         | Both were global in data; v0.1 placed them in the repo dock incidentally                         |
| Per-repo dock layout                | Deferred past v0.2                      | Mixes architectural change with UX shift; do one thing per milestone                             |
| First per-scope feature             | Per-repo Git binary override            | Small, exercises every layer, real user motivation, safe to misconfigure                         |
| Line endings: mirror, not strategy  | LeGit panels are direct editors for `core.autocrlf` and `core.eol` at the corresponding `git config` scope; no LeGit-side strategy state | Earlier strategy abstraction created a second source of truth and a divergence problem; mirror eliminates both |
| Line-ending authority hierarchy     | `.gitattributes` > `git config`         | LeGit defers to declarative repo intent; matches modern Git practice                             |
| LeGit writes to `git config`        | Repo panel writes `--local`; global panel writes `--global`; system is read-only; every write requires confirmation; global writes carry a heightened warning | Scope matches by construction (you're editing config at the scope of the panel you're in); opt-in protects the user from surprise writes |
| Line-endings persistence            | None on LeGit's side                    | `git config` is the only persistent state; LeGit never stores a parallel preference              |

---

## L. Resolved Questions

An earlier draft of this document had an Open Questions section. Those
questions have been resolved in the body of the document during drafting:

- **Repo-scope storage location.** Resolved: app data directory, never
  in the repo's working tree. See §B.5.
- **Repo identity for the out-of-tree fallback.** Resolved: SHA-256 hash
  of the canonicalized absolute path. See §B.5.
- **Global region default state on first launch.** Deferred to v1 — v0.2
  ships with the region expanded since closed dogfooding is the only
  audience and discoverability isn't a concern yet. The right default
  for public builds (likely collapsed) is a v1 decision.
- **Settings UI structure.** Resolved: two separate panels, one per
  scope, with scope-obvious titles and field-level "writes to" hints.
  See §F.6.
- **Mixed-ending detection scope.** Resolved: on-demand only, triggered
  by opening the Repo Settings panel. See §H.6. To be revisited when
  per-file normalization actions arrive.
- **Quick presets in Line Endings.** Resolved: removed. The mirror
  approach exposes the underlying keys directly; presets would
  re-introduce the abstraction layer §H.1 rejects. See §H.3.
