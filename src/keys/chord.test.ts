// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  chordMatchCandidates,
  eventChordCandidates,
  eventToChord,
  formatChord,
  isEditableTarget,
  normalizeChord,
  parseChord,
} from "./chord";

const WIN = { isMac: false };
const MAC = { isMac: true };

describe("parseChord", () => {
  it("parses modifiers and key", () => {
    expect(parseChord("Mod+Shift+M")).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      key: "M",
    });
  });

  it("parses a bare key and named keys", () => {
    expect(parseChord("F5")).toEqual({ mod: false, ctrl: false, alt: false, shift: false, key: "F5" });
    expect(parseChord("Alt+ArrowDown")?.alt).toBe(true);
    expect(parseChord("Mod+,")?.key).toBe(",");
  });

  it("rejects garbage", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("Mod+")).toBeNull();
    expect(parseChord("Mod+Shift")).toBeNull(); // modifier-only
    expect(parseChord("Bogus+M")).toBeNull();
  });
});

describe("normalizeChord", () => {
  it("canonicalizes modifier order and letter case", () => {
    expect(normalizeChord("Shift+Mod+m")).toBe("Mod+Shift+M");
    expect(normalizeChord("alt+arrowdown")).toBe("Alt+ArrowDown");
  });

  it("returns null for unparseable input", () => {
    expect(normalizeChord("Nope")).toBeNull();
  });
});

describe("formatChord", () => {
  it("renders Mod per platform", () => {
    expect(formatChord("Mod+Shift+M", WIN)).toBe("Ctrl+Shift+M");
    expect(formatChord("Mod+Shift+M", MAC)).toBe("Cmd+Shift+M");
  });

  it("renders named keys as-is", () => {
    expect(formatChord("F5", WIN)).toBe("F5");
    expect(formatChord("Alt+ArrowDown", WIN)).toBe("Alt+ArrowDown");
  });
});

describe("eventToChord", () => {
  const ev = (init: Partial<KeyboardEvent> & { key: string }) =>
    ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init }) as KeyboardEvent;

  it("maps Ctrl to Mod on Windows/Linux", () => {
    expect(eventToChord(ev({ key: "m", ctrlKey: true, shiftKey: true }), WIN)).toBe("Mod+Shift+M");
  });

  it("normalizes Shift-uppercased letter keys", () => {
    expect(eventToChord(ev({ key: "M", ctrlKey: true, shiftKey: true }), WIN)).toBe("Mod+Shift+M");
  });

  it("maps Meta to Mod and Ctrl to Ctrl on macOS", () => {
    expect(eventToChord(ev({ key: "f", metaKey: true }), MAC)).toBe("Mod+F");
    expect(eventToChord(ev({ key: "f", ctrlKey: true }), MAC)).toBe("Ctrl+F");
  });

  it("returns null for modifier-only presses", () => {
    expect(eventToChord(ev({ key: "Control", ctrlKey: true }), WIN)).toBeNull();
    expect(eventToChord(ev({ key: "Shift", shiftKey: true }), WIN)).toBeNull();
  });

  it("names Space and Plus (chord separator collision)", () => {
    expect(eventToChord(ev({ key: " " }), WIN)).toBe("Space");
    expect(eventToChord(ev({ key: "+", ctrlKey: true }), WIN)).toBe("Mod+Plus");
  });

  it("passes named keys through", () => {
    expect(eventToChord(ev({ key: "F5" }), WIN)).toBe("F5");
    expect(eventToChord(ev({ key: "ArrowDown", altKey: true }), WIN)).toBe("Alt+ArrowDown");
    expect(eventToChord(ev({ key: "Escape" }), WIN)).toBe("Escape");
  });

  it("Meta on Windows/Linux never becomes Mod", () => {
    expect(eventToChord(ev({ key: "f", metaKey: true }), WIN)).toBe("Meta+F");
  });
});

describe("chordMatchCandidates", () => {
  it("on Windows/Linux a Mod chord also matches its Ctrl spelling (Mod IS Ctrl there)", () => {
    expect(chordMatchCandidates("Mod+Tab", WIN)).toEqual(["Mod+Tab", "Ctrl+Tab"]);
    expect(chordMatchCandidates("Mod+Shift+Tab", WIN)).toEqual([
      "Mod+Shift+Tab",
      "Ctrl+Shift+Tab",
    ]);
  });

  it("on macOS Mod (Cmd) and Ctrl are distinct keys", () => {
    expect(chordMatchCandidates("Mod+Tab", MAC)).toEqual(["Mod+Tab"]);
    expect(chordMatchCandidates("Ctrl+Tab", MAC)).toEqual(["Ctrl+Tab"]);
  });

  it("chords without Mod are returned as-is", () => {
    expect(chordMatchCandidates("F5", WIN)).toEqual(["F5"]);
    expect(chordMatchCandidates("Alt+ArrowDown", WIN)).toEqual(["Alt+ArrowDown"]);
  });
});

describe("eventChordCandidates", () => {
  const ev = (init: Partial<KeyboardEvent> & { key: string }) =>
    ({
      code: "",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...init,
    }) as KeyboardEvent;

  it("is the event's chord plus the Ctrl-spelling fold, nothing else", () => {
    expect(eventChordCandidates(ev({ key: "Tab", ctrlKey: true }), WIN)).toEqual([
      "Mod+Tab",
      "Ctrl+Tab",
    ]);
    expect(eventChordCandidates(ev({ key: "Control", ctrlKey: true }), WIN)).toEqual([]);
  });

  it("NEVER infers the physical key from code - what capture showed is what matches", () => {
    // Swiss QWERTZ Ctrl+Shift+1 reports "+": it matches a binding captured
    // as Mod+Shift+Plus, and deliberately NOT a hand-written Mod+Shift+1.
    const plus = ev({ key: "+", code: "Digit1", ctrlKey: true, shiftKey: true });
    expect(eventChordCandidates(plus, WIN)).toEqual(["Mod+Shift+Plus", "Ctrl+Shift+Plus"]);
  });

  it("works on a REAL KeyboardEvent (properties live on prototype getters)", () => {
    const e = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true });
    expect(eventChordCandidates(e, WIN)).toEqual(["Mod+Tab", "Ctrl+Tab"]);
  });
});

describe("isEditableTarget", () => {
  const make = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);
    return host.firstElementChild as HTMLElement;
  };

  it("true for inputs, textareas, selects and contenteditable", () => {
    expect(isEditableTarget(make("<input>"))).toBe(true);
    expect(isEditableTarget(make("<textarea></textarea>"))).toBe(true);
    expect(isEditableTarget(make("<select></select>"))).toBe(true);
    const ce = make("<div contenteditable='true'><span>x</span></div>");
    expect(isEditableTarget(ce.firstElementChild as HTMLElement)).toBe(true);
  });

  it("true inside a CodeMirror content element", () => {
    const cm = make("<div class='cm-content'><span>x</span></div>");
    expect(isEditableTarget(cm.firstElementChild as HTMLElement)).toBe(true);
  });

  it("false for plain elements and non-elements", () => {
    expect(isEditableTarget(make("<div></div>"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget("not-a-node")).toBe(false);
  });
});
