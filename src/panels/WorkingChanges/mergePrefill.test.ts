// Decision logic for prefilling the commit box with git's prepared merge
// message: prefill only into an empty box, never touch typed text, clear an
// untouched prefill when the merge ends, don't refill a box the user emptied.

import { describe, expect, it } from "vitest";
import { mergePrefillEffect } from "./mergePrefill";

const MSG = "Merge branch 'feature' into main";

describe("mergePrefillEffect", () => {
  it("prefills an empty box when a merge is in progress", () => {
    expect(mergePrefillEffect(MSG, "", null)).toEqual({ kind: "prefill", message: MSG });
    expect(mergePrefillEffect(MSG, "   \n", null)).toEqual({ kind: "prefill", message: MSG });
  });

  it("never clobbers a typed draft", () => {
    expect(mergePrefillEffect(MSG, "my own message", null)).toEqual({ kind: "none" });
    expect(mergePrefillEffect(MSG, "my own message", MSG)).toEqual({ kind: "none" });
  });

  it("does not refill a box the user emptied mid-merge", () => {
    expect(mergePrefillEffect(MSG, "", MSG)).toEqual({ kind: "none" });
  });

  it("clears an untouched prefill when the merge ends", () => {
    expect(mergePrefillEffect(null, MSG, MSG)).toEqual({ kind: "clear" });
  });

  it("keeps an edited draft when the merge ends", () => {
    expect(mergePrefillEffect(null, `${MSG} plus notes`, MSG)).toEqual({ kind: "none" });
  });

  it("does nothing outside a merge without a prior prefill", () => {
    expect(mergePrefillEffect(null, "", null)).toEqual({ kind: "none" });
    expect(mergePrefillEffect(null, "draft", null)).toEqual({ kind: "none" });
  });

  it("prefills again when a new merge prepares a different message", () => {
    expect(mergePrefillEffect("Merge branch 'other'", "", MSG)).toEqual({
      kind: "prefill",
      message: "Merge branch 'other'",
    });
  });
});
