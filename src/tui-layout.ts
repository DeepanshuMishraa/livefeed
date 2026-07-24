import type { ConnectionState } from "./domain";

export type StatusTone = "connected" | "muted" | "warning" | "live";

export type StatusDisplay = {
  readonly text: string;
  readonly tone: StatusTone;
};

export const ChatLayoutPolicy = {
  showStatus(height: number): boolean {
    return height > 1;
  },

  status({
    width,
    title,
    state,
    following,
    unread,
  }: {
    readonly width: number;
    readonly title: string;
    readonly state: ConnectionState;
    readonly following: boolean;
    readonly unread: number;
  }): StatusDisplay {
    const status =
      state._tag === "live"
        ? { label: "connected", short: "LIVE", tone: "connected" as const }
        : state._tag === "waiting"
          ? {
              label: "not connected · livestream offline",
              short: "OFFLINE",
              tone: "muted" as const,
            }
          : state._tag === "connecting"
            ? { label: "connecting…", short: "WAIT", tone: "muted" as const }
            : state._tag === "reconnecting"
              ? {
                  label: `reconnecting in ${state.retryInSeconds}s…`,
                  short: "RETRY",
                  tone: "warning" as const,
                }
              : state._tag === "ended"
                ? { label: "stream ended", short: "ENDED", tone: "muted" as const }
                : { label: state.message, short: "ERROR", tone: "live" as const };
    const reading = !following && unread > 0 ? ` · ${unread} new · G latest` : "";
    const text =
      width < 14
        ? status.short
        : width < 48
          ? `● ${status.label}${reading}`
          : `● ${status.label} · ${title}${reading} · q quit`;
    return { text, tone: status.tone };
  },
} as const;
