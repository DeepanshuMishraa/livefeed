import { secrets } from "bun";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateTwitch, twitchAccessToken } from "../src/twitch-auth";

vi.mock("bun", () => ({
  secrets: {
    delete: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("authenticateTwitch", () => {
  it("uses broker PKCE, opens Twitch, and stores the resulting login", async () => {
    let tokenPolls = 0;
    let openedUrl = "";
    const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/v1/oauth/twitch/sessions") {
        return Response.json(
          {
            sessionId: "session-id-with-enough-characters",
            authorizationUrl: "https://id.twitch.tv/oauth2/authorize?client_id=public-client-id",
            clientId: "public-client-id",
            expiresInSeconds: 300,
            pollIntervalSeconds: 1,
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/v1/oauth/twitch/token") {
        tokenPolls += 1;
        return tokenPolls === 1
          ? Response.json(
              { error: { code: "pending", message: "Authorization is still pending." } },
              { status: 202 },
            )
          : Response.json({
              accessToken: "access-token",
              refreshToken: "refresh-token",
              expiresIn: 14_400,
            });
      }
      if (url.pathname === "/helix/users") {
        return Response.json({
          data: [{ id: "user-1", login: "streamer", display_name: "Streamer" }],
        });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    });
    const sleep = vi.fn(async (): Promise<void> => undefined);

    const result = await authenticateTwitch({
      fetch: fetcher,
      now: () => 0,
      openBrowser: (url) => {
        openedUrl = url;
        return true;
      },
      sleep,
    });

    expect(result).toMatchObject({
      value: {
        refreshToken: "refresh-token",
        clientId: "public-client-id",
        userId: "user-1",
        displayName: "Streamer",
      },
    });
    expect(openedUrl).toContain("https://id.twitch.tv/oauth2/authorize");
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(secrets.set).toHaveBeenCalledWith({
      service: "dev.livefeed.cli",
      name: "twitch",
      value: JSON.stringify({
        refreshToken: "refresh-token",
        clientId: "public-client-id",
        userId: "user-1",
        login: "streamer",
        displayName: "Streamer",
      }),
    });
  });
});

describe("twitchAccessToken", () => {
  it("refreshes through the broker and persists a rotated refresh token", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json({
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          expiresIn: 3600,
        }),
    );

    const result = await twitchAccessToken(
      {
        refreshToken: "old-refresh-token",
        clientId: "public-client-id",
        userId: "user-1",
        login: "streamer",
        displayName: "Streamer",
      },
      { fetch: fetcher },
    );

    expect(result).toMatchObject({ value: "new-access-token" });
    expect(secrets.set).toHaveBeenCalledWith({
      service: "dev.livefeed.cli",
      name: "twitch",
      value: JSON.stringify({
        refreshToken: "new-refresh-token",
        clientId: "public-client-id",
        userId: "user-1",
        login: "streamer",
        displayName: "Streamer",
      }),
    });
  });
});
