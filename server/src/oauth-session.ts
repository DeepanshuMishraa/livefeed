import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import type { Bindings } from "./bindings";
import {
  googleTokenSchema,
  secureEqual,
  sha256Base64Url,
  storedSessionSchema,
  type StoredSession,
} from "./domain";

const SESSION_KEY = "session";

const createRequestSchema = v.object({
  browserState: v.string(),
  clientCodeChallenge: v.string(),
  googleCodeVerifier: v.string(),
  expiresAt: v.number(),
});

const callbackRequestSchema = v.object({
  browserState: v.string(),
  code: v.optional(v.string()),
  error: v.optional(v.string()),
  redirectUri: v.string(),
});

const exchangeRequestSchema = v.object({
  codeVerifier: v.string(),
});

type InternalErrorCode =
  | "invalid_request"
  | "not_found"
  | "pending"
  | "expired"
  | "state_mismatch"
  | "authorization_failed"
  | "verifier_mismatch"
  | "google_unavailable";

export class OAuthSession extends DurableObject<Bindings> {
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
    const existing = await this.readSession();
    if (existing) return internalError("invalid_request", "Session already exists.", 409);
    const session: StoredSession = { status: "pending", ...body };
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
      await this.ctx.storage.put(SESSION_KEY, {
        status: "failed",
        clientCodeChallenge: session.clientCodeChallenge,
        reason:
          body.error === "access_denied"
            ? "Google authorization was cancelled."
            : "Google authorization did not finish.",
        expiresAt: session.expiresAt,
      } satisfies StoredSession);
      return internalError(
        "authorization_failed",
        body.error === "access_denied"
          ? "Google authorization was cancelled."
          : "Google authorization did not finish.",
        400,
      );
    }
    if (!body.code) {
      return internalError("invalid_request", "Google did not return an authorization code.", 400);
    }

    await this.ctx.storage.put(SESSION_KEY, { ...session, status: "exchanging" });
    const tokenResult = await this.exchangeGoogleCode(body.code, body.redirectUri, session);
    if (!tokenResult.ok) {
      await this.ctx.storage.put(SESSION_KEY, {
        ...session,
        status: "pending",
      } satisfies StoredSession);
      return tokenResult.response;
    }
    if (!tokenResult.tokens.refresh_token) {
      await this.ctx.storage.put(SESSION_KEY, {
        status: "failed",
        clientCodeChallenge: session.clientCodeChallenge,
        reason: "Google did not issue a refresh token. Remove Livefeed access and try again.",
        expiresAt: session.expiresAt,
      } satisfies StoredSession);
      return internalError(
        "authorization_failed",
        "Google did not issue a refresh token. Remove Livefeed access and try again.",
        400,
      );
    }
    await this.ctx.storage.put(SESSION_KEY, {
      status: "ready",
      clientCodeChallenge: session.clientCodeChallenge,
      accessToken: tokenResult.tokens.access_token,
      refreshToken: tokenResult.tokens.refresh_token,
      expiresIn: tokenResult.tokens.expires_in,
      expiresAt: session.expiresAt,
    } satisfies StoredSession);
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

  private async exchangeGoogleCode(
    code: string,
    redirectUri: string,
    session: Extract<StoredSession, { readonly status: "pending" }>,
  ): Promise<
    | { readonly ok: true; readonly tokens: v.InferOutput<typeof googleTokenSchema> }
    | { readonly ok: false; readonly response: Response }
  > {
    let response: Response;
    try {
      response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.env.GOOGLE_CLIENT_ID,
          client_secret: this.env.GOOGLE_CLIENT_SECRET,
          code,
          code_verifier: session.googleCodeVerifier,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
    } catch {
      return {
        ok: false,
        response: internalError(
          "google_unavailable",
          "Google could not be reached. No login was stored; retry shortly.",
          502,
        ),
      };
    }
    if (!response.ok) {
      await response.text();
      return {
        ok: false,
        response: internalError(
          "google_unavailable",
          "Google rejected the token exchange. Check the Worker OAuth configuration.",
          502,
        ),
      };
    }
    const payload: unknown = await response.json();
    const parsed = v.safeParse(googleTokenSchema, payload);
    return parsed.success
      ? { ok: true, tokens: parsed.output }
      : {
          ok: false,
          response: internalError(
            "google_unavailable",
            "Google returned an unexpected token response.",
            502,
          ),
        };
  }

  private async activeSession(): Promise<StoredSession | Response> {
    const session = await this.readSession();
    if (!session) return internalError("not_found", "OAuth session was not found.", 404);
    if (session.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return internalError("expired", "OAuth session expired. Start sign-in again.", 410);
    }
    return session;
  }

  private async readSession(): Promise<StoredSession | null> {
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
