import { useRef, useState } from "react";
import { DragHandleIcon } from "../../icons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { useRowDragReorder } from "../shared/useRowDragReorder";
import { useSettingsStore } from "../../store/settings";
import {
  orderedWorkingChangesSections,
  WORKING_CHANGES_SECTION_LABELS,
} from "../WorkingChanges/sectionOrder";
import { FieldNote, Section, ToggleSection, WritesTo } from "./primitives";

export function DiffViewerSection() {
  const enabled = useSettingsStore((s) => s.settings?.diff_syntax_highlighting ?? false);
  const setDiffSyntaxHighlighting = useSettingsStore((s) => s.setDiffSyntaxHighlighting);
  const { busy: saving, run } = useDelayedBusy();

  return (
    <ToggleSection
      title="Diff viewer"
      writesNote="applies to all repos"
      id="global-diff-syntax"
      label="Syntax-highlight code in diffs and file views"
      checked={enabled}
      disabled={saving}
      onToggle={() => void run(() => setDiffSyntaxHighlighting(!enabled))}
    >
      <FieldNote>
        Colours come from the theme's Syntax tokens. Each hunk is highlighted on
        its own, so constructs opened outside the visible context may colour
        imperfectly. Very large diffs are skipped.
      </FieldNote>
    </ToggleSection>
  );
}

export function WorkingChangesLayoutSection() {
  const savedOrder = orderedWorkingChangesSections(
    useSettingsStore((s) => s.settings?.working_changes_section_order),
  );
  const setOrder = useSettingsStore((s) => s.setWorkingChangesSectionOrder);
  const { busy: saving, run } = useDelayedBusy();
  // Live order during a drag (null = idle); the setting is written ONCE on
  // release, not per reorder step.
  const [liveOrder, setLiveOrder] = useState<string[] | null>(null);
  const order = (liveOrder ?? savedOrder) as typeof savedOrder;
  const listRef = useRef<HTMLDivElement | null>(null);
  const { draggingKey, dragY, registerItem, beginDrag } = useRowDragReorder({
    container: listRef,
    order,
    onReorder: setLiveOrder,
    onDrop: (next, changed) => {
      setLiveOrder(null);
      if (changed) void run(() => setOrder(next as typeof savedOrder));
    },
    disabled: saving,
  });

  return (
    <Section title="Working Changes layout">
      <WritesTo note="applies to all repos" />
      <FieldNote>
        Top-to-bottom order of the three Working Changes sections. Drag rows
        to put Staged first, or move the commit box to the top.
      </FieldNote>
      <div
        ref={listRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.333em",
          marginTop: "0.667em",
          // Row offsets resolve against this container (drag math).
          position: "relative",
        }}
      >
        {order.map((id) => (
          <div
            key={id}
            ref={registerItem(id)}
            onPointerDown={(e) => beginDrag(e, id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.667em",
              // Same metrics as the global `button` base (settings-body
              // buttons like Top/Bottom - Left/Right): --fz-lg text,
              // line-height 1.4, 4px vertical padding, radius 4 - so the
              // rows sit at exactly the neighbouring controls' height.
              fontSize: "var(--fz-lg)",
              lineHeight: 1.4,
              border: "1px solid var(--panel-border)",
              borderRadius: 4,
              padding: "0.333em 0.667em",
              background: "var(--panel-bg)",
              // Rows are drag handles (same fix as the repo tabs).
              userSelect: "none",
              cursor: saving ? undefined : draggingKey === id ? "grabbing" : "grab",
              transform: draggingKey === id ? `translateY(${dragY}px)` : undefined,
              zIndex: draggingKey === id ? 1 : undefined,
              boxShadow: draggingKey === id ? "0 2px 8px var(--shadow-color)" : undefined,
              position: "relative",
            }}
          >
            <span className="legit-subtle" style={{ display: "flex" }}>
              <DragHandleIcon />
            </span>
            <span>{WORKING_CHANGES_SECTION_LABELS[id]}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
