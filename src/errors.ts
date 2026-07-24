export type LivefeedError =
  | { readonly _tag: "Unauthenticated" }
  | { readonly _tag: "OAuthCallbackFailed"; readonly reason: string }
  | { readonly _tag: "AuthServerUnavailable"; readonly reason: string }
  | { readonly _tag: "AuthServerFailure"; readonly status: number; readonly reason: string }
  | { readonly _tag: "InvalidAuthServerResponse"; readonly operation: string }
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
  | { readonly _tag: "InvalidGoogleResponse"; readonly operation: string }
  | { readonly _tag: "TwitchUnauthenticated" }
  | { readonly _tag: "TwitchOAuthCallbackFailed"; readonly reason: string }
  | { readonly _tag: "TwitchTokenRejected" }
  | { readonly _tag: "TwitchServiceFailure"; readonly status: number; readonly reason: string }
  | { readonly _tag: "InvalidTwitchResponse"; readonly operation: string };

export const LivefeedError = {
  message(error: LivefeedError): string {
    switch (error._tag) {
      case "Unauthenticated":
        return "Not signed in. Run `livefeed auth`, then try again.";
      case "OAuthCallbackFailed":
        return `Google sign-in did not finish: ${error.reason}. No credentials were changed; run \`livefeed auth\` to retry.`;
      case "AuthServerUnavailable":
        return `Could not reach the Livefeed authentication server: ${error.reason}. No credentials were changed; check your connection and retry.`;
      case "AuthServerFailure":
        return `Livefeed authentication returned ${error.status}: ${error.reason}. No credentials were changed; retry shortly.`;
      case "InvalidAuthServerResponse":
        return `Livefeed authentication returned an unexpected response during ${error.operation}. Update livefeed or report the issue.`;
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
      case "TwitchUnauthenticated":
        return "Not signed in to Twitch. Run `livefeed twitch auth`, then try again.";
      case "TwitchOAuthCallbackFailed":
        return `Twitch sign-in did not finish: ${error.reason}. No credentials were changed; run \`livefeed twitch auth\` to retry.`;
      case "TwitchTokenRejected":
        return "Twitch rejected the saved login. Run `livefeed twitch auth` to reconnect your account.";
      case "TwitchServiceFailure":
        return `Twitch returned ${error.status}: ${error.reason}. Existing messages are preserved; retry shortly.`;
      case "InvalidTwitchResponse":
        return `Twitch returned an unexpected response during ${error.operation}. Update livefeed or report the issue.`;
    }
  },
} as const;
