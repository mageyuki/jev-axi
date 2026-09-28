import { AxiError, validation } from "./errors.js";
import { readConfig, resolveApiKey, resolveModel, type JevConfig } from "./config.js";
import { resolveConsoleCredential } from "./opencode-credentials.js";

export type BackendName = "opencode-zen" | "typesafe" | "laya";
export type CredentialSource = "env" | "sqlite" | ".env" | "config" | "local" | "missing";
export interface ResolvedBackend {
  readonly name: BackendName;
  readonly endpoint: string;
  readonly sdkBaseURL?: string;
  readonly defaultModel: string;
  readonly credentialSource: CredentialSource;
  readonly hasCredential: boolean;
  credential(): string | undefined;
}

const ZEN_ENDPOINT = "https://opencode.ai/zen/v1/systemone";
const LOCAL_BASE = "http://127.0.0.1:8000";
const TYPESAFE_BASE = "https://api.typesafe.ai";
const LOCAL_CREDENTIAL = "local";

function nonempty(value: string | undefined): string | undefined { return value?.trim() || undefined; }

function sdkBaseURL(input: string): string {
  let url: URL;
  try { url = new URL(input); }
  catch { throw validation("Invalid TypeSafe endpoint URL"); }
  if (!/^https?:$/.test(url.protocol) || !url.host || url.search || url.hash || url.username || url.password) {
    throw validation("Invalid TypeSafe endpoint URL");
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${pathname}`;
}

export async function resolveBackend(config: JevConfig = readConfig()): Promise<ResolvedBackend> {
  const selected = nonempty(process.env.JEV_BACKEND);
  if (selected && !["opencode-zen", "typesafe", "laya"].includes(selected)) throw validation("Invalid JEV_BACKEND");
  const local = nonempty(process.env.TYPESAFE_BASE_URL) || process.env.TYPESAFE_BACKEND === "laya";
  let name: BackendName;
  let consoleKey: Awaited<ReturnType<typeof resolveConsoleCredential>> | undefined;
  if (selected) name = selected as BackendName;
  else if (local) name = "laya";
  else {
    consoleKey = await resolveConsoleCredential();
    name = consoleKey.key ? "opencode-zen" : "typesafe";
  }

  const environmentModel = nonempty(process.env.JEV_MODEL);
  const defaultModel = name === "opencode-zen" ? "jev-1.13-free"
    : name === "laya" && process.env.TYPESAFE_DEFAULT_MODEL === undefined && config.model === undefined ? "laya-421m"
    : resolveModel(undefined, config);
  let key: string | undefined;
  let source: CredentialSource;
  let endpoint: string;
  let base: string | undefined;
  if (name === "opencode-zen") {
    consoleKey ??= await resolveConsoleCredential();
    key = consoleKey.key;
    source = consoleKey.source;
    endpoint = ZEN_ENDPOINT;
  } else {
    const resolved = resolveApiKey(config);
    key = resolved.key;
    source = resolved.source;
    if (name === "laya" && !key) { key = LOCAL_CREDENTIAL; source = "local"; }
    base = sdkBaseURL(nonempty(process.env.TYPESAFE_BASE_URL) ?? (name === "laya" ? LOCAL_BASE : TYPESAFE_BASE));
    endpoint = `${base}/v1/systemone`;
  }
  const descriptor: ResolvedBackend = {
    name, endpoint, ...(base ? { sdkBaseURL: base } : {}), defaultModel,
    credentialSource: source, hasCredential: !!key,
    credential: () => key,
  };
  // Snapshot model overrides at resolution time without putting a secret on the descriptor.
  const model = environmentModel;
  modelSnapshots.set(descriptor, model);
  return Object.freeze(descriptor);
}

const modelSnapshots = new WeakMap<ResolvedBackend, string | undefined>();
export function resolveBackendModel(backend: ResolvedBackend, override?: string): string {
  return override ?? modelSnapshots.get(backend) ?? backend.defaultModel;
}

export function requireBackendCredential(backend: ResolvedBackend): string {
  const key = backend.credential();
  if (key) return key;
  if (backend.name === "opencode-zen") throw new AxiError("OpenCode Console credential required: set OPENCODE_API_KEY or use a compatible Node 22.13+ runtime for Console store discovery", "AUTH_REQUIRED");
  throw new AxiError("TYPESAFE_API_KEY is not set; configure a TypeSafe environment, dotenv, or config key", "AUTH_REQUIRED");
}

export function describeBackend(backend: ResolvedBackend, override?: string): { backend: BackendName; model: string; credential: "ok" | "missing"; source: CredentialSource } {
  return { backend: backend.name, model: resolveBackendModel(backend, override), credential: backend.hasCredential ? "ok" : "missing", source: backend.credentialSource };
}
