import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBackend, resolveBackendModel, requireBackendCredential, describeBackend } from "../src/backend.js";
import { resolveConsoleCredential, resolveOpenCodeDbPath } from "../src/opencode-credentials.js";

const discovery = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: discovery }));
afterEach(() => { discovery.mockReset(); vi.restoreAllMocks(); });

function dbWith(rows: Array<[string, string]>): string {
  const file = join(mkdtempSync(join(tmpdir(), "jev-store-")), "opencode.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
  const insert = db.prepare("INSERT INTO credential VALUES (?, ?)");
  for (const row of rows) insert.run(...row);
  db.close();
  process.env.JEV_OPENCODE_DB = file;
  return file;
}

describe("backend selection and credential boundary", () => {
  it("explicit Zen ignores local and TypeSafe settings and never serializes its secret", async () => {
    process.env.JEV_BACKEND = "opencode-zen";
    process.env.OPENCODE_API_KEY = "synthetic-console-credential";
    process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:8000";
    process.env.TYPESAFE_DEFAULT_MODEL = "typesafe-only-model";
    const b = await resolveBackend({ model: "jev-latest", apiKey: "synthetic-config-secret" });
    expect(b.endpoint).toBe("https://opencode.ai/zen/v1/systemone");
    expect(b.defaultModel).toBe("jev-1.13-free");
    expect(resolveBackendModel(b)).toBe("jev-1.13-free");
    expect(resolveBackendModel(b, "jev-latest")).toBe("jev-latest");
    expect(describeBackend(b)).toEqual({ backend: "opencode-zen", model: "jev-1.13-free", credential: "ok", source: "env" });
    expect(JSON.stringify(b)).not.toMatch(/synthetic-console-credential|synthetic-config-secret/);
    expect(Object.isFrozen(b)).toBe(true);
  });

  it("rejects invalid backend even with a usable key", async () => {
    process.env.JEV_BACKEND = "other";
    process.env.OPENCODE_API_KEY = "synthetic-key";
    await expect(resolveBackend()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(discovery).not.toHaveBeenCalled();
  });

  it.each(["typesafe", "laya"])("explicit %s never discovers Console", async name => {
    process.env.JEV_BACKEND = name;
    process.env.JEV_OPENCODE_DB = join(tmpdir(), "absent.db");
    const b = await resolveBackend({ apiKey: "synthetic-typesafe" });
    expect(b.name).toBe(name);
    expect(b.credential()).toBe("synthetic-typesafe");
    expect(discovery).not.toHaveBeenCalled();
  });

  it("local selector wins before Console; missing Laya key is local only", async () => {
    delete process.env.JEV_BACKEND;
    process.env.TYPESAFE_BACKEND = "laya";
    process.env.OPENCODE_API_KEY = "synthetic-console";
    const b = await resolveBackend({});
    expect(b.name).toBe("laya");
    expect(b.credentialSource).toBe("local");
    expect(b.hasCredential).toBe(true);
    expect(discovery).not.toHaveBeenCalled();
  });

  it("automatic Zen uses the environment key ahead of the store; absent credential selects TypeSafe", async () => {
    delete process.env.JEV_BACKEND;
    dbWith([["opencode", JSON.stringify({ type: "key", key: "synthetic-store" })]]);
    process.env.OPENCODE_API_KEY = "  synthetic-env  ";
    expect((await resolveBackend()).credential()).toBe("synthetic-env");
    delete process.env.OPENCODE_API_KEY;
    expect((await resolveBackend({})).credential()).toBe("synthetic-store");
    process.env.JEV_OPENCODE_DB = "";
    expect((await resolveBackend({})).name).toBe("typesafe");
    expect(discovery).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "key", key: "  synthetic-first-key  " }, "synthetic-first-key"],
    [{ type: "oauth", key: " ", access: "  synthetic-first-access  " }, "synthetic-first-access"],
  ])("skips unusable rows and takes the first later usable Console record", async (first, expected) => {
    delete process.env.JEV_BACKEND;
    const file = dbWith([
      ["other", JSON.stringify({ type: "key", key: "wrong-integration" })],
      ["opencode", "{"], ["opencode", JSON.stringify({ type: "unknown", key: "wrong-type" })],
      ["opencode", JSON.stringify({ type: "key", key: "  " })],
      ["opencode", JSON.stringify({ type: "oauth", key: "", access: " " })],
      ["opencode", JSON.stringify(first)],
      ["opencode", JSON.stringify({ type: "key", key: "synthetic-later" })],
    ]);
    const before = readFileSync(file);
    const b = await resolveBackend({});
    expect(b.name).toBe("opencode-zen");
    expect(b.credentialSource).toBe("sqlite");
    expect(b.credential()).toBe(expected);
    expect(readFileSync(file)).toEqual(before);
  });

  it("all unusable records and missing stores stay unresolved without creation", async () => {
    const file = dbWith([["opencode", "not json"], ["other", JSON.stringify({ type: "key", key: "other" })]]);
    expect(await resolveConsoleCredential()).toEqual({ source: "missing" });
    process.env.JEV_OPENCODE_DB = join(file, "nonexistent.db");
    expect(await resolveConsoleCredential()).toEqual({ source: "missing" });
    expect(existsSync(process.env.JEV_OPENCODE_DB)).toBe(false);
    expect(discovery).not.toHaveBeenCalled();
  });

  it("explicit empty store path disables discovery; XDG fallback follows invalid discovery", async () => {
    process.env.JEV_OPENCODE_DB = "";
    expect(await resolveOpenCodeDbPath()).toBeUndefined();
    delete process.env.JEV_OPENCODE_DB;
    discovery.mockImplementation((_cmd, _args, _opts, cb) => cb(Error("failed"), "canary stdout", "canary stderr"));
    expect(await resolveOpenCodeDbPath()).toBe(join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
    expect(discovery).toHaveBeenCalledWith("opencode", ["debug", "paths", "db"], expect.objectContaining({ timeout: 5000 }), expect.any(Function));
  });

  it.each(["success", "invalid", "failure", "timeout"])("never exposes discovery streams on %s", async mode => {
    delete process.env.JEV_OPENCODE_DB;
    const good = join(process.env.XDG_DATA_HOME!, "chosen.db");
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { writes.push(String(chunk)); return true; });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { writes.push(String(chunk)); return true; });
    discovery.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = mode === "failure" || mode === "timeout" ? Object.assign(new Error("canary exception"), { stdout: "canary stdout", stderr: "canary stderr" }) : null;
      cb(err, mode === "success" ? `${good}\n` : "canary stdout\nother", "canary stderr");
    });
    let path: string | undefined;
    try { path = await resolveOpenCodeDbPath(); }
    finally { stdout.mockRestore(); stderr.mockRestore(); }
    expect(path).toBe(mode === "success" ? good : join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
    expect(writes.join("")).not.toContain("canary");
    expect(JSON.stringify({ path })).not.toContain("canary");
  });

  it.each(["typesafe", "laya"])("normalizes a terminal /v1 for %s", async name => {
    process.env.JEV_BACKEND = name;
    for (const suffix of ["/v1", "/v1/"]) {
      process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:8000${suffix}`;
      const b = await resolveBackend({});
      expect(b.sdkBaseURL).toBe("http://127.0.0.1:8000");
      expect(b.endpoint).toBe("http://127.0.0.1:8000/v1/systemone");
    }
    process.env.TYPESAFE_BASE_URL = "not-an-absolute-url";
    await expect(resolveBackend({})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(discovery).not.toHaveBeenCalled();
  });

  it("preserves backend model precedence and snapshots the environment", async () => {
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_DEFAULT_MODEL = "typesafe-model";
    const b = await resolveBackend({ model: "config-model" });
    expect(resolveBackendModel(b)).toBe("typesafe-model");
    process.env.JEV_MODEL = "  custom-model  ";
    expect(resolveBackendModel(b)).toBe("typesafe-model");
    const newer = await resolveBackend({ model: "config-model" });
    expect(resolveBackendModel(newer)).toBe("custom-model");
    expect(resolveBackendModel(newer, "flag-model")).toBe("flag-model");
    process.env.JEV_BACKEND = "opencode-zen";
    process.env.OPENCODE_API_KEY = "synthetic";
    process.env.JEV_MODEL = "   ";
    expect(resolveBackendModel(await resolveBackend({ model: "config-model" }))).toBe("jev-1.13-free");
  });

  it("Laya keeps an explicit jev-latest preference but defaults to laya-421m", async () => {
    process.env.JEV_BACKEND = "laya";
    process.env.TYPESAFE_DEFAULT_MODEL = "jev-latest";
    expect(resolveBackendModel(await resolveBackend({}))).toBe("jev-latest");
    delete process.env.TYPESAFE_DEFAULT_MODEL;
    expect(resolveBackendModel(await resolveBackend({ model: "jev-latest" }))).toBe("jev-latest");
    expect(resolveBackendModel(await resolveBackend({}))).toBe("laya-421m");
  });

  it("missing Zen key gives Console guidance, not TypeSafe guidance", async () => {
    process.env.JEV_BACKEND = "opencode-zen";
    process.env.JEV_OPENCODE_DB = "";
    const b = await resolveBackend({});
    expect(b.hasCredential).toBe(false);
    try { requireBackendCredential(b); throw Error("expected auth error"); }
    catch (error) {
      expect(error).toMatchObject({ code: "AUTH_REQUIRED" });
      expect(String(error)).toMatch(/Console.*OPENCODE_API_KEY/);
      expect(String(error)).not.toContain("TYPESAFE_API_KEY");
    }
  });

  it("older runtime skips store discovery but environment-key Zen and SDK remain usable", async () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    Object.defineProperty(process.versions, "node", { configurable: true, value: "22.12.0" });
    try {
      process.env.JEV_BACKEND = "opencode-zen";
      delete process.env.OPENCODE_API_KEY;
      expect((await resolveBackend({})).credentialSource).toBe("missing");
      expect(discovery).not.toHaveBeenCalled();
      process.env.OPENCODE_API_KEY = "synthetic-older-runtime";
      expect((await resolveBackend({})).credential()).toBe("synthetic-older-runtime");
      process.env.JEV_BACKEND = "typesafe";
      expect((await resolveBackend({ apiKey: "synthetic-sdk" })).credential()).toBe("synthetic-sdk");
    } finally { Object.defineProperty(process.versions, "node", original); }
  });

  it("unavailable SQLite is a safe miss without breaking environment-key Zen or SDK", async () => {
    process.env.JEV_OPENCODE_DB = join(tmpdir(), "synthetic-absent-store.db");
    vi.doMock("node:sqlite", () => { throw Error("synthetic sqlite unavailable diagnostic"); });
    try {
      process.env.JEV_BACKEND = "opencode-zen";
      const b = await resolveBackend({});
      expect(b.credentialSource).toBe("missing");
      expect(() => requireBackendCredential(b)).toThrow(/Console/);
      process.env.OPENCODE_API_KEY = "synthetic-env-only";
      expect((await resolveBackend({})).credential()).toBe("synthetic-env-only");
      process.env.JEV_BACKEND = "typesafe";
      expect((await resolveBackend({ apiKey: "synthetic-sdk" })).credential()).toBe("synthetic-sdk");
    } finally { vi.doUnmock("node:sqlite"); }
  });
});
