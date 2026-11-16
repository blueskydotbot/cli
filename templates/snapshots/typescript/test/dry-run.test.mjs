import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the default run has no credentials or network requirement", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/bot.ts"],
    { env: { PATH: process.env.PATH, DRY_RUN: "true" }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run/);
  assert.doesNotMatch(result.stderr, /password|token/i);
});
test("replies stay opt-in and schedules never overlap", () => {
  assert.match(
    readFileSync(".github/workflows/bot.yml", "utf8"),
    /cancel-in-progress: false/,
  );
  assert.match(
    readFileSync(".github/workflows/bot.yml", "utf8"),
    /REPLY_TO_MENTIONS: 'false'/,
  );
});
