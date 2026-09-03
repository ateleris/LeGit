import { describe, expect, it } from "vitest";
import { AUTOCRLF_OPTIONS, EOL_OPTIONS, getChangedValues } from "./lineEndingOptions";

describe("getChangedValues", () => {
  it("returns nothing when both values are unchanged", () => {
    expect(getChangedValues({ autocrlf: "true", eol: "lf" }, { autocrlf: "true", eol: "lf" })).toEqual(
      []
    );
    expect(getChangedValues({ autocrlf: null, eol: null }, { autocrlf: null, eol: null })).toEqual([]);
  });

  it("reports only the keys that changed", () => {
    expect(
      getChangedValues({ autocrlf: "true", eol: "lf" }, { autocrlf: "input", eol: "lf" })
    ).toEqual([{ key: "core.autocrlf", before: "true", after: "input" }]);
  });

  it("reports both keys and keeps their order", () => {
    expect(getChangedValues({ autocrlf: "true", eol: "lf" }, { autocrlf: "false", eol: "crlf" })).toEqual(
      [
        { key: "core.autocrlf", before: "true", after: "false" },
        { key: "core.eol", before: "lf", after: "crlf" },
      ]
    );
  });

  // Setting and unsetting are both real changes: `null` is "inherit", not
  // "leave alone", so the confirmation must show them.
  it("treats set -> unset and unset -> set as changes", () => {
    expect(getChangedValues({ autocrlf: "true", eol: null }, { autocrlf: null, eol: null })).toEqual([
      { key: "core.autocrlf", before: "true", after: null },
    ]);
    expect(getChangedValues({ autocrlf: null, eol: null }, { autocrlf: null, eol: "native" })).toEqual([
      { key: "core.eol", before: null, after: "native" },
    ]);
  });
});

describe("value tables", () => {
  it("offer an Inherit (unset) entry", () => {
    expect(AUTOCRLF_OPTIONS.some((o) => o.value === null)).toBe(true);
    expect(EOL_OPTIONS.some((o) => o.value === null)).toBe(true);
  });

  it("carry git's documented values", () => {
    expect(AUTOCRLF_OPTIONS.map((o) => o.value)).toEqual(["true", "input", "false", null]);
    expect(EOL_OPTIONS.map((o) => o.value)).toEqual(["lf", "crlf", "native", null]);
  });
});
