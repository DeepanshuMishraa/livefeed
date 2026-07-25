import { secrets } from "bun";
import { Result, type Result as ResultType } from "better-result";
import * as v from "valibot";
import type { LivefeedError } from "./errors";

const SERVICE = "dev.livefeed.cli";
const NAME = "default";
const DEFAULT_AUTH_SERVER = "https://livefeed-auth.dipxsy.app";

const credentialSchema = v.object({
  refreshToken: v.string(),
  channelTitle: v.string(),
});
const sessionSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(24), v.maxLength(64)),
  authorizationUrl: v.string(),
  expiresInSeconds: v.pipe(v.number(), v.minValue(1), v.maxValue(600)),
  pollIntervalSeconds: v.pipe(v.number(), v.minValue(1), v.maxValue(10)),
});
const tokenSchema = v.object({
  accessToken: v.string(),
  refreshToken: v.string(),
  expiresIn: v.number(),
});
const refreshedTokenSchema = v.object({
  accessToken: v.string(),
  expiresIn: v.number(),
});
const brokerErrorSchema = v.object({
  error: v.object({
    code: v.string(),
    message: v.string(),
  }),
});
const channelSchema = v.object({
  items: v.array(v.object({ snippet: v.object({ title: v.string() }) })),
});

export type Credentials = v.InferOutput<typeof credentialSchema>;

interface AuthRuntime {
  readonly authServer: string;
  readonly fetch: Fetcher;
  readonly now: () => number;
  readonly openBrowser: (url: string) => boolean;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export type AuthOverrides = Partial<AuthRuntime>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
  overrides?: AuthOverrides,
): Promise<ResultType<string, LivefeedError>> {
  const runtime = authRuntime(overrides);
  const response = await brokerFetch(
    runtime,
    "/v1/oauth/refresh",
    JSON.stringify({ refreshToken: credentials.refreshToken }),
  );
  if (Result.isError(response)) return Result.err(response.error);
  if (response.value.status === 400 || response.value.status === 401) {
    await response.value.body?.cancel();
    return Result.err({ _tag: "TokenRejected" });
  }
  if (!response.value.ok) return Result.err(await brokerResponseError(response.value));
  const body: unknown = await response.value.json();
  const parsed = v.safeParse(refreshedTokenSchema, body);
  return parsed.success
    ? Result.ok(parsed.output.accessToken)
    : Result.err({ _tag: "InvalidAuthServerResponse", operation: "token refresh" });
}

export async function authenticate(
  overrides?: AuthOverrides,
): Promise<ResultType<Credentials, LivefeedError>> {
  const runtime = authRuntime(overrides);
  const verifier = randomBase64Url(64);
  const challenge = await sha256Base64Url(verifier);
  const sessionResponse = await brokerFetch(
    runtime,
    "/v1/oauth/sessions",
    JSON.stringify({ codeChallenge: challenge }),
  );
  if (Result.isError(sessionResponse)) return Result.err(sessionResponse.error);
  if (!sessionResponse.value.ok) {
    return Result.err(await brokerResponseError(sessionResponse.value));
  }
  const sessionBody: unknown = await sessionResponse.value.json();
  const sessionParsed = v.safeParse(sessionSchema, sessionBody);
  if (!sessionParsed.success || !isGoogleAuthorizationUrl(sessionParsed.output.authorizationUrl)) {
    return Result.err({
      _tag: "InvalidAuthServerResponse",
      operation: "session creation",
    });
  }
  const session = sessionParsed.output;

  if (!runtime.openBrowser(session.authorizationUrl)) {
    console.log(`Open this URL to sign in:\n${session.authorizationUrl}`);
  }
  const tokens = await pollForTokens(runtime, session, verifier);
  if (Result.isError(tokens)) return Result.err(tokens.error);

  const channelResponse = await safeFetch(
    runtime.fetch,
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    { headers: { authorization: `Bearer ${tokens.value.accessToken}` } },
  );
  if (Result.isError(channelResponse)) return Result.err(channelResponse.error);
  if (!channelResponse.value.ok) return Result.err(responseError(channelResponse.value));
  const channelBody: unknown = await channelResponse.value.json();
  const channelParsed = v.safeParse(channelSchema, channelBody);
  const channelTitle = channelParsed.success ? channelParsed.output.items[0]?.snippet.title : null;
  if (!channelTitle) return Result.err({ _tag: "NoChannel" });

  const credentials = { refreshToken: tokens.value.refreshToken, channelTitle };
  try {
    await secrets.set({ service: SERVICE, name: NAME, value: JSON.stringify(credentials) });
    return Result.ok(credentials);
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
}

export async function logout(
  overrides?: Pick<AuthOverrides, "fetch">,
): Promise<ResultType<boolean, LivefeedError>> {
  const credentials = await loadCredentials();
  if (Result.isError(credentials)) {
    return credentials.error._tag === "Unauthenticated"
      ? Result.ok(false)
      : Result.err(credentials.error);
  }
  const runtime = authRuntime(overrides);
  const revoked = await safeFetch(
    runtime.fetch,
    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(credentials.value.refreshToken)}`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } },
  );
  if (Result.isError(revoked)) return Result.err(revoked.error);
  if (!revoked.value.ok) return Result.err(responseError(revoked.value));
  try {
    return Result.ok(await secrets.delete({ service: SERVICE, name: NAME }));
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
}

async function pollForTokens(
  runtime: AuthRuntime,
  session: v.InferOutput<typeof sessionSchema>,
  verifier: string,
): Promise<ResultType<v.InferOutput<typeof tokenSchema>, LivefeedError>> {
  const deadline = runtime.now() + session.expiresInSeconds * 1000;
  while (runtime.now() < deadline) {
    const response = await brokerFetch(
      runtime,
      "/v1/oauth/token",
      JSON.stringify({
        sessionId: session.sessionId,
        codeVerifier: verifier,
      }),
    );
    if (Result.isError(response)) return Result.err(response.error);
    if (response.value.status === 202) {
      await response.value.body?.cancel();
      await runtime.sleep(session.pollIntervalSeconds * 1000);
      continue;
    }
    if (!response.value.ok) {
      const error = await brokerResponseError(response.value);
      return Result.err(
        error._tag === "AuthServerFailure"
          ? { _tag: "OAuthCallbackFailed", reason: error.reason }
          : error,
      );
    }
    const body: unknown = await response.value.json();
    const parsed = v.safeParse(tokenSchema, body);
    return parsed.success
      ? Result.ok(parsed.output)
      : Result.err({ _tag: "InvalidAuthServerResponse", operation: "token exchange" });
  }
  return Result.err({ _tag: "OAuthCallbackFailed", reason: "sign-in timed out" });
}

function authRuntime(overrides?: AuthOverrides): AuthRuntime {
  return {
    authServer: overrides?.authServer ?? DEFAULT_AUTH_SERVER,
    fetch: overrides?.fetch ?? globalThis.fetch,
    now: overrides?.now ?? Date.now,
    openBrowser: overrides?.openBrowser ?? openBrowser,
    sleep: overrides?.sleep ?? ((milliseconds) => Bun.sleep(milliseconds)),
  };
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

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function isGoogleAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "accounts.google.com";
  } catch {
    return false;
  }
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

async function brokerResponseError(response: Response): Promise<LivefeedError> {
  try {
    const body: unknown = await response.json();
    const parsed = v.safeParse(brokerErrorSchema, body);
    return {
      _tag: "AuthServerFailure",
      status: response.status,
      reason: parsed.success ? parsed.output.error.message : response.statusText,
    };
  } catch {
    return {
      _tag: "AuthServerFailure",
      status: response.status,
      reason: response.statusText || "unexpected response",
    };
  }
}

async function brokerFetch(
  runtime: AuthRuntime,
  path: string,
  body: string,
): Promise<ResultType<Response, LivefeedError>> {
  let url: URL;
  try {
    url = new URL(path, runtime.authServer);
  } catch {
    return Result.err({
      _tag: "AuthServerFailure",
      status: 0,
      reason: "the authentication server URL is invalid",
    });
  }
  try {
    return Result.ok(
      await runtime.fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body,
      }),
    );
  } catch (cause) {
    return Result.err({
      _tag: "AuthServerUnavailable",
      reason: cause instanceof Error ? cause.message : "network request failed",
    });
  }
}

async function safeFetch(
  fetcher: Fetcher,
  input: string,
  init?: RequestInit,
): Promise<ResultType<Response, LivefeedError>> {
  try {
    return Result.ok(await fetcher(input, init));
  } catch (cause) {
    return Result.err({
      _tag: "NetworkUnavailable",
      reason: cause instanceof Error ? cause.message : "network request failed",
    });
  }
}
