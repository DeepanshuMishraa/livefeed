export type Command = "run" | "auth" | "logout" | "help" | "version";

export function parseCommand(args: readonly string[]): Command {
  const first = args[0];
  if (!first) return "run";
  if (first === "auth") return "auth";
  if (first === "logout") return "logout";
  if (first === "--version" || first === "-v") return "version";
  return "help";
}
