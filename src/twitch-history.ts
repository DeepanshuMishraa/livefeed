import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Result, type Result as ResultType } from "better-result";
import * as v from "valibot";
import type { ChatEvent } from "./domain";
import { appendBounded } from "./domain";
import type { LivefeedError } from "./errors";
import type { ChatHistory } from "./feed";

const historySchema = v.object({
  streamId: v.string(),
  events: v.array(
    v.object({
      id: v.string(),
      authorChannelId: v.string(),
      authorName: v.string(),
      role: v.picklist(["owner", "moderator", "member", "viewer"]),
      verified: v.boolean(),
      message: v.string(),
      publishedAt: v.string(),
      kind: v.picklist(["text", "membership", "paid", "gift", "poll", "moderation", "system"]),
    }),
  ),
});

type StoredHistory = v.InferOutput<typeof historySchema>;

export type TwitchChatHistoryStore = {
  readonly load: (streamId: string) => Promise<ResultType<ChatHistory, LivefeedError>>;
  readonly append: (streamId: string, event: ChatEvent) => Promise<ResultType<void, LivefeedError>>;
};

export const TwitchChatHistory = {
  file(directory = defaultHistoryDirectory()): TwitchChatHistoryStore {
    const historyPath = join(directory, "history.json");
    const temporaryPath = join(directory, "history.json.tmp");
    let cached: StoredHistory | null | undefined;
    let pendingWrite = Promise.resolve();

    const read = async (): Promise<ResultType<StoredHistory | null, LivefeedError>> => {
      if (cached !== undefined) return Result.ok(cached);
      let encoded: string;
      try {
        encoded = await readFile(historyPath, "utf8");
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") {
          cached = null;
          return Result.ok(null);
        }
        return Result.err(historyError("load", cause));
      }
      try {
        const decoded: unknown = JSON.parse(encoded);
        const parsed = v.safeParse(historySchema, decoded);
        if (!parsed.success) {
          return Result.err({
            _tag: "TwitchHistoryUnavailable",
            operation: "load",
            reason: "the saved history file is invalid",
          });
        }
        cached = {
          ...parsed.output,
          events: parsed.output.events.slice(-2000),
        };
        return Result.ok(cached);
      } catch (cause) {
        return Result.err(historyError("load", cause));
      }
    };

    const append = async (
      streamId: string,
      event: ChatEvent,
    ): Promise<ResultType<void, LivefeedError>> => {
      const current = await read();
      if (Result.isError(current)) return Result.err(current.error);
      const events =
        current.value?.streamId === streamId
          ? appendBounded(current.value.events, [event])
          : [event];
      const next: StoredHistory = { streamId, events: [...events] };
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporaryPath, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, historyPath);
        cached = next;
        return Result.ok(undefined);
      } catch (cause) {
        return Result.err(historyError("save", cause));
      }
    };

    return {
      async load(streamId) {
        const stored = await read();
        if (Result.isError(stored)) return Result.err(stored.error);
        return Result.ok({
          events: stored.value?.streamId === streamId ? stored.value.events : [],
          nextPageToken: "",
        });
      },
      append(streamId, event) {
        const result = pendingWrite.then(() => append(streamId, event));
        pendingWrite = result.then(() => undefined);
        return result;
      },
    };
  },
} as const;

export const defaultTwitchChatHistory = TwitchChatHistory.file();

function defaultHistoryDirectory(): string {
  const xdgStateHome = process.env["XDG_STATE_HOME"];
  if (xdgStateHome) return join(xdgStateHome, "livefeed", "twitch");
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "livefeed", "twitch")
    : join(homedir(), ".local", "state", "livefeed", "twitch");
}

function historyError(
  operation: "load" | "save",
  cause: unknown,
): Extract<LivefeedError, { readonly _tag: "TwitchHistoryUnavailable" }> {
  return {
    _tag: "TwitchHistoryUnavailable",
    operation,
    reason: cause instanceof Error ? cause.message : "unknown filesystem error",
  };
}

function errorCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
  const code: unknown = Reflect.get(cause, "code");
  return typeof code === "string" ? code : null;
}
