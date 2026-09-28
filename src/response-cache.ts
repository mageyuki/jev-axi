import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EntryType } from "@typesafe-ai/sdk";
import type { BackendName, ResolvedBackend } from "./backend.js";
import { ensureDir, paths, resolveCacheTtlHours } from "./config.js";
import type { Answer, QuestionMap, SystemOneEnvelope } from "./evaluation-types.js";
import type { Usage } from "@typesafe-ai/sdk";

export interface CacheScope { backend: BackendName; endpointHash: string; dir: string }
export interface CacheEntry extends SystemOneEnvelope {
  version: 2;
  backend: BackendName;
  endpointHash: string;
  requestedModel: string;
  created: number;
  answers: Record<string, Answer>;
  usage: Usage;
}
export interface CacheStats {
  dir: string; entries: number; fresh: number; stale: number; bytes: number;
  ttlHours: number; aliases: Record<string, string>; legacyEntries: number;
}
const names: BackendName[] = ["typesafe", "opencode-zen", "laya"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const root = () => paths.cacheDir();
const v2 = () => join(root(), "v2");

/** Refuse links at every managed path component, including the cache root. */
function safe(path: string, kind: "file" | "dir"): boolean {
  const base = resolve(root());
  const target = resolve(path);
  const child = relative(base, target);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return false;
  const parts = child ? child.split(sep) : [];
  let current = base;
  try {
    const first = lstatSync(current);
    if (!first.isDirectory() || first.isSymbolicLink()) return false;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !(i === parts.length - 1 && kind === "file" ? stat.isFile() : stat.isDirectory())) return false;
    }
    return true;
  } catch { return false; }
}
function validScope(s: CacheScope): boolean {
  return names.includes(s.backend) && /^[a-f0-9]{64}$/.test(s.endpointHash) && resolve(s.dir) === resolve(join(v2(), s.backend, s.endpointHash));
}
function ensureScope(s: CacheScope): boolean {
  if (!validScope(s)) return false;
  try {
    if (!safe(root(), "dir")) {
      try {
        const parent = lstatSync(resolve(root(), ".."));
        if (!parent.isDirectory() || parent.isSymbolicLink()) return false;
      } catch { /* the managed cache directory has not been created yet */ }
      ensureDir(root());
    }
    for (const p of [root(), v2(), join(v2(), s.backend), s.dir]) {
      if (!safe(p, "dir")) {
        // A missing child may be created only when its parent is an ordinary directory.
        if (!safe(resolve(p, ".."), "dir")) return false;
        mkdirSync(p);
      }
      if (!safe(p, "dir")) return false;
    }
    return true;
  } catch { return false; }
}
function files(dir: string): string[] {
  if (!safe(dir, "dir")) return [];
  try { return readdirSync(dir); } catch { return []; }
}
function parse(file: string): unknown {
  if (!safe(file, "file")) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}
function aliases(scope: CacheScope): Record<string, string> {
  if (!validScope(scope)) return {};
  const raw = parse(join(scope.dir, "aliases.json"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => k !== "__proto__" && typeof v === "string"));
}
function atomic(file: string, data: unknown): void {
  const temp = join(resolve(file, ".."), `.cache-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally { try { rmSync(temp, { force: true }); } catch { /* best effort */ } }
}
export function cacheScope(backend: ResolvedBackend): CacheScope | undefined {
  if (!names.includes(backend.name)) return undefined;
  let url: URL;
  try { url = new URL(backend.endpoint); } catch { return undefined; }
  if (!(["http:", "https:"].includes(url.protocol)) || !url.host || url.username || url.password || url.search || url.hash) return undefined;
  const canonical = url.href;
  const endpointHash = hash(canonical);
  return { backend: backend.name, endpointHash, dir: join(v2(), backend.name, endpointHash) };
}
function requestFile(s: CacheScope, model: string, state: EntryType, questions: QuestionMap): string {
  return join(s.dir, `${hash(JSON.stringify({ model, state, questions }))}.json`);
}
export function cacheEnabled(): boolean {
  return process.env.JEV_AXI_NO_CACHE !== "1" && resolveCacheTtlHours() > 0;
}
export function staleReason(entry: Pick<CacheEntry, "model" | "created">, requested: string, now = Date.now(), ttlHours = resolveCacheTtlHours(), observed: Record<string, string> = {}): string | undefined {
  if (!entry.created || !Number.isFinite(entry.created)) return "no timestamp";
  if (ttlHours <= 0 || now - entry.created > ttlHours * 3_600_000) return "expired";
  const current = observed[requested];
  if (current && current !== entry.model) return `model moved from ${entry.model} to ${current}`;
  return undefined;
}
function entry(value: unknown, s: CacheScope): value is CacheEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<CacheEntry>;
  return v.version === 2 && v.backend === s.backend && v.endpointHash === s.endpointHash &&
    typeof v.requestedModel === "string" && typeof v.model === "string" && typeof v.created === "number" &&
    !!v.answers && typeof v.answers === "object" && !Array.isArray(v.answers) &&
    !!v.usage && typeof v.usage.input_tokens === "number" && typeof v.usage.output_tokens === "number";
}
export function readCached(s: CacheScope, requestedModel: string, state: EntryType, questions: QuestionMap, now = Date.now()): CacheEntry | undefined {
  if (!validScope(s) || !cacheEnabled()) return undefined;
  const v = parse(requestFile(s, requestedModel, state, questions));
  if (!entry(v, s) || v.requestedModel !== requestedModel || staleReason(v, requestedModel, now, resolveCacheTtlHours(), aliases(s))) return undefined;
  return v;
}
export function writeCached(s: CacheScope, requestedModel: string, state: EntryType, questions: QuestionMap, response: SystemOneEnvelope, now = Date.now()): void {
  try {
    if (!cacheEnabled() || !ensureScope(s)) return;
    const data: CacheEntry = { version: 2, backend: s.backend, endpointHash: s.endpointHash, requestedModel, model: response.model, answers: response.answers, usage: response.usage, created: now };
    atomic(requestFile(s, requestedModel, state, questions), data);
  } catch { /* best-effort */ }
}
export function recordAlias(s: CacheScope, requestedModel: string, resolvedModel: string): void {
  try {
    if (!ensureScope(s)) return;
    const previous = aliases(s);
    if (previous[requestedModel] === resolvedModel) return;
    atomic(join(s.dir, "aliases.json"), { ...previous, [requestedModel]: resolvedModel });
  } catch { /* best-effort */ }
}
function scopes(): CacheScope[] {
  const result: CacheScope[] = [];
  for (const name of names) for (const digest of files(join(v2(), name))) {
    if (/^[a-f0-9]{64}$/.test(digest)) {
      const s = { backend: name, endpointHash: digest, dir: join(v2(), name, digest) };
      if (safe(s.dir, "dir")) result.push(s);
    }
  }
  return result;
}
function managedEntries(): Array<{ file: string; scope?: CacheScope }> {
  const result: Array<{ file: string; scope?: CacheScope }> = [];
  for (const f of files(root())) if (f.endsWith(".json") && f !== "aliases.json") result.push({ file: join(root(), f) });
  for (const s of scopes()) for (const f of files(s.dir)) if (/^[a-f0-9]{64}\.json$/.test(f)) result.push({ file: join(s.dir, f), scope: s });
  return result;
}
function fresh(file: string, s: CacheScope, now: number, ttl: number): boolean {
  const v = parse(file);
  return entry(v, s) && !staleReason(v, v.requestedModel, now, ttl, aliases(s));
}
export function cacheStats(now = Date.now()): CacheStats {
  const ttlHours = resolveCacheTtlHours();
  const stats: CacheStats = { dir: root(), entries: 0, fresh: 0, stale: 0, bytes: 0, ttlHours, aliases: {}, legacyEntries: 0 };
  for (const s of scopes()) for (const [requested, resolved] of Object.entries(aliases(s))) stats.aliases[`${s.backend}/${s.endpointHash}/${requested}`] = resolved;
  for (const { file, scope } of managedEntries()) {
    stats.entries++;
    if (!scope) stats.legacyEntries++;
    try { stats.bytes += lstatSync(file).size; } catch { /* disappeared */ }
    if (scope && fresh(file, scope, now, ttlHours)) stats.fresh++;
    else stats.stale++;
  }
  return stats;
}
export function clearCache(onlyStale: boolean, now = Date.now()): number {
  let removed = 0;
  const ttl = resolveCacheTtlHours();
  for (const { file, scope } of managedEntries()) {
    if (onlyStale && scope && fresh(file, scope, now, ttl)) continue;
    // Unlink a managed symlink itself, never recurse into its target.
    if (!safe(resolve(file, ".."), "dir")) continue;
    try { rmSync(file, { force: true }); removed++; } catch { /* best effort */ }
  }
  if (!onlyStale) {
    for (const s of scopes()) {
      const file = join(s.dir, "aliases.json");
      try { rmSync(file, { force: true }); } catch { /* best effort */ }
    }
    if (safe(root(), "dir")) try { rmSync(join(root(), "aliases.json"), { force: true }); } catch { /* best effort */ }
  }
  return removed;
}
