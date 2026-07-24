import type { LiveChatMessage } from "./generated/stream_list";

export type AuthorRole = "owner" | "moderator" | "member" | "viewer";
export type ChatEventKind =
  | "text"
  | "membership"
  | "paid"
  | "gift"
  | "poll"
  | "moderation"
  | "system";

export type ChatEvent = {
  readonly id: string;
  readonly authorChannelId: string;
  readonly authorName: string;
  readonly role: AuthorRole;
  readonly verified: boolean;
  readonly message: string;
  readonly publishedAt: string;
  readonly kind: ChatEventKind;
};

export type Broadcast = {
  readonly id: string;
  readonly title: string;
  readonly actualStartTime: string;
  readonly liveChatId: string;
};

export type ConnectionState =
  | { readonly _tag: "connecting" }
  | { readonly _tag: "live" }
  | { readonly _tag: "reconnecting"; readonly attempt: number; readonly retryInSeconds: number }
  | { readonly _tag: "ended" }
  | { readonly _tag: "fatal"; readonly message: string };

export const ChatEvent = {
  fromMessage(message: LiveChatMessage): ChatEvent | null {
    const id = message.id;
    const snippet = message.snippet;
    if (!id || !snippet) return null;
    const author = message.authorDetails;
    const role: AuthorRole = author?.isChatOwner
      ? "owner"
      : author?.isChatModerator
        ? "moderator"
        : author?.isChatSponsor
          ? "member"
          : "viewer";

    return {
      id,
      authorChannelId: author?.channelId ?? "system",
      authorName: author?.displayName || "YouTube",
      role,
      verified: author?.isVerified ?? false,
      message: snippet.displayMessage || eventFallback(snippet.type ?? 0),
      publishedAt: snippet.publishedAt ?? "",
      kind: eventKind(snippet.type ?? 0),
    };
  },
} as const;

function eventKind(type: number): ChatEventKind {
  if (type === 1) return "text";
  if ([7, 17, 18, 19].includes(type)) return "membership";
  if ([15, 16].includes(type)) return "paid";
  if (type === 21) return "gift";
  if (type === 20) return "poll";
  if ([2, 10].includes(type)) return "moderation";
  return "system";
}

function eventFallback(type: number): string {
  switch (type) {
    case 2:
      return "Message removed";
    case 4:
      return "Chat ended";
    case 5:
      return "Members-only mode enabled";
    case 6:
      return "Members-only mode disabled";
    case 10:
      return "A viewer was moderated";
    default:
      return "Live chat event";
  }
}

export function stableAuthorColor(
  channelId: string,
  noColor = false,
  lightBackground = false,
): string {
  if (noColor) return lightBackground ? "#242424" : "#d7dae5";
  const palette = lightBackground
    ? ["#006b68", "#6f42a6", "#265f9e", "#39752a", "#9b3f62", "#806300"]
    : ["#79c7c5", "#c9a7eb", "#8fb8e8", "#93c47d", "#e3a6b8", "#d6b86a"];
  let hash = 2166136261;
  for (const character of channelId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return palette[Math.abs(hash) % palette.length] ?? "#79c7c5";
}

export function appendBounded(
  current: readonly ChatEvent[],
  incoming: readonly ChatEvent[],
  limit = 1000,
): readonly ChatEvent[] {
  const seen = new Set(current.map((event) => event.id));
  const unique = incoming.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  return [...current, ...unique].slice(-limit);
}
