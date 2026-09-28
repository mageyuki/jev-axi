import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const forbidden = async (): Promise<never> => { throw new Error("Unexpected network request in test"); };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-hermetic-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  process.chdir(repo);
  for (const name of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA"]) {
    process.env[name] = join(root, name);
    mkdirSync(process.env[name]!, { recursive: true });
  }
  for (const name of ["OPENCODE_API_KEY", "JEV_OPENCODE_DB", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_BACKEND", "TYPESAFE_DEFAULT_MODEL", "JEV_MODEL"]) delete process.env[name];
  process.env.JEV_BACKEND = "typesafe";
  process.env.NO_UPDATE_NOTIFIER = "1";
  const shims = join(root, "shims");
  mkdirSync(shims);
  const noOpenCode = join(shims, process.platform === "win32" ? "opencode.cmd" : "opencode");
  writeFileSync(noOpenCode, process.platform === "win32" ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
  if (process.platform !== "win32") chmodSync(noOpenCode, 0o755);
  process.env.PATH = [dirname(process.execPath), shims, originalEnv.PATH ?? ""].join(process.platform === "win32" ? ";" : ":");
  const preload = resolve(originalCwd, "test/helpers/deny-network.cjs");
  process.env.NODE_OPTIONS = `${originalEnv.NODE_OPTIONS ?? ""} --require=${preload}`.trim();
  vi.stubGlobal("fetch", forbidden);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
  for (const key of new Set([...Object.keys(process.env), ...Object.keys(originalEnv)])) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});
