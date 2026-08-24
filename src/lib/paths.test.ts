import { describe, test, expect } from "vitest";
import { toAbsolutePath } from "./paths";

describe("toAbsolutePath", () => {
  test("joins a backslash Windows root using backslashes", () => {
    expect(toAbsolutePath("C:\\WORK\\repo", "src/panels/App.tsx")).toBe(
      "C:\\WORK\\repo\\src\\panels\\App.tsx",
    );
  });

  test("normalizes a forward-slash Windows root to backslashes", () => {
    // The backend reports Windows repo roots with forward slashes
    // (e.g. "C:/WORK/repo"); the copied absolute path must be OS-native.
    expect(toAbsolutePath("C:/WORK/repo", "a/b.txt")).toBe(
      "C:\\WORK\\repo\\a\\b.txt",
    );
  });

  test("joins a POSIX root using forward slashes", () => {
    expect(toAbsolutePath("/home/u/repo", "src/lib/a.ts")).toBe(
      "/home/u/repo/src/lib/a.ts",
    );
  });

  test("tolerates a trailing separator on the root", () => {
    expect(toAbsolutePath("C:\\WORK\\repo\\", "a/b.txt")).toBe(
      "C:\\WORK\\repo\\a\\b.txt",
    );
    expect(toAbsolutePath("C:/WORK/repo/", "a/b.txt")).toBe(
      "C:\\WORK\\repo\\a\\b.txt",
    );
    expect(toAbsolutePath("/repo/", "a/b.txt")).toBe("/repo/a/b.txt");
  });

  test("treats a UNC root as Windows", () => {
    expect(toAbsolutePath("\\\\server\\share\\repo", "a/b.txt")).toBe(
      "\\\\server\\share\\repo\\a\\b.txt",
    );
  });
});
