import { Result } from "better-result";
import { describe, expect, it } from "vitest";
import { packageManagerForPath, type UpdateCommandRunner, updateLivefeed } from "../src/update";

const registryResponse = (version: string): Response =>
  new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("packageManagerForPath", () => {
  it.each([
    ["/Users/me/.bun/install/global/node_modules/livefeed/dist/index.js", "bun"],
    ["/Users/me/.bun/install/cache/livefeed@0.0.2/dist/index.js", "bun"],
    ["/Users/me/Library/pnpm/global/5/node_modules/livefeed/dist/index.js", "pnpm"],
    [
      "/Users/me/Library/pnpm/global/5/.pnpm/livefeed@0.0.2/node_modules/livefeed/dist/index.js",
      "pnpm",
    ],
    ["/usr/local/lib/node_modules/livefeed/dist/index.js", "npm"],
  ] as const)("detects %s as %s", (path, expected) => {
    expect(packageManagerForPath(path)).toBe(expected);
  });
});

describe("updateLivefeed", () => {
  it("reports the current installation when latest matches", async () => {
    const commands: string[][] = [];
    const result = await updateLivefeed({
      currentVersion: "0.0.2",
      mainPath: "/usr/local/lib/node_modules/livefeed/dist/index.js",
      fetcher: async () => registryResponse("0.0.2"),
      runCommand: recordingRunner(commands),
    });

    expect(Result.isOk(result) ? result.value : null).toEqual({
      _tag: "current",
      version: "0.0.2",
    });
    expect(commands).toEqual([]);
  });

  it("updates with the package manager used by the installation", async () => {
    const commands: string[][] = [];
    const result = await updateLivefeed({
      currentVersion: "0.0.1",
      mainPath: "/Users/me/Library/pnpm/global/5/node_modules/livefeed/dist/index.js",
      fetcher: async () => registryResponse("0.0.2"),
      runCommand: recordingRunner(commands),
    });

    expect(Result.isOk(result) ? result.value : null).toEqual({
      _tag: "updated",
      fromVersion: "0.0.1",
      toVersion: "0.0.2",
      packageManager: "pnpm",
    });
    expect(commands).toEqual([["pnpm", "add", "--global", "livefeed@0.0.2"]]);
  });

  it("preserves the installed version when the update command fails", async () => {
    const result = await updateLivefeed({
      currentVersion: "0.0.1",
      mainPath: "/Users/me/.bun/install/global/node_modules/livefeed/dist/index.js",
      fetcher: async () => registryResponse("0.0.2"),
      runCommand: async () => 1,
    });

    expect(Result.isError(result) ? result.error : null).toEqual({
      _tag: "UpdateFailed",
      packageManager: "bun",
      exitCode: 1,
    });
  });

  it("rejects invalid registry versions before running a command", async () => {
    const commands: string[][] = [];
    const result = await updateLivefeed({
      currentVersion: "0.0.1",
      mainPath: "/usr/local/lib/node_modules/livefeed/dist/index.js",
      fetcher: async () => registryResponse("not-a-version"),
      runCommand: recordingRunner(commands),
    });

    expect(Result.isError(result) ? result.error : null).toEqual({
      _tag: "InvalidUpdateResponse",
    });
    expect(commands).toEqual([]);
  });
});

function recordingRunner(commands: string[][]): UpdateCommandRunner {
  return async (command) => {
    commands.push([...command]);
    return 0;
  };
}
