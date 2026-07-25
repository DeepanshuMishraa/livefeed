import { secrets } from "bun";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessToken, authenticate } from "../src/auth";

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

describe("accessToken", () => {
  it("refreshes the saved login through the auth broker", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requestUrl = inputUrl(input).toString();
        requestBody = parseJsonBody(init);
        return Response.json({ accessToken: "access-token", expiresIn: 3600 });
      },
    );

    const result = await accessToken(
      {
        refreshToken: "refresh-token",
        channelTitle: "Channel",
      },
      { fetch: fetcher },
    );

    expect(result).toMatchObject({ value: "access-token" });
    expect(requestUrl).toBe("https://livefeed-auth.dipxsy.app/v1/oauth/refresh");
    expect(requestBody).toEqual({ refreshToken: "refresh-token" });
  });

  it("asks the user to sign in again when Google rejects the refresh token", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => Response.json({}, { status: 401 }));

    const result = await accessToken(
      {
        refreshToken: "expired-refresh-token",
        channelTitle: "Channel",
      },
      { fetch: fetcher },
    );

    expect(result).toMatchObject({ error: { _tag: "TokenRejected" } });
  });
});

describe("authenticate", () => {
  it("uses PKCE, opens Google, polls the broker, and stores the refresh token", async () => {
    let clientChallenge = "";
    let codeVerifier = "";
    let tokenPolls = 0;
    let openedUrl = "";
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = inputUrl(input);
        if (url.pathname === "/v1/oauth/sessions") {
          const body = parseJsonBody(init);
          const challenge = stringProperty(body, "codeChallenge");
          if (!challenge) {
            return Response.json({}, { status: 400 });
          }
          clientChallenge = challenge;
          return Response.json(
            {
              sessionId: "session-id-with-enough-characters",
              authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
              expiresInSeconds: 300,
              pollIntervalSeconds: 2,
            },
            { status: 201 },
          );
        }
        if (url.pathname === "/v1/oauth/token") {
          tokenPolls += 1;
          const body = parseJsonBody(init);
          const verifier = stringProperty(body, "codeVerifier");
          if (!verifier) {
            return Response.json({}, { status: 400 });
          }
          codeVerifier = verifier;
          return tokenPolls === 1
            ? Response.json(
                { error: { code: "pending", message: "Authorization is still pending." } },
                { status: 202 },
              )
            : Response.json({
                accessToken: "access-token",
                refreshToken: "refresh-token",
                expiresIn: 3600,
              });
        }
        if (url.hostname === "www.googleapis.com") {
          return Response.json({
            items: [{ snippet: { title: "Live channel" } }],
          });
        }
        return Response.json({}, { status: 404 });
      },
    );
    const sleep = vi.fn(async (): Promise<void> => undefined);

    const result = await authenticate({
      fetch: fetcher,
      now: () => 0,
      openBrowser: (url) => {
        openedUrl = url;
        return true;
      },
      sleep,
    });

    expect(result).toMatchObject({
      value: { refreshToken: "refresh-token", channelTitle: "Live channel" },
    });
    expect(openedUrl).toContain("https://accounts.google.com/");
    expect(tokenPolls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(await sha256Base64Url(codeVerifier)).toBe(clientChallenge);
    expect(secrets.set).toHaveBeenCalledWith({
      service: "dev.livefeed.cli",
      name: "default",
      value: JSON.stringify({
        refreshToken: "refresh-token",
        channelTitle: "Live channel",
      }),
    });
  });

  it("does not open a non-Google authorization URL returned by the broker", async () => {
    const openBrowser = vi.fn(() => true);
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json(
          {
            sessionId: "session-id-with-enough-characters",
            authorizationUrl: "https://example.com/sign-in",
            expiresInSeconds: 300,
            pollIntervalSeconds: 2,
          },
          { status: 201 },
        ),
    );

    const result = await authenticate({ fetch: fetcher, openBrowser });

    expect(result).toMatchObject({
      error: { _tag: "InvalidAuthServerResponse", operation: "session creation" },
    });
    expect(openBrowser).not.toHaveBeenCalled();
  });
});

function inputUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function parseJsonBody(init?: RequestInit): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

function stringProperty(value: unknown, property: string): string | null {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, property)) return null;
  const propertyValue: unknown = Reflect.get(value, property);
  return typeof propertyValue === "string" ? propertyValue : null;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}
