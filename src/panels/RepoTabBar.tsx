import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRepoStore } from "../store/repos";
import { formatAppError } from "../lib/types";
import { repoOpenInEditor, repoOpenRemotePage, repoRemoteWebUrl } from "../lib/commands";
import { useEditorActionLabel } from "../lib/editorAction";
import { notify } from "../store/notifications";
import { ExternalEditorIcon, RemotePageIcon } from "../icons";
import { ViewMenu } from "./ViewMenu";
import { RepoOverflowMenu } from "./RepoOverflowMenu";
import { RepoAddMenu } from "./RepoAddMenu";

const DRAG_THRESHOLD = 4; // px before a press becomes a drag

export function RepoTabBar() {
  const openRepos = useRepoStore((s) => s.openRepos);
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const refresh = useRepoStore((s) => s.refresh);
  const setActive = useRepoStore((s) => s.setActive);
  const closeRepo = useRepoStore((s) => s.closeRepo);
  const reorderRepos = useRepoStore((s) => s.reorderRepos);
  const initialized = useRepoStore((s) => s.initialized);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);

  // Live horizontal drag-to-reorder (Gitnuro-style): the grabbed tab follows the
  // pointer and the order updates live so it lands where it's dragged. `order`
  // (ids) is the live ordering during a drag; null when idle. We commit to the
  // store only on release.
  const tabEls = useRef(new Map<string, HTMLDivElement>());
  const dragInfo = useRef<{ id: string; grabOffset: number; width: number; startX: number; moved: boolean } | null>(null);
  const orderRef = useRef<string[]>([]);
  const justDragged = useRef(false);
  const desiredLeftRef = useRef(0); // dragged tab's intended left (content space)
  const [order, setOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragX, setDragX] = useState(0);

  // After the order changes mid-drag the dragged tab moves to a new slot; its
  // base offsetLeft changed, so recompute the follow offset against the new
  // layout (synchronously, before paint) to avoid a one-frame jump.
  useLayoutEffect(() => {
    const info = dragInfo.current;
    if (!info || order === null) return;
    const el = tabEls.current.get(info.id);
    if (el) setDragX(desiredLeftRef.current - el.offsetLeft);
  }, [order]);

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

  const beginDrag = (e: React.PointerEvent, repoId: string) => {
    if (e.button !== 0) return; // left button only
    // Don't start a drag from the close button.
    if ((e.target as HTMLElement).closest(".legit-tab__close")) return;
    const scroller = scrollerRef.current;
    const el = tabEls.current.get(repoId);
    if (!scroller || !el) return;

    const sRect = scroller.getBoundingClientRect();
    const pointerContentX = e.clientX - sRect.left + scroller.scrollLeft;
    dragInfo.current = {
      id: repoId,
      grabOffset: pointerContentX - el.offsetLeft, // where in the tab it was grabbed
      width: el.offsetWidth,
      startX: e.clientX,
      moved: false,
    };
    orderRef.current = openRepos.map((r) => r.id);

    const onMove = (ev: PointerEvent) => {
      const info = dragInfo.current;
      const sc = scrollerRef.current;
      if (!info || !sc) return;
      if (!info.moved) {
        if (Math.abs(ev.clientX - info.startX) < DRAG_THRESHOLD) return;
        info.moved = true;
        setDraggingId(info.id);
        setOrder(orderRef.current.slice());
      }
      const rect = sc.getBoundingClientRect();
      const pointerX = ev.clientX - rect.left + sc.scrollLeft;
      const desiredLeft = pointerX - info.grabOffset;
      desiredLeftRef.current = desiredLeft;
      const draggedCenter = desiredLeft + info.width / 2;

      // Insert before the first tab whose centre is right of the dragged centre.
      const ids = orderRef.current;
      let target = 0;
      for (const id of ids) {
        if (id === info.id) continue;
        const tel = tabEls.current.get(id);
        if (!tel) continue;
        if (tel.offsetLeft + tel.offsetWidth / 2 < draggedCenter) target++;
      }
      const without = ids.filter((id) => id !== info.id);
      without.splice(target, 0, info.id);
      if (without.some((id, i) => id !== ids[i])) {
        orderRef.current = without;
        setOrder(without);
      }
      // Keep the dragged tab under the pointer regardless of its slot.
      const dEl = tabEls.current.get(info.id);
      setDragX(desiredLeft - (dEl ? dEl.offsetLeft : 0));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const info = dragInfo.current;
      dragInfo.current = null;
      if (info?.moved) {
        justDragged.current = true; // suppress the click that follows
        reorderRepos(orderRef.current);
      }
      orderRef.current = [];
      setOrder(null);
      setDraggingId(null);
      setDragX(0);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const editorLabel = useEditorActionLabel(activeRepoId ?? undefined);
  const onOpenInEditor = async () => {
    if (!activeRepoId) return;
    try {
      await repoOpenInEditor(activeRepoId);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  // The remote web page of the active repo (null = no remote / no web form).
  // Keyed under the "remotes" domain so remote add/remove invalidations
  // refresh the button's enabled state.
  const { data: remoteWebUrl = null } = useQuery<string | null>({
    queryKey: [activeRepoId, "remotes", "web-url"],
    queryFn: () => repoRemoteWebUrl(activeRepoId!),
    enabled: !!activeRepoId,
    staleTime: 60_000,
  });
  const onOpenRemotePage = async () => {
    if (!activeRepoId) return;
    try {
      await repoOpenRemotePage(activeRepoId);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  const byId = new Map(openRepos.map((r) => [r.id, r] as const));
  const orderedIds = order ?? openRepos.map((r) => r.id);

  return (
    <div className="legit-tabs" role="tablist">
      <div className="legit-tabs__scroll" ref={scrollerRef}>
        {openRepos.length === 0 && (
          <span className="legit-subtle" style={{ padding: "0 12px", alignSelf: "center" }}>
            No repositories open.
          </span>
        )}
        {orderedIds.map((id) => {
          const repo = byId.get(id);
          if (!repo) return null;
          const isActive = repo.id === activeRepoId;
          const isDragging = draggingId === repo.id;
          return (
            <div
              key={repo.id}
              role="tab"
              aria-selected={isActive}
              ref={(el) => {
                if (el) tabEls.current.set(repo.id, el);
                else tabEls.current.delete(repo.id);
                if (isActive) activeTabRef.current = el;
              }}
              className={`legit-tab${isActive ? " is-active" : ""}`}
              onPointerDown={(e) => beginDrag(e, repo.id)}
              onClick={() => {
                if (justDragged.current) {
                  justDragged.current = false; // this click ends a drag — ignore it
                  return;
                }
                setActive(repo.id);
              }}
              onAuxClick={(e) => {
                // Middle-click closes (browser tab convention).
                if (e.button === 1) {
                  e.preventDefault();
                  closeRepo(repo.id);
                }
              }}
              style={{
                userSelect: "none",
                transform: isDragging ? `translateX(${dragX}px)` : undefined,
                zIndex: isDragging ? 2 : undefined,
                transition: isDragging ? "none" : undefined,
                cursor: isDragging ? "grabbing" : undefined,
                opacity: isDragging ? 0.9 : undefined,
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
        {activeRepoId && (
          <>
            <button
              className="legit-tabs__icon"
              onClick={onOpenInEditor}
              aria-label={editorLabel}
              title={editorLabel}
            >
              <ExternalEditorIcon />
            </button>
            <button
              className="legit-tabs__icon"
              onClick={onOpenRemotePage}
              disabled={!remoteWebUrl}
              aria-label={remoteWebUrl ? `Open ${remoteWebUrl} in browser` : "No remote web page"}
              title={remoteWebUrl ? `Open ${remoteWebUrl} in browser` : "No remote web page"}
              style={!remoteWebUrl ? { opacity: 0.4, cursor: "default" } : undefined}
            >
              <RemotePageIcon />
            </button>
          </>
        )}
        <RepoAddMenu />
        <ViewMenu />
      </div>
    </div>
  );
}
