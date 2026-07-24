import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/cli";

describe("parseCommand", () => {
  it.each([
    [[], { _tag: "run", provider: "youtube" }],
    [["auth"], { _tag: "auth", provider: "youtube" }],
    [["logout"], { _tag: "logout", provider: "youtube" }],
    [["yt"], { _tag: "run", provider: "youtube" }],
    [["youtube", "auth"], { _tag: "auth", provider: "youtube" }],
    [["twitch"], { _tag: "run", provider: "twitch" }],
    [["twitch", "auth"], { _tag: "auth", provider: "twitch" }],
    [["twitch", "logout"], { _tag: "logout", provider: "twitch" }],
    [["--version"], { _tag: "version" }],
    [["-v"], { _tag: "version" }],
    [["--help"], { _tag: "help" }],
    [["unknown"], { _tag: "help" }],
    [["twitch", "unknown"], { _tag: "help" }],
  ] as const)("maps %j to %s", (args, expected) => {
    expect(parseCommand(args)).toEqual(expected);
  });
});
