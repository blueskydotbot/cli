import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type Credentials = {
  version: 1;
  apiUrl: string;
  token: string;
  did: string;
  handle: string;
  expiresAt: string;
};

export function configDir(env: NodeJS.ProcessEnv): string {
  if (env.BSBOT_CONFIG_DIR) return env.BSBOT_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "bsbot");
}

export function credentialsPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), "credentials.json");
}

function isCredentials(value: unknown): value is Credentials {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.apiUrl === "string" &&
    typeof v.token === "string" &&
    typeof v.did === "string" &&
    typeof v.handle === "string" &&
    typeof v.expiresAt === "string"
  );
}

export async function readCredentials(
  env: NodeJS.ProcessEnv,
): Promise<Credentials | null> {
  const file = credentialsPath(env);
  let text: string;
  try {
    const info = await stat(file);
    // Tighten a file that others can read back to 0600.
    if ((info.mode & 0o077) !== 0) await chmod(file, 0o600);
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isCredentials(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeCredentials(
  env: NodeJS.ProcessEnv,
  credentials: Credentials,
): Promise<string> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // `mkdir` leaves an existing folder as it was.
  await chmod(dir, 0o700);

  const file = credentialsPath(env);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  // `wx`: never follow or reuse an existing file. Written then renamed, so a
  // crash never leaves half a file.
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  return file;
}

export async function deleteCredentials(env: NodeJS.ProcessEnv): Promise<void> {
  await rm(credentialsPath(env), { force: true });
}
