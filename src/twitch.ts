import { Result, type Result as ResultType } from "better-result";
import * as v from "valibot";
import type { Broadcast, ChatEvent, AuthorRole } from "./domain";
import type { LivefeedError } from "./errors";
import type { ChatConnection, ChatHistory, ChatStreamCallbacks } from "./feed";
import type { TwitchCredentials } from "./twitch-auth";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const streamsSchema = v.object({
  data: v.array(
    v.object({
      id: v.string(),
      title: v.string(),
      started_at: v.string(),
      user_id: v.string(),
    }),
  ),
});
const envelopeSchema = v.object({
  metadata: v.object({
    message_type: v.string(),
    message_timestamp: v.optional(v.string()),
  }),
  payload: v.unknown(),
});
const welcomeSchema = v.object({
  session: v.object({ id: v.string() }),
});
const notificationSchema = v.object({
  subscription: v.object({ type: v.string() }),
  event: v.unknown(),
});
const chatMessageSchema = v.object({
  broadcaster_user_id: v.string(),
  chatter_user_id: v.string(),
  chatter_user_name: v.string(),
  message_id: v.string(),
  message: v.object({ text: v.string() }),
  badges: v.optional(
    v.array(
      v.object({
        set_id: v.string(),
      }),
    ),
  ),
});
const twitchErrorSchema = v.object({ message: v.string() });

export async function findActiveTwitchBroadcast(
  accessToken: string,
  credentials: TwitchCredentials,
  fetcher: Fetcher = globalThis.fetch,
): Promise<ResultType<Broadcast, LivefeedError>> {
  const url = new URL("https://api.twitch.tv/helix/streams");
  url.searchParams.set("user_id", credentials.userId);
  const response = await safeFetch(fetcher, url, {
    headers: twitchHeaders(credentials.clientId, accessToken),
  });
  if (Result.isError(response)) return Result.err(response.error);
  if (response.value.status === 401) {
    await response.value.body?.cancel();
    return Result.err({ _tag: "TwitchTokenRejected" });
  }
  if (!response.value.ok) return Result.err(await twitchResponseError(response.value));
  const body: unknown = await response.value.json();
  const parsed = v.safeParse(streamsSchema, body);
  if (!parsed.success) {
    return Result.err({ _tag: "InvalidTwitchResponse", operation: "stream discovery" });
  }
  const stream = parsed.output.data[0];
  if (!stream) {
    return Result.err({ _tag: "NoActiveBroadcast", channelTitle: credentials.displayName });
  }
  return Result.ok({
    id: stream.id,
    title: stream.title,
    actualStartTime: stream.started_at,
    liveChatId: stream.user_id,
  });
}

export async function loadTwitchChatHistory(): Promise<ResultType<ChatHistory, LivefeedError>> {
  return Result.ok({ events: [], nextPageToken: "" });
}

export function openTwitchChatStream(
  accessToken: string,
  broadcasterUserId: string,
  _pageToken: string,
  callbacks: ChatStreamCallbacks,
  clientId: string,
  fetcher: Fetcher = globalThis.fetch,
): ChatConnection {
  let socket: WebSocket | null = null;
  let cancelled = false;
  let failed = false;

  const fail = (error: LivefeedError): void => {
    if (cancelled || failed) return;
    failed = true;
    callbacks.onError(error);
    socket?.close();
  };

  const subscribe = async (sessionId: string): Promise<void> => {
    const subscriptions = [
      {
        type: "channel.chat.message",
        version: "1",
        condition: {
          broadcaster_user_id: broadcasterUserId,
          user_id: broadcasterUserId,
        },
      },
      {
        type: "stream.offline",
        version: "1",
        condition: { broadcaster_user_id: broadcasterUserId },
      },
    ] as const;
    for (const subscription of subscriptions) {
      const response = await safeFetch(
        fetcher,
        "https://api.twitch.tv/helix/eventsub/subscriptions",
        {
          method: "POST",
          headers: {
            ...twitchHeaders(clientId, accessToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...subscription,
            transport: { method: "websocket", session_id: sessionId },
          }),
        },
      );
      if (Result.isError(response)) {
        fail(response.error);
        return;
      }
      if (response.value.status === 401) {
        await response.value.body?.cancel();
        fail({ _tag: "TwitchTokenRejected" });
        return;
      }
      if (!response.value.ok) {
        fail(await twitchResponseError(response.value));
        return;
      }
      await response.value.body?.cancel();
    }
    callbacks.onResponse("");
  };

  const connect = (): void => {
    socket = new WebSocket("wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30");
    socket.addEventListener("message", (event) => {
      const data: unknown = event.data;
      void frameText(data).then((text) => {
        if (cancelled || Result.isError(text)) {
          if (Result.isError(text)) fail(text.error);
          return;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(text.value);
        } catch {
          fail({ _tag: "InvalidTwitchResponse", operation: "chat event decoding" });
          return;
        }
        const envelope = v.safeParse(envelopeSchema, decoded);
        if (!envelope.success) {
          fail({ _tag: "InvalidTwitchResponse", operation: "chat event decoding" });
          return;
        }
        if (envelope.output.metadata.message_type === "session_welcome") {
          const welcome = v.safeParse(welcomeSchema, envelope.output.payload);
          if (!welcome.success) {
            fail({ _tag: "InvalidTwitchResponse", operation: "chat connection" });
            return;
          }
          void subscribe(welcome.output.session.id);
          return;
        }
        if (envelope.output.metadata.message_type === "session_reconnect") {
          socket?.close();
          return;
        }
        if (envelope.output.metadata.message_type !== "notification") return;
        const notification = v.safeParse(notificationSchema, envelope.output.payload);
        if (!notification.success) return;
        if (notification.output.subscription.type === "stream.offline") {
          callbacks.onEnd();
          return;
        }
        if (notification.output.subscription.type !== "channel.chat.message") return;
        const message = twitchChatEvent(
          notification.output.event,
          envelope.output.metadata.message_timestamp ?? "",
        );
        if (message) callbacks.onMessages([message]);
      });
    });
    socket.addEventListener("close", () => {
      if (!cancelled && !failed) callbacks.onClose();
    });
    socket.addEventListener("error", () => {
      fail({ _tag: "NetworkUnavailable", reason: "Twitch chat connection failed" });
    });
  };

  connect();
  return {
    cancel() {
      cancelled = true;
      socket?.close();
      socket = null;
    },
  };
}

export function twitchChatEvent(value: unknown, publishedAt: string): ChatEvent | null {
  const parsed = v.safeParse(chatMessageSchema, value);
  if (!parsed.success) return null;
  const event = parsed.output;
  const badges = new Set((event.badges ?? []).map((badge) => badge.set_id));
  const role: AuthorRole =
    event.chatter_user_id === event.broadcaster_user_id
      ? "owner"
      : badges.has("moderator")
        ? "moderator"
        : badges.has("subscriber")
          ? "member"
          : "viewer";
  return {
    id: event.message_id,
    authorChannelId: event.chatter_user_id,
    authorName: event.chatter_user_name,
    role,
    verified: badges.has("verified"),
    message: event.message.text,
    publishedAt,
    kind: "text",
  };
}

function twitchHeaders(clientId: string, accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "client-id": clientId,
  };
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

async function twitchResponseError(response: Response): Promise<LivefeedError> {
  let reason = response.statusText || "unexpected response";
  try {
    const body: unknown = await response.json();
    const parsed = v.safeParse(twitchErrorSchema, body);
    if (parsed.success) reason = parsed.output.message;
  } catch {
    // Keep the HTTP status text when Twitch did not return JSON.
  }
  return { _tag: "TwitchServiceFailure", status: response.status, reason };
}

async function frameText(value: unknown): Promise<ResultType<string, LivefeedError>> {
  if (typeof value === "string") return Result.ok(value);
  if (value instanceof Blob) return Result.ok(await value.text());
  if (value instanceof ArrayBuffer) {
    return Result.ok(new TextDecoder().decode(new Uint8Array(value)));
  }
  return Result.err({ _tag: "InvalidTwitchResponse", operation: "chat event decoding" });
}
