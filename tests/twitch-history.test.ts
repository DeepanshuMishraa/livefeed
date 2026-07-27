import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/domain";
import { TwitchChatHistory } from "../src/twitch-history";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("TwitchChatHistory", () => {
  it("restores messages for the same stream after the store is reopened", async () => {
    const directory = await temporaryDirectory();
    const firstProcess = TwitchChatHistory.file(directory);

    await expect(firstProcess.append("stream-1", event("message-1"))).resolves.toMatchObject({
      value: undefined,
    });
    await expect(firstProcess.append("stream-1", event("message-2"))).resolves.toMatchObject({
      value: undefined,
    });

    const nextProcess = TwitchChatHistory.file(directory);
    const loaded = await nextProcess.load("stream-1");

    expect(Result.isOk(loaded) ? loaded.value.events.map((item) => item.id) : []).toEqual([
      "message-1",
      "message-2",
    ]);
  });

  it("does not mix messages from separate Twitch streams", async () => {
    const directory = await temporaryDirectory();
    const firstProcess = TwitchChatHistory.file(directory);
    await firstProcess.append("stream-1", event("old-message"));

    const nextProcess = TwitchChatHistory.file(directory);
    await expect(nextProcess.load("stream-2")).resolves.toMatchObject({
      value: { events: [], nextPageToken: "" },
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "livefeed-twitch-history-"));
  temporaryDirectories.push(directory);
  return directory;
}

function event(id: string): ChatEvent {
  return {
    id,
    authorChannelId: "viewer-1",
    authorName: "Viewer",
    role: "viewer",
    verified: false,
    message: id,
    publishedAt: "2026-07-27T10:00:00Z",
    kind: "text",
  };
}
