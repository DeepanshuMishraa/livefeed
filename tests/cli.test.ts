import { describe, expect, it } from "vitest";
import { automaticProvider, type Provider, parseCommand } from "../src/cli";

describe("parseCommand", () => {
  it.each([
    [[], { _tag: "run-auto" }],
    [["auth"], { _tag: "auth" }],
    [["logout"], { _tag: "logout" }],
    [["--version"], { _tag: "version" }],
    [["-v"], { _tag: "version" }],
    [["update"], { _tag: "update" }],
    [["--help"], { _tag: "help" }],
    [["unknown"], { _tag: "help" }],
    [["yt"], { _tag: "help" }],
    [["youtube", "auth"], { _tag: "help" }],
    [["twitch"], { _tag: "help" }],
    [["twitch", "auth"], { _tag: "help" }],
    [["twitch", "unknown"], { _tag: "help" }],
  ] as const)("maps %j to %s", (args, expected) => {
    expect(parseCommand(args)).toEqual(expected);
  });
});

describe("automaticProvider", () => {
  it.each([
    [[], { _tag: "none" }],
    [["youtube"], { _tag: "selected", provider: "youtube" }],
    [["twitch"], { _tag: "selected", provider: "twitch" }],
    [["youtube", "twitch"], { _tag: "choose" }],
  ] as const)("resolves authenticated providers %j", (providers, expected) => {
    expect(automaticProvider(new Set<Provider>(providers))).toEqual(expected);
  });
});
