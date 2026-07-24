import type { OAuthSession } from "./oauth-session";

export interface Bindings {
  readonly GOOGLE_CLIENT_ID: string;
  readonly GOOGLE_CLIENT_SECRET: string;
  readonly PUBLIC_ORIGIN: string;
  readonly OAUTH_SESSIONS: DurableObjectNamespace<OAuthSession>;
}
