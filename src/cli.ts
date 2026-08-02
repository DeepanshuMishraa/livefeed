export type Provider = "youtube" | "twitch" | "kick";

export type Command =
  | { readonly _tag: "run-auto" }
  | { readonly _tag: "demo" }
  | { readonly _tag: "auth" }
  | { readonly _tag: "logout" }
  | { readonly _tag: "help" }
  | { readonly _tag: "update" }
  | { readonly _tag: "version" };

export function parseCommand(args: readonly string[]): Command {
  const first = args[0];
  if (!first) return { _tag: "run-auto" };
  if (first === "--demo" && args.length === 1) return { _tag: "demo" };
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
  if (authenticated.size === 0) return { _tag: "none" };
  if (authenticated.size > 1) return { _tag: "choose" };
  const provider = authenticated.values().next().value;
  return provider ? { _tag: "selected", provider } : { _tag: "none" };
}
