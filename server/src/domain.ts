import * as v from "valibot";

export const SESSION_LIFETIME_MS = 5 * 60 * 1000;
export const POLL_INTERVAL_SECONDS = 2;
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const TWITCH_SCOPE = "user:read:chat";
export const KICK_SCOPE = "user:read channel:read events:subscribe";

const base64UrlSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/));

export const createSessionSchema = v.object({
  codeChallenge: v.pipe(base64UrlSchema, v.length(43)),
});

export const exchangeSessionSchema = v.object({
  sessionId: v.pipe(base64UrlSchema, v.minLength(24), v.maxLength(64)),
  codeVerifier: v.pipe(
    v.string(),
    v.minLength(43),
    v.maxLength(128),
    v.regex(/^[A-Za-z0-9._~-]+$/),
  ),
});

export const refreshTokenSchema = v.object({
  refreshToken: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
});

export const storedSessionSchema = v.variant("status", [
  v.object({
    status: v.literal("pending"),
    browserState: base64UrlSchema,
    clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
    googleCodeVerifier: v.string(),
    expiresAt: v.number(),
  }),
  v.object({
    status: v.literal("exchanging"),
    browserState: base64UrlSchema,
    clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
    googleCodeVerifier: v.string(),
    expiresAt: v.number(),
  }),
  v.object({
    status: v.literal("ready"),
    clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresIn: v.number(),
    expiresAt: v.number(),
  }),
  v.object({
    status: v.literal("failed"),
    clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
    reason: v.string(),
    expiresAt: v.number(),
  }),
]);

export type StoredSession = v.InferOutput<typeof storedSessionSchema>;

export const googleTokenSchema = v.object({
  access_token: v.string(),
  expires_in: v.number(),
  refresh_token: v.optional(v.string()),
});

export const twitchTokenSchema = v.object({
  access_token: v.string(),
  expires_in: v.number(),
  refresh_token: v.string(),
});

export const kickTokenSchema = v.object({
  access_token: v.string(),
  expires_in: v.number(),
  refresh_token: v.string(),
});

export function randomBase64Url(size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function parsePublicOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    const localDevelopment =
      url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (url.protocol !== "https:" && !localDevelopment) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export function parseOAuthState(
  value: string,
): { readonly sessionId: string; readonly browserState: string } | null {
  const separator = value.indexOf(".");
  if (separator < 1 || separator === value.length - 1) return null;
  const sessionId = value.slice(0, separator);
  const browserState = value.slice(separator + 1);
  const sessionParsed = v.safeParse(
    v.pipe(base64UrlSchema, v.minLength(24), v.maxLength(64)),
    sessionId,
  );
  const stateParsed = v.safeParse(base64UrlSchema, browserState);
  return sessionParsed.success && stateParsed.success
    ? { sessionId: sessionParsed.output, browserState: stateParsed.output }
    : null;
}

export function secureEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
