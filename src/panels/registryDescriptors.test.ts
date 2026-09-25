// The layout layer identifies panels by the pure descriptors; the registry's
// component maps must cover exactly the same ids.
import { describe, it, expect } from "vitest";
import { GLOBAL_DOCKVIEW_COMPONENTS, REPO_DOCKVIEW_COMPONENTS } from "./registry";
import { GLOBAL_PANELS, REPO_PANELS } from "../layout/descriptors";

const ids = (list: { id: string }[]) => list.map((p) => p.id).sort();

describe("panel registry", () => {
  it("has a component for every descriptor and no others", () => {
    expect(Object.keys(GLOBAL_DOCKVIEW_COMPONENTS).sort()).toEqual(ids(GLOBAL_PANELS));
    expect(Object.keys(REPO_DOCKVIEW_COMPONENTS).sort()).toEqual(ids(REPO_PANELS));
  });
});
