// Token contract — once a panel references a name here, that name is part
// of LeGit's user-facing theme contract (DESIGN.md §6.8). Renaming or
// removing entries breaks user themes. Adding is safe.
//
// `documentation` is shown when a user hovers a token in the Theme Editor.

export interface TokenDescriptor {
  name: string;
  group: string;
  documentation: string;
}

export interface PaletteDescriptor {
  name: string;
  documentation: string;
}

export const PALETTE_CONTRACT: readonly PaletteDescriptor[] = [
  { name: "main-bg", documentation: "App background. Drives most large surfaces." },
  { name: "main-fg", documentation: "Default text colour over `main-bg`." },
  { name: "panel-bg", documentation: "Panel background. Often equal to `main-bg`." },
  { name: "panel-border", documentation: "Borders, dividers, hairlines." },
  { name: "accent", documentation: "Selection, focus, current-branch markers." },
  { name: "accent-hover", documentation: "Hover shade for primary buttons and accent surfaces." },
  { name: "accent-fg", documentation: "Text drawn on `accent`." },
  {
    name: "danger",
    documentation:
      "Error and removed-line colour. Chosen colourblind-friendly by default (orange).",
  },
  { name: "danger-hover", documentation: "Hover shade for danger buttons." },
  {
    name: "success",
    documentation:
      "Signed/verified and added-line colour. Chosen colourblind-friendly by default (blue).",
  },
  { name: "warning", documentation: "Non-fatal warnings." },
  { name: "subtle-fg", documentation: "Muted text: timestamps, hints, inactive labels." },
  { name: "shadow", documentation: "Drop-shadow colour for floating surfaces (menus, popovers, toasts). Usually black with alpha." },
  { name: "input-bg", documentation: "Background of text inputs." },
  {
    name: "row-selected-bg",
    documentation: "Background of the selected row in list panels (e.g. the Commits panel).",
  },
  { name: "console-bg", documentation: "Git Console background." },
  { name: "stderr-fg", documentation: "Stderr text in the Git Console." },
  // The 16 ANSI terminal colours git's coloured output resolves to in the
  // Git Console (color.ui: diff, status, log decorations, ...).
  { name: "ansi-black", documentation: "ANSI black (colour 0) in the Git Console." },
  { name: "ansi-red", documentation: "ANSI red (colour 1): removed diff lines, errors." },
  { name: "ansi-green", documentation: "ANSI green (colour 2): added diff lines, staged files." },
  { name: "ansi-yellow", documentation: "ANSI yellow (colour 3): commit hashes in git log." },
  { name: "ansi-blue", documentation: "ANSI blue (colour 4)." },
  { name: "ansi-magenta", documentation: "ANSI magenta (colour 5)." },
  { name: "ansi-cyan", documentation: "ANSI cyan (colour 6): hunk headers." },
  { name: "ansi-white", documentation: "ANSI white (colour 7)." },
  { name: "ansi-bright-black", documentation: "ANSI bright black (colour 8)." },
  { name: "ansi-bright-red", documentation: "ANSI bright red (colour 9)." },
  { name: "ansi-bright-green", documentation: "ANSI bright green (colour 10): current branch in git branch." },
  { name: "ansi-bright-yellow", documentation: "ANSI bright yellow (colour 11)." },
  { name: "ansi-bright-blue", documentation: "ANSI bright blue (colour 12)." },
  { name: "ansi-bright-magenta", documentation: "ANSI bright magenta (colour 13)." },
  { name: "ansi-bright-cyan", documentation: "ANSI bright cyan (colour 14)." },
  { name: "ansi-bright-white", documentation: "ANSI bright white (colour 15)." },
  // Ref chip colours (Commits panel). Each chip type has a translucent fill,
  // a border, and a text/icon colour.
  { name: "ref-branch-bg", documentation: "Local branch chip fill." },
  { name: "ref-branch-border", documentation: "Local branch chip border." },
  { name: "ref-branch-fg", documentation: "Local branch chip text." },
  { name: "ref-branch-current-bg", documentation: "Checked-out branch chip fill." },
  { name: "ref-branch-current-border", documentation: "Checked-out branch chip border." },
  { name: "ref-branch-current-fg", documentation: "Checked-out branch chip text." },
  { name: "ref-remote-bg", documentation: "Remote branch chip fill (and fused-chip remote indicator)." },
  { name: "ref-remote-border", documentation: "Remote branch chip border." },
  { name: "ref-remote-fg", documentation: "Remote branch chip text / remote indicator colour." },
  { name: "ref-tag-bg", documentation: "Tag chip fill." },
  { name: "ref-tag-border", documentation: "Tag chip border." },
  { name: "ref-tag-fg", documentation: "Tag chip text." },
  { name: "ref-head-bg", documentation: "HEAD chip fill." },
  { name: "ref-head-border", documentation: "HEAD chip border." },
  { name: "ref-head-fg", documentation: "HEAD chip / HEAD→ indicator text." },
  { name: "ref-stash-fg", documentation: "Stash accent (e.g. the stash icon in the Stashes panel)." },
  { name: "ref-overflow-bg", documentation: "\"+N\" overflow chip fill (refs that don't fit on the row)." },
  { name: "ref-overflow-border", documentation: "\"+N\" overflow chip border." },
  { name: "ref-other-bg", documentation: "Chip fill for unrecognised ref types." },
  { name: "ref-other-border", documentation: "Chip border for unrecognised ref types." },
  // File-status indicator colours (Changed Files panel icons + line counts).
  { name: "status-added", documentation: "Added-file indicator (icon and +N count)." },
  { name: "status-modified", documentation: "Modified-file indicator." },
  { name: "status-deleted", documentation: "Deleted-file indicator (icon and −N count)." },
  { name: "status-renamed", documentation: "Renamed/copied-file indicator." },
  // Diff line-background tints (lighter than the full success/danger used for
  // changed characters). Use an alpha so the line reads as a wash.
  { name: "diff-added-line", documentation: "Whole-line background for an added/modified diff line (light tint)." },
  { name: "diff-added-word", documentation: "Background for the changed characters within an added/modified line (stronger tint; translucent so line text stays AA-readable)." },
  { name: "diff-removed-line", documentation: "Whole-line background for a removed/modified diff line (light tint)." },
  { name: "diff-removed-word", documentation: "Background for the changed characters within a removed/modified line (stronger tint; translucent so line text stays AA-readable)." },
  { name: "diff-hunk-header", documentation: "Background band behind a diff hunk's `@@` header row." },
  { name: "merge-fold", documentation: "Background band behind the merge view's folded-lines bars (neutral: must not read as either conflict side)." },
  // Syntax highlighting colours (diff viewer code).
  { name: "syn-keyword", documentation: "Syntax: keywords (`if`, `fn`, `const`, ...)." },
  { name: "syn-string", documentation: "Syntax: string, character, and regexp literals." },
  { name: "syn-number", documentation: "Syntax: numeric literals." },
  { name: "syn-comment", documentation: "Syntax: comments and preprocessor/meta lines." },
  { name: "syn-function", documentation: "Syntax: function and macro names." },
  { name: "syn-type", documentation: "Syntax: type, class, and namespace names." },
  { name: "syn-variable", documentation: "Syntax: variable names." },
  { name: "syn-property", documentation: "Syntax: object properties and markup attribute names." },
  { name: "syn-operator", documentation: "Syntax: operators." },
  { name: "syn-punctuation", documentation: "Syntax: punctuation and brackets." },
  { name: "syn-constant", documentation: "Syntax: built-in constants (`true`, `null`, `self`, ...)." },
  { name: "syn-tag", documentation: "Syntax: markup tag names and headings." },
] as const;

export const TOKEN_CONTRACT: readonly TokenDescriptor[] = [
  { name: "app.bg", group: "App", documentation: "Top-level app background." },
  { name: "app.fg", group: "App", documentation: "Top-level default text." },
  { name: "accent", group: "App", documentation: "General accent: focus rings, active markers, highlighted icons." },
  { name: "accent.fg", group: "App", documentation: "Text/icons drawn on accent-coloured surfaces." },
  { name: "banner.op.bg", group: "App", documentation: "Background of the merge/rebase-in-progress banner (app chrome, below the repo tabs)." },
  { name: "banner.op.fg", group: "App", documentation: "Text of the merge/rebase-in-progress banner, including its buttons' text and border." },
  { name: "banner.warning.bg", group: "App", documentation: "Background of app-chrome warning banners (e.g. the missing-git-lfs warning below the repo tabs)." },
  { name: "banner.warning.fg", group: "App", documentation: "Text of app-chrome warning banners, including their buttons' text and border." },

  { name: "panel.bg", group: "Panel", documentation: "Panel body background." },
  { name: "panel.fg", group: "Panel", documentation: "Panel body text." },
  { name: "panel.border", group: "Panel", documentation: "Panel borders and dividers." },
  { name: "panel.border.drag", group: "Panel", documentation: "Highlight of a panel divider while it is hovered/dragged for resizing." },
  { name: "panel.header.bg", group: "Panel", documentation: "Panel header background." },
  { name: "panel.header.fg", group: "Panel", documentation: "Panel header text." },
  { name: "pane.header.bg", group: "Panel", documentation: "Accordion section header background (e.g. the Refs panel's Branches/Remotes/Stashes headers)." },
  { name: "pane.header.fg", group: "Panel", documentation: "Accordion section header text." },
  { name: "preview.checker.a", group: "Panel", documentation: "Image-preview checkerboard backdrop, first tile shade (makes transparency visible)." },
  { name: "preview.checker.b", group: "Panel", documentation: "Image-preview checkerboard backdrop, second tile shade." },
  { name: "pane.header.border", group: "Panel", documentation: "Accordion section header bottom border." },
  { name: "progress.bar.bg", group: "Panel", documentation: "Indeterminate loading bar pinned to a panel's top edge." },
  { name: "shadow.color", group: "Panel", documentation: "Drop-shadow colour for floating surfaces (menus, popovers, toasts, floating groups)." },
  { name: "dnd.overlay.bg", group: "Panel", documentation: "Translucent wash shown over a drop target while dragging panels/tabs." },

  { name: "tab.strip.bg", group: "Repo Tabs", documentation: "Background of the repository tab strip (the bar behind the tabs)." },
  { name: "tab.bg", group: "Repo Tabs", documentation: "Inactive repository tab background." },
  { name: "tab.fg", group: "Repo Tabs", documentation: "Inactive repository tab text." },
  { name: "tab.active.bg", group: "Repo Tabs", documentation: "Active repository tab background." },
  { name: "tab.active.fg", group: "Repo Tabs", documentation: "Active repository tab text." },
  { name: "tab.border", group: "Repo Tabs", documentation: "Repository tab strip border." },

  { name: "panel.tab.bg", group: "Panel Tabs", documentation: "Panel tab strip background (dockview panels)." },
  { name: "panel.tab.fg", group: "Panel Tabs", documentation: "Inactive panel tab text." },
  { name: "panel.tab.active.bg", group: "Panel Tabs", documentation: "Active panel tab background." },
  { name: "panel.tab.active.fg", group: "Panel Tabs", documentation: "Active panel tab text." },

  { name: "button.bg", group: "Controls", documentation: "Default button background." },
  { name: "button.fg", group: "Controls", documentation: "Default button text." },
  { name: "button.hover.bg", group: "Controls", documentation: "Default button hover background." },
  { name: "button.primary.bg", group: "Controls", documentation: "Primary action button background." },
  { name: "button.primary.hover.bg", group: "Controls", documentation: "Primary action button hover background." },
  { name: "button.primary.fg", group: "Controls", documentation: "Primary action button text." },
  { name: "button.danger.bg", group: "Controls", documentation: "Destructive action button background." },
  { name: "button.danger.hover.bg", group: "Controls", documentation: "Destructive action button hover background." },
  { name: "button.danger.fg", group: "Controls", documentation: "Destructive action button text." },
  { name: "button.active.bg", group: "Controls", documentation: "Background of an active/selected toggle button (e.g. view-mode switches)." },

  { name: "input.bg", group: "Controls", documentation: "Text input background." },
  { name: "input.fg", group: "Controls", documentation: "Text input text." },
  { name: "input.border", group: "Controls", documentation: "Text input border." },
  { name: "input.focus.border", group: "Controls", documentation: "Text input border when focused." },

  { name: "console.bg", group: "Console", documentation: "Git Console background." },
  { name: "console.fg", group: "Console", documentation: "Default Git Console text." },
  { name: "console.stdout.fg", group: "Console", documentation: "stdout lines." },
  { name: "console.stderr.fg", group: "Console", documentation: "stderr lines." },
  { name: "console.prompt.fg", group: "Console", documentation: "Input prompt indicator." },
  { name: "console.ansi.black", group: "Console", documentation: "ANSI black (0) in coloured git output." },
  { name: "console.ansi.red", group: "Console", documentation: "ANSI red (1): removed diff lines, errors." },
  { name: "console.ansi.green", group: "Console", documentation: "ANSI green (2): added diff lines, staged files." },
  { name: "console.ansi.yellow", group: "Console", documentation: "ANSI yellow (3): commit hashes in git log." },
  { name: "console.ansi.blue", group: "Console", documentation: "ANSI blue (4)." },
  { name: "console.ansi.magenta", group: "Console", documentation: "ANSI magenta (5)." },
  { name: "console.ansi.cyan", group: "Console", documentation: "ANSI cyan (6): hunk headers." },
  { name: "console.ansi.white", group: "Console", documentation: "ANSI white (7)." },
  { name: "console.ansi.bright.black", group: "Console", documentation: "ANSI bright black (8)." },
  { name: "console.ansi.bright.red", group: "Console", documentation: "ANSI bright red (9)." },
  { name: "console.ansi.bright.green", group: "Console", documentation: "ANSI bright green (10): current branch in git branch." },
  { name: "console.ansi.bright.yellow", group: "Console", documentation: "ANSI bright yellow (11)." },
  { name: "console.ansi.bright.blue", group: "Console", documentation: "ANSI bright blue (12)." },
  { name: "console.ansi.bright.magenta", group: "Console", documentation: "ANSI bright magenta (13)." },
  { name: "console.ansi.bright.cyan", group: "Console", documentation: "ANSI bright cyan (14)." },
  { name: "console.ansi.bright.white", group: "Console", documentation: "ANSI bright white (15)." },

  { name: "divider.bg", group: "Divider", documentation: "Region divider background (between global and repo panels)." },
  { name: "divider.hover.bg", group: "Divider", documentation: "Region divider background on hover." },

  { name: "scrollbar.thumb", group: "Scrollbar", documentation: "Scrollbar thumb (draggable handle)." },
  { name: "scrollbar.thumb.hover", group: "Scrollbar", documentation: "Scrollbar thumb on hover." },
  { name: "scrollbar.track", group: "Scrollbar", documentation: "Scrollbar track (gutter behind the thumb)." },

  { name: "subtle.fg", group: "Text", documentation: "Muted text." },
  { name: "error.fg", group: "Text", documentation: "Error text." },
  { name: "success.fg", group: "Text", documentation: "Success text." },
  { name: "warning.fg", group: "Text", documentation: "Warning text." },

  { name: "diff.added.bg", group: "Diff", documentation: "Whole-line background for added lines (light tint)." },
  { name: "diff.added.fg", group: "Diff", documentation: "Foreground for added lines." },
  { name: "diff.added.word.bg", group: "Diff", documentation: "Background for the changed characters within a modified added line (stronger)." },
  { name: "diff.removed.bg", group: "Diff", documentation: "Whole-line background for removed lines (light tint)." },
  { name: "diff.removed.fg", group: "Diff", documentation: "Foreground for removed lines." },
  { name: "diff.removed.word.bg", group: "Diff", documentation: "Background for the changed characters within a modified removed line (stronger)." },
  { name: "diff.gutter.bg", group: "Diff", documentation: "Line-number gutter background in the Diff panel." },
  { name: "diff.gutter.fg", group: "Diff", documentation: "Line-number gutter text in the Diff panel." },
  { name: "diff.hunk.header.bg", group: "Diff", documentation: "Background of a hunk's `@@` header row." },
  { name: "diff.hunk.header.fg", group: "Diff", documentation: "Text of a hunk's `@@` header row." },
  { name: "merge.fold.bg", group: "Merge", documentation: "Background of the merge view's folded-lines bar." },
  { name: "merge.fold.fg", group: "Merge", documentation: "Text of the merge view's folded-lines bar." },
  { name: "diff.edited.bg", group: "Diff", documentation: "Whole-line background for a line with unsaved edits in the editable diff." },
  { name: "diff.action.bg", group: "Diff", documentation: "Background of the hunk stage/unstage buttons." },
  { name: "diff.action.fg", group: "Diff", documentation: "Text of the hunk stage/unstage buttons." },
  { name: "diff.action.hover.bg", group: "Diff", documentation: "Background of the hunk stage/unstage buttons on hover." },
  { name: "diff.action.hover.fg", group: "Diff", documentation: "Text of the hunk stage/unstage buttons on hover." },
  { name: "diff.discard.bg", group: "Diff", documentation: "Background of the hunk discard button (destructive)." },
  { name: "diff.discard.fg", group: "Diff", documentation: "Text of the hunk discard button." },
  { name: "diff.discard.hover.bg", group: "Diff", documentation: "Background of the hunk discard button on hover." },
  { name: "diff.discard.hover.fg", group: "Diff", documentation: "Text of the hunk discard button on hover." },
  { name: "blame.alt.bg", group: "Blame", documentation: "Background of the alternating (every-other) commit rows in the Blame panel." },

  { name: "syntax.keyword", group: "Syntax highlighting", documentation: "Keywords (`if`, `fn`, `const`, ...) in the diff viewer's code." },
  { name: "syntax.string", group: "Syntax highlighting", documentation: "String, character, and regexp literals." },
  { name: "syntax.number", group: "Syntax highlighting", documentation: "Numeric literals." },
  { name: "syntax.comment", group: "Syntax highlighting", documentation: "Comments and preprocessor/meta lines." },
  { name: "syntax.function", group: "Syntax highlighting", documentation: "Function and macro names." },
  { name: "syntax.type", group: "Syntax highlighting", documentation: "Type, class, and namespace names." },
  { name: "syntax.variable", group: "Syntax highlighting", documentation: "Variable names." },
  { name: "syntax.property", group: "Syntax highlighting", documentation: "Object properties and markup attribute names." },
  { name: "syntax.operator", group: "Syntax highlighting", documentation: "Operators." },
  { name: "syntax.punctuation", group: "Syntax highlighting", documentation: "Punctuation and brackets." },
  { name: "syntax.constant", group: "Syntax highlighting", documentation: "Built-in constants (`true`, `null`, `self`, ...)." },
  { name: "syntax.tag", group: "Syntax highlighting", documentation: "Markup tag names and headings." },

  { name: "menu.hover.bg", group: "Menus", documentation: "Background of a hovered context-menu item." },


  { name: "ref.branch.bg", group: "Refs", documentation: "Local branch chip fill." },
  { name: "ref.branch.border", group: "Refs", documentation: "Local branch chip border." },
  { name: "ref.branch.fg", group: "Refs", documentation: "Local branch chip text." },
  { name: "ref.branch.current.bg", group: "Refs", documentation: "Checked-out branch chip fill." },
  { name: "ref.branch.current.border", group: "Refs", documentation: "Checked-out branch chip border." },
  { name: "ref.branch.current.fg", group: "Refs", documentation: "Checked-out branch chip text." },
  { name: "ref.remote.bg", group: "Refs", documentation: "Remote branch chip fill." },
  { name: "ref.remote.border", group: "Refs", documentation: "Remote branch chip border." },
  { name: "ref.remote.fg", group: "Refs", documentation: "Remote branch chip text and the fused-chip remote indicator." },
  { name: "ref.tag.bg", group: "Refs", documentation: "Tag chip fill." },
  { name: "ref.tag.border", group: "Refs", documentation: "Tag chip border." },
  { name: "ref.tag.fg", group: "Refs", documentation: "Tag chip text." },
  { name: "ref.head.bg", group: "Refs", documentation: "HEAD chip fill." },
  { name: "ref.head.border", group: "Refs", documentation: "HEAD chip border." },
  { name: "ref.head.fg", group: "Refs", documentation: "HEAD chip and HEAD→ indicator text." },
  { name: "ref.stash.fg", group: "Refs", documentation: "Stash accent (e.g. the stash icon in the Stashes panel)." },
  { name: "ref.overflow.bg", group: "Refs", documentation: "\"+N\" overflow chip fill (refs that don't fit on the row)." },
  { name: "ref.overflow.border", group: "Refs", documentation: "\"+N\" overflow chip border." },
  { name: "ref.overflow.fg", group: "Refs", documentation: "\"+N\" overflow chip text." },
  { name: "ref.other.bg", group: "Refs", documentation: "Chip fill for unrecognised ref types." },
  { name: "ref.other.border", group: "Refs", documentation: "Chip border for unrecognised ref types." },
  { name: "ref.other.fg", group: "Refs", documentation: "Chip text for unrecognised ref types." },

  { name: "graph.lane.0", group: "Graph", documentation: "Lane 0 colour (main branch by convention)." },
  { name: "graph.lane.1", group: "Graph", documentation: "Lane 1 colour." },
  { name: "graph.lane.2", group: "Graph", documentation: "Lane 2 colour." },
  { name: "graph.lane.3", group: "Graph", documentation: "Lane 3 colour." },
  { name: "graph.lane.4", group: "Graph", documentation: "Lane 4 colour." },
  { name: "graph.lane.5", group: "Graph", documentation: "Lane 5 colour." },
  { name: "graph.lane.fallback", group: "Graph", documentation: "Fallback colour for lanes beyond index 5." },
  { name: "graph.row.selected.bg", group: "Graph", documentation: "Background of the selected commit row." },
  { name: "graph.row.focused.bg", group: "Graph", documentation: "Background of the keyboard-focused (but not selected) row in file trees." },
  { name: "graph.row.hover.bg", group: "Graph", documentation: "Background of a hovered commit row." },

  { name: "status.added", group: "File Status", documentation: "Added-file icon and +N line count (Changed Files panel)." },
  { name: "status.modified", group: "File Status", documentation: "Modified-file icon." },
  { name: "status.deleted", group: "File Status", documentation: "Deleted-file icon and −N line count." },
  { name: "status.renamed", group: "File Status", documentation: "Renamed-file icon." },
  { name: "status.copied", group: "File Status", documentation: "Copied-file icon." },
  { name: "status.conflicted", group: "File Status", documentation: "Conflicted-file icon." },
] as const;

export interface ContrastPair {
  fg: string;
  bg: string;
  /**
   * The surface a translucent `bg` renders on (diff washes, chip fills,
   * banners) — one token, or a layer stack ordered nearest-first when the
   * surface is itself translucent (word highlights sit on the line wash on
   * the panel). The check composites bg over the stack before measuring;
   * omitted when `bg` is expected to be opaque.
   */
  base?: string | readonly string[];
  label: string;
  /** Heading the editor groups the pair under. */
  group: string;
  /**
   * Contrast floor for this pair: the built-in themes must meet it and the
   * editor counts a pair below it as failing. Defaults to 4.5 (WCAG AA).
   * Pairs where AA would neuter the design (syntax colours over the diff
   * line washes) declare 3 (the WCAG AA-Large tier) instead.
   */
  minRatio?: number;
  /**
   * Informational only: the editor shows the ratio and tier for theme
   * authors, but the pair has no floor — it never counts as failing and is
   * not enforced for the built-in themes. Used where any floor would defeat
   * the surface's purpose (syntax colours over the diff word highlights).
   */
  advisory?: boolean;
}

/** Pairs whose contrast the editor surfaces for the user. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: "panel.fg", bg: "panel.bg", label: "Panel body", group: "Core surfaces" },
  { fg: "app.fg", bg: "app.bg", label: "App chrome", group: "Core surfaces" },
  { fg: "subtle.fg", bg: "panel.bg", label: "Muted text", group: "Core surfaces" },
  { fg: "error.fg", bg: "panel.bg", label: "Error text", group: "Core surfaces" },
  { fg: "success.fg", bg: "panel.bg", label: "Success text", group: "Core surfaces" },
  { fg: "warning.fg", bg: "panel.bg", label: "Warning text", group: "Core surfaces" },
  { fg: "accent.fg", bg: "accent", label: "Accent surface", group: "Core surfaces" },
  {
    fg: "panel.fg",
    bg: "graph.row.selected.bg",
    base: "panel.bg",
    label: "Selected row",
    group: "Core surfaces",
  },
  { fg: "tab.active.fg", bg: "tab.active.bg", label: "Active repo tab", group: "Tabs & headers" },
  {
    fg: "tab.fg",
    bg: "tab.bg",
    base: "tab.strip.bg",
    label: "Inactive repo tab",
    group: "Tabs & headers",
  },
  {
    fg: "panel.tab.active.fg",
    bg: "panel.tab.active.bg",
    base: "panel.tab.bg",
    label: "Active panel tab",
    group: "Tabs & headers",
  },
  {
    fg: "panel.tab.fg",
    bg: "panel.tab.bg",
    base: "panel.bg",
    label: "Inactive panel tab",
    group: "Tabs & headers",
  },
  {
    fg: "panel.header.fg",
    bg: "panel.header.bg",
    base: "panel.bg",
    label: "Panel header",
    group: "Tabs & headers",
  },
  {
    fg: "pane.header.fg",
    bg: "pane.header.bg",
    base: "panel.bg",
    label: "Accordion header",
    group: "Tabs & headers",
  },
  {
    fg: "banner.op.fg",
    bg: "banner.op.bg",
    base: "app.bg",
    label: "Operation banner",
    group: "Tabs & headers",
  },
  {
    fg: "banner.warning.fg",
    bg: "banner.warning.bg",
    base: "app.bg",
    label: "Warning banner",
    group: "Tabs & headers",
  },
  { fg: "button.fg", bg: "button.bg", label: "Default button", group: "Controls" },
  {
    fg: "button.fg",
    bg: "button.hover.bg",
    label: "Default button (hover)",
    group: "Controls",
  },
  { fg: "button.primary.fg", bg: "button.primary.bg", label: "Primary button", group: "Controls" },
  {
    fg: "button.primary.fg",
    bg: "button.primary.hover.bg",
    label: "Primary button (hover)",
    group: "Controls",
  },
  { fg: "button.danger.fg", bg: "button.danger.bg", label: "Danger button", group: "Controls" },
  {
    fg: "button.danger.fg",
    bg: "button.danger.hover.bg",
    label: "Danger button (hover)",
    group: "Controls",
  },
  { fg: "input.fg", bg: "input.bg", label: "Text input", group: "Controls" },
  { fg: "console.fg", bg: "console.bg", label: "Console body", group: "Console" },
  { fg: "console.stderr.fg", bg: "console.bg", label: "Console stderr", group: "Console" },
  { fg: "console.prompt.fg", bg: "console.bg", label: "Console prompt", group: "Console" },
  { fg: "diff.added.fg", bg: "diff.added.bg", base: "panel.bg", label: "Diff added", group: "Diff" },
  {
    fg: "diff.added.fg",
    bg: "diff.added.word.bg",
    base: ["diff.added.bg", "panel.bg"],
    label: "Diff added word",
    group: "Diff",
  },
  {
    fg: "diff.removed.fg",
    bg: "diff.removed.bg",
    base: "panel.bg",
    label: "Diff removed",
    group: "Diff",
  },
  {
    fg: "diff.removed.fg",
    bg: "diff.removed.word.bg",
    base: ["diff.removed.bg", "panel.bg"],
    label: "Diff removed word",
    group: "Diff",
  },
  {
    fg: "diff.gutter.fg",
    bg: "diff.gutter.bg",
    base: "panel.bg",
    label: "Diff gutter",
    group: "Diff",
  },
  {
    fg: "diff.hunk.header.fg",
    bg: "diff.hunk.header.bg",
    base: "panel.bg",
    label: "Hunk header",
    group: "Diff",
  },
  {
    fg: "merge.fold.fg",
    bg: "merge.fold.bg",
    base: "panel.bg",
    label: "Merge folded bar",
    group: "Diff",
  },
  {
    fg: "diff.action.fg",
    bg: "diff.action.bg",
    base: "panel.bg",
    label: "Hunk action button",
    group: "Diff",
  },
  {
    fg: "diff.action.hover.fg",
    bg: "diff.action.hover.bg",
    base: "panel.bg",
    label: "Hunk action button (hover)",
    group: "Diff",
  },
  {
    fg: "diff.discard.fg",
    bg: "diff.discard.bg",
    base: "panel.bg",
    label: "Hunk discard button",
    group: "Diff",
  },
  {
    fg: "diff.discard.hover.fg",
    bg: "diff.discard.hover.bg",
    base: "panel.bg",
    label: "Hunk discard button (hover)",
    group: "Diff",
  },
  {
    fg: "ref.branch.fg",
    bg: "ref.branch.bg",
    base: "panel.bg",
    label: "Branch chip",
    group: "Ref chips",
  },
  {
    fg: "ref.branch.current.fg",
    bg: "ref.branch.current.bg",
    base: "panel.bg",
    label: "Current branch chip",
    group: "Ref chips",
  },
  {
    fg: "ref.remote.fg",
    bg: "ref.remote.bg",
    base: "panel.bg",
    label: "Remote chip",
    group: "Ref chips",
  },
  { fg: "ref.tag.fg", bg: "ref.tag.bg", base: "panel.bg", label: "Tag chip", group: "Ref chips" },
  { fg: "ref.head.fg", bg: "ref.head.bg", base: "panel.bg", label: "HEAD chip", group: "Ref chips" },
  // Syntax colours are read as body text on plain code (AA) and on the diff
  // line washes (3:1 — holding AA there would force either a washed-out
  // syntax palette or near-invisible line tints). The word-highlight pairs
  // are advisory: they inform theme authors but carry no floor — word
  // highlights are character-level emphasis, and any enforceable floor
  // would push the word washes toward invisibility. See
  // design/2026-08-19-contrast-checks-aa.md.
  ...[
    "keyword",
    "string",
    "number",
    "comment",
    "function",
    "type",
    "variable",
    "property",
    "operator",
    "punctuation",
    "constant",
    "tag",
  ].flatMap((s): ContrastPair[] => [
    { fg: `syntax.${s}`, bg: "panel.bg", label: `Syntax ${s}`, group: "Syntax highlighting" },
    {
      fg: `syntax.${s}`,
      bg: "diff.added.bg",
      base: "panel.bg",
      minRatio: 3,
      label: `Syntax ${s} (added)`,
      group: "Syntax highlighting",
    },
    {
      fg: `syntax.${s}`,
      bg: "diff.added.word.bg",
      base: ["diff.added.bg", "panel.bg"],
      advisory: true,
      label: `Syntax ${s} (added word)`,
      group: "Syntax highlighting",
    },
    {
      fg: `syntax.${s}`,
      bg: "diff.removed.bg",
      base: "panel.bg",
      minRatio: 3,
      label: `Syntax ${s} (removed)`,
      group: "Syntax highlighting",
    },
    {
      fg: `syntax.${s}`,
      bg: "diff.removed.word.bg",
      base: ["diff.removed.bg", "panel.bg"],
      advisory: true,
      label: `Syntax ${s} (removed word)`,
      group: "Syntax highlighting",
    },
  ]),
];
