import { describe, expect, it } from "vitest";
import { LiveChatMessageListResponse, LiveChatMessageType } from "../src/generated/stream_list";

describe("YouTube stream protocol", () => {
  it("round-trips the fields consumed by the TUI", () => {
    const original: LiveChatMessageListResponse = {
      offlineAt: "",
      nextPageToken: "next",
      items: [
        {
          id: "1",
          snippet: {
            type: LiveChatMessageType.TEXT_MESSAGE_EVENT,
            publishedAt: "2026-07-24T10:00:00Z",
            displayMessage: "hello",
            hasDisplayContent: true,
          },
          authorDetails: {
            channelId: "channel",
            displayName: "viewer",
            isVerified: false,
            isChatOwner: false,
            isChatSponsor: false,
            isChatModerator: false,
          },
        },
      ],
    };
    const decoded = LiveChatMessageListResponse.decode(
      LiveChatMessageListResponse.encode(original).finish(),
    );
    expect(decoded).toEqual(original);
  });
});
