// @vitest-environment happy-dom
//
// Regression tests for the Refs paneview restore flow against the real
// dockview, under React.StrictMode like the dev build. The restore logic
// here mirrors RefsPanel.onReady (which can't be mounted directly - its
// sections pull in stores and Tauri IPC); the sanitizing step is the real
// `sanitizePaneviewLayout`.
//
// The key case: a persisted layout referencing a pane component that no
// longer exists ("submodules", from a reverted experiment) made dockview's
// fromJSON throw AFTER building the restored panes' DOM but before
// initialising them all - the fallback then added the default panes on top
// of the zombies and every pane appeared twice in the accordion.
import { describe, it, expect, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  PaneviewReact,
  type IPaneviewPanelProps,
  type PaneviewReadyEvent,
} from "dockview-react";
import { sanitizePaneviewLayout } from "./refsLayout";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT_PANES = [
  { id: "branches", title: "Branches", isExpanded: true },
  { id: "remotes", title: "Remotes", isExpanded: false },
  { id: "tags", title: "Tags", isExpanded: false },
  { id: "stashes", title: "Stashes", isExpanded: true },
  { id: "reflog", title: "Reflog", isExpanded: false },
] as const;

const PANE_COMPONENTS: Record<
  string,
  React.FunctionComponent<IPaneviewPanelProps>
> = {
  branches: () => <div>branches-body</div>,
  remotes: () => <div>remotes-body</div>,
  tags: () => <div>tags-body</div>,
  stashes: () => <div>stashes-body</div>,
  reflog: () => <div>reflog-body</div>,
};

function Header({ title }: IPaneviewPanelProps) {
  return <div className="test-header">{title}</div>;
}
const HEADER_COMPONENTS = { default: Header };

function savedView(id: string) {
  return {
    size: 22,
    data: {
      id,
      component: id,
      headerComponent: "default",
      title: id[0].toUpperCase() + id.slice(1),
    },
    headerSize: 22,
    expanded: false,
  };
}

/** Mirrors RefsPanel.onReady: sanitize + restore, else defaults; then append
 * any default panes the restored layout didn't contain. */
function Panel({
  headerSize,
  savedLayout,
}: {
  headerSize: number;
  savedLayout?: unknown;
}) {
  const onReady = React.useCallback(
    (event: PaneviewReadyEvent) => {
      const api = event.api;
      let restored = false;
      if (savedLayout !== undefined) {
        try {
          const json = sanitizePaneviewLayout(
            savedLayout,
            (name) => name in PANE_COMPONENTS,
            headerSize,
          );
          if (json) {
            api.fromJSON(json as Parameters<typeof api.fromJSON>[0]);
            restored = api.panels.length > 0;
          }
        } catch {
          try {
            for (const panel of [...api.panels]) api.removePanel(panel);
          } catch {
            /* paneview unusable */
          }
        }
      }
      for (const p of DEFAULT_PANES) {
        if (restored && api.getPanel(p.id)) continue;
        api.addPanel({
          id: p.id,
          component: p.id,
          headerComponent: "default",
          title: p.title,
          isExpanded: p.isExpanded,
          headerSize,
        });
      }
    },
    [headerSize, savedLayout],
  );
  return (
    <div style={{ height: "100%" }}>
      <PaneviewReact
        key={headerSize}
        components={PANE_COMPONENTS}
        headerComponents={HEADER_COMPONENTS}
        onReady={onReady}
      />
    </div>
  );
}

async function mount(ui: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<React.StrictMode>{ui}</React.StrictMode>);
  });
  // flush dockview's deferred onDidAddView timers
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  return root;
}

function headerTitles(): string[] {
  return Array.from(document.querySelectorAll(".test-header")).map(
    (el) => el.textContent ?? "",
  );
}

const ALL_TITLES = ["Branches", "Remotes", "Tags", "Stashes", "Reflog"];

describe("Refs paneview restore (StrictMode, real dockview)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("first launch (no saved layout) creates each default pane once", async () => {
    await mount(<Panel headerSize={22} />);
    expect(document.querySelectorAll(".dv-pane-container").length).toBe(1);
    expect(headerTitles()).toEqual(ALL_TITLES);
  });

  it("re-creating the paneview on font-size change keeps panes unique", async () => {
    const root = await mount(<Panel headerSize={22} />);
    await act(async () => {
      root.render(
        <React.StrictMode>
          <Panel headerSize={25} />
        </React.StrictMode>,
      );
    });
    expect(document.querySelectorAll(".dv-pane-container").length).toBe(1);
    expect(headerTitles()).toEqual(ALL_TITLES);
  });

  it("restores a legacy layout and appends only the missing panes", async () => {
    const layout = {
      views: ["branches", "remotes", "tags", "stashes"].map(savedView),
      size: 1302,
    };
    await mount(<Panel headerSize={22} savedLayout={layout} />);
    expect(headerTitles()).toEqual(ALL_TITLES);
  });

  it("a layout with an unknown pane component must not duplicate panes", async () => {
    const layout = {
      views: [
        "branches",
        "remotes",
        "tags",
        "stashes",
        "submodules", // no longer exists in PANE_COMPONENTS
        "reflog",
      ].map(savedView),
      size: 1302,
    };
    await mount(<Panel headerSize={22} savedLayout={layout} />);
    expect(document.querySelectorAll(".dv-pane-container").length).toBe(1);
    expect(headerTitles()).toEqual(ALL_TITLES);
  });
});
