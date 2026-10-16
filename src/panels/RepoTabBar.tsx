import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRepoStore } from "../store/repos";
import { useRepoGroupsStore } from "../store/repoGroups";
import {
  APPEND_AT_END,
  buildStripModel,
  collectItemMeta,
  cssColorToHex,
  listGroups,
  refKey,
  type StripNode,
  visibleDepth,
} from "./repoTabStrip/stripModel";
import { DRAG_THRESHOLD, MERGE_DWELL_MS, useGroupedDrag } from "./repoTabStrip/useGroupedDrag";
import { onGlobalSettingsChanged } from "../lib/events";
import type { ItemRef, RepoGroup, RepoGroupsDoc, RepoSummary } from "../lib/types";
import { PanelContextMenuProvider, usePanelContextMenu } from "./shared/menu/PanelContextMenu";
import { MenuItem, SectionLabel, Separator, Submenu } from "./shared/menu/primitives";
import { InlineRenameInput } from "./Commits/cells/InlineRenameInput";
import { formatAppError } from "../lib/errors";
import { api } from "../lib/commands";
import { useEditorAction } from "../lib/editorAction";
import { notify } from "../store/notifications";
import { ExternalEditorIcon, FolderIcon, RemotePageIcon, SuperprojectIcon } from "../icons";
import { ViewMenu } from "./ViewMenu";
import { RepoOverflowMenu } from "./RepoOverflowMenu";
import { RepoAddMenu } from "./RepoAddMenu";
import { CloneTabs } from "./CloneTab";
import { HostBadge } from "./shared/HostBadge";
import { WatchOffBadge } from "./shared/WatchOffBadge";
import { useCloneStore } from "../store/clone";
import { STALE } from "../lib/queryTiming";

export function RepoTabBar() {
  return (
    <PanelContextMenuProvider baseline={[]}>
      <RepoTabBarInner />
    </PanelContextMenuProvider>
  );
}

function RepoTabBarInner() {
  const openRepos = useRepoStore((s) => s.openRepos);
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const refresh = useRepoStore((s) => s.refresh);
  const setActive = useRepoStore((s) => s.setActive);
  const closeRepo = useRepoStore((s) => s.closeRepo);
  const reorderRepos = useRepoStore((s) => s.reorderRepos);
  const initialized = useRepoStore((s) => s.initialized);
  const groupsDoc = useRepoGroupsStore((s) => s.doc);
  const loadGroups = useRepoGroupsStore((s) => s.load);
  const applyGroupsOp = useRepoGroupsStore((s) => s.applyOp);
  const { openMenu, closeMenu } = usePanelContextMenu();
  const groupEls = useRef(new Map<string, HTMLDivElement>());
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const colorInputRef = useRef<HTMLInputElement | null>(null);
  const colorTargetRef = useRef<ItemRef | null>(null);
  /** Where the hidden color input sits: the native picker anchors to it, so
   * it parks under the group being recolored (state - a re-render while the
   * dialog opens must not snap it back to the corner). */
  const [colorInputPos, setColorInputPos] = useState({ left: -100, top: 0 });
  // A selected "Cloning" tab takes the active highlight from the repo tabs:
  // the repo region shows its progress view, not the active repo's panels.
  const cloneFocused = useCloneStore((s) => s.focusedOpId !== null && s.focusedOpId in s.jobs);
  const cloneCount = useCloneStore((s) => Object.keys(s.jobs).length);
  const hasClones = cloneCount > 0;
  const focusClone = useCloneStore((s) => s.focus);
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
  /** Suppress only the click fired by THIS release: when the pointer ends a
   * drag over a different element, no click fires at all, and a sticky flag
   * would swallow the user's next real click instead. */
  const markJustDragged = () => {
    justDragged.current = true;
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
  };
  const desiredLeftRef = useRef(0); // dragged tab's intended left (content space)
  const [order, setOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragX, setDragX] = useState(0);

  // The group-aware drag machine (live preview, dwell-merge, stability).
  const drag = useGroupedDrag({
    tabEls,
    groupEls,
    applyOp: applyGroupsOp,
    onGroupCreated: setRenamingGroupId,
    onDragEnd: markJustDragged,
    isRenaming: () => renamingGroupId != null,
  });
  const { beginItemDrag, draggingKey, mergeTargetKey, previewDoc, floatX, elForKey } = drag;

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

  // The groups doc changes behind our back on settings sync and from the
  // backend's open/close hooks: reload on the settings-changed broadcast.
  useEffect(() => {
    loadGroups();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onGlobalSettingsChanged(() => loadGroups())
      .then((f) => {
        if (disposed) f();
        else unlisten = f;
      })
      .catch(() => {
        /* no event runtime (tests) */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadGroups]);

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

  // The strip shows no scrollbar; a fade on the clipped edge(s) signals the
  // hidden tabs instead. The data attributes drive the CSS mask (global.css).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.toggleAttribute("data-clipped-left", el.scrollLeft > 1);
      el.toggleAttribute("data-clipped-right", el.scrollLeft < max - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
    // groupsDoc: collapsing/expanding a group changes scrollWidth without a
    // box resize, so the fade must re-measure on doc changes too.
  }, [openRepos, cloneCount, groupsDoc]);

  const byId = new Map(openRepos.map((r) => [r.id, r] as const));
  const orderedIds = order ?? openRepos.map((r) => r.id);
  const displayRepos = orderedIds
    .map((id) => byId.get(id))
    .filter((r): r is RepoSummary => r !== undefined);
  const displayDoc = previewDoc ?? groupsDoc;
  const stripNodes = buildStripModel(displayDoc, displayRepos, cloneFocused ? null : activeRepoId);
  const hasGroups = stripNodes.some((n) => n.kind === "group");
  const stripDepth = visibleDepth(stripNodes);
  const renderMeta = collectItemMeta(displayDoc);
  // The drag machine reads the CURRENT layout through this ref while its
  // live preview re-renders the strip.
  drag.layout.current = { stripNodes, renderMeta, displayDoc, groupsDoc, openRepos };

  const previewClass = (ref: ItemRef): string =>
    mergeTargetKey === refKey(ref) ? " is-merge-target" : "";

  /** Style that floats the dragged element under the pointer (grouped drag);
   * its layout box stays in the preview slot and holds the space. */
  const floatStyle = (ref: ItemRef): React.CSSProperties | null =>
    draggingKey === refKey(ref)
      ? {
          transform: `translateX(${floatX}px)`,
          zIndex: 1000,
          transition: "none",
          cursor: "grabbing",
        }
      : null;

  const newGroupWith = (ref: ItemRef) => {
    const before = new Set(listGroups(groupsDoc).map((g) => g.id));
    void applyGroupsOp({ op: "new_group_with", item: ref }).then((doc) => {
      const created = doc && listGroups(doc).find((g) => !before.has(g.id));
      if (created) setRenamingGroupId(created.id);
    });
  };

  const pickItemColor = (target: ItemRef, currentColor: string | null) => {
    const input = colorInputRef.current;
    if (!input) return;
    colorTargetRef.current = target;
    const el = elForKey(refKey(target));
    const rect = el?.getBoundingClientRect();
    if (rect) {
      setColorInputPos({ left: Math.round(rect.left), top: Math.round(rect.bottom) });
      input.style.left = `${Math.round(rect.left)}px`;
      input.style.top = `${Math.round(rect.bottom)}px`;
    }
    const fallback = el ? cssColorToHex(getComputedStyle(el).backgroundColor) : null;
    const initial = (currentColor && cssColorToHex(currentColor)) || fallback;
    if (initial) input.value = initial;
    // The native dialog anchors to the input's last PAINTED position: flush
    // the layout and let a frame commit before opening, or it opens where
    // the input sat the previous time.
    input.getBoundingClientRect();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => input.click());
    });
  };

  const tabMenuSection = (repo: RepoSummary, color: string | null) => {
    const ref: ItemRef = { kind: "repo", locator: repo.locator ?? "" };
    const meta = renderMeta.get(refKey(ref));
    const groups = listGroups(groupsDoc);
    const parentMeta = meta?.parentId != null ? renderMeta.get(`group:${meta.parentId}`) : undefined;
    return (
      <>
        <SectionLabel>{repo.name}</SectionLabel>
        <Submenu label="Move to group" testId="tab-menu-move-to-group">
          {groups
            .filter((g) => g.id !== meta?.parentId)
            .map((g) => (
              <MenuItem
                key={g.id}
                onClick={() => {
                  closeMenu();
                  void applyGroupsOp({
                    op: "move_item",
                    item: ref,
                    parent: g.id,
                    index: APPEND_AT_END,
                  });
                }}
              >
                {g.name}
              </MenuItem>
            ))}
          {groups.length > 0 && <Separator />}
          <MenuItem
            testId="tab-menu-new-group"
            onClick={() => {
              closeMenu();
              newGroupWith(ref);
            }}
          >
            New group...
          </MenuItem>
        </Submenu>
        {meta?.parentId != null && (
          <MenuItem
            testId="tab-menu-remove-from-group"
            onClick={() => {
              closeMenu();
              void applyGroupsOp({
                op: "move_item",
                item: ref,
                parent: parentMeta?.parentId ?? null,
                index: (parentMeta?.index ?? 0) + 1,
              });
            }}
          >
            Remove from group
          </MenuItem>
        )}
        <MenuItem
          testId="tab-menu-color"
          onClick={() => {
            closeMenu();
            pickItemColor(ref, color);
          }}
        >
          Change color...
        </MenuItem>
        {color != null && (
          <MenuItem
            onClick={() => {
              closeMenu();
              void applyGroupsOp({ op: "set_repo_color", locator: ref.locator, color: null });
            }}
          >
            Reset to theme color
          </MenuItem>
        )}
      </>
    );
  };

  const groupMenuSection = (group: RepoGroup) => (
    <>
      <SectionLabel>{group.name}</SectionLabel>
      <MenuItem
        testId="group-menu-rename"
        onClick={() => {
          closeMenu();
          setRenamingGroupId(group.id);
        }}
      >
        Rename
      </MenuItem>
      <MenuItem
        onClick={() => {
          closeMenu();
          void applyGroupsOp({
            op: "set_collapsed",
            group_id: group.id,
            collapsed: !group.collapsed,
          });
        }}
      >
        {group.collapsed ? "Expand" : "Collapse"}
      </MenuItem>
      <MenuItem
        testId="group-menu-ungroup"
        onClick={() => {
          closeMenu();
          void applyGroupsOp({ op: "ungroup", group_id: group.id });
        }}
      >
        Ungroup
      </MenuItem>
      <MenuItem
        testId="group-menu-color"
        onClick={() => {
          closeMenu();
          pickItemColor({ kind: "group", id: group.id }, group.color);
        }}
      >
        Change color...
      </MenuItem>
      {group.color != null && (
        <MenuItem
          onClick={() => {
            closeMenu();
            void applyGroupsOp({ op: "set_color", group_id: group.id, color: null });
          }}
        >
          Reset to theme color
        </MenuItem>
      )}
    </>
  );

  const onGroupClick = (group: RepoGroup) => {
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    void applyGroupsOp({
      op: "set_collapsed",
      group_id: group.id,
      collapsed: !group.collapsed,
    });
  };

  const beginDrag = (e: React.PointerEvent, repoId: string) => {
    if (e.button !== 0) return; // left button only
    // Group-aware drag (merge/move ops) is the drag machine's job; the flat
    // live-reorder below only runs while the strip has no groups.
    if (hasGroups) return;
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
    const locatorOf = (id: string) => openRepos.find((r) => r.id === id)?.locator;
    // Center dwell on a flat strip is the PRIMARY group-creation gesture:
    // resting on another tab's center arms "merge into a new group".
    const dwell = { targetId: null as string | null, since: 0, lastX: e.clientX };
    let dwellTimer: ReturnType<typeof setTimeout> | null = null;
    let mergeTargetId: string | null = null;

    const evaluateDwell = () => {
      if (dwellTimer) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
      }
      const info = dragInfo.current;
      if (!info?.moved) return;
      let hovered: string | null = null;
      for (const [id, tel] of tabEls.current) {
        if (id === info.id || locatorOf(id) == null) continue;
        const r = tel.getBoundingClientRect();
        if (dwell.lastX >= r.left + r.width * 0.25 && dwell.lastX < r.left + r.width * 0.75) {
          hovered = id;
          break;
        }
      }
      if (hovered !== dwell.targetId) {
        dwell.targetId = hovered;
        dwell.since = performance.now();
      }
      const armed =
        hovered != null && performance.now() - dwell.since >= MERGE_DWELL_MS;
      if (armed !== (mergeTargetId != null) || (armed && mergeTargetId !== hovered)) {
        mergeTargetId = armed ? hovered : null;
        const locator = armed && hovered != null ? locatorOf(hovered) : undefined;
        drag.setMergeTarget(
          armed && locator != null ? { kind: "repo", locator } : null,
        );
      }
      if (hovered != null && !armed) {
        dwellTimer = setTimeout(evaluateDwell, MERGE_DWELL_MS - (performance.now() - dwell.since) + 10);
      }
    };

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
      dwell.lastX = ev.clientX;
      evaluateDwell();

      // While the merge preview is armed the order freezes: the dragged tab
      // hovers OVER its target instead of displacing it.
      if (mergeTargetId == null) {
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
      }
      // Keep the dragged tab under the pointer regardless of its slot.
      const dEl = tabEls.current.get(info.id);
      setDragX(desiredLeft - (dEl ? dEl.offsetLeft : 0));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (dwellTimer) clearTimeout(dwellTimer);
      const info = dragInfo.current;
      dragInfo.current = null;
      drag.setMergeTarget(null);
      if (info?.moved) {
        markJustDragged(); // suppress the click that follows
        const draggedLocator = locatorOf(info.id);
        const targetLocator = mergeTargetId != null ? locatorOf(mergeTargetId) : undefined;
        if (draggedLocator != null && targetLocator != null) {
          const before = new Set(listGroups(groupsDoc).map((g) => g.id));
          void applyGroupsOp({
            op: "merge_into_group",
            dragged: { kind: "repo", locator: draggedLocator },
            target: { kind: "repo", locator: targetLocator },
          }).then((doc) => {
            const created = doc && listGroups(doc).find((g) => !before.has(g.id));
            if (created) setRenamingGroupId(created.id);
          });
        } else {
          reorderRepos(orderRef.current);
        }
      }
      orderRef.current = [];
      setOrder(null);
      setDraggingId(null);
      setDragX(0);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const editorAction = useEditorAction(activeRepoId ?? undefined);
  const onOpenInEditor = async () => {
    if (!activeRepoId) return;
    try {
      await api.repoOpenInEditor(activeRepoId);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };
  const onOpenFolder = async () => {
    if (!activeRepoId) return;
    try {
      await api.repoOpenFolder(activeRepoId);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  // The remote web page of the active repo (null = no remote / no web form).
  // Keyed under the "remotes" domain so remote add/remove invalidations
  // refresh the button's enabled state.
  const { data: remoteWebUrl = null } = useQuery<string | null>({
    queryKey: [activeRepoId, "remotes", "web-url"],
    queryFn: () => api.repoRemoteWebUrl(activeRepoId!),
    enabled: !!activeRepoId,
    staleTime: STALE.stable,
  });
  const onOpenRemotePage = async () => {
    if (!activeRepoId) return;
    try {
      await api.repoOpenRemotePage(activeRepoId);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  // The superproject working tree when the active repo is a submodule
  // checkout (null otherwise). The value only changes when the repo is
  // re-parented on disk, so a long staleTime is fine.
  const openRepoFromStore = useRepoStore((s) => s.openRepo);
  const { data: superprojectPath = null } = useQuery<string | null>({
    queryKey: [activeRepoId, "superproject"],
    queryFn: () => api.repoSuperproject(activeRepoId!),
    enabled: !!activeRepoId,
    staleTime: STALE.rare,
  });
  const onOpenSuperproject = async () => {
    if (!superprojectPath) return;
    try {
      await openRepoFromStore(superprojectPath);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  const renderRepoTab = (repo: RepoSummary, depth = 0, rowZ = 0, color: string | null = null) => {
    const isActive = repo.id === activeRepoId && !cloneFocused;
    const isDragging = draggingId === repo.id;
    const ref: ItemRef = { kind: "repo", locator: repo.locator ?? "" };
    // Per-repo color override (user data): the active highlight wins, so
    // the current repo stays unmistakable.
    const colorOverride =
      !isActive && color
        ? ({ background: color, "--legit-tab-fillet-bg": color } as React.CSSProperties)
        : null;
    // Pill mode: every pill sits on the shared baseline of the deepest
    // nesting level (consumed only by the pill-style CSS).
    const pillLift = Math.max(stripDepth - depth, 0);
    return (
      <div
        key={repo.id}
              role="tab"
              data-testid="repo-tab"
              aria-selected={isActive}
              ref={(el) => {
                if (el) tabEls.current.set(repo.id, el);
                else tabEls.current.delete(repo.id);
                if (isActive) activeTabRef.current = el;
              }}
              className={`legit-tab${isActive ? " is-active" : ""}${previewClass(ref)}`}
              onPointerDown={(e) => (hasGroups ? beginItemDrag(e, ref) : beginDrag(e, repo.id))}
              onContextMenu={(e) => openMenu(e, tabMenuSection(repo, color))}
              onClick={() => {
                if (justDragged.current) {
                  justDragged.current = false; // this click ends a drag — ignore it
                  return;
                }
                // Explicit, not left to the activeRepoId subscription: clicking
                // the repo that was already active (the common case - the clone
                // tab took over from it) changes no store value, so only this
                // call brings its panels back.
                focusClone(null);
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
                // Browser style: items layer left over right within a row;
                // the active tab tops its row, a dragged item tops everything.
                zIndex: isDragging ? 1000 : isActive ? 999 : rowZ,
                transition: isDragging ? "none" : undefined,
                cursor: isDragging ? "grabbing" : undefined,
                ...({ "--legit-pill-lift": pillLift } as React.CSSProperties),
                ...colorOverride,
                ...floatStyle(ref),
              }}
              title={repo.path}
            >
              {repo.host && <HostBadge distro={repo.host.distro} />}
              {repo.watch_error != null && <WatchOffBadge reason={repo.watch_error} />}
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
  };

  const renderGroupName = (group: RepoGroup) =>
    renamingGroupId === group.id ? (
      <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <InlineRenameInput
          initialValue={group.name}
          title="Group name"
          cancelOnBlur
          allowEmpty
          style={{
            fontSize: "var(--fz-sm)",
            height: "calc(var(--ui-font-size) * 1.25)",
            width: `${Math.min(Math.max(group.name.length + 3, 10), 30)}ch`,
            padding: "0 0.4em",
            background: "var(--input-bg)",
            color: "var(--input-fg)",
            border: "1px solid var(--input-focus-border)",
            borderRadius: "0.33em",
          }}
          onSave={(name) => {
            setRenamingGroupId(null);
            void applyGroupsOp({ op: "rename", group_id: group.id, name });
          }}
          onCancel={() => setRenamingGroupId(null)}
        />
      </span>
    ) : (
      <span>{group.name}</span>
    );

  const renderNode = (node: StripNode, rowZ = 0): React.ReactNode => {
    if (node.kind === "repo") return renderRepoTab(node.repo, node.depth, rowZ, node.color);
    const { group } = node;
    const ref: ItemRef = { kind: "group", id: group.id };
    // Plain `background`, never an inline --group-bg: a custom property
    // would inherit into nested groups and recolor them too. The fillet var
    // is safe to set inline: every container re-declares it in CSS.
    const colorOverride = group.color
      ? ({ background: group.color, "--legit-group-flare": group.color } as React.CSSProperties)
      : undefined;
    if (group.collapsed) {
      // Collapse never changes the group's height: the body stretches by the
      // hidden subtree's depth so a depth-2 group stays depth-2 tall.
      const innerDepth = visibleDepth(node.children);
      const collapsedStyle = {
        ...colorOverride,
        // The chain holding the active repo tops every row it crosses, so
        // the active tab reads frontmost regardless of nesting.
        zIndex: node.containsActive ? 999 : rowZ,
        "--legit-group-nest": innerDepth,
        ...(innerDepth > 0 ? { "--legit-group-inner-depth": innerDepth } : null),
        ...floatStyle(ref),
      } as React.CSSProperties;
      return (
        <div
          key={`group-${group.id}`}
          ref={(el) => {
            if (el) groupEls.current.set(group.id, el);
            else groupEls.current.delete(group.id);
          }}
          className={`legit-tab-group is-collapsed${node.containsActive ? " has-active" : ""}${previewClass(ref)}`}
          style={collapsedStyle}
          data-testid="repo-group-chip"
          title={group.name}
          onPointerDown={(e) => beginItemDrag(e, ref)}
          onClick={() => onGroupClick(group)}
          onContextMenu={(e) => openMenu(e, groupMenuSection(group))}
        >
          <span className="legit-tab-group__fillet is-left" aria-hidden="true" />
          <span className="legit-tab-group__fillet is-right" aria-hidden="true" />
          <div className="legit-tab-group__header">{renderGroupName(group)}</div>
          <div className="legit-tab-group__tabs">
            <div
              className="legit-tab-group__count"
              style={
                {
                  "--legit-pill-lift": Math.max(stripDepth - node.depth - 1, 0),
                } as React.CSSProperties
              }
            >
              <span>{node.openCount}</span>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div
        key={`group-${group.id}`}
        ref={(el) => {
          if (el) groupEls.current.set(group.id, el);
          else groupEls.current.delete(group.id);
        }}
        className={`legit-tab-group${previewClass(ref)}`}
        style={
          {
            ...colorOverride,
            zIndex: node.containsActive ? 999 : rowZ,
            "--legit-group-nest": visibleDepth(node.children),
            ...floatStyle(ref),
          } as React.CSSProperties
        }
        data-testid="repo-group"
      >
        <span className="legit-tab-group__fillet is-left" aria-hidden="true" />
        <span className="legit-tab-group__fillet is-right" aria-hidden="true" />
        <div
          className="legit-tab-group__header"
          title={group.name}
          onPointerDown={(e) => beginItemDrag(e, ref)}
          onClick={() => onGroupClick(group)}
          onContextMenu={(e) => openMenu(e, groupMenuSection(group))}
        >
          {renderGroupName(group)}
        </div>
        <div className="legit-tab-group__tabs">
          {node.children.length > 0 ? (
            node.children.map((c, i) => renderNode(c, node.children.length - i))
          ) : (
            // A group emptied mid-drag (kept until the drop) holds the
            // height a member would occupy, lift included.
            <div
              className="legit-tab-group__spacer"
              style={
                {
                  "--legit-pill-lift": Math.max(stripDepth - node.depth - 1, 0),
                } as React.CSSProperties
              }
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="legit-tabs" role="tablist">
      <div className={`legit-tabs__scroll${hasGroups ? " has-groups" : ""}`} ref={scrollerRef}>
        {openRepos.length === 0 && !hasClones && (
          <span className="legit-subtle" style={{ padding: "0 1em", alignSelf: "center" }}>
            No repositories open.
          </span>
        )}
        {stripNodes.map((n, i) => renderNode(n, stripNodes.length - i))}
        <CloneTabs />
      </div>
      {/* Hidden driver for "Change color...": the native picker, fed the
          group's current colour, commits on dismissal. */}
      <input
        ref={colorInputRef}
        type="color"
        tabIndex={-1}
        aria-hidden="true"
        style={{
          position: "fixed",
          left: colorInputPos.left,
          top: colorInputPos.top,
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
        onChange={(e) => {
          const target = colorTargetRef.current;
          if (target?.kind === "group") {
            void applyGroupsOp({ op: "set_color", group_id: target.id, color: e.target.value });
          } else if (target?.kind === "repo") {
            void applyGroupsOp({
              op: "set_repo_color",
              locator: target.locator,
              color: e.target.value,
            });
          }
        }}
      />
      <div className="legit-tabs__actions">
        <RepoOverflowMenu />
        {activeRepoId && (
          <>
            {superprojectPath && (
              <button
                className="legit-tabs__icon"
                onClick={onOpenSuperproject}
                aria-label={`Open superproject ${superprojectPath}`}
                title={`This repo is a submodule - open its superproject (${superprojectPath})`}
              >
                <SuperprojectIcon />
              </button>
            )}
            <button
              className="legit-tabs__icon"
              onClick={onOpenFolder}
              aria-label="Open in folder"
              title="Open in folder"
            >
              <FolderIcon />
            </button>
            {editorAction.configured && (
              <button
                className="legit-tabs__icon"
                onClick={onOpenInEditor}
                aria-label={editorAction.label}
                title={editorAction.label}
              >
                <ExternalEditorIcon />
              </button>
            )}
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
