import { secrets } from "bun";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateKick, kickAccessToken } from "../src/kick-auth";

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

describe("authenticateKick", () => {
  it("uses broker PKCE and stores relay credentials", async () => {
    let tokenPolls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/v1/oauth/kick/sessions") {
        return Response.json(
          {
            sessionId: "session-id-with-enough-characters",
            authorizationUrl: "https://id.kick.com/oauth/authorize?client_id=public-client-id",
            expiresInSeconds: 300,
            pollIntervalSeconds: 1,
          },
          { status: 201 },
        );
      }
      tokenPolls += 1;
      return tokenPolls === 1
        ? Response.json(
            { error: { code: "pending", message: "Authorization is still pending." } },
            { status: 202 },
          )
        : Response.json({
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresIn: 3600,
            userId: 42,
            displayName: "Streamer",
            relayToken: "relay-token-with-at-least-thirty-two-characters",
            subscriptionIds: ["subscription-1", "subscription-2"],
          });
    });
    const sleep = vi.fn(async (): Promise<void> => undefined);

    const result = await authenticateKick({
      fetch: fetcher,
      now: () => 0,
      openBrowser: () => true,
      sleep,
    });

    expect(result).toMatchObject({ value: { userId: "42", displayName: "Streamer" } });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(secrets.set).toHaveBeenCalledWith({
      service: "dev.livefeed.cli",
      name: "kick",
      value: JSON.stringify({
        refreshToken: "refresh-token",
        userId: "42",
        displayName: "Streamer",
        relayToken: "relay-token-with-at-least-thirty-two-characters",
        subscriptionIds: ["subscription-1", "subscription-2"],
      }),
    });
  });
});

describe("kickAccessToken", () => {
  it("persists a rotated refresh token", async () => {
    const credentials = {
      refreshToken: "old-refresh-token",
      userId: "42",
      displayName: "Streamer",
      relayToken: "relay-token-with-at-least-thirty-two-characters",
      subscriptionIds: ["subscription-1"],
    };
    const result = await kickAccessToken(credentials, {
      fetch: async () =>
        Response.json({
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          expiresIn: 3600,
        }),
    });

    expect(result).toMatchObject({ value: "new-access-token" });
    expect(secrets.set).toHaveBeenCalledWith({
      service: "dev.livefeed.cli",
      name: "kick",
      value: JSON.stringify({ ...credentials, refreshToken: "new-refresh-token" }),
    });
  });
});
