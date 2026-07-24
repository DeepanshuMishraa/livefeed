import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/cli";

describe("parseCommand", () => {
  it.each([
    [[], "run"],
    [["auth"], "auth"],
    [["logout"], "logout"],
    [["--version"], "version"],
    [["-v"], "version"],
    [["--help"], "help"],
    [["unknown"], "help"],
  ] as const)("maps %j to %s", (args, expected) => {
    expect(parseCommand(args)).toBe(expected);
  });
});
