import {
  credentials as grpcCredentials,
  Metadata,
  status as GrpcStatus,
  type ServiceError,
} from "@grpc/grpc-js";
import { Result, type Result as ResultType } from "better-result";
import * as v from "valibot";
import type { Broadcast, ChatEvent as ChatEventType } from "./domain";
import { ChatEvent } from "./domain";
import type { LivefeedError } from "./errors";
import {
  LiveChatMessageType,
  type LiveChatMessageListResponse,
  V3DataLiveChatMessageServiceClient,
} from "./generated/stream_list";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const broadcastsSchema = v.object({
  items: v.array(
    v.object({
      id: v.string(),
      snippet: v.object({
        title: v.string(),
        actualStartTime: v.optional(v.string()),
        liveChatId: v.optional(v.string()),
      }),
    }),
  ),
});

const historySchema = v.object({
  nextPageToken: v.string(),
  items: v.array(
    v.object({
      id: v.string(),
      snippet: v.object({
        type: v.string(),
        publishedAt: v.optional(v.string()),
        displayMessage: v.optional(v.string()),
      }),
      authorDetails: v.optional(
        v.object({
          channelId: v.optional(v.string()),
          displayName: v.optional(v.string()),
          isVerified: v.optional(v.boolean()),
          isChatOwner: v.optional(v.boolean()),
          isChatSponsor: v.optional(v.boolean()),
          isChatModerator: v.optional(v.boolean()),
        }),
      ),
    }),
  ),
});

export async function findActiveBroadcast(
  accessToken: string,
  fetcher: Fetcher = globalThis.fetch,
): Promise<ResultType<Broadcast, LivefeedError>> {
  const url = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");
  url.search = new URLSearchParams({
    part: "id,snippet",
    broadcastStatus: "active",
    broadcastType: "all",
    maxResults: "50",
  }).toString();
  let response: Response;
  try {
    response = await fetcher(url, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (cause) {
    return Result.err(networkError(cause));
  }
  if (response.status === 401) {
    await response.body?.cancel();
    return Result.err({ _tag: "TokenRejected" });
  }
  if (response.status === 403) {
    const body = await response.text();
    if (body.includes("liveStreamingNotEnabled")) {
      return Result.err({ _tag: "LiveStreamingDisabled" });
    }
  }
  if (!response.ok) {
    return Result.err({
      _tag: "GoogleServiceFailure",
      status: response.status,
      reason: response.statusText,
    });
  }
  const body: unknown = await response.json();
  const parsed = v.safeParse(broadcastsSchema, body);
  if (!parsed.success) {
    return Result.err({ _tag: "InvalidGoogleResponse", operation: "broadcast discovery" });
  }
  const active = parsed.output.items
    .filter((item) => item.snippet.actualStartTime && item.snippet.liveChatId)
    .sort((left, right) =>
      (right.snippet.actualStartTime ?? "").localeCompare(left.snippet.actualStartTime ?? ""),
    )[0];
  if (!active?.snippet.actualStartTime || !active.snippet.liveChatId) {
    return Result.err({ _tag: "NoActiveBroadcast", channelTitle: "your channel" });
  }
  return Result.ok({
    id: active.id,
    title: active.snippet.title,
    actualStartTime: active.snippet.actualStartTime,
    liveChatId: active.snippet.liveChatId,
  });
}

export type ChatHistory = {
  readonly events: readonly ChatEventType[];
  readonly nextPageToken: string;
};

export async function loadChatHistory(
  accessToken: string,
  liveChatId: string,
  fetcher: Fetcher = globalThis.fetch,
): Promise<ResultType<ChatHistory, LivefeedError>> {
  const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
  url.search = new URLSearchParams({
    liveChatId,
    part: "id,snippet,authorDetails",
    maxResults: "2000",
  }).toString();
  let response: Response;
  try {
    response = await fetcher(url, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (cause) {
    return Result.err(networkError(cause));
  }
  if (response.status === 401) {
    await response.body?.cancel();
    return Result.err({ _tag: "TokenRejected" });
  }
  if (!response.ok) {
    const body = await response.text();
    if (body.includes("liveChatDisabled")) return Result.err({ _tag: "ChatDisabled" });
    if (body.includes("liveChatEnded")) return Result.err({ _tag: "ChatEnded" });
    if (body.includes("quotaExceeded")) return Result.err({ _tag: "QuotaExceeded" });
    return Result.err({
      _tag: "GoogleServiceFailure",
      status: response.status,
      reason: response.statusText,
    });
  }
  const body: unknown = await response.json();
  const parsed = v.safeParse(historySchema, body);
  if (!parsed.success) {
    return Result.err({ _tag: "InvalidGoogleResponse", operation: "chat history" });
  }
  const events = parsed.output.items
    .map((message) =>
      ChatEvent.fromMessage({
        id: message.id,
        snippet: {
          type: historyMessageType(message.snippet.type),
          publishedAt: message.snippet.publishedAt,
          displayMessage: message.snippet.displayMessage,
          hasDisplayContent: Boolean(message.snippet.displayMessage),
        },
        authorDetails: message.authorDetails,
      }),
    )
    .filter((event): event is ChatEventType => event !== null);
  return Result.ok({ events, nextPageToken: parsed.output.nextPageToken });
}

export type ChatStreamCallbacks = {
  readonly onMessages: (messages: readonly ChatEventType[]) => void;
  readonly onResponse: (pageToken: string) => void;
  readonly onClose: () => void;
  readonly onEnd: () => void;
  readonly onError: (error: LivefeedError) => void;
};

export type ChatConnection = { readonly cancel: () => void };

export function openChatStream(
  accessToken: string,
  liveChatId: string,
  pageToken: string,
  callbacks: ChatStreamCallbacks,
): ChatConnection {
  const client = new V3DataLiveChatMessageServiceClient(
    "youtube.googleapis.com:443",
    grpcCredentials.createSsl(),
  );
  const metadata = new Metadata();
  metadata.set("authorization", `Bearer ${accessToken}`);
  const stream = client.streamList(
    { liveChatId, pageToken, part: ["id", "snippet", "authorDetails"] },
    metadata,
  );
  let errored = false;
  let ended = false;
  let cancelled = false;
  stream.on("data", (response: LiveChatMessageListResponse) => {
    callbacks.onResponse(response.nextPageToken ?? "");
    const messages = response.items
      .map(ChatEvent.fromMessage)
      .filter((event): event is ChatEventType => event !== null);
    if (messages.length > 0) callbacks.onMessages(messages);
    if (response.offlineAt) {
      ended = true;
      callbacks.onEnd();
    }
  });
  stream.on("error", (error: ServiceError) => {
    if (cancelled) return;
    errored = true;
    callbacks.onError(mapGrpcError(error));
  });
  stream.on("end", () => {
    if (!cancelled && !errored && !ended) callbacks.onClose();
    client.close();
  });
  return {
    cancel() {
      cancelled = true;
      stream.cancel();
      client.close();
    },
  };
}

function mapGrpcError(error: ServiceError): LivefeedError {
  if (error.code === GrpcStatus.UNAUTHENTICATED) return { _tag: "TokenRejected" };
  if (error.code === GrpcStatus.RESOURCE_EXHAUSTED) return { _tag: "QuotaExceeded" };
  if (error.code === GrpcStatus.FAILED_PRECONDITION) {
    return error.details.includes("DISABLED") ? { _tag: "ChatDisabled" } : { _tag: "ChatEnded" };
  }
  if ([GrpcStatus.UNAVAILABLE, GrpcStatus.DEADLINE_EXCEEDED].includes(error.code)) {
    return { _tag: "NetworkUnavailable", reason: error.details || "connection unavailable" };
  }
  return {
    _tag: "GoogleServiceFailure",
    status: error.code,
    reason: error.details || error.message,
  };
}

function networkError(cause: unknown): LivefeedError {
  return {
    _tag: "NetworkUnavailable",
    reason: cause instanceof Error ? cause.message : "network request failed",
  };
}

function historyMessageType(type: string): LiveChatMessageType {
  switch (type) {
    case "textMessageEvent":
      return LiveChatMessageType.TEXT_MESSAGE_EVENT;
    case "tombstone":
      return LiveChatMessageType.TOMBSTONE;
    case "chatEndedEvent":
      return LiveChatMessageType.CHAT_ENDED_EVENT;
    case "sponsorOnlyModeStartedEvent":
      return LiveChatMessageType.SPONSOR_ONLY_MODE_STARTED_EVENT;
    case "sponsorOnlyModeEndedEvent":
      return LiveChatMessageType.SPONSOR_ONLY_MODE_ENDED_EVENT;
    case "newSponsorEvent":
      return LiveChatMessageType.NEW_SPONSOR_EVENT;
    case "userBannedEvent":
      return LiveChatMessageType.USER_BANNED_EVENT;
    case "superChatEvent":
      return LiveChatMessageType.SUPER_CHAT_EVENT;
    case "superStickerEvent":
      return LiveChatMessageType.SUPER_STICKER_EVENT;
    case "memberMilestoneChatEvent":
      return LiveChatMessageType.MEMBER_MILESTONE_CHAT_EVENT;
    case "membershipGiftingEvent":
      return LiveChatMessageType.MEMBERSHIP_GIFTING_EVENT;
    case "giftMembershipReceivedEvent":
      return LiveChatMessageType.GIFT_MEMBERSHIP_RECEIVED_EVENT;
    case "pollEvent":
      return LiveChatMessageType.POLL_EVENT;
    case "giftEvent":
      return LiveChatMessageType.GIFT_EVENT;
    default:
      return LiveChatMessageType.UNRECOGNIZED;
  }
}

export function retryDelaySeconds(attempt: number): number {
  return [1, 2, 4, 8, 15][Math.min(attempt, 4)] ?? 15;
}
