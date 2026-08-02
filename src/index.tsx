#!/usr/bin/env bun
import { Result } from "better-result";
import packageJson from "../package.json" with { type: "json" };
import { accessToken, authenticate, type Credentials, loadCredentials, logout } from "./auth";
import { automaticProvider, type Provider, parseCommand } from "./cli";
import { demoFeed } from "./demo";
import { LivefeedError, type LivefeedError as LivefeedErrorType } from "./errors";
import type { FeedClient } from "./feed";
import {
  authenticateKick,
  type KickCredentials,
  kickAccessToken,
  loadKickCredentials,
  logoutKick,
} from "./kick-auth";
import { findActiveKickBroadcast, loadKickChatHistory, openKickChatStream } from "./kick";
import {
  type LogoutTarget,
  selectAuthProvider,
  selectDemoProvider,
  selectLogoutTarget,
  selectProvider,
} from "./provider-selector";
import { runTui } from "./tui";
import { findActiveTwitchBroadcast, loadTwitchChatHistory, openTwitchChatStream } from "./twitch";
import {
  authenticateTwitch,
  loadTwitchCredentials,
  logoutTwitch,
  type TwitchCredentials,
  twitchAccessToken,
} from "./twitch-auth";
import { findActiveBroadcast, loadChatHistory, openChatStream } from "./youtube";
import { UpdateError, updateLivefeed } from "./update";

const VERSION = packageJson.version;
const HELP = `livefeed — YouTube, Twitch, and Kick live chat, in the terminal

Usage:
  livefeed                    Open the connected chat or choose a provider
  livefeed --demo             Preview synthetic chat without signing in
  livefeed auth               Choose a provider and sign in
  livefeed logout             Choose providers and remove saved logins
  livefeed update             Install the latest Livefeed version
  livefeed --help             Show this help
  livefeed --version          Show the installed version`;

const command = parseCommand(Bun.argv.slice(2));

function printError(error: LivefeedErrorType): void {
  console.error(LivefeedError.message(error));
  if (error._tag !== "NoActiveBroadcast") process.exitCode = 1;
}

switch (command._tag) {
  case "help":
    console.log(HELP);
    break;
  case "version":
    console.log(VERSION);
    break;
  case "demo": {
    const provider = await selectDemoProvider();
    if (provider) await runTui("demo", demoFeed(provider));
    break;
  }
  case "update": {
    console.log(`Checking for Livefeed updates. Installed version: ${VERSION}`);
    const result = await updateLivefeed({ currentVersion: VERSION, mainPath: Bun.main });
    if (Result.isError(result)) {
      console.error(UpdateError.message(result.error));
      process.exitCode = 1;
    } else if (result.value._tag === "current") {
      console.log(`Livefeed ${result.value.version} is already the latest version.`);
    } else {
      console.log(
        `Updated Livefeed from ${result.value.fromVersion} to ${result.value.toVersion} using ${result.value.packageManager}.`,
      );
    }
    break;
  }
  case "auth": {
    const provider = await selectAuthProvider();
    if (provider) await authenticateProvider(provider);
    break;
  }
  case "logout": {
    const target = await selectLogoutTarget();
    if (target) await logoutSelected(target);
    break;
  }
  case "run-auto": {
    const [youtubeCredentials, twitchCredentials, kickCredentials] = await Promise.all([
      loadCredentials(),
      loadTwitchCredentials(),
      loadKickCredentials(),
    ]);

    if (Result.isError(youtubeCredentials) && youtubeCredentials.error._tag !== "Unauthenticated") {
      printError(youtubeCredentials.error);
      break;
    }
    if (
      Result.isError(twitchCredentials) &&
      twitchCredentials.error._tag !== "TwitchUnauthenticated"
    ) {
      printError(twitchCredentials.error);
      break;
    }
    if (Result.isError(kickCredentials) && kickCredentials.error._tag !== "KickUnauthenticated") {
      printError(kickCredentials.error);
      break;
    }

    const authenticated = new Set<Provider>();
    if (Result.isOk(youtubeCredentials)) authenticated.add("youtube");
    if (Result.isOk(twitchCredentials)) authenticated.add("twitch");
    if (Result.isOk(kickCredentials)) authenticated.add("kick");
    const automatic = automaticProvider(authenticated);

    if (automatic._tag === "none") {
      printError({ _tag: "NoAuthenticatedProvider" });
      break;
    }

    const provider = automatic._tag === "selected" ? automatic.provider : await selectProvider();
    if (!provider) break;

    if (provider === "youtube" && Result.isOk(youtubeCredentials)) {
      await runYouTube(youtubeCredentials.value);
    } else if (provider === "twitch" && Result.isOk(twitchCredentials)) {
      await runTwitch(twitchCredentials.value);
    } else if (provider === "kick" && Result.isOk(kickCredentials)) {
      await runKick(kickCredentials.value);
    }
    break;
  }
}

async function authenticateProvider(provider: Provider): Promise<void> {
  if (provider === "youtube") {
    console.log("Opening Google sign-in…");
    const result = await authenticate();
    if (Result.isError(result)) printError(result.error);
    else console.log(`Connected to ${result.value.channelTitle}.`);
    return;
  }

  if (provider === "kick") {
    console.log("Opening Kick sign-in…");
    const result = await authenticateKick();
    if (Result.isError(result)) printError(result.error);
    else console.log(`Connected to ${result.value.displayName}.`);
    return;
  }

  console.log("Opening Twitch sign-in…");
  const result = await authenticateTwitch();
  if (Result.isError(result)) printError(result.error);
  else console.log(`Connected to ${result.value.displayName}.`);
}

async function logoutSelected(target: LogoutTarget): Promise<void> {
  if (target === "all") {
    const [youtubeResult, twitchResult, kickResult] = await Promise.all([
      logout(),
      logoutTwitch(),
      logoutKick(),
    ]);
    printLogoutResult("YouTube", youtubeResult);
    printLogoutResult("Twitch", twitchResult);
    printLogoutResult("Kick", kickResult);
    return;
  }

  if (target === "youtube") {
    printLogoutResult("YouTube", await logout());
  } else if (target === "twitch") {
    printLogoutResult("Twitch", await logoutTwitch());
  } else {
    printLogoutResult("Kick", await logoutKick());
  }
}

function printLogoutResult(label: string, result: Awaited<ReturnType<typeof logout>>): void {
  if (Result.isError(result)) {
    printError(result.error);
    return;
  }
  console.log(
    result.value
      ? `Signed out of ${label}. The saved login was removed.`
      : `${label} was already signed out.`,
  );
}

async function runYouTube(credentials: Credentials): Promise<void> {
  const token = await accessToken(credentials);
  if (Result.isError(token)) {
    printError(token.error);
    return;
  }
  const feed: FeedClient = {
    channelTitle: credentials.channelTitle,
    refreshAccessToken: () => accessToken(credentials),
    findActiveBroadcast,
    loadChatHistory,
    openChatStream,
  };
  await runTui(token.value, feed);
}

async function runTwitch(credentials: TwitchCredentials): Promise<void> {
  const token = await twitchAccessToken(credentials);
  if (Result.isError(token)) {
    printError(token.error);
    return;
  }
  await runTui(token.value, twitchFeed(credentials));
}

function twitchFeed(credentials: TwitchCredentials): FeedClient {
  return {
    channelTitle: credentials.displayName,
    refreshAccessToken: async () => {
      const current = await loadTwitchCredentials();
      return Result.isError(current) ? Result.err(current.error) : twitchAccessToken(current.value);
    },
    findActiveBroadcast: (token) => findActiveTwitchBroadcast(token, credentials),
    loadChatHistory: loadTwitchChatHistory,
    openChatStream: (token, liveChatId, pageToken, callbacks) =>
      openTwitchChatStream(
        token,
        liveChatId,
        pageToken,
        callbacks,
        credentials.clientId,
        credentials.userId,
      ),
  };
}

async function runKick(credentials: KickCredentials): Promise<void> {
  const token = await kickAccessToken(credentials);
  if (Result.isError(token)) {
    printError(token.error);
    return;
  }
  await runTui(token.value, kickFeed(credentials));
}

function kickFeed(credentials: KickCredentials): FeedClient {
  return {
    channelTitle: credentials.displayName,
    refreshAccessToken: async () => {
      const current = await loadKickCredentials();
      return Result.isError(current) ? Result.err(current.error) : kickAccessToken(current.value);
    },
    findActiveBroadcast: (token) => findActiveKickBroadcast(token, credentials),
    loadChatHistory: () => loadKickChatHistory(credentials),
    openChatStream: (_token, _liveChatId, _pageToken, callbacks) =>
      openKickChatStream(credentials, callbacks),
  };
}
