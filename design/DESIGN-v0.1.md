# LeGit — Design Document

> A free, open-source, cross-platform Git GUI. Conceived as a community alternative
> to GitKraken after its move to a subscription model and Fork's move to a paid
> license, with proper Linux support and colorblind-friendly theming as
> first-class concerns.

---

## 1. Product Positioning

- **Target user:** developers comfortable with Git concepts who want a visual,
  graph-centric client without a subscription. The "GitKraken refugee" persona.
- **Differentiators:**
  - Free and open source (no rug-pull risk).
  - First-class support for Windows, macOS, **and** Linux.
  - Lighter footprint than Electron-based competitors.
  - Dockable panel UI that adapts to your workflow: users choose which views
    to display and where they live, and panels can summon each other based
    on selection (clicking a commit reveals its diff in the panel the user
    last placed it in). Configurability and workflow-driven flow are not
    opposed.
  - Full user-defined theming with import/export, designed for accessibility
    (including red-green colorblindness) from day one.
- **Explicitly not targeted at v1:** absolute Git beginners, CLI purists,
  third-party plugin authors.

---

## 2. Architecture Overview

LeGit is a Tauri desktop application with a Rust backend and a React/TypeScript
frontend. **All Git operations flow through a single chokepoint that invokes
the system `git` binary** — no libgit2/git2, no reimplementation. The frontend
is a dockable-panel shell where each feature is a self-contained panel the
user can show, hide, dock, tab, or float. All visual styling flows through
a three-layer theming system.

```
+--------------------------------------------------------------+
|  React + TypeScript Frontend (Vite)                          |
|  +--------------------------------------------------------+  |
|  |  dockview: panel layout shell                          |  |
|  |  Theme layer: palette -> semantic tokens -> components |  |
|  |   - panels (Repositories, Status, Branches, Log, ...)  |  |
|  +--------------------------------------------------------+  |
|  Zustand (UI state) | TanStack Query (server cache)          |
|  Generated typed `invoke` wrappers (specta)                  |
+----------------------------|---------------------------------+
                             | Tauri IPC (typed commands)
+----------------------------|---------------------------------+
|  Rust Backend (Tauri 2.x)                                    |
|  +--------------------------------------------------------+  |
|  |  AppState: multi-repo session map                      |  |
|  |  Tauri commands (one per backend operation)            |  |
|  +--------------------------------------------------------+  |
|  +--------------------------------------------------------+  |
|  |  legit-core                                            |  |
|  |    GitBackend trait (domain operations)                |  |
|  |    GitCliBackend (the v1 impl)                         |  |
|  |    Parsers (pure functions: text -> domain types)      |  |
|  |    GitRunner (the only thing that spawns `git`)        |  |
|  +--------------------------------------------------------+  |
|  +--------------------------------------------------------+  |
|  |  legit-providers (later: GitHub / GitLab / Bitbucket)  |  |
|  +--------------------------------------------------------+  |
+--------------------------------------------------------------+
```

---

## 3. Stack Decisions

### Backend

| Concern              | Choice                                              |
| -------------------- | --------------------------------------------------- |
| Language             | Rust                                                |
| App framework        | Tauri 2.x                                           |
| Git execution        | System `git` binary via `GitRunner` chokepoint      |
| Git library (future) | `gix` (gitoxide) candidate, behind same trait       |
| Async                | `tokio`                                             |
| State container      | `tauri::State<AppState>` with `RwLock<HashMap<…>>`  |
| Errors               | `thiserror`-based enums, never `anyhow` at boundary |
| Logging              | `tracing`                                           |
| JSON Schema (themes) | `jsonschema` crate                                  |

### Frontend

| Concern              | Choice                                          |
| -------------------- | ----------------------------------------------- |
| Language             | TypeScript                                      |
| UI framework         | React                                           |
| Bundler              | Vite (Tauri default)                            |
| Panel/docking system | `dockview`                                      |
| Client state         | Zustand                                         |
| Server cache         | TanStack Query                                  |
| Styling              | CSS custom properties (no inline color values)  |

### Interface

| Concern              | Choice                                          |
| -------------------- | ----------------------------------------------- |
| Type sharing         | `specta` + `tauri-specta` (generated TS types)  |
| Command wrappers     | Generated typed `invoke` wrappers               |
| Long ops             | Tauri events for progress streaming             |

### 3.1 Git Execution: The One-Path Principle

**Every Git operation in LeGit — reads, writes, and Git Console commands —
runs through the same `GitRunner` against the same system `git` binary.**

There is no `git2`, no libgit2, no reimplementation of Git. There is no
"path A for buttons, path B for the console." There is one path.

Consequences:

- **Hooks fire correctly** (pre-commit, commit-msg, pre-push, post-checkout,
  ...) without LeGit reimplementing the hook protocol.
- **Credential helpers work natively** (Git Credential Manager, osxkeychain,
  libsecret, user-configured custom helpers). Whatever works in the user's
  terminal works in LeGit.
- **Commit signing works** (GPG, SSH) via the user's configured signer.
- **SSH agent and `ssh_config` work** without `libssh2` quirks.
- **LFS, sparse checkout, partial clone, future Git features** all work the
  day they appear in the user's installed `git`.
- **The user's `.gitconfig` is the source of truth.** What LeGit sees is what
  the user sees.

This is the same architectural direction GitKraken began migrating toward in
2023 after years of pure-libgit2. LeGit starts where they're heading.

### 3.2 GitRunner Responsibilities

`GitRunner` is the single chokepoint that invokes `git`. Its job is **execution
only**, not parsing.

What it does:

- Spawn `git` with the correct binary path, working directory, and base
  environment (`GIT_EDITOR=false`, `GIT_TERMINAL_PROMPT=0`, `LANG=C.UTF-8`
  for parseable output, ...).
- Capture stdout/stderr, or stream them as Tauri events for long-running ops.
- Log every invocation (full args, working dir, env overrides, duration,
  exit code) via `tracing`.
- Handle cancellation and timeouts.
- Return raw text plus exit status to its caller. Nothing more.

What it does **not** do:

- Parse output.
- Know which commands exist or what they mean.
- Decide what to do with errors beyond classifying exit codes.

Parsing is per-command and lives in pure functions next to the backend
method that issues the command (see §4.3). Keeping `GitRunner` parser-free
means it stays small, command-agnostic, and trivially testable in isolation.

### 3.3 Free Capabilities From One-Path Architecture

Because every operation flows through `GitRunner`, several features fall out
of the architecture at near-zero cost (and are likely to ship in v1 or later):

- **Git Activity log panel** — every command LeGit runs, with args, duration,
  exit code, copyable to the clipboard. Long-requested by GitKraken users;
  LeGit gets it for free.
- **Command replay** — re-run the last command, or any command from history.
- **Audit export** — "what did LeGit do to my repo today?" as a text file.

### 3.4 Panels Are Wrappers — But Only Over Git

A direct consequence of §3.1 and §3.2: **every UI panel performs its Git
operations through the same `GitRunner` calls the Git Console makes.**
The Status panel's "Commit" button and the Console's `git commit -m "..."`
are not two implementations of "commit" — they are two UI surfaces over
a single backend operation.

This principle has practical consequences:

- **Git invocation is shared.** Panels never spawn `git` themselves and
  never parse `git` output with logic that diverges from
  `cli_impl/parsers/`. They call Tauri commands → `GitCliBackend` methods
  → `GitRunner`. The same call chain the Console uses.
- **Two surfaces, identical results.** Whether a user commits via the
  Status panel's button or via `git commit -m "..."` in the Console,
  the resulting state of the repository (hooks fired, signing applied,
  config honored) is identical. The button is not allowed to "almost"
  do what the command does.
- **A Git bug is fixed in one place.** Whether a user hit the bug via a
  button or via typed text, the fix is in the backend method, the
  parser, or `GitRunner` itself — never in panel-specific Git code.
- **Validation of the backend validates every future panel.** If
  `GitRunner` and the trait implementations work correctly when driven
  by the Console, they will work correctly when driven by any panel
  built on top of them later. This is the foundation that makes the
  milestone structure (§8) work.

**What panels are free to do.** Panels are not required to be thin. They
can and will contain meaningful logic of their own, as long as that logic
is *not* a reimplementation of Git itself. Specifically:

- **Orchestration of multiple Git operations.** "Refresh this panel" might
  call `status`, `branches`, and a partial `log` in parallel, then
  combine the results. The orchestration is the panel's responsibility;
  each underlying call still goes through the chokepoint.
- **Composite user actions.** "Push and tag" might be two `GitRunner`
  invocations. The composition lives in the panel (or its mutation
  hook); each individual call is unchanged.
- **Derived state and presentation transforms.** Grouping files by
  directory, computing rename pairs from a flat status list, building
  the graph layout from a commit list — all panel-side logic over data
  the backend supplied.
- **Non-Git concerns.** Filtering, sorting, search, virtualized
  rendering, selection state, drag-and-drop, keyboard shortcuts,
  animations. None of this touches Git.
- **Caching beyond what TanStack Query gives** for free, when a panel
  has expensive client-side computations over Git data.

**One principled exception: the Git Console.** The Console calls
`GitRunner` directly rather than going through `GitBackend` trait
methods. Its contract is "run whatever `git` command the user types and
stream the raw output" — going through the trait would require trait
methods for every possible Git operation, defeating the purpose. Every
*other* panel reaches Git via the trait; the Console is the explicit,
principled exception. This is what lets all Git operations work in v0.1
even though most trait methods are stubs (§8).

---

## 4. Backend Design

### 4.1 Multi-Repo Sessions

Multi-repo support is built in from day one. The backend maintains a session
per open repository, identified by a stable generated `RepoId` (not by path).

```rust
pub type RepoId = String; // generated; stable for the session lifetime

pub struct RepoSession {
    pub id: RepoId,
    pub path: PathBuf,
    pub runner: Arc<GitRunner>,           // configured for this repo
    pub backend: Arc<dyn GitBackend>,     // wraps the runner
    pub opened_at: SystemTime,
    // future: cached refs, fetch status, fs watchers, ...
}

pub struct AppState {
    pub repos: RwLock<HashMap<RepoId, Arc<RepoSession>>>,
    // ... other global state
}
```

Rules:

- Sessions are wrapped in `Arc` so command handlers clone the `Arc` and drop
  the map lock before doing any Git work. The `HashMap` lock is never held
  across Git operations.
- `RwLock` (not `Mutex`) on the map: lookups are concurrent, mutations are rare.
- `RepoId` is a generated id, not a path. Paths move, paths collide on
  case-insensitive filesystems, paths contain ugly characters.
- Every Tauri command takes `repo_id` as its first argument. A helper
  centralizes the lookup-or-error pattern.
- Each session has its own `GitRunner` bound to that repo's working directory.

### 4.2 The GitBackend Trait

The trait exists so that the implementation strategy can evolve (e.g., a
future `GixBackend` for hot read paths) without disturbing callers. Domain
types are the contract; library or subprocess concerns never leak.

```rust
#[async_trait]
pub trait GitBackend: Send + Sync {
    async fn status(&self) -> Result<Vec<FileStatus>, GitError>;
    async fn log(&self, opts: LogOptions) -> Result<Vec<Commit>, GitError>;
    async fn branches(&self) -> Result<Vec<Branch>, GitError>;
    async fn diff(&self, from: &CommitId, to: &CommitId) -> Result<Diff, GitError>;
    async fn commit(&self, message: &str, opts: CommitOptions) -> Result<CommitId, GitError>;
    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError>;
    // ... grows from panel needs, not speculation
}
```

Design rules for the trait:

- **Granularity matches LeGit's needs.** The trait reflects what panels do,
  not what `git` happens to expose.
- **All methods are `async`.** `GitCliBackend` awaits `GitRunner` calls.
- **No subprocess or library types in signatures.** Domain types only.
- **`GitError` is a domain enum.** `GitCliBackend` maps `git`'s exit codes
  and stderr patterns into it.

### 4.3 GitCliBackend Layering

`GitCliBackend` is the v1 (and likely only) implementation of `GitBackend`.
It is internally three layers:

```
+---------------------------------------------------------+
| GitBackend trait method                                 |
|   GitCliBackend::status()                               |
|     1. runner.run(&["status", "--porcelain=v2", "-z"])  |
|     2. parsers::status::parse(&output.stdout)           |
|     3. map errors, return Vec<FileStatus>               |
+--------|--------------------------------|---------------+
         v                                v
+------------------+              +------------------------+
| GitRunner        |              | parsers::status        |
|   execution only |  raw text    |   text -> domain types |
|   logs invocation|------------->|   pure function        |
|   handles errors |              |   exhaustively tested  |
+------------------+              +------------------------+
```

- The **runner** spawns `git` and returns raw output.
- The **parser** is a pure function `(text) -> Result<DomainType, ParseError>`.
  No I/O, no async, no subprocess. Unit tests feed it captured `git` output
  strings and assert on the parsed result.
- The **backend method** is the glue: pick the right args, call the runner,
  call the parser, map errors.

Why separate execution from parsing:

- Parsing is **per-command**; execution is universal. A god-object runner
  that knows how to parse every command becomes a pile.
- Parsers must be testable **without a subprocess**. Pure functions over
  strings can have hundreds of cheap unit tests.
- Some commands have no parsing (`git commit` is mostly exit-code-driven).
  Forcing them through a parsing step is awkward.
- Raw output is what you want in the bug-report log; keep the runner at
  the raw-text level.

### 4.4 Domain Types

Types are designed for the long-term feature set, even if v0.1 only populates
the simple cases. Adding fields later is a cross-cutting refactor; including
them now is one line.

```rust
pub struct CommitId(pub String);   // hex string

pub struct Commit {
    pub id: CommitId,
    pub parents: Vec<CommitId>,
    pub author: Signature,
    pub committer: Signature,
    pub message: String,
    pub timestamp: i64,
    pub signature: Option<CommitSignature>,   // signing support
}

pub enum FileState {
    Modified, Added, Deleted, Renamed, Copied,
    Untracked, Ignored, Conflicted,
    SubmoduleChanged,                          // submodules
}

pub struct FileStatus {
    pub path: PathBuf,
    pub state: FileState,
}

pub enum DiffEntry {
    Text(TextDiff),
    Binary(BinaryDiff),
    Submodule(SubmoduleChange),                // submodules
}
```

All domain types derive `Serialize + Deserialize` and are exposed to
TypeScript through `specta`.

### 4.5 `git` Invocation Conventions

To make parsers robust and consistent:

- **Always use null-terminated output where available** — `-z`, `--null`,
  `--porcelain=v2 -z`. Eliminates issues with paths containing spaces or
  newlines.
- **Use machine-readable formats** — `--porcelain` for status, `--format=`
  with explicit `%x00` field separators for log, `--raw --numstat` for diff,
  `for-each-ref --format=` for refs.
- **Format strings are defined as constants** next to the command and the
  parser, so the contract between them is visible.
- **Plumbing commands over porcelain** when output stability matters
  (`for-each-ref`, `rev-list`, `cat-file --batch`).

### 4.6 Crate Layout

```
legit-core/
  src/
    types.rs              — domain types
    backend.rs            — GitBackend trait, GitError
    runner.rs             — GitRunner: spawns `git`, no parsing
    cli_impl/             — GitCliBackend implementation
      mod.rs
      status.rs           — builds args, calls runner, calls parser
      log.rs
      diff.rs
      branches.rs
      commit.rs
      push.rs              — streams via runner.stream()
      ...
      parsers/             — pure functions: text -> domain types
        status.rs
        log.rs
        diff.rs
        branches.rs
        ...
    lib.rs                — re-exports types + trait

legit-providers/           — GitHub/GitLab/Bitbucket clients (later)

legit-app/                 — Tauri app: wires core + providers, owns
                             AppState, defines all #[tauri::command] handlers
```

---

## 5. Frontend Design

### 5.1 Panel Shell

`dockview` manages the panel layout: show/hide, drag to split, drag to tab,
float, save/restore. v0.1 uses a **global layout** (one layout for the whole
app). Per-repo layouts can come later — the layout JSON is already
serializable, so the change is additive.

Each feature is a panel: a self-contained React component that calls backend
commands for its data and renders its own UI. Adding a new feature is
"add a new panel component, register it, ship it."

### 5.2 Repo State

Active-repo state lives in the frontend, not the backend. The backend keeps
sessions for every open repo; the frontend decides which one is "active" and
passes its `RepoId` with each command.

```ts
interface RepoState {
  openRepos: RepoSummary[];
  activeRepoId: RepoId | null;
  openRepo: (path: string) => Promise<void>;
  closeRepo: (id: RepoId) => Promise<void>;
  setActive: (id: RepoId) => void;
}
```

A tab strip UI binds to this store. Panels read `activeRepoId` and pass it to
their backend calls. TanStack Query keys include the `RepoId`, so switching
tabs automatically invalidates and refetches.

### 5.3 Data Fetching

Every panel that reads backend data wraps its `invoke` call in a TanStack
Query hook keyed on `[command, repoId, ...args]`. This gives caching,
deduplication, background refetching, and loading/error state for free.

Mutations (commit, checkout, push, ...) use TanStack Query's `useMutation`
with explicit cache invalidation of affected queries. **After any Git
Console command completes, all queries for the active repo are invalidated**
(coarse but correct; refinement deferred).

### 5.4 Panel Relationships

A pure dockable shell asks the user to compose their workspace from scratch.
A pure slot-and-mode shell decides for the user what goes where. Git
workflows want both: users want to *configure* their panels (where Log
lives, how big the diff is, what's tabbed with what), but they also want
the app to *respond* to selection (click a commit → see its diff;
click a file → see that file's diff). LeGit's shell supports both by
giving panels a small vocabulary for **summoning** each other while
respecting the user's last placement.

#### Driver and Target Panels

Panels play one or both of two roles in a relationship:

- A **driver** panel is one whose user interactions can trigger another
  panel. Log is a driver (selecting a commit drives Commit Details).
  Status, once it exists, will be a driver (selecting a changed file drives
  Diff).
- A **target** panel is one that can be summoned by a driver and which
  accepts a payload describing what to show. Commit Details is a target
  (payload: a `CommitId`). Diff will be a target (payload: a file path +
  base + head).

A panel can be both. The Changes-files list for a selected commit, for
example, is a target of Log *and* a driver of Diff.

#### The Summon Operation

A driver invokes summon with:

```ts
summon(targetPanelId, payload)
```

The shell handles three cases:

1. **Target is visible.** Focus the target. Dispatch the payload to it.
   The target updates its internal state to render the payload.
2. **Target is hidden but has been placed before.** Restore the target at
   its last-known location in the layout. Focus it. Dispatch the payload.
3. **Target has never been opened.** Open it at a sensible default
   position declared in the panel's registration metadata. Focus it.
   Dispatch the payload.

The user's last placement is sacred. Summoning never moves a visible
panel. Summoning a hidden panel restores it where the user last saw fit
to put it.

#### Position Memory for Hidden Panels

`dockview` persists the layout of *visible* panels. The panel registry
extends this with **placement memory** for hidden panels: when a panel is
closed, its last-known location (dock region, group, tab order,
relative size) is stored separately and survives across LeGit restarts.
Reopening a panel restores it there.

Placement memory is per-panel, not per-relationship. The Commit Details
panel has one last-known location, regardless of which driver summoned
it most recently.

#### Payloads Are Per-Panel State

A target panel's "what am I currently showing" lives in the panel's own
state (Zustand store per panel, or local React state for simple cases).
The shell is not in the business of routing payloads beyond delivering
the most recent one to the target. If the target panel needs to react to
the payload (refetch, scroll, highlight), that's the panel's own logic.

Concretely: Commit Details holds a `selectedCommitId: CommitId | null`
in its own state. A summon from Log sets that field. The panel's render
reacts to the field. The shell didn't touch the state.

#### What's Not Defined By Relationships

Several panel behaviors are explicitly **not** part of the relationship
mechanism, to keep its surface small:

- **Default selection.** Whether the Log panel auto-selects the first
  commit when it opens is a panel-internal choice, not a relationship.
- **Cross-panel synchronization beyond summon.** If both a Log panel and
  a hypothetical Refs panel showed selection state, keeping them in sync
  would be a separate concern (a shared selection store, probably).
  Summon is one-shot: driver fires, target updates, done.
- **History / back navigation.** "Show me the commit I was looking at
  before this one" is a target-panel concern, not a shell concern. The
  shell doesn't track per-target payload history.
- **Multiple targets for one driver event.** Clicking a commit in Log
  could plausibly summon both Commit Details and a Changed Files view.
  This is fine — the driver fires `summon()` twice. The mechanism does
  not have a primitive for "summon group."

#### Why Not Build This Into the Shell as Slot-and-Mode?

A slot-and-mode shell (main slot + side slot, content driven by app
state) would solve the same workflow problem more aggressively but
removes user configurability — which §1 keeps as a core differentiator.
The summon model preserves configurability and layers selection-driven
behavior on top.

The cost is that panels declare summon relationships explicitly, in
their registration metadata. There is no implicit "this panel summons
that one" — every relationship is named code. That's a feature: the
relationships are auditable in one place and don't grow organically out
of UI events scattered across components.

#### Relationship Registration

A driver panel that summons another declares it at registration time:

```ts
registerPanel({
  id: "log",
  scope: "repo",
  // ...
  summons: ["commit-details"],
});

registerPanel({
  id: "commit-details",
  scope: "repo",
  defaultPlacement: { region: "right", group: "details" },
  // ...
});
```

The declared `summons` list is informational for tooling and future
documentation (a panel cannot summon something it didn't declare, but
that's enforced by the API rather than the registry). The
`defaultPlacement` is used only the first time a panel is ever opened;
afterward, placement memory takes over.

---

## 6. Theme System

Theming is a **first-class architectural concern** because LeGit is committed
to accessibility for colorblind users (including the project author, who is
red-green colorblind). The system is designed so users can build themes that
genuinely work for them — not just adjust an accent color.

### 6.1 Three-Layer Model

```
Layer 1: Palette          — named colors with actual values
  "main-bg"   = #1e1e1e
  "main-fg"   = #e0e0e0
  "accent"    = #4a9eff
  "danger"    = #e58e26     ← colorblind-friendly orange
  "success"   = #3498db     ← colorblind-friendly blue
  ...

Layer 2: Semantic tokens   — UI meanings, mapped to palette names
  "diff.added.bg"           -> "success"
  "diff.removed.bg"         -> "danger"
  "branch.current.fg"       -> "accent"
  "commit.signed.indicator" -> "success"
  ...

Layer 3: Components        — read semantic tokens only
  <DiffLine added /> reads var(--diff-added-bg), var(--diff-added-fg)
```

**Why three layers and not two?** Two different UI elements might share a
palette color today and need to diverge tomorrow. The semantic layer is
where customization actually happens; the palette is shared infrastructure.

A colorblind user remaps `diff.added.bg` and `diff.removed.bg` to colors
that are distinguishable for them, globally, in one place. Every diff in
the app updates consistently.

### 6.2 Implementation

CSS custom properties carry the theme at runtime. All three layers live as
CSS variables on `:root`; tokens reference palette via `var()`; components
reference tokens via `var()`.

```css
:root {
  --palette-main-bg: #1e1e1e;
  --palette-success: #3498db;

  --diff-added-bg: var(--palette-success);
  --diff-added-fg: var(--palette-main-fg);
}

.diff-line--added {
  background: var(--diff-added-bg);
  color: var(--diff-added-fg);
}
```

Changing a palette color cascades through every semantic token that
references it, which cascades through every component — in one repaint,
with zero JavaScript.

**No component hardcodes a color value, ever.** All colors flow through
semantic tokens. This is enforceable via a lint rule (forbid hex / rgb /
hsl literals in component CSS).

### 6.3 Theme File Format

Themes are JSON files. The format is the same for built-in themes,
user-saved themes, and import/export.

```json
{
  "$schema":        "https://legit.dev/schemas/theme-v1.json",
  "format":         "legit-theme",
  "formatVersion":  1,
  "name":           "My Theme",
  "author":         "optional",
  "description":    "optional",
  "palette": {
    "main-bg":  "#1e1e1e",
    "main-fg":  "#e0e0e0",
    "accent":   "#4a9eff",
    "danger":   "#e58e26",
    "success":  "#3498db",
    "warning":  "#f1fa8c"
  },
  "tokens": {
    "diff.added.bg":            "success",
    "diff.added.fg":            "main-fg",
    "diff.removed.bg":          "danger",
    "branch.current.fg":        "accent",
    "commit.signed.indicator":  "success"
  }
}
```

- `format` and `formatVersion` identify the file and handle future format
  changes. **Versioned from day one** so v0.1 themes import cleanly into
  later LeGit versions with sensible defaults for new tokens.
- `$schema` points to a published JSON Schema. Editors like VS Code then
  validate and autocomplete the file while users hand-edit it.
- File extension: **`.legit-theme.json`** — compound extension so OS file
  associations can target LeGit themes without claiming all JSON files.

### 6.4 Import / Export

- **Export** is in the Theme Editor: "Export theme..." → native save dialog
  → writes `.legit-theme.json`.
- **Import** is in the Theme Editor or via **drag-and-drop on the app
  window**. Validates and either adds to the user's theme list or shows an
  error.
- **Export is full**, not just overrides — every palette color and every
  token is written out. This makes exported themes self-contained and
  resilient to LeGit's default-token changes.
- **Pretty-printed JSON** with stable key ordering (top-level keys in
  documented order; `palette` and `tokens` alphabetically). Themes diff
  cleanly when version-controlled.

### 6.5 Import Validation Rules

Import is strict on structure, lenient on unknown content, generous about
gaps — the combination that makes a format survive over years.

| Condition                                       | Behavior                              |
| ----------------------------------------------- | ------------------------------------- |
| Invalid JSON                                    | Reject with parse error               |
| Missing `format: "legit-theme"`                 | Reject — not a LeGit theme            |
| `formatVersion` newer than known                | Warn, attempt import                  |
| Token references undefined palette name         | Reject with field-specific error      |
| Tokens missing that LeGit expects               | Fill in from default theme            |
| Tokens present that LeGit doesn't recognize     | Preserve silently (don't drop)        |
| Malformed color value in palette                | Reject with field-specific error      |
| Duplicate theme name                            | Append " (Imported)" or " (2)"        |

Rules around unknown fields and missing tokens are what give the format
forward and backward compatibility.

### 6.6 Built-in Themes

v0.1 ships **two built-in themes**: Light and Dark.

They are themselves `.legit-theme.json` files bundled with the app, loaded
through the same code path as user-imported themes. No hardcoded built-in
theme values anywhere in code.

**Benefits of treating built-ins as data:**

- The import/export code path is exercised on every app startup. Bugs
  surface immediately.
- Built-ins serve as canonical examples for theme authors.
- "Export this theme" works on built-ins too — users fork a built-in to
  customize.
- Adding a built-in theme later (e.g., a colorblind-friendly default
  promoted from community contributions) requires zero code changes.

Colorblind-friendly themes are explicitly **not** built into v0.1. They are
authored against the same token system and shared via the import/export
mechanism. The system being good enough for the project author to use
daily is the design test.

### 6.7 Theme Editor Panel

A global panel — not per-panel configuration. Theming is a global concern;
users think "make all my added lines blue" rather than "make Diff panel's
added lines blue, and also Log panel's added lines, ..."

- **Palette section** — list of named palette colors with color pickers.
  Add / rename / delete entries. Live preview.
- **Tokens section** — grouped by area (Diff, Log, Branches, ...). Each
  token shows its current binding as a dropdown of palette names. A small
  swatch shows the resolved color.
- **Theme management** — switch active theme, save current as new theme,
  duplicate, delete, import, export.
- **Contrast indicator** — for foreground/background token pairs, show
  WCAG contrast ratio with AA/AAA badge. Helps users build themes that
  remain readable.
- **Right-click any UI element → "Customize this color"** opens the Theme
  Editor scrolled to the relevant token. (v0.2 — not required for v0.1.)

### 6.8 Token Naming Contract

Once panels reference a token name, that name is part of LeGit's user-facing
contract. User themes depend on it. Renaming or removing tokens later
breaks user themes.

Therefore:

- **Naming convention:** `area.element.property` — e.g., `diff.added.bg`,
  `log.commit.fg`, `branch.current.indicator`.
- **Keep the initial token list small and meaningful.** Tokenize semantic
  colors, not every CSS property of every element. Border radii, paddings,
  fonts — leave alone for v0.1.
- **Document each token** in-app: hover a token in the editor to see what
  it controls.
- **Adding tokens later is safe** (filled in from default on import).
  Renaming or removing is a breaking change requiring migration.

---

## 7. Cross-Cutting Concerns

### 7.1 Commit Signing

Commit signing works in v0.1, through the same channel as every other Git
operation: `GitRunner` invokes the system `git`, which honors the user's
existing signing config (`commit.gpgsign`, `gpg.format`, `user.signingkey`,
`gpg.program`, `gpg.ssh.program`). A user with signing configured types
`commit -S ...` in the Git Console and produces a signed commit; types
`log --show-signature` and sees verification output. The user's GPG agent
or SSH agent handles prompts; LeGit never sees keys or passphrases.

This is the same pattern as every Git feature in LeGit (§3.4): the
**operation** is available in v0.1 via the Console; the **visual UX** is
added in v1 as panels become wrappers over the same commands. Signing is
not special in this regard.

**Supported signers.** GPG and SSH (Git 2.34+). X.509/S-MIME deferred.
The minimum-`git` version check (§7.6) already enforces the SSH signing
floor.

**Signing is delegated, never implemented in LeGit.** `git` invokes the
user's configured signer subprocess. LeGit does not implement crypto,
manage keys, or prompt for passphrases — those go through the OS-level
agent the user already has. This is true in v0.1 and remains true in v1.

**v1 Status panel UX** (added on top of the v0.1 foundation):

- A **signing indicator** showing whether the next commit will be signed,
  based on the resolved config. Reads through `git config`; cached per repo.
- A **per-commit override toggle** ("Sign this commit" / "Don't sign this
  commit") that maps to `git commit -S` or `git commit --no-gpg-sign`.
  Defaults to whatever the config says.
- **Clear error surfacing** when signing fails (typically an unavailable
  agent or missing key). LeGit shows the `git` stderr prominently.

**v1 Log panel UX**:

- An icon per commit indicating signed / unsigned / unverified / bad
  signature, sourced from `git log --show-signature` or `git verify-commit`.
- Hover or selection shows the signer identity and full verification
  details.
- **Signature verification is cached per commit** because verifying every
  commit on every log refresh would be unusable on large repos. The cache
  is keyed on commit ID and invalidated only when keys change (rare).

**Type-level support (set up in v0.1).**
`CommitOptions { sign: SignMode, ... }` where `SignMode` is
`None | Default | WithKey(KeyId)`. `Commit.signature: Option<CommitSignature>`
carries signer identity and verification status. Both are declared in the
v0.1 domain model; they remain unpopulated until v1 parsers fill them in.

**What is not in v1:** a signing settings panel that lets users configure
their signing key from inside LeGit. Users configure signing the way they
always have (via `git config` or their dotfiles); LeGit just respects it
and surfaces it. A "Signing Settings" panel that writes config on the
user's behalf is reasonable beyond v1.

### 7.2 Submodule Handling (long-term)

Submodules are notoriously the weakest part of most Git GUIs. Doing them
well is a deliberate differentiator.

- Superproject sessions know their submodules (path, recorded SHA,
  configured URL, init/dirty/detached status).
- Submodules open as peer `RepoSession`s in the tab strip when the user
  enters them. Each submodule is "just another repo" once opened.
- Bulk operations ("init all," "update all," "fetch all") live on the
  superproject and orchestrate across submodules with progress reporting.
- `FileStatus::SubmoduleChanged` and `DiffEntry::Submodule` exist from
  day one so the UI distinguishes "submodule pointer changed" from "file
  changed."
- The `GitBackend` trait has `submodule_*` methods (initially stubbed in
  `GitCliBackend`).

### 7.3 Progress Streaming

Long-running operations (clone, fetch, push, bulk submodule update) stream
progress. The pattern:

- The command returns an `OperationId` immediately.
- Progress events stream to the frontend via Tauri's event system, keyed
  on the `OperationId`. `GitRunner::stream()` is the entry point.
- Cancellation is a separate command taking the `OperationId`.

This pattern is established once and reused — not invented per command.

### 7.4 Git Console

The **Git Console** is an escape hatch for commands the UI doesn't yet
expose. Users type Git commands (without the `git` prefix); the backend
runs them through the same `GitRunner` as everything else.

- **Always runs `git <args>` against the active repo.** Not a general shell.
- **Never invoked through a shell** (`Command::new("git").args(...)`),
  eliminating injection by construction.
- **Blocks `-C`, `--git-dir`, `--work-tree`** to prevent bypassing the
  multi-repo session model.
- **Editor-requiring commands fail fast** because `GIT_EDITOR=false` is
  set in the base environment. The console returns a clear error rather
  than hanging.
- **Streams output** via the same Tauri event pattern as other long ops.
- **Cancellable** via a stop button (kills the subprocess by `OperationId`).
- **Invalidates the active repo's cached state** when a command completes,
  so other panels refresh automatically.
- **History** (up/down arrows) in the current session; persistent history
  is v0.2+.

### 7.5 Configuration

Git config (read and write, at user / repo / system scope) is a first-class
capability of the backend, not an afterthought. Implemented in terms of
`git config` invocations through `GitRunner`.

### 7.6 System Git Requirements

LeGit depends on a working system `git`. The architecture handles this
explicitly rather than assuming.

**Configurable binary path.** `GitRunner` is constructed with a `git_path`,
not a hardcoded `"git"`. The app resolves the path in this order:

1. User-specified path from settings (if set).
2. Auto-detection: search `PATH`, then common install locations
   (`/usr/bin/git`, `/usr/local/bin/git`, Homebrew prefixes,
   `C:\Program Files\Git\cmd\git.exe`, scoop, ...).
3. Fall back to `"git"` and let the OS resolve it.

A **"Git executable" setting** in the app preferences exposes the resolved
path and lets the user override it. This pre-empts a common bug class —
Sourcetree has a long history of "found the wrong `git`" issues with
non-standard installs (scoop, WSL, multiple installations). Letting users
point at the binary they want eliminates the guessing game.

**Startup check.** On app launch, `GitRunner` runs `git --version` and:

- If `git` cannot be found at all → show a clear setup screen with a
  download link and a "Browse for git executable..." button. Block app
  use until resolved.
- If the version is **below the minimum supported version** (currently
  Git 2.34+, for SSH signing support) → show a warning with a "continue
  anyway" option and a download link. The user may proceed at their own
  risk; some features (notably SSH signing) won't work.
- If `git --version` succeeds and is supported → log the resolved path
  and version, continue normally.

The resolved version is recorded in `tracing` logs so bug reports always
identify which `git` LeGit was running against.

**This embedded-`git` is not bundled in v0.1.** Sourcetree-style bundling
(ship a `git` binary inside the installer) is a possible v0.2+ packaging
decision for Windows users without a system `git`. The architecture
already supports it — `GitRunner` would just default to the bundled path
— so adoption is a packaging change, not a code change.

### 7.7 Error Handling

- `GitError` (domain-level) inside `legit-core`. Constructed by mapping
  `git`'s exit codes and stderr patterns into specific variants
  (`NotARepo`, `RefNotFound`, `MergeConflict`, `AuthFailed`, ...).
- `Internal(String)` variant as the escape hatch for unanticipated errors;
  heavy use signals the enum needs more variants.
- The Tauri command layer defines `AppError` (wrapping `GitError` plus
  command-layer concerns like "unknown repo id").
- `AppError` is `Serialize` and crosses the IPC boundary cleanly.
- `anyhow` is fine inside implementations but never appears at boundaries.

### 7.8 Persistence

All persistent state lives in Tauri's app data directory as JSON:

- **Recent repos list** + last-session open repos.
- **Dock layout** for the global panel arrangement.
- **User themes** as individual `.legit-theme.json` files in a `themes/`
  subdirectory.
- **Active theme** as a settings entry pointing to a theme by name.

**No credentials in LeGit storage.** The shell-out architecture means
credentials are handled by the user's existing Git credential helpers
automatically.

---

## 8. Milestones

LeGit's milestones are organized around a distinction between **proving the
architecture works** and **delivering a usable Git GUI**. These are different
goals and shouldn't be conflated — collapsing them is how foundations get
built on top of before they're validated.

### v0.1 — Architecture Validation

**Goal:** prove the architectural decisions in this document hold up against
reality. v0.1 is **not** a usable Git GUI for daily work. It is a minimal
end-to-end slice that exercises every layer of the stack, so any flaws in
the foundation are discovered before more UI is built on top.

The principle in §3.4 — that every panel is a visual wrapper over the same
`GitRunner` calls the Console makes — means that once the Console works
correctly end-to-end, every future panel is "just" a new UI surface over the
same proven backend. v0.1 validates that the foundation is sound.

#### What "Git commands work in v0.1" means

Every Git operation is available in v0.1 — through the Console.
`GitRunner` invokes the system `git` for any command the user types, so
the user has the full power of their `git` installation: every
subcommand, hooks, commit signing, credential helpers, all of it.

What v0.1 does **not** have is:

- Structured `GitBackend` trait methods (`status()`, `log()`, etc.)
  return `unimplemented!` or `Err(GitError::NotYet)` in v0.1.
- Per-command parsers in `cli_impl/parsers/`. Not needed because no
  panel consumes structured data yet.
- The visual surfaces over these commands (Status panel, Log panel,
  Diff panel, etc.) and their affordances (signing indicators,
  hunk-level staging, signature icons, ...).

The Console panel calls `GitRunner` directly, which is the principled
exception called out in §3.4. The trait exists in v0.1 so its shape is
committed to, but its methods are stubbed until v1 panels need them
filled in.

#### v0.1 in scope

**Infrastructure**

- Tauri 2.x + React + TypeScript + Vite scaffold.
- `dockview` panel shell with layout persistence.
- Tab strip for switching between open repos.
- Theme system as specified in §6: palette + tokens + components, CSS
  variables, two built-in themes (Light, Dark), full import/export.
- Multi-repo session map (§4.1).
- `GitRunner` (§3.2) — the chokepoint, full behavior including streaming,
  cancellation, logging, env management.
- `GitBackend` trait with `GitCliBackend` implementation.
- Startup `git --version` check and configurable Git binary path (§7.6).
- `specta`-generated typed Tauri commands.

**Panels**

- **Repositories** — open / close / switch repos.
- **Git Console** — typed Git commands, streamed text output, cancellation,
  invalidation of cached state on completion (§7.4). The primary way to
  exercise Git in v0.1.
- **Theme Editor** — palette and token editing, save / load / import /
  export, contrast indicator. Necessary because the theme system is part
  of what v0.1 validates.

**Settings**

- Git executable path (auto-detected with manual override; see §7.6).

#### v0.1 explicitly **not** in scope

Everything that would normally make a Git GUI useful — Status, Branches,
Log, Diff panels, fetch/pull/push toolbar, signing UX, commit graph — is
deferred to v1. They are not architecturally interesting. Each is a visual
wrapper over commands the Console already exercises, and once v0.1 proves
the wrapper pattern works, they become incremental UI work rather than
risky bets on the architecture.

The reason for this discipline: building five panels on top of an unproven
backend means that when a flaw is discovered in `GitRunner`, multi-repo, or
the trait shape, you've already invested in surfaces that may need to change.
Building the Console first means the backend gets a complete workout —
every command class, output format, error condition, cancellation case —
without UI affordances having to be re-done after the fact.

#### v0.1 success criteria

v0.1 is done when:

- The author (and any other tester) can use the Console to drive Git
  through LeGit, against multiple repos in tabs, with `git --version`,
  `status`, `log`, `diff`, `commit` (signed and unsigned), `push`, `pull`,
  `fetch`, `branch`, `checkout`, and a handful of long-running operations
  like `clone`.
- All operations log cleanly through `tracing`.
- Theme changes including imported themes apply correctly across the app.
- Panel layout is persisted across restarts.
- Multi-repo tabs behave correctly (switching tabs doesn't bleed state
  between repos).
- The architecture decisions in this document feel right after real use —
  or specific decisions get revised based on what was learned.

### v1 — Usable Git GUI

**Goal:** a GitKraken-replacement that someone could realistically adopt
for daily Git work.

v1 is where LeGit becomes a Git GUI in the user-facing sense: every CLI Git
operation that matters has a UI affordance, the commit graph is the
centerpiece, signing has a real UX, and the experience is polished enough
for public alpha.

#### v1 in scope

**Panels added on top of the v0.1 foundation**

- **Status** — working tree and staged changes; Stage / Unstage / Commit
  buttons; commit message editor; signing indicator and per-commit
  sign/don't-sign toggle (see §7.1).
- **Branches** — local and remote branch list; Checkout / Create / Delete /
  Merge actions.
- **Log** — flat chronological commit list **and** the commit graph
  rendering (the headline differentiator). Selecting a commit drives the
  Diff panel. Signature status icon per commit with hover details.
- **Diff** — side-by-side and unified views; driven by selection in Status
  or Log.

**Toolbar**

- Fetch / Pull / Push for the active repo.

**Cross-cutting v1 work**

- Commit signing UX surfaced in Status and Log (§7.1).
- Progress streaming pattern wired into clone/fetch/push (§7.3).
- Submodule data model and basic display in Status/Diff (§7.2).
- Polish pass on theming, layouts, error messages.

#### v1 success criteria

v1 is done when the author replaces their previous Git GUI with LeGit for
daily work and the experience holds up over several weeks of real use.
Public alpha announcement is gated on this.

### Beyond v1 (no committed timing)

These are real long-term goals tied to the architecture but explicitly
not on the v1 critical path:

- **Signing Settings panel** — managing signing config from inside LeGit
  rather than only respecting existing config.
- **Dedicated submodule UI** — bulk init/update, navigation from
  superproject to submodule tabs.
- **GitHub / GitLab / Bitbucket integration** via `legit-providers`.
- **Interactive rebase UI.**
- **Conflict resolution editor.**
- **Stash management UI.**
- **Search, blame, bisect, LFS, worktrees.**
- **Real PTY terminal** (separate from the Git Console).
- **Git Activity log panel** (falls out of architecture; UI deferred).
- **Bundled embedded `git`** — Sourcetree-style packaging for Windows
  users without a system `git`.
- **Per-repo panel layouts.**
- **Colorblindness simulation** in the theme editor.
- **Right-click "Customize this color"** jump-to-token.
- **Third-party extensions.**

### Always deferred (until clear demand)

- Multiple repos visible simultaneously in different panels.
- X.509 commit signing.

---

## 9. Open Questions

To be resolved before or during early development:

- **License.** MIT/Apache (permissive) vs. GPL (derivatives must stay open).
  Affects contributor pool and whether LeGit can be commercialized by a
  third party. **Decide before the first public commit.**
- **Project name conflict check.** "LeGit" is the working title. Check
  crates.io, npm, GitHub, and trademark databases before going public.
- **Styling system inside components.** Tailwind, CSS Modules, or plain CSS.
  Whichever it is must respect the theme system (only CSS variables for
  colors, no inline literals).
- **Hosting and CI.** GitHub vs. GitLab vs. Codeberg.
- **Schema hosting URL.** `legit.dev` is a placeholder; secure a real
  domain before publishing themes referencing it.

---

## 10. Roadmap Sketch

Indicative ordering; not a schedule.

**Toward v0.1 (architecture validation)**

1. **Scaffold.** Tauri + React + TS template, add `dockview`, `specta`.
   Wire one trivial end-to-end command with full types. Validates the
   interface layer.
2. **GitRunner foundation.** Get one Git command running end-to-end through
   the runner with logging, env, working dir, and parsing. Validates the
   one-path architecture before any panels exist.
3. **Theme system foundation.** CSS variables on `:root`, light/dark
   built-in JSON themes, theme loader and switcher. Done before panel work
   so every panel is built theme-correct from the start.
4. **Panel shell.** Dummy panels, drag/dock/save layout. Validates the
   frontend story.
5. **Multi-repo session map** and the Repositories panel that drives it.
6. **Git Console panel** with full v0.1 behavior: streaming, cancellation,
   state invalidation, error surfacing, the security boundaries from §7.4.
7. **Theme Editor panel** with import/export.
8. **Settings: Git executable path** + startup `git --version` check.
9. **v0.1 dogfooding.** Use the Console-driven build for a few weeks of
   real Git work. Revise the architecture based on what hurts.

**Toward v1 (usable Git GUI)**

10. Status panel + signing UX.
11. Branches panel.
12. Log panel (flat list first, then graph rendering — the headline piece).
13. Diff panel.
14. Fetch / Pull / Push toolbar with progress streaming.
15. Submodule data model surfacing in Status and Diff.
16. Polish, error message review, theme tuning, performance pass.
17. **Public alpha** behind a clear "not yet stable" notice.

**Beyond v1**

18. Iterate based on real user feedback before any commitment to a
    public stable API or plugin system. Tackle items from the "Beyond
    v1" list in §8 by demand, not by a fixed plan.

---

## 11. Decision Log

| Decision                        | Choice                                     | Why                                                                                       |
| ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Form factor                     | Cross-platform desktop GUI                 | Target user is the GitKraken refugee                                                      |
| Linux support                   | First-class                                | Gap in market; Sourcetree absent, GitHub Desktop unofficial                               |
| App framework                   | Tauri 2.x                                  | Lighter than Electron — concrete differentiator                                           |
| Backend language                | Rust                                       | Good fit for Tauri; strong HTTP/JSON for provider integration                             |
| Git execution                   | System `git` via `GitRunner` chokepoint    | One execution path; correct hooks/credentials/signing for free; matches GitKraken's 2023+ migration direction |
| `git2`/libgit2                  | Not used                                   | Hooks don't fire, credential helpers don't run natively, lags new Git features            |
| `gix` (gitoxide)                | Candidate for future hot read paths        | Behind the trait so introduction is incremental                                           |
| GitRunner responsibilities      | Execution only; no parsing                 | Parsers are per-command and must be unit-testable without subprocess                      |
| Output parsing                  | Pure functions in `cli_impl/parsers/`      | Cheap unit tests; clear separation from I/O; testable against captured `git` output       |
| `git` output format             | `-z` / `--porcelain` / explicit `--format=`| Robust against paths with spaces or newlines; stable for parsing                          |
| Multi-repo                      | From day one                               | Retrofitting is expensive; GitKraken parity needs it                                      |
| Frontend                        | React + TypeScript + Vite                  | Largest ecosystem with type safety end-to-end                                             |
| Panel system                    | `dockview`                                 | TypeScript-native, modern, framework-agnostic, actively maintained                        |
| Type sharing                    | `specta` + `tauri-specta`                  | Generates typed `invoke` wrappers, not just types                                         |
| State container                 | `RwLock<HashMap<RepoId, …>>`               | Reads dominate; per-repo work doesn't block other repos                                   |
| Extension model                 | None in v1 (dockable panels)               | "Extension-based" reframed as dockable first-party panels                                 |
| Layout scope                    | Global, not per-repo                       | Simpler v0.1; serializable layout makes per-repo additive later                           |
| Theme architecture              | Palette + semantic tokens                  | Enables colorblind-friendly customization globally and cleanly                            |
| Theme storage                   | `.legit-theme.json` files                  | Human-readable, version-controllable, shareable                                           |
| Built-in themes                 | Light + Dark only in v0.1                  | System supports any theme; community can produce more                                     |
| Built-in theme implementation   | Same JSON path as user themes              | Exercises import code on startup; built-ins are not special-cased                         |
| Git Console                     | Escape hatch for unsupported commands      | Runs through GitRunner like everything else; consistent behavior; no PTY needed in v0.1   |
| Milestone framing               | v0.1 = validation, v1 = usable GUI         | Conflating "first ship" with "proves the architecture" leads to building UI on unproven foundations |
| v0.1 panel scope                | Repositories + Console + Theme Editor      | Sufficient to exercise every layer; future panels share the Git-invocation chokepoint but may have their own orchestration and presentation logic |
| Commit graph                    | v1 milestone, not v0.1                     | Headline differentiator belongs in the usable GUI, not the validation slice                         |
| Commit signing                  | Operation works in v0.1; UX added in v1    | Same pattern as every Git feature — Console drives it in v0.1, panels surface it in v1   |
| Signing config management       | Out of scope for v0.1                      | LeGit respects user's existing config; managing it is a v0.2 add                          |
| Minimum supported Git version   | 2.34+ (for SSH signing)                    | Enables SSH signing; `--porcelain=v2` and other parser-friendly outputs already available |
| Git binary path                 | Auto-detected with user-configurable override | Pre-empts the "wrong git" bug class that has long plagued Sourcetree                   |
| Startup check                   | `git --version` with version-floor validation | Clear setup screen rather than mysterious failures later                              |
| Embedded `git` binary           | Not in v0.1                                | Architecture supports it; Sourcetree-style bundling is a v0.2+ packaging decision        |
| Panel UX paradigm               | Dockable shell + selection-driven summon   | Pure dockable mismatches Git workflows; pure slot-and-mode removes configurability; hybrid preserves both |
| Summon vs. moving panels        | Summon never moves visible panels; only restores hidden ones | User's last placement is sacred; surprise movement would undermine the configurability story |
| Placement memory                | Per-panel last-known location, persisted across restarts | Hidden panels reopen where the user last had them, regardless of which driver summoned them |
| Relationship surface            | Explicit `summons` declarations at panel registration | Auditable in one place; prevents organic growth of cross-panel coupling in UI event handlers |
| Payload routing                 | Shell delivers payload to target; target owns its own state | Keeps the shell's responsibility small; payload reaction is panel logic, not shell logic |
