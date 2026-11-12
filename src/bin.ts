#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { run } from "./cli.ts";

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "linux"
        ? "xdg-open"
        : null;
  if (!opener) return;
  try {
    // No shell: the URL is a single argument, never interpreted.
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser: the URL is printed anyway.
  }
}

const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const code = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  fetch,
  openBrowser,
  confirm: interactive ? confirm : null,
});
process.exitCode = code;
