import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src";

const validChallenge = "a".repeat(43);

describe("livefeed auth worker", () => {
  it("reports its health", async () => {
    const response = await app.request("https://auth.livefeed.test/", undefined, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "livefeed-auth",
      status: "ok",
    });
  });

  it("rejects an invalid PKCE challenge", async () => {
    const response = await app.request(
      "https://auth.livefeed.test/v1/oauth/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codeChallenge: "short" }),
      },
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "The request body is invalid.",
      },
    });
  });

  it("creates a short-lived Google authorization session", async () => {
    const response = await createSession();
    const payload: unknown = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({
      expiresInSeconds: 300,
      pollIntervalSeconds: 2,
    });
    if (!isSessionResponse(payload)) throw new Error("Expected an OAuth session response.");
    const authorizationUrl = new URL(payload.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://auth.livefeed.test/v1/oauth/callback",
    );
    expect(authorizationUrl.searchParams.get("state")).toContain(payload.sessionId);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("creates a short-lived Twitch authorization session", async () => {
    const response = await app.request(
      "https://auth.livefeed.test/v1/oauth/twitch/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codeChallenge: validChallenge }),
      },
      env,
    );
    const payload: unknown = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({
      clientId: "test-twitch-client",
      expiresInSeconds: 300,
      pollIntervalSeconds: 2,
    });
    if (!isSessionResponse(payload)) throw new Error("Expected an OAuth session response.");
    const authorizationUrl = new URL(payload.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://id.twitch.tv");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://auth.livefeed.test/v1/oauth/twitch/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("user:read:chat");
    expect(authorizationUrl.searchParams.get("state")).toContain(payload.sessionId);
  });

  it("keeps token exchange pending until the browser callback finishes", async () => {
    const session = await sessionPayload();
    const response = await app.request(
      "https://auth.livefeed.test/v1/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          codeVerifier: "v".repeat(43),
        }),
      },
      env,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "pending",
        message: "Authorization is still pending.",
      },
    });
  });

  it("returns a clean callback error page for an invalid link", async () => {
    const callback = await app.request(
      "https://auth.livefeed.test/v1/oauth/callback?state=invalid",
      undefined,
      env,
    );
    await callback.body?.cancel();
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/v1/oauth/complete?status=error");

    const response = await app.request(
      "https://auth.livefeed.test/v1/oauth/complete?status=error",
      undefined,
      env,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Authorization did not finish");
    expect(html).not.toContain("gradient");
  });

  it("preserves a cancelled authorization for the polling CLI", async () => {
    const session = await sessionPayload();
    const authorizationUrl = new URL(session.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    if (!state) throw new Error("Expected OAuth state.");

    const callback = await app.request(
      `https://auth.livefeed.test/v1/oauth/callback?state=${encodeURIComponent(state)}&error=access_denied`,
      undefined,
      env,
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/v1/oauth/complete?status=error");
    await callback.body?.cancel();

    const exchange = await app.request(
      "https://auth.livefeed.test/v1/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          codeVerifier: "v".repeat(43),
        }),
      },
      env,
    );
    expect(exchange.status).toBe(400);
    await expect(exchange.json()).resolves.toEqual({
      error: {
        code: "authorization_failed",
        message: "Google authorization was cancelled.",
      },
    });
  });
});

async function createSession(): Promise<Response> {
  return app.request(
    "https://auth.livefeed.test/v1/oauth/sessions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codeChallenge: validChallenge }),
    },
    env,
  );
}

async function sessionPayload(): Promise<{
  readonly sessionId: string;
  readonly authorizationUrl: string;
}> {
  const response = await createSession();
  const payload: unknown = await response.json();
  if (!isSessionResponse(payload)) throw new Error("Expected an OAuth session response.");
  return payload;
}

function isSessionResponse(
  value: unknown,
): value is { readonly sessionId: string; readonly authorizationUrl: string } {
  if (typeof value !== "object" || value === null) return false;
  return (
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    "authorizationUrl" in value &&
    typeof value.authorizationUrl === "string"
  );
}
