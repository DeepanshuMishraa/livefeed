#!/usr/bin/env bun
import { Result } from "better-result";
import packageJson from "../package.json" with { type: "json" };
import { accessToken, authenticate, loadCredentials, logout } from "./auth";
import { parseCommand } from "./cli";
import { LivefeedError, type LivefeedError as LivefeedErrorType } from "./errors";
import type { FeedClient } from "./feed";
import {
  authenticateTwitch,
  loadTwitchCredentials,
  logoutTwitch,
  twitchAccessToken,
  type TwitchCredentials,
} from "./twitch-auth";
import { findActiveTwitchBroadcast, loadTwitchChatHistory, openTwitchChatStream } from "./twitch";
import { runTui } from "./tui";
import { findActiveBroadcast, loadChatHistory, openChatStream } from "./youtube";

const VERSION = packageJson.version;
const HELP = `livefeed — YouTube and Twitch live chat, in the terminal

Usage:
  livefeed yt                 Open your YouTube live chat
  livefeed yt auth            Sign in with Google
  livefeed yt logout          Remove the saved YouTube login
  livefeed twitch             Open your Twitch live chat
  livefeed twitch auth        Sign in with Twitch
  livefeed twitch logout      Remove the saved Twitch login
  livefeed                    Alias for livefeed yt
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
  case "auth": {
    console.log(`Opening ${command.provider === "youtube" ? "Google" : "Twitch"} sign-in…`);
    if (command.provider === "youtube") {
      const result = await authenticate();
      if (Result.isError(result)) printError(result.error);
      else console.log(`Connected to ${result.value.channelTitle}.`);
    } else {
      const result = await authenticateTwitch();
      if (Result.isError(result)) printError(result.error);
      else console.log(`Connected to ${result.value.displayName}.`);
    }
    break;
  }
  case "logout": {
    const result = command.provider === "youtube" ? await logout() : await logoutTwitch();
    if (Result.isError(result)) printError(result.error);
    else
      console.log(
        result.value ? "Signed out. The saved login was removed." : "Already signed out.",
      );
    break;
  }
  case "run": {
    if (command.provider === "youtube") {
      const credentials = await loadCredentials();
      if (Result.isError(credentials)) {
        printError(credentials.error);
        break;
      }
      const token = await accessToken(credentials.value);
      if (Result.isError(token)) {
        printError(token.error);
        break;
      }
      const feed: FeedClient = {
        channelTitle: credentials.value.channelTitle,
        refreshAccessToken: () => accessToken(credentials.value),
        findActiveBroadcast,
        loadChatHistory,
        openChatStream,
      };
      await runTui(token.value, feed);
    } else {
      const credentials = await loadTwitchCredentials();
      if (Result.isError(credentials)) {
        printError(credentials.error);
        break;
      }
      const token = await twitchAccessToken(credentials.value);
      if (Result.isError(token)) {
        printError(token.error);
        break;
      }
      await runTui(token.value, twitchFeed(credentials.value));
    }
    break;
  }
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
      openTwitchChatStream(token, liveChatId, pageToken, callbacks, credentials.clientId),
  };
}
