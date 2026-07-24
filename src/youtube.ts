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
  type LiveChatMessageListResponse,
  V3DataLiveChatMessageServiceClient,
} from "./generated/stream_list";

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

export async function findActiveBroadcast(
  accessToken: string,
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
    response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (cause) {
    return Result.err(networkError(cause));
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

export function retryDelaySeconds(attempt: number): number {
  return [1, 2, 4, 8, 15][Math.min(attempt, 4)] ?? 15;
}
