import type { EntryType, Fetch } from "@typesafe-ai/sdk";
import { requireBackendCredential, type ResolvedBackend } from "./backend.js";
import { AxiError, validation } from "./errors.js";
import type { QuestionMap, SystemOneEnvelope } from "./evaluation-types.js";

const URL = "https://opencode.ai/zen/v1/systemone";
const MAX_RESPONSE_BYTES = 1_048_576;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const invalid = (): never => { throw new AxiError("Invalid Zen response envelope", "API_ERROR"); };
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
};

export function validateZenQuestions(questions: QuestionMap): void {
  if (!object(questions) || Object.keys(questions).length === 0) throw validation("Invalid Zen questions");
  for (const question of Object.values(questions)) {
    if (!object(question)) throw validation("Invalid Zen question");
    if (!(typeof question.instructions === "string" && question.instructions.length > 0) &&
        !(question.instructions !== null && typeof question.instructions === "object")) throw validation("Invalid Zen instructions");
    if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2) throw validation("Zen score criteria must be an array of at least two levels");
    } else if (question.type === "choice") {
      if (!object(question.criteria) || Object.keys(question.criteria).length === 0) throw validation("Invalid Zen choice criteria");
    } else if (question.type !== "noul") throw validation("Invalid Zen question type");
  }
}

export function assertNoCredentialEcho(value: unknown, credential: string): void {
  if (credential.length < 16) return;
  const seen = new WeakSet<object>();
  const scan = (item: unknown): void => {
    if (typeof item === "string") {
      if (item.includes(credential)) invalid();
    } else if (item !== null && typeof item === "object") {
      if (seen.has(item)) invalid();
      seen.add(item);
      if (Array.isArray(item)) {
        for (const entry of item) scan(entry);
      } else {
        for (const [key, entry] of Object.entries(item)) {
          if (key.includes(credential)) invalid();
          scan(entry);
        }
      }
    }
  };
  try {
    scan(value);
  } catch {
    invalid();
  }
}

export function validateZenResponse(raw: unknown, questions: QuestionMap, credential: string): SystemOneEnvelope {
  assertNoCredentialEcho(raw, credential);
  if (!object(raw)) return invalid();
  if (typeof raw.model !== "string" || !raw.model.trim() ||
      !object(raw.answers) || !object(raw.usage) ||
      !Number.isSafeInteger(raw.usage.input_tokens) || (raw.usage.input_tokens as number) < 0 ||
      !Number.isSafeInteger(raw.usage.output_tokens) || (raw.usage.output_tokens as number) < 0 ||
      !exactKeys(raw.answers, Object.keys(questions))) return invalid();
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw.answers[id];
    if (!object(answer) || answer.type !== question.type) return invalid();
    if (question.type === "noul") {
      if (!probability(answer.noul)) invalid();
    } else if (question.type === "choice") {
      const labels = Object.keys(question.criteria);
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice) ||
          !probability(answer.confidence) || !object(answer.probabilities) ||
          !exactKeys(answer.probabilities, labels) || !labels.every(label => probability((answer.probabilities as Record<string, unknown>)[label]))) invalid();
    } else {
      const levels = question.criteria.map((_, i) => String(i));
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels.length - 1 ||
          !probability(answer.confidence) || !object(answer.legend) || !exactKeys(answer.legend, levels) ||
          !object(answer.probabilities) || !exactKeys(answer.probabilities, levels) ||
          !levels.every(level => probability((answer.probabilities as Record<string, unknown>)[level]) &&
            (answer.legend as Record<string, unknown>)[level] !== undefined)) invalid();
    }
  }
  return raw as unknown as SystemOneEnvelope;
}

function statusError(status: number): AxiError {
  if (status === 401) return new AxiError("OpenCode Console credential rejected (401): set OPENCODE_API_KEY or connect Console", "AUTH_REQUIRED");
  if (status === 403) return new AxiError("Zen API rejected the request (403)", "API_REJECTED");
  if (status === 400 || status === 422) return new AxiError(`Zen API rejected the request (${status})`, "VALIDATION_ERROR");
  if (status === 429) return new AxiError("Zen API rate limited after retries (429)", "RATE_LIMITED");
  if (status === 529) return new AxiError("Zen API overloaded after retries (529)", "OVERLOADED");
  return new AxiError(`Zen API error (${status})`, "API_ERROR");
}

function retryDelay(attempt: number, headers?: Headers): number {
  if (headers) {
    const msHeader = headers.get("retry-after-ms");
    const ms = msHeader === null ? NaN : Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0 && ms <= 60_000) return ms;
    const raw = headers.get("retry-after");
    if (raw !== null) {
      const seconds = Number(raw);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
      if (Number.isFinite(delay) && delay >= 0 && delay <= 60_000) return delay;
    }
  }
  return Math.round(Math.min(500 * 2 ** attempt, 5000) * (1 - Math.random() * 0.25));
}

async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    rejectAbort(new Error("aborted"));
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const next = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw new Error("aborted");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new AxiError("Zen response exceeds size limit", "API_ERROR");
      }
      chunks.push(next.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, size));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function evaluateZen(
  backend: ResolvedBackend,
  request: { model: string; state: EntryType; questions: QuestionMap },
  options: { fetch?: Fetch; timeoutMs?: number; maxRetries?: number } = {},
): Promise<SystemOneEnvelope> {
  if (backend.name !== "opencode-zen" || backend.endpoint !== URL) throw validation("Invalid Zen backend");
  validateZenQuestions(request.questions);
  const credential = requireBackendCredential(backend);
  const fetcher = options.fetch ?? globalThis.fetch;
  const retries = options.maxRetries ?? 2;
  const timeout = options.timeoutMs ?? 60_000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let delay: number | undefined;
    try {
      const response = await fetcher(URL, {
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json", "User-Agent": "opencode/jev-axi" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const retry = ![301, 302, 303, 307, 308].includes(response.status) &&
          (response.status === 408 || response.status === 429 || response.status >= 500 && response.status <= 599) && attempt < retries;
        if (retry) delay = retryDelay(attempt, response.headers);
        void response.body?.cancel().catch(() => {});
        if (!retry) throw statusError(response.status);
      } else {
        const text = await responseText(response, controller.signal);
        let raw: unknown;
        try { raw = JSON.parse(text); } catch { invalid(); }
        return validateZenResponse(raw, request.questions, credential);
      }
    } catch (error) {
      if (error instanceof AxiError) throw error;
      if (attempt >= retries) throw new AxiError("Could not reach the Zen API", "NETWORK");
      delay = retryDelay(attempt);
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new AxiError("Could not reach the Zen API", "NETWORK");
}
