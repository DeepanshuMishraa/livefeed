import { describe, expect, it } from "vitest";
import {
  appendBounded,
  ChatEvent,
  stableAuthorColor,
  type ChatEvent as Event,
} from "../src/domain";
import { LiveChatMessageType, type LiveChatMessage } from "../src/generated/stream_list";

function message(overrides: Partial<LiveChatMessage> = {}): LiveChatMessage {
  return {
    id: "message-1",
    snippet: {
      type: LiveChatMessageType.TEXT_MESSAGE_EVENT,
      publishedAt: "2026-07-24T10:00:00Z",
      displayMessage: "hello",
      hasDisplayContent: true,
    },
    authorDetails: {
      channelId: "channel-1",
      displayName: "viewer",
      isVerified: false,
      isChatOwner: false,
      isChatSponsor: false,
      isChatModerator: false,
    },
    ...overrides,
  };
}

function event(id: string): Event {
  return {
    id,
    authorChannelId: "channel",
    authorName: "viewer",
    role: "viewer",
    verified: false,
    message: id,
    publishedAt: "",
    kind: "text",
  };
}

describe("ChatEvent", () => {
  it("maps author roles and message content", () => {
    const mapped = ChatEvent.fromMessage(
      message({
        authorDetails: {
          channelId: "owner",
          displayName: "creator",
          isVerified: true,
          isChatOwner: true,
          isChatSponsor: false,
          isChatModerator: false,
        },
      }),
    );
    expect(mapped).toMatchObject({
      authorName: "creator",
      role: "owner",
      verified: true,
      message: "hello",
      kind: "text",
    });
  });

  it("maps paid and system events without optional detail objects", () => {
    expect(
      ChatEvent.fromMessage(
        message({
          snippet: {
            type: LiveChatMessageType.SUPER_CHAT_EVENT,
            publishedAt: "",
            displayMessage: "$10 Great stream",
            hasDisplayContent: true,
          },
        }),
      )?.kind,
    ).toBe("paid");
    expect(
      ChatEvent.fromMessage(
        message({
          snippet: {
            type: LiveChatMessageType.CHAT_ENDED_EVENT,
            publishedAt: "",
            displayMessage: "",
            hasDisplayContent: false,
          },
        }),
      )?.message,
    ).toBe("Chat ended");
  });

  it("drops malformed messages without identifiers or snippets", () => {
    expect(ChatEvent.fromMessage(message({ id: undefined }))).toBeNull();
    expect(ChatEvent.fromMessage(message({ snippet: undefined }))).toBeNull();
  });
});

describe("appendBounded", () => {
  it("deduplicates resumed messages and keeps the newest bounded window", () => {
    expect(
      appendBounded([event("1"), event("2")], [event("2"), event("3")], 2).map((item) => item.id),
    ).toEqual(["2", "3"]);
  });
});

describe("stableAuthorColor", () => {
  it("is deterministic and respects NO_COLOR mode", () => {
    expect(stableAuthorColor("channel")).toBe(stableAuthorColor("channel"));
    expect(stableAuthorColor("channel", true)).toBe("#d7dae5");
  });
});
