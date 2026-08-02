import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import type { Bindings } from "./bindings";
import { kickTokenSchema, randomBase64Url, secureEqual, sha256Base64Url } from "./domain";

const SESSION_KEY = "session";
const base64UrlSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/));
const createRequestSchema = v.object({
  browserState: base64UrlSchema,
  clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
  kickCodeVerifier: v.string(),
  expiresAt: v.number(),
});
const callbackRequestSchema = v.object({
  browserState: base64UrlSchema,
  code: v.optional(v.string()),
  error: v.optional(v.string()),
  redirectUri: v.string(),
});
const exchangeRequestSchema = v.object({ codeVerifier: v.string() });
const userResponseSchema = v.object({
  data: v.array(v.object({ user_id: v.number(), name: v.string() })),
});
const subscriptionListSchema = v.object({
  data: v.array(
    v.object({
      id: v.string(),
      event: v.string(),
      version: v.number(),
    }),
  ),
});
const subscriptionCreateSchema = v.object({
  data: v.array(
    v.object({
      name: v.string(),
      version: v.number(),
      subscription_id: v.optional(v.string()),
      error: v.optional(v.string()),
    }),
  ),
});
const storedSessionSchema = v.variant("status", [
  v.object({
    status: v.literal("pending"),
    browserState: base64UrlSchema,
    clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
    kickCodeVerifier: v.string(),
    expiresAt: v.number(),
  }),
  v.object({
    status: v.literal("exchanging"),
    browserState: base64UrlSchema,
    clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
    kickCodeVerifier: v.string(),
    expiresAt: v.number(),
  }),
  v.object({
    status: v.literal("ready"),
    clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresIn: v.number(),
    userId: v.number(),
    displayName: v.string(),
    relayToken: base64UrlSchema,
    subscriptionIds: v.array(v.string()),
    expiresAt: v.number(),
  }),
  v.object({
    status: v.literal("failed"),
    clientCodeChallenge: v.pipe(base64UrlSchema, v.length(43)),
    reason: v.string(),
    expiresAt: v.number(),
  }),
]);

type StoredKickSession = v.InferOutput<typeof storedSessionSchema>;
type InternalErrorCode =
  | "invalid_request"
  | "not_found"
  | "pending"
  | "expired"
  | "state_mismatch"
  | "authorization_failed"
  | "verifier_mismatch"
  | "kick_unavailable";

const REQUIRED_EVENTS = ["chat.message.sent", "livestream.status.updated"] as const;

export class KickOAuthSession extends DurableObject<Bindings> {
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
    await this.ctx.storage.put(SESSION_KEY, {
      status: "pending",
      ...body,
    } satisfies StoredKickSession);
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
          ? "Kick authorization was cancelled."
          : "Kick authorization did not finish.";
      await this.fail(session, reason);
      return internalError("authorization_failed", reason, 400);
    }
    if (!body.code) {
      return internalError("invalid_request", "Kick did not return an authorization code.", 400);
    }

    await this.ctx.storage.put(SESSION_KEY, { ...session, status: "exchanging" });
    const setup = await this.completeSetup(body.code, body.redirectUri, session.kickCodeVerifier);
    if (!setup.ok) {
      await this.ctx.storage.put(SESSION_KEY, { ...session, status: "pending" });
      return setup.response;
    }
    await this.ctx.storage.put(SESSION_KEY, {
      status: "ready",
      clientCodeChallenge: session.clientCodeChallenge,
      accessToken: setup.value.accessToken,
      refreshToken: setup.value.refreshToken,
      expiresIn: setup.value.expiresIn,
      userId: setup.value.userId,
      displayName: setup.value.displayName,
      relayToken: setup.value.relayToken,
      subscriptionIds: [...setup.value.subscriptionIds],
      expiresAt: session.expiresAt,
    } satisfies StoredKickSession);
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
    const payload = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      userId: session.userId,
      displayName: session.displayName,
      relayToken: session.relayToken,
      subscriptionIds: session.subscriptionIds,
    };
    await this.ctx.storage.deleteAll();
    return Response.json(payload);
  }

  private async completeSetup(
    code: string,
    redirectUri: string,
    kickCodeVerifier: string,
  ): Promise<
    | {
        readonly ok: true;
        readonly value: {
          readonly accessToken: string;
          readonly refreshToken: string;
          readonly expiresIn: number;
          readonly userId: number;
          readonly displayName: string;
          readonly relayToken: string;
          readonly subscriptionIds: readonly string[];
        };
      }
    | { readonly ok: false; readonly response: Response }
  > {
    const tokenResponse = await safeFetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.env.KICK_CLIENT_ID,
        client_secret: this.env.KICK_CLIENT_SECRET,
        code,
        code_verifier: kickCodeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenResponse?.ok) {
      await tokenResponse?.body?.cancel();
      return { ok: false, response: kickUnavailable("Kick rejected the token exchange.") };
    }
    const tokenPayload: unknown = await tokenResponse.json();
    const tokens = v.safeParse(kickTokenSchema, tokenPayload);
    if (!tokens.success) {
      return {
        ok: false,
        response: kickUnavailable("Kick returned an unexpected token response."),
      };
    }

    const userResponse = await safeFetch("https://api.kick.com/public/v1/users", {
      headers: { authorization: `Bearer ${tokens.output.access_token}` },
    });
    if (!userResponse?.ok) {
      await userResponse?.body?.cancel();
      return { ok: false, response: kickUnavailable("Kick could not load the authorized user.") };
    }
    const userPayload: unknown = await userResponse.json();
    const users = v.safeParse(userResponseSchema, userPayload);
    const user = users.success ? users.output.data[0] : undefined;
    if (!user) {
      return { ok: false, response: kickUnavailable("Kick returned an unexpected user response.") };
    }

    const subscriptionIds = await this.ensureSubscriptions(tokens.output.access_token);
    if (!subscriptionIds) {
      return { ok: false, response: kickUnavailable("Kick chat events could not be subscribed.") };
    }
    const relayToken = randomBase64Url(32);
    const relay = this.env.KICK_CHAT_RELAYS.get(
      this.env.KICK_CHAT_RELAYS.idFromName(String(user.user_id)),
    );
    const configured = await relay.fetch("https://kick-relay/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relayToken }),
    });
    if (!configured.ok) {
      await configured.body?.cancel();
      return { ok: false, response: kickUnavailable("The Kick chat relay could not be prepared.") };
    }
    await configured.body?.cancel();

    return {
      ok: true,
      value: {
        accessToken: tokens.output.access_token,
        refreshToken: tokens.output.refresh_token,
        expiresIn: tokens.output.expires_in,
        userId: user.user_id,
        displayName: user.name,
        relayToken,
        subscriptionIds,
      },
    };
  }

  private async ensureSubscriptions(accessToken: string): Promise<readonly string[] | null> {
    const headers = { authorization: `Bearer ${accessToken}` };
    const listResponse = await safeFetch("https://api.kick.com/public/v1/events/subscriptions", {
      headers,
    });
    if (!listResponse?.ok) {
      await listResponse?.body?.cancel();
      return null;
    }
    const listPayload: unknown = await listResponse.json();
    const listed = v.safeParse(subscriptionListSchema, listPayload);
    if (!listed.success) return null;
    const existing = listed.output.data.filter(
      (subscription) =>
        subscription.version === 1 && REQUIRED_EVENTS.some((event) => event === subscription.event),
    );
    const missing = REQUIRED_EVENTS.filter(
      (event) => !existing.some((subscription) => subscription.event === event),
    );
    if (missing.length === 0) return existing.map((subscription) => subscription.id);

    const createResponse = await safeFetch("https://api.kick.com/public/v1/events/subscriptions", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        events: missing.map((name) => ({ name, version: 1 })),
        method: "webhook",
      }),
    });
    if (!createResponse?.ok) {
      await createResponse?.body?.cancel();
      return null;
    }
    const createPayload: unknown = await createResponse.json();
    const created = v.safeParse(subscriptionCreateSchema, createPayload);
    if (
      !created.success ||
      created.output.data.some((item) => item.error || !item.subscription_id)
    ) {
      return null;
    }
    return [
      ...existing.map((subscription) => subscription.id),
      ...created.output.data.flatMap((item) =>
        item.subscription_id ? [item.subscription_id] : [],
      ),
    ];
  }

  private async fail(
    session: Extract<StoredKickSession, { readonly status: "pending" }>,
    reason: string,
  ): Promise<void> {
    await this.ctx.storage.put(SESSION_KEY, {
      status: "failed",
      clientCodeChallenge: session.clientCodeChallenge,
      reason,
      expiresAt: session.expiresAt,
    } satisfies StoredKickSession);
  }

  private async activeSession(): Promise<StoredKickSession | Response> {
    const session = await this.readSession();
    if (!session) return internalError("not_found", "OAuth session was not found.", 404);
    if (session.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return internalError("expired", "OAuth session expired. Start sign-in again.", 410);
    }
    return session;
  }

  private async readSession(): Promise<StoredKickSession | null> {
    const stored: unknown = await this.ctx.storage.get(SESSION_KEY);
    const parsed = v.safeParse(storedSessionSchema, stored);
    return parsed.success ? parsed.output : null;
  }
}

async function safeFetch(input: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(input, init);
  } catch {
    return null;
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

function kickUnavailable(message: string): Response {
  return internalError("kick_unavailable", `${message} No login was stored; retry shortly.`, 502);
}

function internalError(code: InternalErrorCode, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}
