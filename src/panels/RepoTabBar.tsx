import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef } from "react";
import { useRepoStore } from "../store/repos";
import { formatAppError } from "../lib/types";
import { ViewMenu } from "./ViewMenu";
import { RepoOverflowMenu } from "./RepoOverflowMenu";

export function RepoTabBar() {
  const openRepos = useRepoStore((s) => s.openRepos);
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const refresh = useRepoStore((s) => s.refresh);
  const setActive = useRepoStore((s) => s.setActive);
  const closeRepo = useRepoStore((s) => s.closeRepo);
  const openRepo = useRepoStore((s) => s.openRepo);
  const initialized = useRepoStore((s) => s.initialized);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!initialized) refresh();
  }, [initialized, refresh]);

  // Keep the active tab visible when it changes (covers click-from-overflow-menu).
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeRepoId]);

  // Convert vertical wheel into horizontal scroll on the tab strip — matches
  // the behaviour of VS Code, Chrome, etc. when tabs overflow.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || e.shiftKey) return;
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onAdd = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await openRepo(selected);
      }
    } catch (e) {
      window.alert(`Could not open repo: ${formatAppError(e)}`);
    }
  };

  return (
    <div className="legit-tabs" role="tablist">
      <div className="legit-tabs__scroll" ref={scrollerRef}>
        {openRepos.length === 0 && (
          <span className="legit-subtle" style={{ padding: "0 12px", alignSelf: "center" }}>
            No repositories open.
          </span>
        )}
        {openRepos.map((repo) => {
          const isActive = repo.id === activeRepoId;
          return (
            <div
              key={repo.id}
              role="tab"
              aria-selected={isActive}
              ref={isActive ? activeTabRef : null}
              className={`legit-tab${isActive ? " is-active" : ""}`}
              onClick={() => setActive(repo.id)}
              onAuxClick={(e) => {
                // Middle-click closes (browser tab convention).
                if (e.button === 1) {
                  e.preventDefault();
                  closeRepo(repo.id);
                }
              }}
              title={repo.path}
            >
              <span className="legit-tab__name">{repo.name}</span>
              <button
                className="legit-tab__close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeRepo(repo.id);
                }}
                aria-label={`Close ${repo.name}`}
              >
                <svg className="dv-svg" width="11" height="11" viewBox="0 0 28 28" aria-hidden="true">
                  <path d="M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
      <div className="legit-tabs__actions">
        <RepoOverflowMenu />
        <button className="legit-tabs__icon" onClick={onAdd} aria-label="Open repository" title="Open repository">
          +
        </button>
        <ViewMenu />
      </div>
    </div>
  );
}
