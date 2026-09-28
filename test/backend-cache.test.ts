import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { paths, writeConfig } from "../src/config.js";
import type { ResolvedBackend, BackendName } from "../src/backend.js";
import { cacheScope, readCached, writeCached, recordAlias, cacheStats, clearCache, cacheEnabled, staleReason } from "../src/response-cache.js";

const state = "context";
const questions = { q: { type: "noul" as const, instructions: "Is this relevant?" } };
const response = { model: "version-a", answers: { q: { type: "noul" as const, noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 1 } };
const now = Date.parse("2026-09-17T12:00:00Z");
function backend(name: BackendName, endpoint: string): ResolvedBackend {
  return { name, endpoint, defaultModel: "free", credentialSource: "env", hasCredential: true, credential: () => "synthetic-secret" };
}
function scope(name: BackendName, endpoint: string) {
  const result = cacheScope(backend(name, endpoint));
  if (!result) throw Error("scope missing");
  return result;
}
function requestPath(s: ReturnType<typeof scope>): string {
  return join(s.dir, readdirSync(s.dir).find(f => f !== "aliases.json")!);
}

describe("backend response cache", () => {
  it("isolates backend and endpoint namespaces, requested models, and reuses same-scope requests", () => {
    const scopes = [scope("typesafe", "https://api.typesafe.ai/v1/systemone"), scope("opencode-zen", "https://opencode.ai/zen/v1/systemone"), scope("laya", "http://localhost:8000/v1/systemone"), scope("laya", "http://localhost:8001/v1/systemone")];
    for (const s of scopes) writeCached(s, "free", state, questions, response, now);
    expect(new Set(scopes.map(s => s.dir)).size).toBe(4);
    expect(scopes[0]!.endpointHash).toBe(createHash("sha256").update("https://api.typesafe.ai/v1/systemone").digest("hex"));
    for (const s of scopes) expect(readCached(s, "free", state, questions, now)?.model).toBe("version-a");
    expect(readCached(scopes[0]!, "paid", state, questions, now)).toBeUndefined();
    writeCached(scopes[0]!, "paid", state, questions, response, now);
    expect(readCached(scopes[0]!, "paid", state, questions, now)?.requestedModel).toBe("paid");
    expect(readdirSync(scopes[0]!.dir).filter(f => f !== "aliases.json")).toHaveLength(2);
    expect(readCached(scopes[0]!, "free", "different", questions, now)).toBeUndefined();
    expect(readCached(scopes[0]!, "free", state, { other: questions.q }, now)).toBeUndefined();
    expect(readFileSync(requestPath(scopes[1]!), "utf8")).not.toContain("synthetic-secret");
  });

  it("invalidates an observed alias move only in its namespace", () => {
    const a = scope("typesafe", "https://api.typesafe.ai/v1/systemone");
    const b = scope("opencode-zen", "https://opencode.ai/zen/v1/systemone");
    for (const s of [a, b]) { writeCached(s, "latest", state, questions, response, now); recordAlias(s, "latest", "version-a"); }
    recordAlias(a, "latest", "version-b");
    expect(readCached(a, "latest", state, questions, now)).toBeUndefined();
    expect(readCached(b, "latest", state, questions, now)?.model).toBe("version-a");
    expect(cacheStats(now).aliases).toMatchObject({ [`typesafe/${a.endpointHash}/latest`]: "version-b", [`opencode-zen/${b.endpointHash}/latest`]: "version-a" });
    expect(readFileSync(join(a.dir, "aliases.json"), "utf8")).not.toContain("synthetic-secret");
  });

  it("rejects expiry, missing timestamps, TTL zero and environment disable", () => {
    const s = scope("typesafe", "https://api.typesafe.ai/v1/systemone");
    writeCached(s, "free", state, questions, response, now);
    expect(readCached(s, "free", state, questions, now + 25 * 3_600_000)).toBeUndefined();
    const file = requestPath(s);
    const entry = JSON.parse(readFileSync(file, "utf8"));
    delete entry.created;
    writeFileSync(file, JSON.stringify(entry));
    expect(readCached(s, "free", state, questions, now)).toBeUndefined();
    expect(staleReason(entry, "free", now, 24, {})).toBe("no timestamp");
    writeCached(s, "free", state, questions, response, now);
    writeConfig({ cacheTtlHours: 0 });
    expect(cacheEnabled()).toBe(false);
    expect(readCached(s, "free", state, questions, now)).toBeUndefined();
    writeConfig({});
    process.env.JEV_AXI_NO_CACHE = "1";
    try { expect(cacheEnabled()).toBe(false); expect(readCached(s, "free", state, questions, now)).toBeUndefined(); }
    finally { delete process.env.JEV_AXI_NO_CACHE; }
  });

  it("counts legacy, rejects corrupt and wrong-namespace entries, and clears stale without touching fresh neighbors", () => {
    const a = scope("typesafe", "https://api.typesafe.ai/v1/systemone");
    const b = scope("laya", "http://localhost:8000/v1/systemone");
    writeCached(a, "free", state, questions, response, now - 25 * 3_600_000);
    writeCached(b, "free", state, questions, response, now);
    const legacy = join(paths.cacheDir(), "legacy.json");
    writeFileSync(legacy, JSON.stringify(response));
    expect(cacheStats(now).legacyEntries).toBe(1);
    expect(readCached(b, "free", state, questions, now)?.model).toBe("version-a");
    expect(clearCache(true, now)).toBeGreaterThanOrEqual(1);
    expect(readCached(b, "free", state, questions, now)).toBeDefined();
    expect(readCached(a, "free", state, questions, now)).toBeUndefined();
    writeCached(a, "free", state, questions, response, now);
    const file = requestPath(a);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), backend: "laya" }));
    expect(readCached(a, "free", state, questions, now)).toBeUndefined();
    writeFileSync(file, "{broken");
    expect(readCached(a, "free", state, questions, now)).toBeUndefined();
    clearCache(false, now);
    expect(readCached(b, "free", state, questions, now)).toBeUndefined();
    expect(existsSync(join(b.dir, "aliases.json"))).toBe(false);
  });

  it("treats a symlinked valid cache entry as a miss without reading its target", () => {
    const s = scope("typesafe", "https://api.typesafe.ai/v1/systemone");
    writeCached(s, "free", state, questions, response, now);
    expect(readCached(s, "free", state, questions, now)).toBeDefined();
    const file = requestPath(s);
    const outside = join(mkdtempSync(join(tmpdir(), "cache-outside-")), "valid.json");
    renameSync(file, outside);
    const bytes = readFileSync(outside);
    symlinkSync(outside, file);
    expect(readCached(s, "free", state, questions, now)).toBeUndefined();
    expect(readFileSync(outside)).toEqual(bytes);
    clearCache(true, now);
    expect(readFileSync(outside)).toEqual(bytes);
    expect(existsSync(file)).toBe(false);
  });

  it("treats a managed entry symlink as a miss even when its target has no cache bytes", () => {
    const s = scope("typesafe", "https://api.typesafe.ai/v1/systemone");
    writeCached(s, "free", state, questions, response, now);
    const file = requestPath(s);
    const absent = join(mkdtempSync(join(tmpdir(), "cache-outside-")), "absent.json");
    unlinkSync(file);
    symlinkSync(absent, file);
    expect(readCached(s, "free", state, questions, now)).toBeUndefined();
  });

  it("full cleanup unlinks managed links but leaves outside targets and linked directories unchanged", () => {
    const s = scope("laya", "http://localhost:8000/v1/systemone");
    writeCached(s, "free", state, questions, response, now);
    const file = requestPath(s);
    const outsideDir = mkdtempSync(join(tmpdir(), "cache-outside-"));
    const outside = join(outsideDir, "valid.json");
    renameSync(file, outside);
    const bytes = readFileSync(outside);
    symlinkSync(outside, file);
    const linked = join(paths.cacheDir(), "v2", "opencode-zen");
    symlinkSync(outsideDir, linked, process.platform === "win32" ? "junction" : "dir");
    recordAlias(s, "free", response.model);
    expect(cacheStats(now).stale).toBeGreaterThanOrEqual(1);
    clearCache(false, now);
    expect(readFileSync(outside)).toEqual(bytes);
    expect(existsSync(join(outsideDir, "valid.json"))).toBe(true);
    expect(existsSync(join(s.dir, "aliases.json"))).toBe(false);
  });

  it("bypasses unsafe endpoints and never persists credentials", () => {
    for (const endpoint of ["https://user:pass@host/v1/systemone", "https://host/v1/systemone?token=secret", "https://host/v1/systemone#secret"]) {
      expect(cacheScope(backend("laya", endpoint))).toBeUndefined();
    }
    const s = scope("typesafe", "https://api.typesafe.ai/v1/systemone");
    writeCached(s, "free", state, questions, response, now);
    recordAlias(s, "free", response.model);
    expect(readdirSync(s.dir).map(f => readFileSync(join(s.dir, f), "utf8")).join(" ")).not.toContain("synthetic-secret");
  });

  it("treats an unwritable namespace as a best-effort cache miss", () => {
    const s = scope("typesafe", "https://api.typesafe.ai/v1/systemone");
    mkdirSync(join(paths.cacheDir(), "v2"), { recursive: true });
    writeFileSync(join(paths.cacheDir(), "v2", "typesafe"), "not a directory");
    expect(() => writeCached(s, "free", state, questions, response, now)).not.toThrow();
    expect(() => recordAlias(s, "free", response.model)).not.toThrow();
    expect(readCached(s, "free", state, questions, now)).toBeUndefined();
  });
});
