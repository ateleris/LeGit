import { describe, test, expect, vi, afterEach } from "vitest";
import { formatRelative, formatFull, formatAbsolute } from "./time";

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

describe("formatAbsolute", () => {
  // 2021-03-14 01:59:26 UTC
  const TS = 1_615_687_166;

  test("each format renders the author-local wall time", () => {
    expect(formatAbsolute(TS, 0, "iso")).toBe("2021-03-14 01:59");
    expect(formatAbsolute(TS, 0, "swiss")).toBe("14.03.2021 01:59");
    expect(formatAbsolute(TS, 0, "uk")).toBe("14/03/2021 01:59");
    expect(formatAbsolute(TS, 0, "us")).toBe("03/14/2021 1:59 AM");
  });

  test("tz offset shifts the wall time (like formatFull)", () => {
    expect(formatAbsolute(TS, 120, "iso")).toBe("2021-03-14 03:59");
    expect(formatAbsolute(TS, -330, "swiss")).toBe("13.03.2021 20:29");
  });

  test("includeTime=false drops the time in every format", () => {
    expect(formatAbsolute(TS, 0, "iso", false)).toBe("2021-03-14");
    expect(formatAbsolute(TS, 0, "swiss", false)).toBe("14.03.2021");
    expect(formatAbsolute(TS, 0, "uk", false)).toBe("14/03/2021");
    expect(formatAbsolute(TS, 0, "us", false)).toBe("03/14/2021");
    // The tz offset still decides which calendar day it is.
    expect(formatAbsolute(TS, -330, "iso", false)).toBe("2021-03-13");
  });

  test("US 12-hour edges: midnight and noon are 12, not 0", () => {
    // 2021-03-14 00:05:00 UTC / 12:05:00 UTC
    const MIDNIGHT = 1_615_680_300;
    const NOON = MIDNIGHT + 12 * 3600;
    expect(formatAbsolute(MIDNIGHT, 0, "us")).toBe("03/14/2021 12:05 AM");
    expect(formatAbsolute(NOON, 0, "us")).toBe("03/14/2021 12:05 PM");
  });
});
