import { describe, test, expect, vi, afterEach } from "vitest";
import { formatRelative, formatFull } from "./time";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatRelative", () => {
  const NOW = 1_700_000_000_000; // ms
  const at = (secondsAgo: number) => NOW / 1000 - secondsAgo;

  test("bucket boundaries", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(formatRelative(at(30))).toBe("just now");
    expect(formatRelative(at(60))).toBe("1m ago");
    expect(formatRelative(at(3599))).toBe("59m ago");
    expect(formatRelative(at(3600))).toBe("1h ago");
    expect(formatRelative(at(86399))).toBe("23h ago");
    expect(formatRelative(at(86400))).toBe("1d ago");
    expect(formatRelative(at(86400 * 29))).toBe("29d ago");
    expect(formatRelative(at(86400 * 30))).toBe("1mo ago");
    expect(formatRelative(at(86400 * 364))).toBe("12mo ago");
    expect(formatRelative(at(86400 * 365))).toBe("1y ago");
  });
});

describe("formatFull", () => {
  // 2021-03-14 01:59:26 UTC
  const TS = 1_615_687_166;

  test("UTC (zero offset)", () => {
    expect(formatFull(TS, 0)).toBe("2021-03-14 01:59:26 +00:00");
  });

  test("positive offset shifts the wall time and prints the zone", () => {
    expect(formatFull(TS, 120)).toBe("2021-03-14 03:59:26 +02:00");
  });

  test("negative offset (incl. half-hour zones)", () => {
    expect(formatFull(TS, -330)).toBe("2021-03-13 20:29:26 -05:30");
  });
});
