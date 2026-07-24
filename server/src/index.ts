import { Hono } from "hono";
import * as v from "valibot";
import type { Bindings } from "./bindings";
import {
  createSessionSchema,
  exchangeSessionSchema,
  googleTokenSchema,
  parseOAuthState,
  parsePublicOrigin,
  POLL_INTERVAL_SECONDS,
  randomBase64Url,
  refreshTokenSchema,
  SESSION_LIFETIME_MS,
  sha256Base64Url,
  YOUTUBE_SCOPE,
} from "./domain";
import { OAuthSession } from "./oauth-session";
import { authorizationPage } from "./page";

export { OAuthSession };

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", async (context, next) => {
  await next();
  context.header("cache-control", "no-store");
  context.header("referrer-policy", "no-referrer");
  context.header("x-content-type-options", "nosniff");
  context.header("x-frame-options", "DENY");
  context.header(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );
});

app.get("/", (context) =>
  context.json({
    service: "livefeed-auth",
    status: "ok",
  }),
);

app.get("/v1/oauth/complete", (context) => {
  const status = context.req.query("status");
  if (!status) return context.html(authorizationPage("success"));
  const detail =
    status === "rate_limited"
      ? "Too many authorization requests were received. Wait one minute and start sign-in again."
      : "Authorization could not be completed. Return to your terminal and try again.";
  return context.html(authorizationPage("error", detail));
});

app.post("/v1/oauth/sessions", async (context) => {
  if (!(await allowed(context.env.API_RATE_LIMITER, "sessions"))) {
    return rateLimitedResponse();
  }
  const clientAddress = context.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await allowed(context.env.SESSION_RATE_LIMITER, `session:${clientAddress}`))) {
    return rateLimitedResponse();
  }
  const config = configuration(context.env);
  if (!config.ok) return context.json(config.error, 500);
  const body = await validJson(context.req.raw, createSessionSchema);
  if (!body.ok) return context.json(body.error, 400);

  const sessionId = randomBase64Url(24);
  const browserState = randomBase64Url(32);
  const googleCodeVerifier = randomBase64Url(64);
  const googleCodeChallenge = await sha256Base64Url(googleCodeVerifier);
  const expiresAt = Date.now() + SESSION_LIFETIME_MS;
  const stub = context.env.OAUTH_SESSIONS.get(context.env.OAUTH_SESSIONS.idFromName(sessionId));
  const created = await stub.fetch("https://oauth-session/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      browserState,
      clientCodeChallenge: body.value.codeChallenge,
      googleCodeVerifier,
      expiresAt,
    }),
  });
  if (!created.ok) {
    await created.body?.cancel();
    return context.json(
      apiError("session_unavailable", "The sign-in session could not be created. Retry shortly."),
      503,
    );
  }
  await created.body?.cancel();

  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.search = new URLSearchParams({
    client_id: context.env.GOOGLE_CLIENT_ID,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: `${sessionId}.${browserState}`,
    code_challenge: googleCodeChallenge,
    code_challenge_method: "S256",
  }).toString();

  return context.json(
    {
      sessionId,
      authorizationUrl: authorizeUrl.toString(),
      expiresInSeconds: SESSION_LIFETIME_MS / 1000,
      pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    },
    201,
  );
});

app.get("/v1/oauth/callback", async (context) => {
  if (!(await allowed(context.env.API_RATE_LIMITER, "callback"))) {
    return context.redirect("/v1/oauth/complete?status=rate_limited", 303);
  }
  const config = configuration(context.env);
  if (!config.ok) {
    return context.redirect("/v1/oauth/complete?status=error", 303);
  }
  const parsedState = parseOAuthState(context.req.query("state") ?? "");
  if (!parsedState) {
    return context.redirect("/v1/oauth/complete?status=error", 303);
  }
  if (!(await allowed(context.env.POLL_RATE_LIMITER, `callback:${parsedState.sessionId}`))) {
    return context.redirect("/v1/oauth/complete?status=rate_limited", 303);
  }

  const stub = context.env.OAUTH_SESSIONS.get(
    context.env.OAUTH_SESSIONS.idFromName(parsedState.sessionId),
  );
  const response = await stub.fetch("https://oauth-session/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      browserState: parsedState.browserState,
      code: context.req.query("code"),
      error: context.req.query("error"),
      redirectUri: config.redirectUri,
    }),
  });
  if (response.ok) {
    await response.body?.cancel();
    return context.redirect("/v1/oauth/complete", 303);
  }
  await response.body?.cancel();
  return context.redirect("/v1/oauth/complete?status=error", 303);
});

app.post("/v1/oauth/token", async (context) => {
  if (!(await allowed(context.env.API_RATE_LIMITER, "token"))) {
    return rateLimitedResponse();
  }
  const body = await validJson(context.req.raw, exchangeSessionSchema);
  if (!body.ok) return context.json(body.error, 400);
  if (!(await allowed(context.env.POLL_RATE_LIMITER, `poll:${body.value.sessionId}`))) {
    return rateLimitedResponse();
  }
  const stub = context.env.OAUTH_SESSIONS.get(
    context.env.OAUTH_SESSIONS.idFromName(body.value.sessionId),
  );
  const response = await stub.fetch("https://oauth-session/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ codeVerifier: body.value.codeVerifier }),
  });
  return new Response(response.body, response);
});

app.post("/v1/oauth/refresh", async (context) => {
  if (!(await allowed(context.env.API_RATE_LIMITER, "refresh"))) {
    return rateLimitedResponse();
  }
  const config = configuration(context.env);
  if (!config.ok) return context.json(config.error, 500);
  const body = await validJson(context.req.raw, refreshTokenSchema);
  if (!body.ok) return context.json(body.error, 400);
  const refreshKey = await sha256Base64Url(body.value.refreshToken);
  if (!(await allowed(context.env.REFRESH_RATE_LIMITER, `refresh:${refreshKey}`))) {
    return rateLimitedResponse();
  }

  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: context.env.GOOGLE_CLIENT_ID,
        client_secret: context.env.GOOGLE_CLIENT_SECRET,
        refresh_token: body.value.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch {
    return context.json(
      apiError("google_unavailable", "Google could not be reached. Retry shortly."),
      502,
    );
  }
  if (response.status === 400 || response.status === 401) {
    await response.body?.cancel();
    return context.json(
      apiError("token_rejected", "Google rejected the saved login. Sign in again."),
      401,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    return context.json(
      apiError("google_unavailable", "Google could not refresh the login. Retry shortly."),
      502,
    );
  }
  const payload: unknown = await response.json();
  const parsed = v.safeParse(googleTokenSchema, payload);
  return parsed.success
    ? context.json({
        accessToken: parsed.output.access_token,
        expiresIn: parsed.output.expires_in,
      })
    : context.json(
        apiError("invalid_google_response", "Google returned an unexpected token response."),
        502,
      );
});

app.notFound((context) =>
  context.json(apiError("not_found", "The requested endpoint does not exist."), 404),
);

app.onError((_error, context) =>
  context.json(
    apiError(
      "internal_error",
      "The authorization server encountered an unexpected error. Retry shortly.",
    ),
    500,
  ),
);

function configuration(
  env: Bindings,
):
  | { readonly ok: true; readonly redirectUri: string }
  | { readonly ok: false; readonly error: ReturnType<typeof apiError> } {
  const origin = parsePublicOrigin(env.PUBLIC_ORIGIN);
  return origin && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { ok: true, redirectUri: new URL("/v1/oauth/callback", origin).toString() }
    : {
        ok: false,
        error: apiError(
          "server_misconfigured",
          "The authorization server is missing a valid origin or Google OAuth credentials.",
        ),
      };
}

async function validJson<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  request: Request,
  schema: TSchema,
): Promise<
  | { readonly ok: true; readonly value: v.InferOutput<TSchema> }
  | { readonly ok: false; readonly error: ReturnType<typeof apiError> }
> {
  try {
    const payload: unknown = await request.json();
    const parsed = v.safeParse(schema, payload);
    return parsed.success
      ? { ok: true, value: parsed.output }
      : {
          ok: false,
          error: apiError("invalid_request", "The request body is invalid."),
        };
  } catch {
    return {
      ok: false,
      error: apiError("invalid_request", "The request body must be valid JSON."),
    };
  }
}

function apiError(
  code: string,
  message: string,
): {
  readonly error: { readonly code: string; readonly message: string };
} {
  return { error: { code, message } };
}

async function allowed(rateLimiter: RateLimit, key: string): Promise<boolean> {
  const result = await rateLimiter.limit({ key });
  return result.success;
}

function rateLimitedResponse(): Response {
  return Response.json(
    apiError("rate_limited", "Too many authentication requests. Wait one minute and try again."),
    {
      status: 429,
      headers: { "retry-after": "60" },
    },
  );
}

export default app;
