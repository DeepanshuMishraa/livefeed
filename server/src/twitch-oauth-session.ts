import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import type { Bindings } from "./bindings";
import { secureEqual, sha256Base64Url, twitchTokenSchema } from "./domain";

const SESSION_KEY = "session";
const base64UrlSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/));

const createRequestSchema = v.object({
  browserState: base64UrlSchema,
  clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
  expiresAt: v.number(),
});
const callbackRequestSchema = v.object({
  browserState: base64UrlSchema,
  code: v.optional(v.string()),
  error: v.optional(v.string()),
  redirectUri: v.string(),
});
const exchangeRequestSchema = v.object({
  codeVerifier: v.string(),
});
const storedSessionSchema = v.variant("status", [
  v.object({
    status: v.literal("pending"),
    browserState: base64UrlSchema,
    clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
    expiresAt: v.number(),
  }),
  v.object({
    status: v.literal("exchanging"),
    browserState: base64UrlSchema,
    clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
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

type StoredTwitchSession = v.InferOutput<typeof storedSessionSchema>;
type InternalErrorCode =
  | "invalid_request"
  | "not_found"
  | "pending"
  | "expired"
  | "state_mismatch"
  | "authorization_failed"
  | "verifier_mismatch"
  | "twitch_unavailable";

export class TwitchOAuthSession extends DurableObject<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/create") return this.create(request);
    if (request.method === "POST" && path === "/callback") return this.callback(request);
    if (request.method === "POST" && path === "/exchange") return this.exchange(request);
    return internalError("not_found", "OAuth session operation was not found.", 404);
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async create(request: Request): Promise<Response> {
    const body = await parseJson(request, createRequestSchema);
    if (!body) return internalError("invalid_request", "Session details were invalid.", 400);
    if (await this.readSession()) {
      return internalError("invalid_request", "Session already exists.", 409);
    }
    const session: StoredTwitchSession = { status: "pending", ...body };
    await this.ctx.storage.put(SESSION_KEY, session);
    await this.ctx.storage.setAlarm(body.expiresAt);
    return Response.json({ ok: true });
  }

  private async callback(request: Request): Promise<Response> {
    const body = await parseJson(request, callbackRequestSchema);
    if (!body) return internalError("invalid_request", "OAuth callback was invalid.", 400);
    const session = await this.activeSession();
    if (session instanceof Response) return session;
    if (session.status !== "pending") {
      return internalError("authorization_failed", "Authorization was already processed.", 409);
    }
    if (!secureEqual(session.browserState, body.browserState)) {
      return internalError("state_mismatch", "OAuth security state did not match.", 401);
    }
    if (body.error) {
      const reason =
        body.error === "access_denied"
          ? "Twitch authorization was cancelled."
          : "Twitch authorization did not finish.";
      await this.ctx.storage.put(SESSION_KEY, {
        status: "failed",
        clientCodeChallenge: session.clientCodeChallenge,
        reason,
        expiresAt: session.expiresAt,
      } satisfies StoredTwitchSession);
      return internalError("authorization_failed", reason, 400);
    }
    if (!body.code) {
      return internalError("invalid_request", "Twitch did not return an authorization code.", 400);
    }

    await this.ctx.storage.put(SESSION_KEY, { ...session, status: "exchanging" });
    const tokenResult = await this.exchangeTwitchCode(body.code, body.redirectUri);
    if (!tokenResult.ok) {
      await this.ctx.storage.put(SESSION_KEY, {
        ...session,
        status: "pending",
      } satisfies StoredTwitchSession);
      return tokenResult.response;
    }
    await this.ctx.storage.put(SESSION_KEY, {
      status: "ready",
      clientCodeChallenge: session.clientCodeChallenge,
      accessToken: tokenResult.tokens.access_token,
      refreshToken: tokenResult.tokens.refresh_token,
      expiresIn: tokenResult.tokens.expires_in,
      expiresAt: session.expiresAt,
    } satisfies StoredTwitchSession);
    return Response.json({ ok: true });
  }

  private async exchange(request: Request): Promise<Response> {
    const body = await parseJson(request, exchangeRequestSchema);
    if (!body) return internalError("invalid_request", "Code verifier was invalid.", 400);
    const session = await this.activeSession();
    if (session instanceof Response) return session;
    if (session.status === "pending" || session.status === "exchanging") {
      return internalError("pending", "Authorization is still pending.", 202);
    }
    if (session.status === "failed") {
      return internalError("authorization_failed", session.reason, 400);
    }
    const challenge = await sha256Base64Url(body.codeVerifier);
    if (!secureEqual(challenge, session.clientCodeChallenge)) {
      return internalError("verifier_mismatch", "PKCE code verifier did not match.", 401);
    }
    const tokens = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
    };
    await this.ctx.storage.deleteAll();
    return Response.json(tokens);
  }

  private async exchangeTwitchCode(
    code: string,
    redirectUri: string,
  ): Promise<
    | { readonly ok: true; readonly tokens: v.InferOutput<typeof twitchTokenSchema> }
    | { readonly ok: false; readonly response: Response }
  > {
    let response: Response;
    try {
      response = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.env.TWITCH_CLIENT_ID,
          client_secret: this.env.TWITCH_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });
    } catch {
      return {
        ok: false,
        response: internalError(
          "twitch_unavailable",
          "Twitch could not be reached. No login was stored; retry shortly.",
          502,
        ),
      };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ok: false,
        response: internalError(
          "twitch_unavailable",
          "Twitch rejected the token exchange. Check the Worker OAuth configuration.",
          502,
        ),
      };
    }
    const payload: unknown = await response.json();
    const parsed = v.safeParse(twitchTokenSchema, payload);
    return parsed.success
      ? { ok: true, tokens: parsed.output }
      : {
          ok: false,
          response: internalError(
            "twitch_unavailable",
            "Twitch returned an unexpected token response.",
            502,
          ),
        };
  }

  private async activeSession(): Promise<StoredTwitchSession | Response> {
    const session = await this.readSession();
    if (!session) return internalError("not_found", "OAuth session was not found.", 404);
    if (session.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return internalError("expired", "OAuth session expired. Start sign-in again.", 410);
    }
    return session;
  }

  private async readSession(): Promise<StoredTwitchSession | null> {
    const stored: unknown = await this.ctx.storage.get(SESSION_KEY);
    const parsed = v.safeParse(storedSessionSchema, stored);
    return parsed.success ? parsed.output : null;
  }
}

async function parseJson<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  request: Request,
  schema: TSchema,
): Promise<v.InferOutput<TSchema> | null> {
  try {
    const body: unknown = await request.json();
    const parsed = v.safeParse(schema, body);
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function internalError(code: InternalErrorCode, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}
