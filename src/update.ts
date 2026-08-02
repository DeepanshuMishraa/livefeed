import { Result, type Result as ResultType } from "better-result";
import * as v from "valibot";

const PACKAGE_NAME = "livefeed";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const stableVersionSchema = v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/));
const registryPackageSchema = v.object({ version: stableVersionSchema });

export type PackageManager = "npm" | "pnpm" | "bun";

export type UpdateOutcome =
  | { readonly _tag: "current"; readonly version: string }
  | {
      readonly _tag: "updated";
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly packageManager: PackageManager;
    };

export type UpdateError =
  | { readonly _tag: "UpdateCheckUnavailable"; readonly reason: string }
  | { readonly _tag: "UpdateRegistryFailure"; readonly status: number }
  | { readonly _tag: "InvalidUpdateResponse" }
  | { readonly _tag: "InvalidInstalledVersion"; readonly version: string }
  | {
      readonly _tag: "UpdateCommandUnavailable";
      readonly packageManager: PackageManager;
      readonly reason: string;
    }
  | {
      readonly _tag: "UpdateFailed";
      readonly packageManager: PackageManager;
      readonly exitCode: number;
    };

export const UpdateError = {
  message(error: UpdateError): string {
    switch (error._tag) {
      case "UpdateCheckUnavailable":
        return `Could not check for a Livefeed update: ${error.reason}. The installed version was not changed; check your connection and retry.`;
      case "UpdateRegistryFailure":
        return `The npm registry returned status ${error.status} while checking for a Livefeed update. The installed version was not changed; retry shortly.`;
      case "InvalidUpdateResponse":
        return "The npm registry returned invalid Livefeed version metadata. The installed version was not changed; retry later or report the issue.";
      case "InvalidInstalledVersion":
        return `The installed Livefeed version (${error.version}) is invalid. Reinstall Livefeed, then run \`livefeed update\` again.`;
      case "UpdateCommandUnavailable":
        return `Could not start ${error.packageManager} to update Livefeed: ${error.reason}. The installed version is still available; ensure ${error.packageManager} is on PATH and retry.`;
      case "UpdateFailed":
        return `${error.packageManager} could not update Livefeed and exited with status ${error.exitCode}. The previous installation remains available; review the package-manager output and retry.`;
    }
  },
} as const;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type UpdateCommandRunner = (command: readonly string[]) => Promise<number>;

interface UpdateOptions {
  readonly currentVersion: string;
  readonly mainPath: string;
  readonly fetcher?: Fetcher;
  readonly runCommand?: UpdateCommandRunner;
}

export async function updateLivefeed(
  options: UpdateOptions,
): Promise<ResultType<UpdateOutcome, UpdateError>> {
  const latest = await latestVersion(options.fetcher ?? fetch);
  if (Result.isError(latest)) return Result.err(latest.error);

  const comparison = compareStableVersions(options.currentVersion, latest.value);
  if (comparison === null) {
    return Result.err({ _tag: "InvalidInstalledVersion", version: options.currentVersion });
  }
  if (comparison >= 0) {
    return Result.ok({ _tag: "current", version: options.currentVersion });
  }

  const packageManager = packageManagerForPath(options.mainPath);
  const command = updateCommand(packageManager, latest.value);
  let exitCode: number;
  try {
    exitCode = await (options.runCommand ?? runCommand)(command);
  } catch (cause) {
    return Result.err({
      _tag: "UpdateCommandUnavailable",
      packageManager,
      reason: causeMessage(cause),
    });
  }
  if (exitCode !== 0) {
    return Result.err({ _tag: "UpdateFailed", packageManager, exitCode });
  }

  return Result.ok({
    _tag: "updated",
    fromVersion: options.currentVersion,
    toVersion: latest.value,
    packageManager,
  });
}

export function packageManagerForPath(mainPath: string): PackageManager {
  const normalized = mainPath.replaceAll("\\", "/");
  if (normalized.includes("/.bun/")) return "bun";
  const lowerPath = normalized.toLowerCase();
  if (lowerPath.includes("/pnpm/") || lowerPath.includes("/.pnpm/")) return "pnpm";
  return "npm";
}

async function latestVersion(fetcher: Fetcher): Promise<ResultType<string, UpdateError>> {
  let response: Response;
  try {
    response = await fetcher(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    return Result.err({ _tag: "UpdateCheckUnavailable", reason: causeMessage(cause) });
  }

  if (!response.ok) {
    await response.body?.cancel();
    return Result.err({ _tag: "UpdateRegistryFailure", status: response.status });
  }

  try {
    const body: unknown = await response.json();
    const parsed = v.safeParse(registryPackageSchema, body);
    return parsed.success
      ? Result.ok(parsed.output.version)
      : Result.err({ _tag: "InvalidUpdateResponse" });
  } catch {
    return Result.err({ _tag: "InvalidUpdateResponse" });
  }
}

function updateCommand(packageManager: PackageManager, version: string): readonly string[] {
  switch (packageManager) {
    case "npm":
      return ["npm", "install", "--global", `${PACKAGE_NAME}@${version}`];
    case "pnpm":
      return ["pnpm", "add", "--global", `${PACKAGE_NAME}@${version}`];
    case "bun":
      return ["bun", "add", "--global", `${PACKAGE_NAME}@${version}`];
  }
}

async function runCommand(command: readonly string[]): Promise<number> {
  const child = Bun.spawn([...command], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

function compareStableVersions(left: string, right: string): -1 | 0 | 1 | null {
  const leftVersion = parseStableVersion(left);
  const rightVersion = parseStableVersion(right);
  if (!leftVersion || !rightVersion) return null;

  for (let index = 0; index < leftVersion.length; index += 1) {
    const leftPart = leftVersion[index];
    const rightPart = rightVersion[index];
    if (leftPart === undefined || rightPart === undefined) return null;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function parseStableVersion(version: string): readonly [number, number, number] | null {
  const parsed = v.safeParse(stableVersionSchema, version);
  if (!parsed.success) return null;
  const [majorText, minorText, patchText] = version.split(".");
  if (majorText === undefined || minorText === undefined || patchText === undefined) return null;
  return [Number(majorText), Number(minorText), Number(patchText)];
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
