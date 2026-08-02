import { Result, type Result as ResultType } from "better-result";
import * as v from "valibot";
import type { Broadcast } from "./domain";
import type { LivefeedError } from "./errors";
import type { ChatConnection, ChatHistory, ChatStreamCallbacks } from "./feed";
import type { KickCredentials } from "./kick-auth";

const DEFAULT_AUTH_SERVER = "https://livefeed-auth.dipxsy.app";
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const streamsSchema = v.object({
  data: v.array(
    v.object({
      id: v.string(),
      title: v.string(),
      started_at: v.string(),
      broadcaster_user: v.object({ id: v.number(), username: v.string() }),
    }),
  ),
});
const chatEventSchema = v.object({
  id: v.string(),
  authorChannelId: v.string(),
  authorName: v.string(),
  role: v.picklist(["owner", "moderator", "member", "viewer"]),
  verified: v.boolean(),
  message: v.string(),
  publishedAt: v.string(),
  kind: v.picklist(["text", "membership", "paid", "gift", "poll", "moderation", "system"]),
});
const historySchema = v.object({
  events: v.array(chatEventSchema),
  nextPageToken: v.string(),
});
const relayEventSchema = v.variant("type", [
  v.object({ type: v.literal("message"), event: chatEventSchema }),
  v.object({ type: v.literal("started") }),
  v.object({ type: v.literal("ended") }),
]);

export async function findActiveKickBroadcast(
  accessToken: string,
  credentials: KickCredentials,
  fetcher: Fetcher = globalThis.fetch,
): Promise<ResultType<Broadcast, LivefeedError>> {
  const url = new URL("https://api.kick.com/public/v1/users/livestreams");
  url.searchParams.set("user_id", credentials.userId);
  const response = await safeFetch(fetcher, url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (Result.isError(response)) return Result.err(response.error);
  if (response.value.status === 401) {
    await response.value.body?.cancel();
    return Result.err({ _tag: "KickTokenRejected" });
  }
  if (!response.value.ok) return Result.err(await kickResponseError(response.value));
  const body: unknown = await response.value.json();
  const parsed = v.safeParse(streamsSchema, body);
  if (!parsed.success) {
    return Result.err({ _tag: "InvalidKickResponse", operation: "stream discovery" });
  }
  const stream = parsed.output.data.find(
    (candidate) => String(candidate.broadcaster_user.id) === credentials.userId,
  );
  if (!stream) {
    return Result.err({ _tag: "NoActiveBroadcast", channelTitle: credentials.displayName });
  }
  return Result.ok({
    id: stream.id,
    title: stream.title,
    actualStartTime: stream.started_at,
    liveChatId: stream.id,
  });
}

export async function loadKickChatHistory(
  credentials: KickCredentials,
  fetcher: Fetcher = globalThis.fetch,
  authServer = DEFAULT_AUTH_SERVER,
): Promise<ResultType<ChatHistory, LivefeedError>> {
  const url = new URL(`/v1/kick/relay/${credentials.userId}/history`, authServer);
  const response = await safeFetch(fetcher, url, {
    headers: { authorization: `Bearer ${credentials.relayToken}` },
  });
  if (Result.isError(response)) return Result.err(response.error);
  if (response.value.status === 401) {
    await response.value.body?.cancel();
    return Result.err({ _tag: "KickTokenRejected" });
  }
  if (!response.value.ok) return Result.err(await relayResponseError(response.value));
  const body: unknown = await response.value.json();
  const parsed = v.safeParse(historySchema, body);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err({ _tag: "InvalidKickResponse", operation: "chat history" });
}

export function openKickChatStream(
  credentials: KickCredentials,
  callbacks: ChatStreamCallbacks,
  authServer = DEFAULT_AUTH_SERVER,
): ChatConnection {
  let cancelled = false;
  let failed = false;
  const url = new URL(`/v1/kick/relay/${credentials.userId}/stream`, authServer);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, ["livefeed", credentials.relayToken]);

  const fail = (error: LivefeedError): void => {
    if (cancelled || failed) return;
    failed = true;
    callbacks.onError(error);
    socket.close();
  };

  socket.addEventListener("open", () => callbacks.onResponse(""));
  socket.addEventListener("message", (frame) => {
    void frameText(frame.data).then((text) => {
      if (cancelled || Result.isError(text)) {
        if (Result.isError(text)) fail(text.error);
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(text.value);
      } catch {
        fail({ _tag: "InvalidKickResponse", operation: "chat event decoding" });
        return;
      }
      const parsed = v.safeParse(relayEventSchema, decoded);
      if (!parsed.success) {
        fail({ _tag: "InvalidKickResponse", operation: "chat event decoding" });
        return;
      }
      if (parsed.output.type === "message") callbacks.onMessages([parsed.output.event]);
      if (parsed.output.type === "ended") callbacks.onEnd();
    });
  });
  socket.addEventListener("close", () => {
    if (!cancelled && !failed) callbacks.onClose();
  });
  socket.addEventListener("error", () => {
    fail({ _tag: "NetworkUnavailable", reason: "Kick chat relay connection failed" });
  });

  return {
    cancel() {
      cancelled = true;
      socket.close();
    },
  };
}

async function frameText(value: unknown): Promise<ResultType<string, LivefeedError>> {
  if (typeof value === "string") return Result.ok(value);
  if (value instanceof Blob) return Result.ok(await value.text());
  if (value instanceof ArrayBuffer) {
    return Result.ok(new TextDecoder().decode(new Uint8Array(value)));
  }
  return Result.err({ _tag: "InvalidKickResponse", operation: "chat event decoding" });
}

async function safeFetch(
  fetcher: Fetcher,
  input: string | URL,
  init?: RequestInit,
): Promise<ResultType<Response, LivefeedError>> {
  try {
    return Result.ok(await fetcher(input, init));
  } catch (cause) {
    return Result.err({
      _tag: "NetworkUnavailable",
      reason: cause instanceof Error ? cause.message : "network request failed",
    });
  }
}

async function kickResponseError(response: Response): Promise<LivefeedError> {
  let reason = response.statusText || "unexpected response";
  try {
    const body: unknown = await response.json();
    const parsed = v.safeParse(v.object({ message: v.string() }), body);
    if (parsed.success) reason = parsed.output.message;
  } catch {
    // Keep the HTTP status text when Kick did not return JSON.
  }
  return { _tag: "KickServiceFailure", status: response.status, reason };
}

async function relayResponseError(response: Response): Promise<LivefeedError> {
  let reason = response.statusText || "unexpected response";
  try {
    const body: unknown = await response.json();
    const parsed = v.safeParse(v.object({ error: v.string() }), body);
    if (parsed.success) reason = parsed.output.error;
  } catch {
    // Keep the HTTP status text when the relay did not return JSON.
  }
  return { _tag: "KickServiceFailure", status: response.status, reason };
}
