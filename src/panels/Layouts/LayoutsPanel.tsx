import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useState } from "react";
import { loadLayout } from "../../lib/commands";
import { formatAppError } from "../../lib/types";
import { DeleteIcon, RenameIcon } from "../../icons";
import { confirmDialog } from "../../store/confirm";
import { useLayoutsStore } from "../../store/layouts";
import { notify } from "../../store/notifications";
import { useConfirmDestructive } from "../../store/settings";
import { InlineRenameInput } from "../Commits/cells/InlineRenameInput";
import { asLayoutBundle, asLayoutDocument, buildLayoutBundle } from "../namedLayouts";
import type { LayoutDocument } from "../../lib/types";
import { Button, IconButton } from "../shared/buttons";

/**
 * Manage saved panel layouts (the View menu is the fast switch path): save
 * the current arrangement under a name, apply/override/rename/delete saved
 * ones, import/export layout files, and reset the docks to the built-in
 * default.
 */
export function LayoutsPanel() {
  const confirmDestructive = useConfirmDestructive();
  const layouts = useLayoutsStore((s) => s.layouts);
  const lastApplied = useLayoutsStore((s) => s.lastApplied);
  const saveCurrent = useLayoutsStore((s) => s.saveCurrent);
  const apply = useLayoutsStore((s) => s.apply);
  const rename = useLayoutsStore((s) => s.rename);
  const remove = useLayoutsStore((s) => s.remove);
  const importDocument = useLayoutsStore((s) => s.importDocument);
  const resetToDefault = useLayoutsStore((s) => s.resetToDefault);

  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  const nameTaken = (name: string) => layouts.some((l) => l.name === name);

  const onSaveCurrent = () =>
    run(async () => {
      const name = newName.trim();
      if (!name) return;
      // Saving under an existing name IS the override action - same
      // confirmation as the per-row Override button.
      if (nameTaken(name) && confirmDestructive) {
        const ok = await confirmDialog({
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
      if (confirmDestructive) {
        const ok = await confirmDialog({
          title: "Override layout",
          message: "Replaces the saved layout with the current arrangement.",
          detail: name,
          confirmLabel: "Override",
        });
        if (!ok) return;
      }
      await saveCurrent(name);
    });

  const onDelete = (name: string) =>
    run(async () => {
      if (confirmDestructive) {
        const ok = await confirmDialog({
          title: "Delete layout",
          message: "Deletes the saved layout file.",
          detail: name,
          confirmLabel: "Delete layout",
        });
        if (!ok) return;
      }
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
      const doc = await loadLayout(name);
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
        const doc = asLayoutDocument(await loadLayout(l.name));
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
      <div className="legit-panel__body">
        {layouts.length === 0 ? (
          <p className="legit-subtle">
            No saved layouts yet. Arrange the panels the way you like, then save the arrangement
            under a name - it becomes a one-click switch in the View menu.
          </p>
        ) : (
          layouts.map((l) => (
            <div
              key={l.name}
              data-testid={`layouts-row-${l.name}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5em",
                padding: "0.25em 0",
              }}
            >
              {renaming === l.name ? (
                <InlineRenameInput
                  initialValue={l.name}
                  onSave={(next) => void onRename(l.name, next)}
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
                  title={l.name}
                >
                  {l.name}
                  {lastApplied === l.name && (
                    <span className="legit-subtle" style={{ marginLeft: "0.5em" }}>
                      (active)
                    </span>
                  )}
                </span>
              )}
              <button onClick={() => void run(() => apply(l.name))}>Apply</button>
              <button
                onClick={() => void onOverride(l.name)}
                title="Replace this layout with the current arrangement"
              >
                Override
              </button>
              <button onClick={() => void onExport(l.name)}>Export…</button>
              <IconButton
                onClick={() => setRenaming(renaming === l.name ? null : l.name)}
                title="Rename layout"
                aria-label={`Rename layout ${l.name}`}
              >
                <RenameIcon />
              </IconButton>
              <IconButton
                onClick={() => void onDelete(l.name)}
                title="Delete layout"
                aria-label={`Delete layout ${l.name}`}
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
