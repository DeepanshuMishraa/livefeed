import { describe, expect, it } from "vitest";
import { ChatLayoutPolicy } from "../src/tui-layout";

describe("ChatLayoutPolicy", () => {
  it("progressively removes chrome as the terminal narrows", () => {
    const common = {
      title: "Resize test",
      state: { _tag: "live" } as const,
      following: true,
      unread: 0,
    };

    expect(ChatLayoutPolicy.status({ ...common, width: 80 }).text).toBe(
      "● connected · Resize test · q quit",
    );
    expect(ChatLayoutPolicy.status({ ...common, width: 22 }).text).toBe("● connected");
    expect(ChatLayoutPolicy.status({ ...common, width: 12 }).text).toBe("LIVE");
  });

  it("gives a one-row terminal entirely to chat", () => {
    expect(ChatLayoutPolicy.showStatus(2)).toBe(true);
    expect(ChatLayoutPolicy.showStatus(1)).toBe(false);
  });

  it("shows unread recovery only when the reader has scrolled away", () => {
    expect(
      ChatLayoutPolicy.status({
        width: 40,
        title: "Stream",
        state: { _tag: "live" },
        following: false,
        unread: 3,
      }).text,
    ).toBe("● connected · 3 new · G latest");
  });
});
