import type { OAuthSession } from "./oauth-session";
import type { TwitchOAuthSession } from "./twitch-oauth-session";
import type { KickChatRelay } from "./kick-chat-relay";
import type { KickOAuthSession } from "./kick-oauth-session";

export interface Bindings {
  readonly GOOGLE_CLIENT_ID: string;
  readonly GOOGLE_CLIENT_SECRET: string;
  readonly TWITCH_CLIENT_ID: string;
  readonly TWITCH_CLIENT_SECRET: string;
  readonly KICK_CLIENT_ID: string;
  readonly KICK_CLIENT_SECRET: string;
  readonly PUBLIC_ORIGIN: string;
  readonly OAUTH_SESSIONS: DurableObjectNamespace<OAuthSession>;
  readonly TWITCH_OAUTH_SESSIONS: DurableObjectNamespace<TwitchOAuthSession>;
  readonly KICK_OAUTH_SESSIONS: DurableObjectNamespace<KickOAuthSession>;
  readonly KICK_CHAT_RELAYS: DurableObjectNamespace<KickChatRelay>;
  readonly API_RATE_LIMITER: RateLimit;
  readonly SESSION_RATE_LIMITER: RateLimit;
  readonly POLL_RATE_LIMITER: RateLimit;
  readonly REFRESH_RATE_LIMITER: RateLimit;
}
