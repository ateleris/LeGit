import { useEffect, useRef, useState } from "react";
import { useRepoStore } from "../store/repos";
import { SectionLabel } from "./Commits/menu/primitives";
import { IconButton } from "./shared/buttons";

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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
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
            const isActive = r.id === activeId;
            return (
              <div
                key={r.id}
                role="menuitem"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  borderRadius: 3,
                  background: isActive ? "var(--tab-active-bg)" : "transparent",
                  color: isActive ? "var(--tab-active-fg)" : "inherit",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setActive(r.id);
                  setOpen(false);
                }}
              >
                <span style={{ display: "inline-block", width: 14, textAlign: "center" }}>
                  {isActive ? "●" : ""}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.name}
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
                    {r.path}
                  </div>
                </div>
                <IconButton
                  aria-label={`Close ${r.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeRepo(r.id);
                  }}
                  style={{ color: "inherit", fontSize: "inherit", padding: "0 4px" }}
                >
                  ×
                </IconButton>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
