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
  { name: "diff-removed-line", documentation: "Whole-line background for a removed/modified diff line (light tint)." },
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

  { name: "panel.bg", group: "Panel", documentation: "Panel body background." },
  { name: "panel.fg", group: "Panel", documentation: "Panel body text." },
  { name: "panel.border", group: "Panel", documentation: "Panel borders and dividers." },
  { name: "panel.border.drag", group: "Panel", documentation: "Highlight of a panel divider while it is hovered/dragged for resizing." },
  { name: "panel.header.bg", group: "Panel", documentation: "Panel header background." },
  { name: "panel.header.fg", group: "Panel", documentation: "Panel header text." },
  { name: "pane.header.bg", group: "Panel", documentation: "Accordion section header background (e.g. the Refs panel's Branches/Remotes/Stashes headers)." },
  { name: "pane.header.fg", group: "Panel", documentation: "Accordion section header text." },
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

  { name: "panel-tab.bg", group: "Panel Tabs", documentation: "Panel tab strip background (dockview panels)." },
  { name: "panel-tab.fg", group: "Panel Tabs", documentation: "Inactive panel tab text." },
  { name: "panel-tab.active.bg", group: "Panel Tabs", documentation: "Active panel tab background." },
  { name: "panel-tab.active.fg", group: "Panel Tabs", documentation: "Active panel tab text." },
  { name: "panel-tab.border", group: "Panel Tabs", documentation: "Panel tab strip border." },

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
  { name: "op.banner.bg", group: "Working Changes", documentation: "Background of the merge/rebase-in-progress banner." },
  { name: "op.banner.fg", group: "Working Changes", documentation: "Text of the merge/rebase-in-progress banner." },
  { name: "diff.action.bg", group: "Diff", documentation: "Background of the hunk stage/unstage buttons." },
  { name: "diff.action.fg", group: "Diff", documentation: "Text of the hunk stage/unstage buttons." },
  { name: "diff.action.hover.bg", group: "Diff", documentation: "Background of the hunk stage/unstage buttons on hover." },
  { name: "diff.action.hover.fg", group: "Diff", documentation: "Text of the hunk stage/unstage buttons on hover." },
  { name: "diff.discard.bg", group: "Diff", documentation: "Background of the hunk discard button (destructive)." },
  { name: "diff.discard.fg", group: "Diff", documentation: "Text of the hunk discard button." },
  { name: "diff.discard.hover.bg", group: "Diff", documentation: "Background of the hunk discard button on hover." },
  { name: "diff.discard.hover.fg", group: "Diff", documentation: "Text of the hunk discard button on hover." },
  { name: "blame.alt.bg", group: "Blame", documentation: "Background of the alternating (every-other) commit rows in the Blame panel." },

  { name: "syntax.keyword", group: "Syntax", documentation: "Keywords (`if`, `fn`, `const`, ...) in the diff viewer's code." },
  { name: "syntax.string", group: "Syntax", documentation: "String, character, and regexp literals." },
  { name: "syntax.number", group: "Syntax", documentation: "Numeric literals." },
  { name: "syntax.comment", group: "Syntax", documentation: "Comments and preprocessor/meta lines." },
  { name: "syntax.function", group: "Syntax", documentation: "Function and macro names." },
  { name: "syntax.type", group: "Syntax", documentation: "Type, class, and namespace names." },
  { name: "syntax.variable", group: "Syntax", documentation: "Variable names." },
  { name: "syntax.property", group: "Syntax", documentation: "Object properties and markup attribute names." },
  { name: "syntax.operator", group: "Syntax", documentation: "Operators." },
  { name: "syntax.punctuation", group: "Syntax", documentation: "Punctuation and brackets." },
  { name: "syntax.constant", group: "Syntax", documentation: "Built-in constants (`true`, `null`, `self`, ...)." },
  { name: "syntax.tag", group: "Syntax", documentation: "Markup tag names and headings." },

  { name: "menu.hover.bg", group: "Menus", documentation: "Background of a hovered context-menu item." },

  { name: "branch.current.fg", group: "Refs", documentation: "Colour of the current branch label." },
  { name: "commit.signed.indicator", group: "Refs", documentation: "Signed-commit indicator colour." },

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
  { name: "graph.row.hover.bg", group: "Graph", documentation: "Background of a hovered commit row." },

  { name: "status.added", group: "File Status", documentation: "Added-file icon and +N line count (Changed Files panel)." },
  { name: "status.modified", group: "File Status", documentation: "Modified-file icon." },
  { name: "status.deleted", group: "File Status", documentation: "Deleted-file icon and −N line count." },
  { name: "status.renamed", group: "File Status", documentation: "Renamed-file icon." },
  { name: "status.copied", group: "File Status", documentation: "Copied-file icon." },
  { name: "status.conflicted", group: "File Status", documentation: "Conflicted-file icon." },
] as const;

/** Pairs whose contrast the editor surfaces for the user. */
export const CONTRAST_PAIRS: readonly { fg: string; bg: string; label: string }[] = [
  { fg: "panel.fg", bg: "panel.bg", label: "Panel body" },
  { fg: "tab.active.fg", bg: "tab.active.bg", label: "Active tab" },
  { fg: "button.fg", bg: "button.bg", label: "Default button" },
  { fg: "button.primary.fg", bg: "button.primary.bg", label: "Primary button" },
  { fg: "input.fg", bg: "input.bg", label: "Text input" },
  { fg: "console.fg", bg: "console.bg", label: "Console body" },
  { fg: "console.stderr.fg", bg: "console.bg", label: "Console stderr" },
  { fg: "diff.added.fg", bg: "diff.added.bg", label: "Diff added" },
  { fg: "diff.removed.fg", bg: "diff.removed.bg", label: "Diff removed" },
] as const;
