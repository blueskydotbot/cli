// `bsbot doctor`: a bot's checkup (bluesky.bot issue 312). Check ids may be
// new: only the status and the message are read, never the id.
import type { Check, Checkup } from "./api.ts";

/** Exit code when a check fails (or warns, with `--strict`). */
export const EXIT_CHECK_FAILED = 3;

const ICONS: Record<string, [icon: string, color: number]> = {
  pass: ["✓", 32],
  warn: ["!", 33],
  fail: ["✗", 31],
  info: ["·", 2],
  unknown: ["?", 2],
};

function icon(status: string, color: boolean): string {
  const [mark, code] = ICONS[status] ?? ["?", 2];
  return color ? `\u001b[${code}m${mark}\u001b[0m` : mark;
}

export function checkupFails(checkup: Checkup, strict: boolean): boolean {
  return checkup.summary.fail > 0 || (strict && checkup.summary.warn > 0);
}

/** `5/7  1 to fix, 1 suggestion` */
export function summaryText(checkup: Checkup): string {
  const { passed, total, fail, warn } = checkup.summary;
  const notes = [
    fail ? `${fail} to fix` : "",
    warn ? `${warn} suggestion${warn === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return `${passed}/${total}  ${notes.length ? notes.join(", ") : "all good"}`;
}

function checkLines(check: Check, color: boolean, indent: string): string[] {
  const lines = [`${indent}${icon(check.status, color)} ${check.message}`];
  if (check.status !== "pass") {
    if (check.fixUrl) lines.push(`${indent}    fix:  ${check.fixUrl}`);
    if (check.docsUrl) lines.push(`${indent}    docs: ${check.docsUrl}`);
  }
  return lines;
}

/** One bot's checkup: a summary line, then every check. */
export function checkupLines(checkup: Checkup, color: boolean): string[] {
  const name = checkup.bot.handle ?? checkup.bot.did;
  return [
    `${name}  ${summaryText(checkup)}`,
    ...checkup.checks.flatMap((check) => checkLines(check, color, "")),
  ];
}

/** A line per bot, with its checks under it when `verbose`. */
export function checkupRow(
  name: string,
  checkup: Checkup,
  color: boolean,
  verbose: boolean,
): string[] {
  const row = `${name.padEnd(36)} ${summaryText(checkup)}`;
  return verbose
    ? [
        row,
        ...checkup.checks.flatMap((check) => checkLines(check, color, "  ")),
      ]
    : [row];
}
