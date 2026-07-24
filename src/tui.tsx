import {
  CliRenderEvents,
  createCliRenderer,
  type ScrollBoxRenderable,
  type ThemeMode,
} from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { Result } from "better-result";
import { type RefObject, useEffect, useRef, useState } from "react";
import { accessToken as refreshAccessToken, type Credentials } from "./auth";
import type { Broadcast, ChatEvent, ConnectionState } from "./domain";
import { appendBounded, stableAuthorColor } from "./domain";
import { LivefeedError, type LivefeedError as LivefeedErrorType } from "./errors";
import { ChatLayoutPolicy } from "./tui-layout";
import {
  findActiveBroadcast,
  type ChatConnection,
  loadChatHistory,
  openChatStream,
  retryDelaySeconds,
} from "./youtube";

const DISCOVERY_INTERVAL_MS = 10_000;
const ENDED_STATUS_MS = 3_000;

const palettes = {
  dark: {
    primary: "#d9dbea",
    muted: "#777f96",
    live: "#ef6b73",
    connected: "#78c7a3",
    warning: "#d8b568",
    paid: "#e4bd63",
  },
  light: {
    primary: "#242424",
    muted: "#656565",
    live: "#b4232f",
    connected: "#247653",
    warning: "#876400",
    paid: "#806300",
  },
} as const;

type Palette = (typeof palettes)[ThemeMode];

function App({
  initialBroadcast,
  initialAccessToken,
  credentials,
}: {
  readonly initialBroadcast: Broadcast | null;
  readonly initialAccessToken: string;
  readonly credentials: Credentials;
}) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [theme, setTheme] = useState<ThemeMode>(renderer.themeMode ?? "dark");
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const streamRef = useRef<ChatConnection | null>(null);
  const accessTokenRef = useRef(initialAccessToken);
  const followingRef = useRef(true);
  const [broadcast, setBroadcast] = useState<Broadcast | null>(initialBroadcast);
  const [events, setEvents] = useState<readonly ChatEvent[]>([]);
  const [state, setState] = useState<ConnectionState>(
    initialBroadcast ? { _tag: "connecting" } : { _tag: "waiting" },
  );
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  const noColor = process.env["NO_COLOR"] !== undefined;

  useEffect(() => {
    const onThemeMode = (mode: ThemeMode) => setTheme(mode);
    renderer.on(CliRenderEvents.THEME_MODE, onThemeMode);
    return () => {
      renderer.off(CliRenderEvents.THEME_MODE, onThemeMode);
    };
  }, [renderer]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: Timer | null = null;
    let attempt = 0;
    let refreshing = false;
    let pageToken = "";

    const schedule = (operation: () => void | Promise<void>, delayMilliseconds: number) => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        void operation();
      }, delayMilliseconds);
    };

    const retryAfter = (error: LivefeedErrorType, operation: () => void | Promise<void>): void => {
      if (error._tag === "TokenRejected" && !refreshing) {
        refreshing = true;
        void refreshAccessToken(credentials).then((result) => {
          refreshing = false;
          if (cancelled) return;
          if (Result.isError(result)) {
            setState({ _tag: "fatal", message: LivefeedError.message(result.error) });
            return;
          }
          accessTokenRef.current = result.value;
          attempt = 0;
          void operation();
        });
        return;
      }
      if (error._tag === "NetworkUnavailable" || error._tag === "GoogleServiceFailure") {
        const delay = retryDelaySeconds(attempt);
        attempt += 1;
        setState({ _tag: "reconnecting", attempt, retryInSeconds: delay });
        schedule(operation, delay * 1000);
        return;
      }
      if (error._tag === "ChatEnded") {
        setState({ _tag: "ended" });
        schedule(() => {
          setEvents([]);
          setBroadcast(null);
        }, ENDED_STATUS_MS);
        return;
      }
      setState({ _tag: "fatal", message: LivefeedError.message(error) });
    };

    if (!broadcast) {
      const discover = async (): Promise<void> => {
        const result = await findActiveBroadcast(accessTokenRef.current);
        if (cancelled) return;
        if (Result.isError(result)) {
          if (result.error._tag === "NoActiveBroadcast") {
            attempt = 0;
            setState({ _tag: "waiting" });
            schedule(discover, DISCOVERY_INTERVAL_MS);
            return;
          }
          retryAfter(result.error, discover);
          return;
        }
        attempt = 0;
        followingRef.current = true;
        setFollowing(true);
        setUnread(0);
        setEvents([]);
        setState({ _tag: "connecting" });
        setBroadcast(result.value);
      };

      setState({ _tag: "waiting" });
      void discover();
    } else {
      const connect = (): void => {
        if (cancelled) return;
        streamRef.current?.cancel();
        streamRef.current = openChatStream(
          accessTokenRef.current,
          broadcast.liveChatId,
          pageToken,
          {
            onMessages(messages) {
              setEvents((current) => appendBounded(current, messages));
              if (!followingRef.current) setUnread((current) => current + messages.length);
              attempt = 0;
              setState({ _tag: "live" });
            },
            onResponse(nextPageToken) {
              pageToken = nextPageToken;
              attempt = 0;
              setState({ _tag: "live" });
            },
            onClose() {
              schedule(connect, pageToken ? 0 : 1000);
            },
            onEnd() {
              setState({ _tag: "ended" });
              schedule(() => {
                setEvents([]);
                setBroadcast(null);
              }, ENDED_STATUS_MS);
            },
            onError(error) {
              retryAfter(error, connect);
            },
          },
        );
      };

      const loadHistoryAndConnect = async (): Promise<void> => {
        setState({ _tag: "connecting" });
        const history = await loadChatHistory(accessTokenRef.current, broadcast.liveChatId);
        if (cancelled) return;
        if (Result.isError(history)) {
          retryAfter(history.error, loadHistoryAndConnect);
          return;
        }
        pageToken = history.value.nextPageToken;
        setEvents(history.value.events);
        connect();
      };

      void loadHistoryAndConnect();
    }

    return () => {
      cancelled = true;
      streamRef.current?.cancel();
      streamRef.current = null;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [broadcast, credentials]);

  useKeyboard((key) => {
    if (key.name === "q") renderer.destroy();
    if (key.name === "g" && key.shift) {
      scrollRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
      followingRef.current = true;
      setFollowing(true);
      setUnread(0);
    }
    if (["up", "k", "pageup"].includes(key.name)) {
      followingRef.current = false;
      setFollowing(false);
    }
  });

  return (
    <ChatLayout
      width={dimensions.width}
      height={dimensions.height}
      title={broadcast?.title ?? credentials.channelTitle}
      events={events}
      state={state}
      following={following}
      unread={unread}
      noColor={noColor}
      theme={theme}
      scrollRef={scrollRef}
    />
  );
}

export function ChatLayout({
  width,
  height,
  title,
  events,
  state,
  following,
  unread,
  noColor,
  theme,
  scrollRef,
}: {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly events: readonly ChatEvent[];
  readonly state: ConnectionState;
  readonly following: boolean;
  readonly unread: number;
  readonly noColor: boolean;
  readonly theme: ThemeMode;
  readonly scrollRef?: RefObject<ScrollBoxRenderable | null>;
}) {
  const palette = palettes[theme];
  const showStatus = ChatLayoutPolicy.showStatus(height);
  return (
    <box width="100%" height="100%" flexDirection="column">
      {showStatus ? (
        <ConnectionLine
          width={width}
          title={title}
          state={state}
          following={following}
          unread={unread}
          palette={palette}
        />
      ) : null}
      <scrollbox
        ref={scrollRef}
        width="100%"
        flexGrow={1}
        focused
        scrollX={false}
        scrollY
        stickyScroll
        stickyStart="bottom"
        rootOptions={{ backgroundColor: "transparent" }}
        wrapperOptions={{ backgroundColor: "transparent" }}
        viewportOptions={{ backgroundColor: "transparent" }}
        contentOptions={{ backgroundColor: "transparent" }}
        verticalScrollbarOptions={{ visible: false, width: 0 }}
        horizontalScrollbarOptions={{ visible: false, height: 0 }}
      >
        {events.length === 0 ? (
          <text width="100%" fg={palette.muted}>
            {state._tag === "waiting"
              ? "No active livestream. Watching for one…"
              : state._tag === "ended"
                ? "Livestream ended. Watching for the next one…"
                : "Waiting for chat…"}
          </text>
        ) : (
          events.map((event) => (
            <MessageRow
              key={event.id}
              event={event}
              noColor={noColor}
              theme={theme}
              palette={palette}
            />
          ))
        )}
      </scrollbox>
    </box>
  );
}

function ConnectionLine({
  width,
  title,
  state,
  following,
  unread,
  palette,
}: {
  readonly width: number;
  readonly title: string;
  readonly state: ConnectionState;
  readonly following: boolean;
  readonly unread: number;
  readonly palette: Palette;
}) {
  const status = ChatLayoutPolicy.status({ width, title, state, following, unread });
  return (
    <text width="100%" height={1} fg={palette[status.tone]}>
      {status.text}
    </text>
  );
}

function MessageRow({
  event,
  noColor,
  theme,
  palette,
}: {
  readonly event: ChatEvent;
  readonly noColor: boolean;
  readonly theme: ThemeMode;
  readonly palette: Palette;
}) {
  const accent =
    event.kind === "paid"
      ? palette.paid
      : stableAuthorColor(event.authorChannelId, noColor, theme === "light");
  return (
    <text width="100%" selectable fg={event.kind === "system" ? palette.muted : palette.primary}>
      <span fg={accent}>
        <strong>{event.authorName}</strong>
      </span>
      <span fg={palette.muted}>: </span>
      {event.message}
    </text>
  );
}

export async function runTui(
  initialAccessToken: string,
  credentials: Credentials,
  initialBroadcast: Broadcast | null = null,
): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    targetFps: 30,
    backgroundColor: "transparent",
  });
  createRoot(renderer).render(
    <App
      initialBroadcast={initialBroadcast}
      initialAccessToken={initialAccessToken}
      credentials={credentials}
    />,
  );
}
