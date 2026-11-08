import { describe, expect, it } from "vite-plus/test";

import { weekOf } from "./week";

// Expected weeks come from the old dashboard's weekOf, run with TZ=America/New_York.
describe("weekOf", () => {
  it("gives the Monday that starts the Trial's week", () => {
    expect(weekOf("2026-11-02T05:00:00Z")).toBe("2026-11-02");
  });

  it("puts a Sunday in the week that started the Monday before", () => {
    expect(weekOf("2026-11-01T12:00:00Z")).toBe("2026-10-26");
  });

  it("uses the reader's time zone, so a Sunday evening that is Monday in UTC stays in its week", () => {
    expect(weekOf("2026-11-02T03:30:00Z")).toBe("2026-10-26");
  });

  it("crosses month, year and daylight saving boundaries", () => {
    expect(weekOf("2026-01-01T12:00:00Z")).toBe("2025-12-29");
    expect(weekOf("2026-03-08T12:00:00Z")).toBe("2026-03-02");
  });

  it("reports a missing or unreadable time as unknown", () => {
    expect(weekOf("garbage")).toBe("unknown");
    expect(weekOf("")).toBe("unknown");
    expect(weekOf(undefined)).toBe("unknown");
  });
});
