import { describe, expect, it } from "vitest";

import { relativeTime } from "./relative-time";

describe("relativeTime", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  it("phrases recent and older edits", () => {
    expect(relativeTime("2026-10-06T11:59:40Z", now, "en")).toBe("just now");
    expect(relativeTime("2026-10-06T09:00:00Z", now, "en")).toBe("3 hours ago");
    expect(relativeTime("2026-10-05T12:00:00Z", now, "en")).toBe("yesterday");
    expect(relativeTime("2026-09-15T12:00:00Z", now, "en")).toBe("3 weeks ago");
  });
});
