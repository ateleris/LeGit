import { useEffect, useRef, useState } from "react";
import { useRepoStore } from "../store/repos";
import { repoOpenInEditor } from "../lib/commands";
import { editorActionLabel, editorOpensFolder, effectiveEditorTemplate } from "../lib/editorAction";
import { useSettingsStore } from "../store/settings";
import { formatAppError } from "../lib/types";
import type { RepoSummary } from "../lib/types";
import { notify } from "../store/notifications";
import { ExternalEditorIcon, FolderIcon } from "../icons";
import { SectionLabel } from "./Commits/menu/primitives";
import { IconButton } from "./shared/buttons";

/** One repo entry in the dropdown. Hover feedback matches the View menu's
 * entries (`--menu-hover-bg`); the active repo is marked by the dot only,
 * not a background (user decision 2026-08-06). */
function RepoRow({
  repo,
  isActive,
  editorTemplate,
  onActivate,
  onOpenEditor,
  onClose,
}: {
  repo: RepoSummary;
  isActive: boolean;
  editorTemplate: string;
  onActivate: () => void;
  onOpenEditor: () => void;
  onClose: () => void;
}) {
  const [hover, setHover] = useState(false);
  const editorLabel = editorActionLabel(editorTemplate);
  const opensFolder = editorOpensFolder(editorTemplate);
  return (
    <div
      role="menuitem"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        borderRadius: 3,
        background: hover ? "var(--menu-hover-bg, rgba(255,255,255,0.08))" : "transparent",
        cursor: "pointer",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onActivate}
    >
      <span style={{ display: "inline-block", width: 14, textAlign: "center" }}>
        {isActive ? "●" : ""}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {repo.name}
        </div>
        <div
          className="legit-subtle"
          style={{
            fontSize: "var(--fz-sm)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {repo.path}
        </div>
      </div>
      <IconButton
        aria-label={`${editorLabel}: ${repo.name}`}
        title={editorLabel}
        onClick={(e) => {
          e.stopPropagation();
          onOpenEditor();
        }}
        style={{ color: "inherit", fontSize: "inherit", padding: "0 4px" }}
      >
        {opensFolder ? <FolderIcon /> : <ExternalEditorIcon />}
      </IconButton>
      <IconButton
        aria-label={`Close ${repo.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ color: "inherit", fontSize: "inherit", padding: "0 4px" }}
      >
        ×
      </IconButton>
    </div>
  );
}

/**
 * Dropdown that lists every open repo, so a user can jump to a buried tab
 * even when it's scrolled off-screen. Pinned to the right of the tab strip
 * next to the `+` and View menu.
 */
export function RepoOverflowMenu() {
  const repos = useRepoStore((s) => s.openRepos);
  const activeId = useRepoStore((s) => s.activeRepoId);
  const setActive = useRepoStore((s) => s.setActive);
  const closeRepo = useRepoStore((s) => s.closeRepo);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Per-row editor labels: a repo-scope override wins over the global template.
  const repoSettingsMap = useRepoStore((s) => s.repoSettings);
  const globalEditorTemplate = useSettingsStore(
    (s) => s.settings?.external_editor_command ?? "",
  );

  // Capture phase: a stopPropagation in another panel must not keep it open
  // (same rule as the shared context menus).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, { capture: true });
    return () => document.removeEventListener("mousedown", onDown, { capture: true });
  }, [open]);

  if (repos.length === 0) return null;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="All open repositories"
      >
        ⋯ {repos.length}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 280,
            maxHeight: 400,
            overflowY: "auto",
            background: "var(--panel-bg)",
            color: "var(--panel-fg)",
            border: "1px solid var(--panel-border)",
            borderRadius: 4,
            boxShadow: "0 4px 10px var(--shadow-color)",
            zIndex: 1000,
            padding: 4,
          }}
        >
          <SectionLabel>Open repositories</SectionLabel>
          {repos.map((r) => {
            const editorTemplate = effectiveEditorTemplate(
              repoSettingsMap[r.id]?.external_editor_command,
              globalEditorTemplate,
            );
            return (
              <RepoRow
                key={r.id}
                repo={r}
                isActive={r.id === activeId}
                editorTemplate={editorTemplate}
                onActivate={() => {
                  setActive(r.id);
                  setOpen(false);
                }}
                onOpenEditor={() => {
                  setOpen(false);
                  repoOpenInEditor(r.id).catch((err) => notify.error(formatAppError(err)));
                }}
                onClose={() => closeRepo(r.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
