import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useRef, useState } from "react";
import { api } from "../../lib/commands";
import { formatAppError } from "../../lib/errors";
import { DeleteIcon, DragHandleIcon, RenameIcon } from "../../icons";
import { confirmDestructiveAction } from "../../store/confirm";
import { useLayoutsStore } from "../../store/layouts";
import { notify } from "../../store/notifications";
import { InlineRenameInput } from "../Commits/cells/InlineRenameInput";
import { asLayoutBundle, asLayoutDocument, buildLayoutBundle } from "../../layout/namedLayouts";
import type { LayoutDocument } from "../../lib/types";
import { Button, IconButton } from "../shared/buttons";
import { useRowDragReorder } from "../shared/useRowDragReorder";
import { LayoutShortcutChip } from "./LayoutShortcutChip";

/**
 * Manage saved panel layouts (the View menu is the fast switch path): save
 * the current arrangement under a name, apply/override/rename/delete saved
 * ones, import/export layout files, and reset the docks to the built-in
 * default.
 */
export function LayoutsPanel() {
  const layouts = useLayoutsStore((s) => s.layouts);
  const lastApplied = useLayoutsStore((s) => s.lastApplied);
  const saveCurrent = useLayoutsStore((s) => s.saveCurrent);
  const apply = useLayoutsStore((s) => s.apply);
  const rename = useLayoutsStore((s) => s.rename);
  const remove = useLayoutsStore((s) => s.remove);
  const importDocument = useLayoutsStore((s) => s.importDocument);
  const resetToDefault = useLayoutsStore((s) => s.resetToDefault);
  const setOrder = useLayoutsStore((s) => s.setOrder);

  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  // Live order during a drag; null = the saved order from the store.
  const [liveOrder, setLiveOrder] = useState<string[] | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const order = liveOrder ?? layouts.map((l) => l.name);
  const { draggingKey, dragY, registerItem, beginDrag } = useRowDragReorder({
    container: listRef,
    order,
    onReorder: setLiveOrder,
    onDrop: (next, changed) => {
      setLiveOrder(null);
      if (changed) void run(() => setOrder(next));
    },
    // The hook lets presses through to inputs, so a rename would start a drag.
    disabled: renaming !== null,
  });

  const nameTaken = (name: string) => layouts.some((l) => l.name === name);

  const onSaveCurrent = () =>
    run(async () => {
      const name = newName.trim();
      if (!name) return;
      // Saving under an existing name IS the override action - same
      // confirmation as the per-row Override button.
      if (nameTaken(name)) {
        const ok = await confirmDestructiveAction({
          title: "Override layout",
          message: "Replaces the saved layout with the current arrangement.",
          detail: name,
          confirmLabel: "Override",
        });
        if (!ok) return;
      }
      await saveCurrent(name);
      setNewName("");
    });

  const onOverride = (name: string) =>
    run(async () => {
      const ok = await confirmDestructiveAction({
        title: "Override layout",
        message: "Replaces the saved layout with the current arrangement.",
        detail: name,
        confirmLabel: "Override",
      });
      if (!ok) return;
      await saveCurrent(name);
    });

  const onDelete = (name: string) =>
    run(async () => {
      const ok = await confirmDestructiveAction({
        title: "Delete layout",
        message: "Deletes the saved layout file.",
        detail: name,
        confirmLabel: "Delete layout",
      });
      if (!ok) return;
      await remove(name);
    });

  const onRename = (oldName: string, next: string) =>
    run(async () => {
      setRenaming(null);
      if (nameTaken(next)) {
        notify.error(`A layout named "${next}" already exists.`);
        return;
      }
      await rename(oldName, next);
    });

  const onExport = (name: string) =>
    run(async () => {
      const path = await saveDialog({
        defaultPath: `${name}.legit-layout.json`,
        filters: [{ name: "LeGit Layout", extensions: ["legit-layout.json", "json"] }],
      });
      if (!path) return;
      const doc = await api.loadLayout(name);
      await writeTextFile(path, JSON.stringify(doc, null, 2));
    });

  const onExportAll = () =>
    run(async () => {
      const path = await saveDialog({
        defaultPath: "legit-layouts.json",
        filters: [{ name: "LeGit Layouts", extensions: ["json"] }],
      });
      if (!path) return;
      const docs: LayoutDocument[] = [];
      for (const l of layouts) {
        const doc = asLayoutDocument(await api.loadLayout(l.name));
        if (doc) docs.push(doc);
      }
      await writeTextFile(path, JSON.stringify(buildLayoutBundle(docs), null, 2));
    });

  // One Import button for both file kinds: a single layout and a bundle of
  // the whole set (exported above, e.g. when moving to a new machine).
  const onImport = () =>
    run(async () => {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "LeGit Layout", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const text = await readTextFile(path);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        notify.error("Not a JSON file.");
        return;
      }
      const bundle = asLayoutBundle(json);
      if (bundle) {
        // Sequential: each import picks its unique name against the list the
        // previous one refreshed.
        for (const doc of bundle) await importDocument(doc);
        notify.success(
          bundle.length === 1
            ? `Imported 1 layout.`
            : `Imported ${bundle.length} layouts.`,
        );
        return;
      }
      const doc = asLayoutDocument(json);
      if (!doc) {
        notify.error("Not a valid LeGit layout file.");
        return;
      }
      const fileStem = path.replace(/^.*[/\\]/, "").replace(/\.legit-layout\.json$/i, "").replace(/\.json$/i, "");
      const name = await importDocument(doc, fileStem || doc.name);
      notify.success(`Imported layout "${name}".`);
    });

  return (
    <div className="legit-panel">
      <div className="legit-panel__toolbar" style={{ flexWrap: "wrap" }}>
        <input
          data-testid="layouts-new-name"
          placeholder="New layout name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onSaveCurrent();
          }}
        />
        <Button
          variant="primary"
          onClick={() => void onSaveCurrent()}
          disabled={newName.trim().length === 0}
          title="Save the current arrangement of both docks as a named layout"
        >
          Save current
        </Button>
        <button onClick={() => void onImport()} title="Import a layout file or an exported layout set">
          Import…
        </button>
        <button
          onClick={() => void onExportAll()}
          disabled={layouts.length === 0}
          title="Export all saved layouts into one file"
        >
          Export all…
        </button>
        <button
          onClick={resetToDefault}
          title="Rebuild both docks' built-in default layout (saved layouts are unaffected)"
        >
          Reset to default layout
        </button>
      </div>
      <div className="legit-panel__body" ref={listRef} style={{ position: "relative" }}>
        {layouts.length > 1 && (
          <p className="legit-subtle" style={{ margin: "0 0 0.5em" }}>
            Drag rows to reorder - the "Apply saved layout N" shortcuts follow this order.
          </p>
        )}
        {layouts.length === 0 ? (
          <p className="legit-subtle">
            No saved layouts yet. Arrange the panels the way you like, then save the arrangement
            under a name - it becomes a one-click switch in the View menu.
          </p>
        ) : (
          order.map((name, i) => (
            <div
              key={name}
              ref={registerItem(name)}
              onPointerDown={(e) => beginDrag(e, name)}
              data-testid={`layouts-row-${name}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5em",
                padding: "0.25em 0.5em",
                marginBottom: "0.25em",
                border: "1px solid var(--panel-border)",
                borderRadius: "0.25em",
                // The row is the drag handle (RepoTabBar pattern).
                userSelect: "none",
                cursor: renaming ? undefined : draggingKey === name ? "grabbing" : "grab",
                transform: draggingKey === name ? `translateY(${dragY}px)` : undefined,
                zIndex: draggingKey === name ? 1 : undefined,
                background: draggingKey === name ? "var(--panel-bg)" : undefined,
                boxShadow: draggingKey === name ? "0 2px 8px var(--shadow-color)" : undefined,
                position: "relative",
              }}
            >
              <span className="legit-subtle" style={{ display: "flex" }}>
                <DragHandleIcon />
              </span>
              {renaming === name ? (
                <InlineRenameInput
                  initialValue={name}
                  onSave={(next) => void onRename(name, next)}
                  onCancel={() => setRenaming(null)}
                  style={{ flex: 1, minWidth: 0 }}
                />
              ) : (
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={name}
                >
                  {name}
                  {lastApplied === name && (
                    <span className="legit-subtle" style={{ marginLeft: "0.5em" }}>
                      (active)
                    </span>
                  )}
                </span>
              )}
              <LayoutShortcutChip index={i} />
              <button onClick={() => void run(() => apply(name))}>Apply</button>
              <button
                onClick={() => void onOverride(name)}
                title="Replace this layout with the current arrangement"
              >
                Override
              </button>
              <button onClick={() => void onExport(name)}>Export…</button>
              <IconButton
                onClick={() => setRenaming(renaming === name ? null : name)}
                title="Rename layout"
                aria-label={`Rename layout ${name}`}
              >
                <RenameIcon />
              </IconButton>
              <IconButton
                onClick={() => void onDelete(name)}
                title="Delete layout"
                aria-label={`Delete layout ${name}`}
              >
                <DeleteIcon />
              </IconButton>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
