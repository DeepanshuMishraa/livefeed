#!/usr/bin/env bun
import { Result } from "better-result";
import packageJson from "../package.json" with { type: "json" };
import { accessToken, authenticate, loadCredentials, logout } from "./auth";
import { parseCommand } from "./cli";
import { LivefeedError, type LivefeedError as LivefeedErrorType } from "./errors";
import { runTui } from "./tui";

const VERSION = packageJson.version;
const HELP = `livefeed — your YouTube live chat, in the terminal

Usage:
  livefeed             Open the newest active broadcast's chat
  livefeed auth        Sign in with Google
  livefeed logout      Revoke and remove the saved login
  livefeed --help      Show this help
  livefeed --version   Show the installed version`;

const command = parseCommand(Bun.argv.slice(2));

function printError(error: LivefeedErrorType): void {
  console.error(LivefeedError.message(error));
  if (error._tag !== "NoActiveBroadcast") process.exitCode = 1;
}

switch (command) {
  case "help":
    console.log(HELP);
    break;
  case "version":
    console.log(VERSION);
    break;
  case "auth": {
    console.log("Opening Google sign-in…");
    const result = await authenticate();
    if (Result.isError(result)) printError(result.error);
    else console.log(`Connected to ${result.value.channelTitle}.`);
    break;
  }
  case "logout": {
    const result = await logout();
    if (Result.isError(result)) printError(result.error);
    else
      console.log(
        result.value ? "Signed out. The saved login was removed." : "Already signed out.",
      );
    break;
  }
  case "run": {
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
    await runTui(token.value, credentials.value);
    break;
  }
}
