export type LivefeedError =
  | { readonly _tag: "Unauthenticated" }
  | { readonly _tag: "OAuthNotConfigured" }
  | { readonly _tag: "OAuthCallbackFailed"; readonly reason: string }
  | { readonly _tag: "CredentialStoreUnavailable"; readonly reason: string }
  | { readonly _tag: "TokenRejected" }
  | { readonly _tag: "NoChannel" }
  | { readonly _tag: "LiveStreamingDisabled" }
  | { readonly _tag: "NoActiveBroadcast"; readonly channelTitle: string }
  | { readonly _tag: "ChatDisabled" }
  | { readonly _tag: "ChatEnded" }
  | { readonly _tag: "QuotaExceeded" }
  | { readonly _tag: "NetworkUnavailable"; readonly reason: string }
  | { readonly _tag: "GoogleServiceFailure"; readonly status: number; readonly reason: string }
  | { readonly _tag: "InvalidGoogleResponse"; readonly operation: string };

export const LivefeedError = {
  message(error: LivefeedError): string {
    switch (error._tag) {
      case "Unauthenticated":
        return "Not signed in. Run `livefeed auth`, then try again.";
      case "OAuthNotConfigured":
        return "Google OAuth is not configured in this build. Set LIVEFEED_GOOGLE_CLIENT_ID, then rebuild.";
      case "OAuthCallbackFailed":
        return `Google sign-in did not finish: ${error.reason}. No credentials were changed; run \`livefeed auth\` to retry.`;
      case "CredentialStoreUnavailable":
        return `The system credential store is unavailable: ${error.reason}. On Linux, start GNOME Keyring or KWallet, then retry.`;
      case "TokenRejected":
        return "Google rejected the saved login. Run `livefeed auth` to reconnect your account.";
      case "NoChannel":
        return "This Google account has no YouTube channel. Create a channel, then run `livefeed auth` again.";
      case "LiveStreamingDisabled":
        return "Live streaming is not enabled for this channel. Enable it in YouTube Studio, then retry.";
      case "NoActiveBroadcast":
        return `No active livestream found for ${error.channelTitle}.`;
      case "ChatDisabled":
        return "Live chat is disabled for this broadcast. The broadcast itself is still live.";
      case "ChatEnded":
        return "The live chat has ended. Messages already received remain visible.";
      case "QuotaExceeded":
        return "YouTube API quota is exhausted. Existing messages are preserved; retry after the quota resets.";
      case "NetworkUnavailable":
        return `Chat disconnected: ${error.reason}. Existing messages are preserved while livefeed retries.`;
      case "GoogleServiceFailure":
        return `YouTube returned ${error.status}: ${error.reason}. Existing messages are preserved; retry shortly.`;
      case "InvalidGoogleResponse":
        return `YouTube returned an unexpected response during ${error.operation}. Update livefeed or report the issue.`;
    }
  },
} as const;
