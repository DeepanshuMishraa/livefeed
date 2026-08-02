import { secrets } from "bun";
import { Result, type Result as ResultType } from "better-result";
import * as v from "valibot";
import type { LivefeedError } from "./errors";

const SERVICE = "dev.livefeed.cli";
const NAME = "kick";
const DEFAULT_AUTH_SERVER = "https://livefeed-auth.dipxsy.app";

const credentialSchema = v.object({
  refreshToken: v.string(),
  userId: v.string(),
  displayName: v.string(),
  relayToken: v.string(),
  subscriptionIds: v.array(v.string()),
});
const sessionSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(24), v.maxLength(64)),
  authorizationUrl: v.string(),
  expiresInSeconds: v.pipe(v.number(), v.minValue(1), v.maxValue(600)),
  pollIntervalSeconds: v.pipe(v.number(), v.minValue(1), v.maxValue(10)),
});
const authorizationSchema = v.object({
  accessToken: v.string(),
  refreshToken: v.string(),
  expiresIn: v.number(),
  userId: v.number(),
  displayName: v.string(),
  relayToken: v.string(),
  subscriptionIds: v.array(v.string()),
});
const tokenSchema = v.object({
  accessToken: v.string(),
  refreshToken: v.string(),
  expiresIn: v.number(),
});
const brokerErrorSchema = v.object({
  error: v.object({ code: v.string(), message: v.string() }),
});

export type KickCredentials = v.InferOutput<typeof credentialSchema>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type KickAuthRuntime = {
  readonly authServer: string;
  readonly fetch: Fetcher;
  readonly now: () => number;
  readonly openBrowser: (url: string) => boolean;
  readonly sleep: (milliseconds: number) => Promise<void>;
};
export type KickAuthOverrides = Partial<KickAuthRuntime>;

export async function loadKickCredentials(): Promise<ResultType<KickCredentials, LivefeedError>> {
  try {
    const stored = await secrets.get({ service: SERVICE, name: NAME });
    if (!stored) return Result.err({ _tag: "KickUnauthenticated" });
    const decoded: unknown = JSON.parse(stored);
    const parsed = v.safeParse(credentialSchema, decoded);
    return parsed.success
      ? Result.ok(parsed.output)
      : Result.err({ _tag: "CredentialStoreUnavailable", reason: "saved Kick login is invalid" });
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
}

export async function authenticateKick(
  overrides?: KickAuthOverrides,
): Promise<ResultType<KickCredentials, LivefeedError>> {
  const runtime = authRuntime(overrides);
  const verifier = randomBase64Url(64);
  const challenge = await sha256Base64Url(verifier);
  const sessionResponse = await brokerFetch(
    runtime,
    "/v1/oauth/kick/sessions",
    JSON.stringify({ codeChallenge: challenge }),
  );
  if (Result.isError(sessionResponse)) return Result.err(sessionResponse.error);
  if (!sessionResponse.value.ok)
    return Result.err(await brokerResponseError(sessionResponse.value));
  const sessionBody: unknown = await sessionResponse.value.json();
  const parsed = v.safeParse(sessionSchema, sessionBody);
  if (!parsed.success || !isKickAuthorizationUrl(parsed.output.authorizationUrl)) {
    return Result.err({ _tag: "InvalidAuthServerResponse", operation: "Kick session creation" });
  }
  if (!runtime.openBrowser(parsed.output.authorizationUrl)) {
    console.log(`Open this URL to sign in:\n${parsed.output.authorizationUrl}`);
  }
  const authorization = await pollForAuthorization(runtime, parsed.output, verifier);
  if (Result.isError(authorization)) return Result.err(authorization.error);
  return saveCredentials({
    refreshToken: authorization.value.refreshToken,
    userId: String(authorization.value.userId),
    displayName: authorization.value.displayName,
    relayToken: authorization.value.relayToken,
    subscriptionIds: authorization.value.subscriptionIds,
  });
}

export async function kickAccessToken(
  credentials: KickCredentials,
  overrides?: KickAuthOverrides,
): Promise<ResultType<string, LivefeedError>> {
  const runtime = authRuntime(overrides);
  const response = await brokerFetch(
    runtime,
    "/v1/oauth/kick/refresh",
    JSON.stringify({ refreshToken: credentials.refreshToken }),
  );
  if (Result.isError(response)) return Result.err(response.error);
  if (response.value.status === 400 || response.value.status === 401) {
    await response.value.body?.cancel();
    return Result.err({ _tag: "KickTokenRejected" });
  }
  if (!response.value.ok) return Result.err(await brokerResponseError(response.value));
  const body: unknown = await response.value.json();
  const parsed = v.safeParse(tokenSchema, body);
  if (!parsed.success) {
    return Result.err({ _tag: "InvalidAuthServerResponse", operation: "Kick token refresh" });
  }
  const saved = await saveCredentials({ ...credentials, refreshToken: parsed.output.refreshToken });
  return Result.isError(saved) ? Result.err(saved.error) : Result.ok(parsed.output.accessToken);
}

export async function logoutKick(
  overrides?: Pick<KickAuthOverrides, "authServer" | "fetch">,
): Promise<ResultType<boolean, LivefeedError>> {
  const credentials = await loadKickCredentials();
  if (Result.isError(credentials)) {
    return credentials.error._tag === "KickUnauthenticated"
      ? Result.ok(false)
      : Result.err(credentials.error);
  }
  const runtime = authRuntime(overrides);
  const accessToken = await kickAccessToken(credentials.value, runtime);
  if (Result.isError(accessToken)) return Result.err(accessToken.error);

  if (credentials.value.subscriptionIds.length > 0) {
    const subscriptionsUrl = new URL("https://api.kick.com/public/v1/events/subscriptions");
    for (const id of credentials.value.subscriptionIds)
      subscriptionsUrl.searchParams.append("id", id);
    const removed = await safeFetch(runtime.fetch, subscriptionsUrl, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken.value}` },
    });
    if (Result.isError(removed)) return Result.err(removed.error);
    if (!removed.value.ok) return Result.err(await kickResponseError(removed.value));
    await removed.value.body?.cancel();
  }

  const clearUrl = new URL(`/v1/kick/relay/${credentials.value.userId}/clear`, runtime.authServer);
  const cleared = await safeFetch(runtime.fetch, clearUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${credentials.value.relayToken}` },
  });
  if (Result.isError(cleared)) return Result.err(cleared.error);
  if (!cleared.value.ok) return Result.err(await brokerResponseError(cleared.value));
  await cleared.value.body?.cancel();

  const revokeUrl = new URL("https://id.kick.com/oauth/revoke");
  revokeUrl.searchParams.set("token", accessToken.value);
  revokeUrl.searchParams.set("token_type_hint", "access_token");
  const revoked = await safeFetch(runtime.fetch, revokeUrl, { method: "POST" });
  if (Result.isError(revoked)) return Result.err(revoked.error);
  if (!revoked.value.ok && revoked.value.status !== 400) {
    return Result.err(await kickResponseError(revoked.value));
  }
  await revoked.value.body?.cancel();
  try {
    return Result.ok(await secrets.delete({ service: SERVICE, name: NAME }));
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
}

async function pollForAuthorization(
  runtime: KickAuthRuntime,
  session: v.InferOutput<typeof sessionSchema>,
  verifier: string,
): Promise<ResultType<v.InferOutput<typeof authorizationSchema>, LivefeedError>> {
  const deadline = runtime.now() + session.expiresInSeconds * 1000;
  while (runtime.now() < deadline) {
    const response = await brokerFetch(
      runtime,
      "/v1/oauth/kick/token",
      JSON.stringify({ sessionId: session.sessionId, codeVerifier: verifier }),
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
          ? { _tag: "KickOAuthCallbackFailed", reason: error.reason }
          : error,
      );
    }
    const body: unknown = await response.value.json();
    const parsed = v.safeParse(authorizationSchema, body);
    return parsed.success
      ? Result.ok(parsed.output)
      : Result.err({ _tag: "InvalidAuthServerResponse", operation: "Kick token exchange" });
  }
  return Result.err({ _tag: "KickOAuthCallbackFailed", reason: "sign-in timed out" });
}

function authRuntime(overrides?: KickAuthOverrides): KickAuthRuntime {
  return {
    authServer: overrides?.authServer ?? DEFAULT_AUTH_SERVER,
    fetch: overrides?.fetch ?? globalThis.fetch,
    now: overrides?.now ?? Date.now,
    openBrowser: overrides?.openBrowser ?? openBrowser,
    sleep: overrides?.sleep ?? ((milliseconds) => Bun.sleep(milliseconds)),
  };
}

async function saveCredentials(
  credentials: KickCredentials,
): Promise<ResultType<KickCredentials, LivefeedError>> {
  try {
    await secrets.set({ service: SERVICE, name: NAME, value: JSON.stringify(credentials) });
    return Result.ok(credentials);
  } catch (cause) {
    return Result.err(credentialStoreError(cause));
  }
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

function isKickAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "id.kick.com";
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
  runtime: KickAuthRuntime,
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
    headers: { accept: "application/json", "content-type": "application/json" },
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

async function kickResponseError(response: Response): Promise<LivefeedError> {
  let reason = response.statusText || "unexpected response";
  try {
    const body: unknown = await response.json();
    const parsed = v.safeParse(v.object({ message: v.string() }), body);
    if (parsed.success) reason = parsed.output.message;
  } catch {
    // Keep the HTTP status text when Kick did not return JSON.
  }
  return { _tag: "KickServiceFailure", status: response.status, reason };
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
