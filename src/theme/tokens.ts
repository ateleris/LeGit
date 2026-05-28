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
  { name: "input-bg", documentation: "Background of text inputs." },
  { name: "console-bg", documentation: "Git Console background." },
  { name: "stderr-fg", documentation: "Stderr text in the Git Console." },
] as const;

export const TOKEN_CONTRACT: readonly TokenDescriptor[] = [
  { name: "app.bg", group: "App", documentation: "Top-level app background." },
  { name: "app.fg", group: "App", documentation: "Top-level default text." },

  { name: "panel.bg", group: "Panel", documentation: "Panel body background." },
  { name: "panel.fg", group: "Panel", documentation: "Panel body text." },
  { name: "panel.border", group: "Panel", documentation: "Panel borders and dividers." },
  { name: "panel.header.bg", group: "Panel", documentation: "Panel header background." },
  { name: "panel.header.fg", group: "Panel", documentation: "Panel header text." },

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

  { name: "diff.added.bg", group: "Diff", documentation: "Background for added lines." },
  { name: "diff.added.fg", group: "Diff", documentation: "Foreground for added lines." },
  { name: "diff.removed.bg", group: "Diff", documentation: "Background for removed lines." },
  { name: "diff.removed.fg", group: "Diff", documentation: "Foreground for removed lines." },

  { name: "branch.current.fg", group: "Refs", documentation: "Colour of the current branch label." },
  { name: "commit.signed.indicator", group: "Refs", documentation: "Signed-commit indicator colour." },
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
