import type { OAuthSession } from "./oauth-session";

export interface Bindings {
  readonly GOOGLE_CLIENT_ID: string;
  readonly GOOGLE_CLIENT_SECRET: string;
  readonly PUBLIC_ORIGIN: string;
  readonly OAUTH_SESSIONS: DurableObjectNamespace<OAuthSession>;
  readonly API_RATE_LIMITER: RateLimit;
  readonly SESSION_RATE_LIMITER: RateLimit;
  readonly POLL_RATE_LIMITER: RateLimit;
  readonly REFRESH_RATE_LIMITER: RateLimit;
}
