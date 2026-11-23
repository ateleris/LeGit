// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { toggleLabelText, withLead } from "./labelText";

const tick = () => new Promise((r) => setTimeout(r, 0));
const lead = (word: string) => (word.startsWith("A") ? "x:" : "y-");

describe("withLead", () => {
  it("leads a single capitalized word, keeping whitespace and ellipsis", () => {
    expect(withLead("Push", lead)).toBe("y-Push");
    expect(withLead(" Apply ", lead)).toBe(" x:Apply ");
    expect(withLead("Pushing…", lead)).toBe("y-Pushing…");
    expect(withLead("OK", lead)).toBe("y-OK");
  });

  it("leaves everything else alone", () => {
    for (const s of ["Stage all", "LFS", "✕", "push", "y-Push", "3", ""]) {
      expect(withLead(s, lead)).toBeNull();
    }
  });
});

describe("toggleLabelText", () => {
  let on = false;
  afterEach(() => {
    if (on) on = toggleLabelText(lead);
    document.body.innerHTML = "";
  });

  it("rewrites existing, added and re-rendered buttons, and restores on toggle-off", async () => {
    document.body.innerHTML =
      "<button id='a'><svg></svg><span>Push</span></button>" +
      "<button id='b'>Stage all</button><span id='c'>Pull</span>";
    on = toggleLabelText(lead);
    const a = document.getElementById("a")!;
    expect(a.textContent).toBe("y-Push");
    expect(document.getElementById("b")!.textContent).toBe("Stage all");
    expect(document.getElementById("c")!.textContent).toBe("Pull");

    const added = document.createElement("button");
    added.textContent = "Fetch";
    document.body.appendChild(added);
    a.querySelector("span")!.firstChild!.nodeValue = "Pushing…";
    await tick();
    expect(added.textContent).toBe("y-Fetch");
    expect(a.textContent).toBe("y-Pushing…");

    on = toggleLabelText(lead);
    expect(a.textContent).toBe("Pushing…");
    expect(added.textContent).toBe("Fetch");
  });

  it("does not lead a label twice", async () => {
    const twice = (word: string) => word.slice(0, 1);
    document.body.innerHTML = "<button id='a'>Push</button>";
    on = toggleLabelText(twice);
    await tick();
    expect(document.getElementById("a")!.textContent).toBe("PPush");
    on = toggleLabelText(twice);
    expect(document.getElementById("a")!.textContent).toBe("Push");
  });
});
