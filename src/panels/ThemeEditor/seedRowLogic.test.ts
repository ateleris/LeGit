import { describe, expect, test } from "vitest";
import { deriveTheme } from "../../theme/simple";
import { seedEditPlan } from "./SeedRow";

const SEEDS = {
  background: "#1e1e1e",
  text: "#e0e0e0",
  primary: "#4a9eff",
  error: "#e58e26",
  warning: "#f1fa8c",
  success: "#3498db",
  diffAdded: "#3498db",
  diffRemoved: "#e58e26",
};

describe("seedEditPlan", () => {
  test("seeded and untouched: regenerate silently", () => {
    const { doc } = deriveTheme(SEEDS, "t");
    expect(seedEditPlan(doc)).toBe("regenerate");
  });

  test("seeded but fine-tuned since: warn before overwriting", () => {
    const { doc } = deriveTheme(SEEDS, "t");
    const drifted = { ...doc, palette: { ...doc.palette, accent: "#123456" } };
    expect(seedEditPlan(drifted)).toBe("warn-overwrite");
  });

  test("no seeds yet (conversion): warn before overwriting", () => {
    const { doc } = deriveTheme(SEEDS, "t");
    const { seeds: _s, seedFingerprint: _f, ...seedless } = doc;
    expect(seedEditPlan(seedless)).toBe("warn-overwrite");
  });
});
