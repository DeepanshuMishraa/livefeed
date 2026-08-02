import { Result } from "better-result";
import type { Provider } from "./cli";
import type { AuthorRole, Broadcast, ChatEvent } from "./domain";
import type { FeedClient } from "./feed";

const MIN_MESSAGE_DELAY_MS = 3_000;
const MESSAGE_DELAY_RANGE_MS = 1_000;

type DemoAuthor = {
  readonly id: string;
  readonly name: string;
  readonly role: AuthorRole;
  readonly verified: boolean;
};

type DemoRuntime = {
  readonly random: () => number;
  readonly now: () => string;
  readonly schedule: (callback: () => void, delayMilliseconds: number) => () => void;
};

type DemoOverrides = Partial<DemoRuntime>;

const authors: readonly [DemoAuthor, ...DemoAuthor[]] = [
  { id: "aurora42", name: "aurora42", role: "viewer", verified: false },
  { id: "pixelpilot", name: "pixelpilot", role: "member", verified: false },
  { id: "codesage", name: "code_sage", role: "moderator", verified: false },
  { id: "devnull", name: "devnull", role: "viewer", verified: false },
  { id: "streamghost", name: "streamghost", role: "viewer", verified: false },
  { id: "logicloop", name: "logicloop", role: "member", verified: true },
  { id: "bytebender", name: "bytebender", role: "viewer", verified: false },
  { id: "syntaxsam", name: "syntax_sam", role: "viewer", verified: false },
];

const messages: readonly [string, ...string[]] = [
  "This setup is so clean",
  "Let's go! 🔥",
  "CLI chat is the move",
  "That transition was smooth",
  "Hello from the terminal 👋",
  "No browser tabs, finally",
  "This is actually huge",
  "Shipping live is brave",
  "The latency looks great",
  "Subscribed!",
  "Can we get a demo of that command?",
  "Love the minimal UI",
];

const providerLabels = {
  youtube: "YouTube",
  twitch: "Twitch",
  kick: "Kick",
} as const satisfies Record<Provider, string>;

export function demoFeed(provider: Provider, overrides: DemoOverrides = {}): FeedClient {
  const runtime = demoRuntime(overrides);
  const label = providerLabels[provider];
  const broadcast: Broadcast = {
    id: `${provider}-demo`,
    title: `${label} · Livefeed demo`,
    actualStartTime: runtime.now(),
    liveChatId: `${provider}-demo-chat`,
  };

  return {
    channelTitle: `${label} demo`,
    refreshAccessToken: async () => Result.ok("demo"),
    findActiveBroadcast: async () => Result.ok(broadcast),
    loadChatHistory: async () => Result.ok({ events: [], nextPageToken: "demo" }),
    openChatStream: (_accessToken, _liveChatId, _pageToken, callbacks) => {
      let cancelled = false;
      let sequence = 0;
      let cancelScheduled: (() => void) | null = null;

      const scheduleNext = (): void => {
        cancelScheduled = runtime.schedule(emitMessage, messageDelay(runtime.random()));
      };

      const emitMessage = (): void => {
        if (cancelled) return;
        sequence += 1;
        callbacks.onMessages([demoEvent(provider, sequence, runtime)]);
        scheduleNext();
      };

      callbacks.onResponse("demo");
      scheduleNext();

      return {
        cancel: () => {
          cancelled = true;
          cancelScheduled?.();
          cancelScheduled = null;
        },
      };
    },
  };
}

function demoEvent(provider: Provider, sequence: number, runtime: DemoRuntime): ChatEvent {
  const author = randomItem(authors, runtime.random());
  return {
    id: `${provider}-demo-${sequence}`,
    authorChannelId: author.id,
    authorName: author.name,
    role: author.role,
    verified: author.verified,
    message: randomItem(messages, runtime.random()),
    publishedAt: runtime.now(),
    kind: "text",
  };
}

function randomItem<T>(items: readonly [T, ...T[]], random: number): T {
  const index = Math.floor(normalizedRandom(random) * items.length);
  return items[index] ?? items[0];
}

function messageDelay(random: number): number {
  return MIN_MESSAGE_DELAY_MS + Math.floor(normalizedRandom(random) * MESSAGE_DELAY_RANGE_MS);
}

function normalizedRandom(random: number): number {
  return Math.min(1, Math.max(0, random));
}

function demoRuntime(overrides: DemoOverrides): DemoRuntime {
  return {
    random: overrides.random ?? Math.random,
    now: overrides.now ?? (() => new Date().toISOString()),
    schedule:
      overrides.schedule ??
      ((callback, delayMilliseconds) => {
        const timer = setTimeout(callback, delayMilliseconds);
        return () => clearTimeout(timer);
      }),
  };
}
