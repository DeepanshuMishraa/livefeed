import { secrets } from "bun";
import { Result, type Result as ResultType } from "better-result";
import * as v from "valibot";
import type { LivefeedError } from "./errors";

const SERVICE = "dev.livefeed.cli";
const NAME = "default";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

const credentialSchema = v.object({
  refreshToken: v.string(),
  channelTitle: v.string(),
});
const tokenSchema = v.object({
  access_token: v.string(),
  expires_in: v.number(),
  refresh_token: v.optional(v.string()),
});
const channelSchema = v.object({
  items: v.array(v.object({ snippet: v.object({ title: v.string() }) })),
});

export type Credentials = v.InferOutput<typeof credentialSchema>;
type OAuthConfig = { readonly clientId: string };

function oauthConfig(): ResultType<OAuthConfig, LivefeedError> {
  const clientId = process.env["LIVEFEED_GOOGLE_CLIENT_ID"];
  return clientId ? Result.ok({ clientId }) : Result.err({ _tag: "OAuthNotConfigured" });
}

export async function loadCredentials(): Promise<ResultType<Credentials, LivefeedError>> {
  try {
    const stored = await secrets.get({ service: SERVICE, name: NAME });
    if (!stored) return Result.err({ _tag: "Unauthenticated" });
    const decoded: unknown = JSON.parse(stored);
    const parsed = v.safeParse(credentialSchema, decoded);
    return parsed.success
      ? Result.ok(parsed.output)
      : Result.err({ _tag: "CredentialStoreUnavailable", reason: "saved login is invalid" });
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
}

export async function accessToken(
  credentials: Credentials,
): Promise<ResultType<string, LivefeedError>> {
  const config = oauthConfig();
  if (Result.isError(config)) return config;
  const response = await safeFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.value.clientId,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (Result.isError(response)) return response;
  if (response.value.status === 400 || response.value.status === 401) {
    return Result.err({ _tag: "TokenRejected" });
  }
  if (!response.value.ok) return Result.err(responseError(response.value));
  const body: unknown = await response.value.json();
  const parsed = v.safeParse(tokenSchema, body);
  return parsed.success
    ? Result.ok(parsed.output.access_token)
    : Result.err({ _tag: "InvalidGoogleResponse", operation: "token refresh" });
}

export async function authenticate(): Promise<ResultType<Credentials, LivefeedError>> {
  const config = oauthConfig();
  if (Result.isError(config)) return config;

  const verifier = randomBase64Url(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  const state = randomBase64Url(32);
  const callback = waitForOAuthCallback(state);
  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.search = new URLSearchParams({
    client_id: config.value.clientId,
    redirect_uri: callback.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  if (!openBrowser(authorizeUrl.toString())) {
    console.log(`Open this URL to sign in:\n${authorizeUrl}`);
  }
  const code = await callback.code;
  if (Result.isError(code)) return code;

  const tokenResponse = await safeFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.value.clientId,
      code: code.value,
      code_verifier: verifier,
      redirect_uri: callback.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (Result.isError(tokenResponse)) return tokenResponse;
  if (!tokenResponse.value.ok) return Result.err(responseError(tokenResponse.value));
  const tokenBody: unknown = await tokenResponse.value.json();
  const tokenParsed = v.safeParse(tokenSchema, tokenBody);
  if (!tokenParsed.success || !tokenParsed.output.refresh_token) {
    return Result.err({ _tag: "InvalidGoogleResponse", operation: "OAuth token exchange" });
  }

  const channelResponse = await safeFetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    { headers: { authorization: `Bearer ${tokenParsed.output.access_token}` } },
  );
  if (Result.isError(channelResponse)) return channelResponse;
  if (!channelResponse.value.ok) return Result.err(responseError(channelResponse.value));
  const channelBody: unknown = await channelResponse.value.json();
  const channelParsed = v.safeParse(channelSchema, channelBody);
  const channelTitle = channelParsed.success ? channelParsed.output.items[0]?.snippet.title : null;
  if (!channelTitle) return Result.err({ _tag: "NoChannel" });

  const credentials = { refreshToken: tokenParsed.output.refresh_token, channelTitle };
  try {
    await secrets.set({ service: SERVICE, name: NAME, value: JSON.stringify(credentials) });
    return Result.ok(credentials);
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
}

export async function logout(): Promise<ResultType<boolean, LivefeedError>> {
  const credentials = await loadCredentials();
  if (Result.isError(credentials)) {
    return credentials.error._tag === "Unauthenticated" ? Result.ok(false) : credentials;
  }
  const revoked = await safeFetch(
    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(credentials.value.refreshToken)}`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } },
  );
  if (Result.isError(revoked)) return revoked;
  if (!revoked.value.ok) return Result.err(responseError(revoked.value));
  try {
    return Result.ok(await secrets.delete({ service: SERVICE, name: NAME }));
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
}

function waitForOAuthCallback(state: string): {
  readonly redirectUri: string;
  readonly code: Promise<ResultType<string, LivefeedError>>;
} {
  let settle: ((result: ResultType<string, LivefeedError>) => void) | undefined;
  let timeout: Timer | undefined;
  const code = new Promise<ResultType<string, LivefeedError>>((resolve) => {
    settle = resolve;
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const oauthError = url.searchParams.get("error");
      const result: ResultType<string, LivefeedError> =
        returnedState !== state
          ? Result.err({ _tag: "OAuthCallbackFailed", reason: "security state did not match" })
          : oauthError
            ? Result.err({ _tag: "OAuthCallbackFailed", reason: oauthError })
            : returnedCode
              ? Result.ok(returnedCode)
              : Result.err({
                  _tag: "OAuthCallbackFailed",
                  reason: "authorization code was missing",
                });
      settle?.(result);
      if (timeout) clearTimeout(timeout);
      server.stop(true);
      return new Response("livefeed is connected. You can close this tab.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
  });
  timeout = setTimeout(() => {
    settle?.(Result.err({ _tag: "OAuthCallbackFailed", reason: "sign-in timed out" }));
    server.stop(true);
  }, 120_000);
  return { redirectUri: `http://127.0.0.1:${server.port}`, code };
}

function openBrowser(url: string): boolean {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "linux"
        ? ["xdg-open", url]
        : null;
  if (!command) return false;
  if (!Bun.which(command[0] ?? "")) return false;
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

function randomBase64Url(size: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)));
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function credentialStoreError(cause: unknown): LivefeedError {
  return {
    _tag: "CredentialStoreUnavailable",
    reason: cause instanceof Error ? cause.message : "unknown credential-store error",
  };
}

function responseError(response: Response): LivefeedError {
  return {
    _tag: "GoogleServiceFailure",
    status: response.status,
    reason: response.statusText,
  };
}

async function safeFetch(
  input: string,
  init?: RequestInit,
): Promise<ResultType<Response, LivefeedError>> {
  try {
    return Result.ok(await fetch(input, init));
  } catch (cause) {
    return Result.err({
      _tag: "NetworkUnavailable",
      reason: cause instanceof Error ? cause.message : "network request failed",
    });
  }
}
