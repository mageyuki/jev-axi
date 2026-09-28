import { AsyncLocalStorage } from "node:async_hooks";
import {
  APIConnectionError, APIError, AuthenticationError, RateLimitError,
  TypeSafeClient, UnprocessableEntityError, type EntryType, type Fetch,
} from "@typesafe-ai/sdk";
import { AxiError } from "./errors.js";
import { readConfig, resolveThresholds } from "./config.js";
import { resolveBackend, resolveBackendModel, requireBackendCredential, type ResolvedBackend } from "./backend.js";
import { evaluateZen } from "./zen.js";
import { cacheScope, readCached, recordAlias, writeCached } from "./response-cache.js";
import { projectName, recordUsage, type BandCounts } from "./usage.js";
import { bandForConfidence, bandForNoul } from "./bands.js";
import type { Answer, EvalResult, QuestionMap, SystemOneEnvelope } from "./evaluation-types.js";

export type { QuestionMap, ChoiceAnswer, ScoreAnswer, NoulAnswer, Answer, EvalResult } from "./evaluation-types.js";
export { cacheEnabled, cacheStats, clearCache, staleReason } from "./response-cache.js";

export interface EvalOptions {
  command: string;
  model?: string;
  cache?: boolean;
  fetch?: Fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

let fetchOverride: Fetch | undefined;
/** Test hook: route all API traffic through a custom fetch. */
export function configureFetch(fetch: Fetch | undefined): void { fetchOverride = fetch; }

const context = new AsyncLocalStorage<{ backend?: Promise<ResolvedBackend> }>();
/** Backend resolution is lazy, shared by every evaluation within one command. */
export function withEvaluationContext<T>(run: () => Promise<T>): Promise<T> {
  return context.run({}, run);
}
export function getEvaluationBackend(): Promise<ResolvedBackend> {
  const store = context.getStore();
  if (!store) return resolveBackend();
  return store.backend ??= resolveBackend();
}

/** Band counts across a response's answers, using the configured thresholds. */
export function countBands(answers: Record<string, Answer>): BandCounts {
  const t = resolveThresholds({});
  const b: BandCounts = { act: 0, confirm: 0, escalate: 0 };
  for (const a of Object.values(answers)) {
    const band = a.type === "noul" ? bandForNoul(a.noul, t) : bandForConfidence(a.confidence, t);
    b[band]++;
  }
  return b;
}

/** Evaluate one state, using the selected backend's wire model and isolated cache. */
export async function evaluate(state: EntryType, questions: QuestionMap, opts: EvalOptions): Promise<EvalResult> {
  const backend = await getEvaluationBackend();
  const requestedModel = resolveBackendModel(backend, opts.model);
  const scope = cacheScope(backend);
  const useCache = (opts.cache ?? true) && !!scope;
  // Unlike TypeSafe, Zen requires an active Console credential even for a cache hit.
  if (backend.name === "opencode-zen") requireBackendCredential(backend);
  const hit = useCache ? readCached(scope!, requestedModel, state, questions) : undefined;
  const qCount = Object.keys(questions).length;
  if (hit) {
    recordUsage({ ts: new Date().toISOString(), cmd: opts.command, model: hit.model, backend: backend.name, requestedModel,
      in: hit.usage.input_tokens, out: hit.usage.output_tokens, ms: 0, q: qCount, cached: true,
      project: projectName(), bands: countBands(hit.answers) });
    return { model: hit.model, answers: hit.answers, usage: hit.usage, ms: 0, cached: true, backend: backend.name, requestedModel };
  }

  const started = performance.now();
  let raw: SystemOneEnvelope;
  if (backend.name === "opencode-zen") {
    raw = await evaluateZen(backend, { state, questions, model: requestedModel },
      { fetch: opts.fetch ?? fetchOverride, timeoutMs: opts.timeoutMs, maxRetries: opts.maxRetries });
  } else {
    try {
      const key = requireBackendCredential(backend);
      const f = opts.fetch ?? fetchOverride;
      const client = new TypeSafeClient({ apiKey: key, ...(backend.sdkBaseURL ? { baseURL: backend.sdkBaseURL } : {}),
        timeout: 60_000, logLevel: "error", ...(f ? { fetch: f } : {}) });
      const response = await client.systemOne({ state, questions, model: requestedModel }, {
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        ...(opts.maxRetries !== undefined ? { retry: { maxRetries: opts.maxRetries } } : {}),
      });
      raw = { model: response.model, answers: response.answers as Record<string, Answer>, usage: response.usage };
    } catch (error) { throw translateError(error, backend); }
  }
  const ms = Math.round(performance.now() - started);
  const result: EvalResult = { ...raw, ms, cached: false, backend: backend.name, requestedModel };
  if (scope) recordAlias(scope, requestedModel, raw.model);
  recordUsage({ ts: new Date().toISOString(), cmd: opts.command, model: raw.model, backend: backend.name, requestedModel,
    in: raw.usage.input_tokens, out: raw.usage.output_tokens, ms, q: qCount, cached: false,
    project: projectName(), bands: countBands(raw.answers) });
  if (useCache) writeCached(scope!, requestedModel, state, questions, raw);
  return result;
}

function translateError(error: unknown, backend: ResolvedBackend): AxiError {
  if (error instanceof AxiError) return error;
  const label = backend.name === "laya" ? "Laya" : "TypeSafe";
  if (error instanceof AuthenticationError) return new AxiError(`${label} API key was rejected (401)`, "AUTH_REQUIRED", [
    "Continue the task without jev-axi, and tell the user in your final answer that its API key was rejected",
    "The user can set a valid key with `export TYPESAFE_API_KEY=<key>` or `jev-axi config set apiKey <key>`",
  ]);
  if (error instanceof RateLimitError) return new AxiError(`Rate limited by the ${label} API after retries (429)`, "RATE_LIMITED", [
    "Wait a few seconds and rerun; batch more questions per call to reduce request count",
  ]);
  if (error instanceof UnprocessableEntityError) return new AxiError(`Request rejected by the ${label} API (422)`, "VALIDATION_ERROR", [
    "Check question shapes: choice needs `criteria` map, score needs >= 2 levels, noul needs `instructions`",
  ]);
  if (error instanceof APIError && error.status === 400 && detail(error.body).includes("max_tokens_exceeded")) {
    return new AxiError("Request exceeds the model's token limit (~32k tokens for state plus questions)", "VALIDATION_ERROR", [
      "Send less state: lower --preview, --tail, or the number of items; batch commands chunk automatically but a single item can still be too large",
    ]);
  }
  if (error instanceof APIError) {
    // TypeSafe's HTML 403 is an edge/firewall intercept; Zen's own HTML 403 is a rejection.
    if (backend.name === "typesafe" && error.status === 403 && isHtmlBody(error.body)) return new AxiError(
      "An edge in front of api.typesafe.ai answered the request with an HTML 403, so it never reached the model", "NETWORK", [
        "Usually a firewall or proxy, not the key or the request; retry",
        "If it persists check network access to api.typesafe.ai and https://status.typesafe.ai",
      ]);
    const code = error.status === 529 ? "OVERLOADED" : error.status === 403 ? "API_REJECTED" : "API_ERROR";
    return new AxiError(`${label} API error (${error.status})`, code, [
      error.status === 529 ? `${label} is overloaded; retry shortly` : `Retry; if it persists check ${backend.endpoint}`,
    ]);
  }
  if (error instanceof APIConnectionError) return new AxiError(`Could not reach the ${label} API`, "NETWORK", [
    `Check network access to ${backend.endpoint} and retry`,
  ]);
  return new AxiError(`Could not complete the ${label} API request`, "UNKNOWN");
}

function detail(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body.slice(0, 300);
  try { const b = body as Record<string, unknown>; return String(b["detail"] ?? b["error"] ?? b["message"] ?? "").slice(0, 300); }
  catch { return ""; }
}
function isHtmlBody(body: unknown): boolean {
  return typeof body === "string" && /^\s*(<!doctype html|<html)/i.test(body.slice(0, 2048));
}

export async function listModels(fetch?: Fetch): Promise<{ name: string; description: string; release_date: string }[]> {
  const backend = await getEvaluationBackend();
  if (backend.name === "opencode-zen") throw new AxiError("Zen model listing is not available", "API_ERROR");
  try {
    const key = requireBackendCredential(backend);
    const client = new TypeSafeClient({ apiKey: key, ...(backend.sdkBaseURL ? { baseURL: backend.sdkBaseURL } : {}),
      timeout: 60_000, logLevel: "error", ...(fetch ?? fetchOverride ? { fetch: fetch ?? fetchOverride } : {}) });
    return await client.models.list();
  } catch (error) { throw translateError(error, backend); }
}

export { readConfig };
