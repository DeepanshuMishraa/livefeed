import { secrets } from "bun";
import { Result, type Result as ResultType } from "better-result";
import * as v from "valibot";
import type { LivefeedError } from "./errors";

const SERVICE = "dev.livefeed.cli";
const NAME = "twitch";
const DEFAULT_AUTH_SERVER = "https://livefeed-auth.d4deepanshu723.workers.dev";

const credentialSchema = v.object({
  refreshToken: v.string(),
  clientId: v.string(),
  userId: v.string(),
  login: v.string(),
  displayName: v.string(),
});
const sessionSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(24), v.maxLength(64)),
  authorizationUrl: v.string(),
  clientId: v.string(),
  expiresInSeconds: v.pipe(v.number(), v.minValue(1), v.maxValue(600)),
  pollIntervalSeconds: v.pipe(v.number(), v.minValue(1), v.maxValue(10)),
});
const tokenSchema = v.object({
  accessToken: v.string(),
  refreshToken: v.string(),
  expiresIn: v.number(),
});
const usersSchema = v.object({
  data: v.array(
    v.object({
      id: v.string(),
      login: v.string(),
      display_name: v.string(),
    }),
  ),
});
const brokerErrorSchema = v.object({
  error: v.object({
    code: v.string(),
    message: v.string(),
  }),
});

export type TwitchCredentials = v.InferOutput<typeof credentialSchema>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type TwitchAuthRuntime = {
  readonly authServer: string;
  readonly fetch: Fetcher;
  readonly now: () => number;
  readonly openBrowser: (url: string) => boolean;
  readonly sleep: (milliseconds: number) => Promise<void>;
};

export type TwitchAuthOverrides = Partial<TwitchAuthRuntime>;

export async function loadTwitchCredentials(): Promise<
  ResultType<TwitchCredentials, LivefeedError>
> {
  try {
    const stored = await secrets.get({ service: SERVICE, name: NAME });
    if (!stored) return Result.err({ _tag: "TwitchUnauthenticated" });
    const decoded: unknown = JSON.parse(stored);
    const parsed = v.safeParse(credentialSchema, decoded);
    return parsed.success
      ? Result.ok(parsed.output)
      : Result.err({ _tag: "CredentialStoreUnavailable", reason: "saved Twitch login is invalid" });
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
}

export async function authenticateTwitch(
  overrides?: TwitchAuthOverrides,
): Promise<ResultType<TwitchCredentials, LivefeedError>> {
  const runtime = authRuntime(overrides);
  const verifier = randomBase64Url(64);
  const challenge = await sha256Base64Url(verifier);
  const sessionResponse = await brokerFetch(
    runtime,
    "/v1/oauth/twitch/sessions",
    JSON.stringify({ codeChallenge: challenge }),
  );
  if (Result.isError(sessionResponse)) return Result.err(sessionResponse.error);
  if (!sessionResponse.value.ok) {
    return Result.err(await brokerResponseError(sessionResponse.value));
  }
  const sessionBody: unknown = await sessionResponse.value.json();
  const sessionParsed = v.safeParse(sessionSchema, sessionBody);
  if (!sessionParsed.success || !isTwitchAuthorizationUrl(sessionParsed.output.authorizationUrl)) {
    return Result.err({ _tag: "InvalidAuthServerResponse", operation: "Twitch session creation" });
  }
  const session = sessionParsed.output;
  if (!runtime.openBrowser(session.authorizationUrl)) {
    console.log(`Open this URL to sign in:\n${session.authorizationUrl}`);
  }
  const tokens = await pollForTokens(runtime, session, verifier);
  if (Result.isError(tokens)) return Result.err(tokens.error);

  const userResponse = await safeFetch(runtime.fetch, "https://api.twitch.tv/helix/users", {
    headers: twitchHeaders(session.clientId, tokens.value.accessToken),
  });
  if (Result.isError(userResponse)) return Result.err(userResponse.error);
  if (userResponse.value.status === 401) {
    await userResponse.value.body?.cancel();
    return Result.err({ _tag: "TwitchTokenRejected" });
  }
  if (!userResponse.value.ok) return Result.err(await twitchResponseError(userResponse.value));
  const userBody: unknown = await userResponse.value.json();
  const parsedUsers = v.safeParse(usersSchema, userBody);
  const user = parsedUsers.success ? parsedUsers.output.data[0] : undefined;
  if (!user) return Result.err({ _tag: "InvalidTwitchResponse", operation: "user lookup" });

  return saveCredentials({
    refreshToken: tokens.value.refreshToken,
    clientId: session.clientId,
    userId: user.id,
    login: user.login,
    displayName: user.display_name,
  });
}

export async function twitchAccessToken(
  credentials: TwitchCredentials,
  overrides?: TwitchAuthOverrides,
): Promise<ResultType<string, LivefeedError>> {
  const runtime = authRuntime(overrides);
  const response = await brokerFetch(
    runtime,
    "/v1/oauth/twitch/refresh",
    JSON.stringify({ refreshToken: credentials.refreshToken }),
  );
  if (Result.isError(response)) return Result.err(response.error);
  if (response.value.status === 400 || response.value.status === 401) {
    await response.value.body?.cancel();
    return Result.err({ _tag: "TwitchTokenRejected" });
  }
  if (!response.value.ok) return Result.err(await brokerResponseError(response.value));
  const body: unknown = await response.value.json();
  const parsed = v.safeParse(tokenSchema, body);
  if (!parsed.success) {
    return Result.err({ _tag: "InvalidAuthServerResponse", operation: "Twitch token refresh" });
  }
  const saved = await saveCredentials({
    ...credentials,
    refreshToken: parsed.output.refreshToken,
  });
  return Result.isError(saved) ? Result.err(saved.error) : Result.ok(parsed.output.accessToken);
}

export async function logoutTwitch(
  overrides?: Pick<TwitchAuthOverrides, "fetch">,
): Promise<ResultType<boolean, LivefeedError>> {
  const credentials = await loadTwitchCredentials();
  if (Result.isError(credentials)) {
    return credentials.error._tag === "TwitchUnauthenticated"
      ? Result.ok(false)
      : Result.err(credentials.error);
  }
  const runtime = authRuntime(overrides);
  const revoked = await safeFetch(runtime.fetch, "https://id.twitch.tv/oauth2/revoke", {
    method: "POST",
    body: new URLSearchParams({
      client_id: credentials.value.clientId,
      token: credentials.value.refreshToken,
    }),
  });
  if (Result.isError(revoked)) return Result.err(revoked.error);
  if (!revoked.value.ok && revoked.value.status !== 400) {
    return Result.err(await twitchResponseError(revoked.value));
  }
  try {
    return Result.ok(await secrets.delete({ service: SERVICE, name: NAME }));
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
}

async function pollForTokens(
  runtime: TwitchAuthRuntime,
  session: v.InferOutput<typeof sessionSchema>,
  verifier: string,
): Promise<ResultType<v.InferOutput<typeof tokenSchema>, LivefeedError>> {
  const deadline = runtime.now() + session.expiresInSeconds * 1000;
  while (runtime.now() < deadline) {
    const response = await brokerFetch(
      runtime,
      "/v1/oauth/twitch/token",
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
          ? { _tag: "TwitchOAuthCallbackFailed", reason: error.reason }
          : error,
      );
    }
    const body: unknown = await response.value.json();
    const parsed = v.safeParse(tokenSchema, body);
    return parsed.success
      ? Result.ok(parsed.output)
      : Result.err({ _tag: "InvalidAuthServerResponse", operation: "Twitch token exchange" });
  }
  return Result.err({ _tag: "TwitchOAuthCallbackFailed", reason: "sign-in timed out" });
}

function authRuntime(overrides?: TwitchAuthOverrides): TwitchAuthRuntime {
  return {
    authServer: overrides?.authServer ?? DEFAULT_AUTH_SERVER,
    fetch: overrides?.fetch ?? globalThis.fetch,
    now: overrides?.now ?? Date.now,
    openBrowser: overrides?.openBrowser ?? openBrowser,
    sleep: overrides?.sleep ?? ((milliseconds) => Bun.sleep(milliseconds)),
  };
}

async function saveCredentials(
  credentials: TwitchCredentials,
): Promise<ResultType<TwitchCredentials, LivefeedError>> {
  try {
    await secrets.set({ service: SERVICE, name: NAME, value: JSON.stringify(credentials) });
    return Result.ok(credentials);
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
}

function twitchHeaders(clientId: string, accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "client-id": clientId,
  };
}

function openBrowser(url: string): boolean {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "linux"
        ? ["xdg-open", url]
        : null;
  if (!command || !Bun.which(command[0] ?? "")) return false;
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

function isTwitchAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "id.twitch.tv";
  } catch {
    return false;
  }
}

function randomBase64Url(size: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(size))).toString("base64url");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}

async function brokerFetch(
  runtime: TwitchAuthRuntime,
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
  return safeFetch(runtime.fetch, url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body,
  });
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

async function twitchResponseError(response: Response): Promise<LivefeedError> {
  let reason = response.statusText || "unexpected response";
  try {
    const body: unknown = await response.json();
    const parsed = v.safeParse(v.object({ message: v.string() }), body);
    if (parsed.success) reason = parsed.output.message;
  } catch {
    // Keep the HTTP status text when Twitch did not return JSON.
  }
  return { _tag: "TwitchServiceFailure", status: response.status, reason };
}

async function safeFetch(
  fetcher: Fetcher,
  input: string | URL,
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

function credentialStoreError(cause: unknown): LivefeedError {
  return {
    _tag: "CredentialStoreUnavailable",
    reason: cause instanceof Error ? cause.message : "unknown credential-store error",
  };
}
