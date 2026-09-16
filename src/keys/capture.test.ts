// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { captureChord, eventToChord, type CaptureEvent } from "./chord";

const WIN = { isMac: false };
const MAC = { isMac: true };

const ev = (init: Partial<CaptureEvent> & { key: string }): CaptureEvent => ({
  code: "",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  isComposing: false,
  getModifierState: () => false,
  ...init,
});

describe("captureChord", () => {
  it("emits byte-identical output to what the matcher compares", () => {
    const e = ev({ key: "M", code: "KeyM", ctrlKey: true, shiftKey: true });
    const r = captureChord(e, WIN);
    expect(r).toEqual({ kind: "chord", chord: "Mod+Shift+M" });
    expect(r.kind === "chord" && r.chord).toBe(eventToChord(e, WIN));
  });

  it("modifier-only presses render a live preview, not a chord", () => {
    expect(captureChord(ev({ key: "Control", ctrlKey: true, shiftKey: true }), WIN)).toEqual({
      kind: "pending",
      preview: "Ctrl+Shift+...",
    });
    expect(captureChord(ev({ key: "Meta", metaKey: true }), MAC)).toEqual({
      kind: "pending",
      preview: "Cmd+...",
    });
  });

  it("Escape cancels the capture", () => {
    expect(captureChord(ev({ key: "Escape" }), WIN)).toEqual({ kind: "cancel" });
  });

  it("rejects dead keys and IME composition with a visible reason", () => {
    expect(captureChord(ev({ key: "Dead", code: "Backquote" }), WIN).kind).toBe("rejected");
    expect(captureChord(ev({ key: "a", code: "KeyA", isComposing: true }), WIN).kind).toBe(
      "rejected",
    );
  });

  it("rejects AltGr chords (ambiguous with Ctrl+Alt on Windows)", () => {
    const e = ev({
      key: "@",
      code: "KeyQ",
      ctrlKey: true,
      altKey: true,
      getModifierState: (m: string) => m === "AltGraph",
    });
    expect(captureChord(e, WIN).kind).toBe("rejected");
  });

  it("falls back to the physical key for non-ASCII characters", () => {
    expect(captureChord(ev({ key: "ü", code: "KeyU", ctrlKey: true }), WIN)).toEqual({
      kind: "chord",
      chord: "Mod+U",
    });
    expect(captureChord(ev({ key: "µ", code: "Digit5", altKey: true }), WIN)).toEqual({
      kind: "chord",
      chord: "Alt+5",
    });
  });

  it("rejects non-ASCII keys on physical keys without a letter/digit code", () => {
    expect(captureChord(ev({ key: "ö", code: "Semicolon" }), WIN).kind).toBe("rejected");
  });

  it("rejects Windows-key chords (never matchable)", () => {
    expect(captureChord(ev({ key: "f", code: "KeyF", metaKey: true }), WIN).kind).toBe(
      "rejected",
    );
  });

  it("the code fallback keeps modifiers on a REAL KeyboardEvent (prototype getters do not spread)", () => {
    const e = new KeyboardEvent("keydown", { key: "ü", code: "KeyU", ctrlKey: true });
    Object.defineProperty(e, "isComposing", { value: false });
    expect(captureChord(e as unknown as CaptureEvent, WIN)).toEqual({
      kind: "chord",
      chord: "Mod+U",
    });
  });

  it("captures plain named keys and F-keys", () => {
    expect(captureChord(ev({ key: "F5", code: "F5" }), WIN)).toEqual({
      kind: "chord",
      chord: "F5",
    });
    expect(captureChord(ev({ key: "ArrowDown", code: "ArrowDown", altKey: true }), WIN)).toEqual({
      kind: "chord",
      chord: "Alt+ArrowDown",
    });
  });
});
