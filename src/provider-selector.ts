import { clearScreenDown, cursorTo, emitKeypressEvents, type Key, moveCursor } from "node:readline";
import type { Provider } from "./cli";

export type LogoutTarget = Provider | "all";

interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly detail: string;
}

interface SelectorConfig<T extends string> {
  readonly prompt: string;
  readonly action: string;
  readonly unavailable: string;
  readonly choices: readonly Choice<T>[];
  readonly confirmation?: (label: string) => string;
}

const providerChoices = [
  { value: "youtube", label: "YouTube", detail: "youtube.com" },
  { value: "twitch", label: "Twitch", detail: "twitch.tv" },
  { value: "kick", label: "Kick", detail: "kick.com" },
] as const satisfies readonly Choice<Provider>[];

const logoutChoices = [
  { value: "youtube", label: "YouTube", detail: "saved Google login" },
  { value: "twitch", label: "Twitch", detail: "saved Twitch login" },
  { value: "kick", label: "Kick", detail: "saved Kick login" },
  { value: "all", label: "All accounts", detail: "YouTube, Twitch, and Kick" },
] as const satisfies readonly Choice<LogoutTarget>[];

export function selectProvider(): Promise<Provider | null> {
  return selectChoice({
    prompt: "Select a chat to open",
    action: "open",
    unavailable:
      "Multiple providers are connected, but choosing a chat requires an interactive terminal. Run `livefeed` from a terminal and try again.",
    choices: providerChoices,
    confirmation: (label) => `✓ Opening ${label} chat`,
  });
}

export function selectDemoProvider(): Promise<Provider | null> {
  return selectChoice({
    prompt: "Select a provider to demo",
    action: "open",
    unavailable:
      "Choosing a demo provider requires an interactive terminal. Run `livefeed --demo` from a terminal and try again.",
    choices: providerChoices,
    confirmation: (label) => `✓ Opening ${label} demo`,
  });
}

export function selectAuthProvider(): Promise<Provider | null> {
  return selectChoice({
    prompt: "Select a provider to connect",
    action: "connect",
    unavailable:
      "Choosing an account to connect requires an interactive terminal. Run `livefeed auth` from a terminal and try again.",
    choices: providerChoices,
  });
}

export function selectLogoutTarget(): Promise<LogoutTarget | null> {
  return selectChoice({
    prompt: "Select accounts to sign out",
    action: "select",
    unavailable:
      "Choosing accounts to sign out requires an interactive terminal. Run `livefeed logout` from a terminal and try again.",
    choices: logoutChoices,
  });
}

function prompt<T extends string>(config: SelectorConfig<T>, selectedIndex: number): string {
  const color = process.env["NO_COLOR"] === undefined;
  const accent = color ? "\u001b[32m" : "";
  const strong = color ? "\u001b[1m" : "";
  const muted = color ? "\u001b[2m" : "";
  const reset = color ? "\u001b[0m" : "";
  const rows = config.choices.map((choice, index) => {
    const marker = index === selectedIndex ? `${accent}❯${reset}` : " ";
    const paddedLabel = choice.label.padEnd(16);
    const label = index === selectedIndex ? `${strong}${paddedLabel}${reset}` : paddedLabel;
    return `${marker} ${label} ${muted}${choice.detail}${reset}`;
  });

  return [
    `${accent}?${reset} ${strong}${config.prompt}${reset}`,
    ...rows,
    `${muted}  ↑↓ move  ·  enter ${config.action}  ·  q cancel${reset}`,
  ].join("\n");
}

async function selectChoice<T extends string>(config: SelectorConfig<T>): Promise<T | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(config.unavailable);
    process.exitCode = 1;
    return null;
  }

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\u001b[?25l");

  return new Promise((resolve) => {
    let selectedIndex = 0;
    let drawn = false;
    let settled = false;
    const promptLines = config.choices.length + 2;

    const clearPrompt = () => {
      if (!drawn) return;
      moveCursor(process.stdout, 0, -promptLines);
      cursorTo(process.stdout, 0);
      clearScreenDown(process.stdout);
    };

    const render = () => {
      clearPrompt();
      process.stdout.write(`${prompt(config, selectedIndex)}\n`);
      drawn = true;
    };

    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      clearPrompt();
      process.stdout.write("\u001b[?25h");

      if (value && config.confirmation) {
        const choice = config.choices.find((candidate) => candidate.value === value);
        if (choice) console.log(config.confirmation(choice.label));
      }

      resolve(value);
    };

    const onKeypress = (_input: string, key: Key) => {
      if (key.ctrl && key.name === "c") {
        process.exitCode = 130;
        finish(null);
        return;
      }
      if (key.name === "q" || key.name === "escape") {
        finish(null);
        return;
      }
      if (key.name === "up" || key.name === "k") {
        selectedIndex = (selectedIndex - 1 + config.choices.length) % config.choices.length;
        render();
        return;
      }
      if (key.name === "down" || key.name === "j") {
        selectedIndex = (selectedIndex + 1) % config.choices.length;
        render();
        return;
      }
      if (key.name === "return") {
        const choice = config.choices[selectedIndex];
        if (choice) finish(choice.value);
      }
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}
