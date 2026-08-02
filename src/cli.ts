export type Provider = "youtube" | "twitch";

export type Command =
  | { readonly _tag: "run-auto" }
  | { readonly _tag: "auth" }
  | { readonly _tag: "logout" }
  | { readonly _tag: "help" }
  | { readonly _tag: "update" }
  | { readonly _tag: "version" };

export function parseCommand(args: readonly string[]): Command {
  const first = args[0];
  if (!first) return { _tag: "run-auto" };
  if (first === "--version" || first === "-v") return { _tag: "version" };
  if (first === "--help" || first === "-h" || first === "help") return { _tag: "help" };
  if (first === "update" && args.length === 1) return { _tag: "update" };
  if (first === "auth" && args.length === 1) return { _tag: "auth" };
  if (first === "logout" && args.length === 1) return { _tag: "logout" };
  return { _tag: "help" };
}

export type AutomaticProvider =
  | { readonly _tag: "none" }
  | { readonly _tag: "selected"; readonly provider: Provider }
  | { readonly _tag: "choose" };

export function automaticProvider(authenticated: ReadonlySet<Provider>): AutomaticProvider {
  const hasYouTube = authenticated.has("youtube");
  const hasTwitch = authenticated.has("twitch");
  if (hasYouTube && hasTwitch) return { _tag: "choose" };
  if (hasYouTube) return { _tag: "selected", provider: "youtube" };
  if (hasTwitch) return { _tag: "selected", provider: "twitch" };
  return { _tag: "none" };
}
