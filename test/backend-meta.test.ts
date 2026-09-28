import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";

describe("backend metadata without network", () => {
  const run = async (args: string[], env: Record<string, string> = {}, nodeArgs: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-meta-"));
    mkdirSync(join(dir, ".git"));
    return runCli(args, { cwd: dir, nodeArgs, env: {
      JEV_BACKEND: "opencode-zen", OPENCODE_API_KEY: "synthetic-zen-secret-9876",
      TYPESAFE_API_KEY: "", JEV_OPENCODE_DB: "", NO_UPDATE_NOTIFIER: "1",
      XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state"), ...env,
    } });
  };

  it("preflights an environment credential before ordinary CLI handling without importing SQLite", async () => {
    expect(await run(["--check-backend"], {}, ["--no-experimental-sqlite"])).toEqual({ stdout: "opencode-zen\n", stderr: "", code: 0 });
  });

  it("keeps stderr empty when the preflight credential comes from a synthetic SQLite store", async ctx => {
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); }
    catch { ctx.skip(); return; }
    const file = join(mkdtempSync(join(tmpdir(), "jev-preflight-store-")), "opencode.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
    db.prepare("INSERT INTO credential VALUES (?, ?)").run("opencode", JSON.stringify({ type: "key", key: "synthetic-store-key" }));
    db.close();
    expect(await run(["--check-backend"], { OPENCODE_API_KEY: "", JEV_OPENCODE_DB: file })).toEqual({
      stdout: "opencode-zen\n", stderr: "", code: 0,
    });
  });

  it("prints only the fixed failure line when a synthetic SQLite store is absent", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "jev-preflight-miss-")), "absent.db");
    expect(await run(["--check-backend"], { OPENCODE_API_KEY: "", JEV_OPENCODE_DB: file })).toEqual({
      stdout: "",
      stderr: "Backend credential unavailable; configure OpenCode Console / OPENCODE_API_KEY or the selected backend credential; use a compatible runtime for Console store discovery.\n",
      code: 1,
    });
  });

  it("fails missing Zen credentials without fallback or secret output", async () => {
    const result = await run(["--check-backend"], { OPENCODE_API_KEY: "" });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OPENCODE_API_KEY");
    expect(result.stderr).not.toContain("TYPESAFE_API_KEY");
  });

  it.each([["check", "q"], ["--json"], ["--full"]])("rejects preflight combined with %s", async (...extra) => {
    const result = await run(["--check-backend", ...extra]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("lists the documented Zen models without a credential", async () => {
    const result = await run(["models", "--json"], { OPENCODE_API_KEY: "" });
    expect(result.code).toBe(0);
    const models = JSON.parse(result.stdout) as { name: string; release_date: string; description: string }[];
    expect(models.map(({ name, release_date }) => ({ name, release_date }))).toEqual([
      { name: "jev-1.13-free", release_date: "" }, { name: "jev-1.13", release_date: "" },
    ]);
    expect(models.every((model) => model.description.includes("opencode.ai/docs/zen"))).toBe(true);
  });

  it("reports resolved backend/model and never shows credential fragments in status or config", async () => {
    for (const args of [[], ["config"]]) {
      const result = await run(args, { JEV_MODEL: "jev-1.13" });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("opencode-zen");
      expect(result.stdout).toContain("jev-1.13");
      expect(result.stdout).not.toContain("synthetic-zen");
      expect(result.stdout).not.toContain("9876");
    }
  });

  it("cache metadata and clear do not need a credential or discover the store", async () => {
    for (const args of [["cache"], ["cache", "clear"]]) {
      const result = await run(args, { OPENCODE_API_KEY: "", PATH: "/nonexistent" });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }
  });
});
