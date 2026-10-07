// apps/web/tests/ui-foundations.test.ts — ported from deck's `ui-foundations` suite (vendored `@/ui`).
import { describe, expect, it } from "bun:test";
import { defineStatusMap, formatAge, formatRelative, formatTimestamp, TONES } from "@/ui";

describe("formatAge", () => {
  it.each([
    [-5_000, "just now"],
    [0, "just now"],
    [9_999, "just now"],
    [42_000, "42s ago"],
    [6 * 60_000, "6m ago"],
    [3 * 3_600_000, "3h ago"],
    [8 * 86_400_000, "8d ago"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatAge(ms)).toBe(text);
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-01-15T12:00:00Z");
  it("measures an ISO timestamp against now", () => {
    expect(formatRelative("2026-01-15T11:54:00Z", now)).toBe("6m ago");
    expect(formatRelative("2026-01-15T11:54:00Z", new Date(now))).toBe("6m ago");
  });
  it("returns unparseable input unchanged", () => {
    expect(formatRelative("not a date", now)).toBe("not a date");
  });
});

describe("formatTimestamp", () => {
  it("formats as local YYYY-MM-DD HH:mm", () => {
    const iso = "2026-01-05T08:07:00";
    expect(formatTimestamp(iso)).toBe("2026-01-05 08:07");
  });
  it("returns unparseable input unchanged", () => {
    expect(formatTimestamp("nope")).toBe("nope");
  });
});

describe("defineStatusMap", () => {
  it("keeps the map as declared and exposes the six tones", () => {
    const map = defineStatusMap<"up" | "down">({
      up: { tone: "ok", icon: "circle-check", label: "Up" },
      down: { tone: "danger", icon: "circle-x", label: "Down", role: "alert" },
    });
    expect(map.down.role).toBe("alert");
    expect(TONES).toEqual(["ok", "warn", "danger", "info", "pending", "neutral"]);
  });
});
