import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

function expandPath(value: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return resolve(value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value);
}

function discoveredPath(): Promise<string | undefined> {
  return new Promise(done => {
    try {
      execFile("opencode", ["debug", "paths", "db"], { timeout: 5000, maxBuffer: 8192, windowsHide: true }, (error, stdout) => {
        if (error) return done(undefined);
        const lines = stdout.trim().split(/\r?\n/);
        done(lines.length === 1 && isAbsolute(lines[0]!) ? lines[0] : undefined);
      });
    } catch {
      done(undefined);
    }
  });
}

/** Select exactly one store; an explicit override never falls through. */
export async function resolveOpenCodeDbPath(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (Object.hasOwn(env, "JEV_OPENCODE_DB")) {
    const value = env.JEV_OPENCODE_DB;
    return value?.trim() ? expandPath(value.trim(), env) : undefined;
  }
  const discovered = await discoveredPath();
  if (discovered) return discovered;
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "opencode", "opencode.db");
}

function usable(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return key.length >= 16 ? key : undefined;
}

/** No store access on the environment-key path; unusable stores are silent misses. */
export async function resolveConsoleCredential(env: NodeJS.ProcessEnv = process.env): Promise<{ key?: string; source: "env" | "sqlite" | "missing" }> {
  const key = usable(env.OPENCODE_API_KEY);
  if (key) return { key, source: "env" };
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 22 || major === 22 && minor! < 13) return { source: "missing" };
  const path = await resolveOpenCodeDbPath(env);
  if (!path) return { source: "missing" };
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    const rows = db.prepare("SELECT value FROM credential WHERE integration_id = ?").all("opencode") as Array<{ value: unknown }>;
    for (const row of rows) {
      try {
        const record = JSON.parse(String(row.value));
        if (!record || typeof record !== "object" || !["key", "oauth"].includes(record.type)) continue;
        const found = usable(record.key) || record.type === "oauth" && usable(record.access);
        if (found) return { key: found, source: "sqlite" };
      } catch { /* a bad row must not prevent trying the next one */ }
    }
  } catch { /* sqlite unavailable, schema invalid, or store unreadable */ }
  finally { try { db?.close(); } catch { /* read-only cleanup */ } }
  return { source: "missing" };
}
