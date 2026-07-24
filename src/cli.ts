export type Provider = "youtube" | "twitch";

export type Command =
  | { readonly _tag: "run"; readonly provider: Provider }
  | { readonly _tag: "auth"; readonly provider: Provider }
  | { readonly _tag: "logout"; readonly provider: Provider }
  | { readonly _tag: "help" }
  | { readonly _tag: "version" };

export function parseCommand(args: readonly string[]): Command {
  const first = args[0];
  if (!first) return { _tag: "run", provider: "youtube" };
  if (first === "--version" || first === "-v") return { _tag: "version" };
  if (first === "--help" || first === "-h" || first === "help") return { _tag: "help" };

  const provider = parseProvider(first);
  if (provider) return parseProviderCommand(provider, args[1], args.length);

  if (first === "auth" || first === "logout") {
    return { _tag: first, provider: "youtube" };
  }
  return { _tag: "help" };
}

function parseProvider(value: string): Provider | null {
  if (value === "yt" || value === "youtube") return "youtube";
  if (value === "twitch") return "twitch";
  return null;
}

function parseProviderCommand(
  provider: Provider,
  action: string | undefined,
  argumentCount: number,
): Command {
  if (argumentCount === 1) return { _tag: "run", provider };
  if (argumentCount === 2 && (action === "auth" || action === "logout")) {
    return { _tag: action, provider };
  }
  return { _tag: "help" };
}
