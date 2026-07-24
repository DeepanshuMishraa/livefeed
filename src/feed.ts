import type { Result } from "better-result";
import type { Broadcast, ChatEvent } from "./domain";
import type { LivefeedError } from "./errors";

export type ChatHistory = {
  readonly events: readonly ChatEvent[];
  readonly nextPageToken: string;
};

export type ChatStreamCallbacks = {
  readonly onMessages: (messages: readonly ChatEvent[]) => void;
  readonly onResponse: (pageToken: string) => void;
  readonly onClose: () => void;
  readonly onEnd: () => void;
  readonly onError: (error: LivefeedError) => void;
};

export type ChatConnection = { readonly cancel: () => void };

export type FeedClient = {
  readonly channelTitle: string;
  readonly refreshAccessToken: () => Promise<Result<string, LivefeedError>>;
  readonly findActiveBroadcast: (accessToken: string) => Promise<Result<Broadcast, LivefeedError>>;
  readonly loadChatHistory: (
    accessToken: string,
    liveChatId: string,
  ) => Promise<Result<ChatHistory, LivefeedError>>;
  readonly openChatStream: (
    accessToken: string,
    liveChatId: string,
    pageToken: string,
    callbacks: ChatStreamCallbacks,
  ) => ChatConnection;
};
