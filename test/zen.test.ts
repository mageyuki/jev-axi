import { describe, expect, it, vi } from "vitest";
import type { QuestionMap } from "../src/client.js";
import { resolveBackend } from "../src/backend.js";
import { evaluateZen, validateZenQuestions, validateZenResponse } from "../src/zen.js";
import { makeEnvelope, scriptedFetch } from "./helpers/systemone.js";

const credential = "synthetic-console-credential-marker";
const questions: QuestionMap = {
  n: { type: "noul", instructions: { check: ["a", 1] } },
  c: { type: "choice", criteria: { a: null, b: "B" } },
  s: { type: "score", criteria: ["low", "high"] },
};
const request = { model: "jev-1.13-free", state: { text: ["hello", 1] }, questions };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
async function backend() {
  process.env.JEV_BACKEND = "opencode-zen";
  process.env.OPENCODE_API_KEY = credential;
  return resolveBackend({});
}

describe("Zen wire", () => {
  it("sends the exact mixed request once and preserves returned model and score/confidence", async () => {
    const envelope = makeEnvelope(questions);
    const wire = scriptedFetch([json(envelope)]);
    const result = await evaluateZen(await backend(), request, { fetch: wire.fetch });
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]!.url).toBe("https://opencode.ai/zen/v1/systemone");
    expect(wire.requests[0]!.init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(wire.requests[0]!.init.headers).toMatchObject({ Authorization: `Bearer ${credential}`, "Content-Type": "application/json", "User-Agent": "opencode/jev-axi" });
    expect(JSON.parse(String(wire.requests[0]!.init.body))).toEqual(request);
    expect(result).toEqual(envelope);
    expect(result.answers.s).toMatchObject({ score: 0.7, confidence: 0.2 });
  });

  it.each([301, 302, 303, 307, 308])("refuses redirect %i without forwarding or retry", async status => {
    const wire = scriptedFetch([new Response(null, { status, headers: { location: "https://redirect.invalid/collect" } })]);
    await expect(evaluateZen(await backend(), request, { fetch: wire.fetch, maxRetries: 2 })).rejects.toMatchObject({ code: "API_ERROR" });
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]!.init.redirect).toBe("manual");
    expect(wire.requests[0]!.url).toBe("https://opencode.ai/zen/v1/systemone");
  });

  it("rejects score maps before making a request", async () => {
    const bad = { s: { type: "score", criteria: { 0: "low", 1: "high" } } } as unknown as QuestionMap;
    const wire = scriptedFetch([]);
    expect(() => validateZenQuestions(bad)).toThrow();
    await expect(evaluateZen(await backend(), { ...request, questions: bad }, { fetch: wire.fetch })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(wire.requests).toHaveLength(0);
  });

  it.each([
    ["model", e => { delete e.model; }],
    ["usage", e => { delete e.usage; }],
    ["wrong token name", e => { e.usage = { prompt_tokens: 100, output_tokens: 10 }; }],
    ["negative tokens", e => { e.usage.input_tokens = -1; }],
    ["fractional tokens", e => { e.usage.output_tokens = 1.5; }],
    ["missing ID", e => { delete e.answers.n; }],
    ["extra ID", e => { e.answers.extra = { type: "noul", noul: 0.5 }; }],
    ["wrong type", e => { e.answers.n.type = "choice"; }],
    ["invalid noul", e => { e.answers.n.noul = Infinity; }],
    ["unknown choice", e => { e.answers.c.choice = "unknown"; }],
    ["missing confidence", e => { delete e.answers.c.confidence; }],
    ["missing distribution", e => { delete e.answers.c.probabilities; }],
    ["missing probability entry", e => { delete e.answers.c.probabilities.b; }],
    ["out of range choice", e => { e.answers.c.probabilities.a = 1.1; }],
    ["invalid score", e => { e.answers.s.score = 2; }],
    ["missing score confidence", e => { delete e.answers.s.confidence; }],
    ["missing legend", e => { delete e.answers.s.legend; }],
    ["missing legend level", e => { delete e.answers.s.legend["1"]; }],
    ["invalid score probability", e => { e.answers.s.probabilities["0"] = -0.1; }],
  ] as Array<[string, (e: any) => void]>) ("rejects malformed %s", (_, mutate) => {
    const envelope: any = makeEnvelope(questions);
    mutate(envelope);
    expect(() => validateZenResponse(envelope, questions, credential)).toThrowError();
  });

  it("rejects selected-credential echoes without exposing the body or key", async () => {
    const envelope = makeEnvelope(questions, `echo-${credential}`);
    const wire = scriptedFetch([json(envelope)]);
    const error = await evaluateZen(await backend(), request, { fetch: wire.fetch }).catch(e => e);
    expect(error.code).toBe("API_ERROR");
    expect(JSON.stringify(error)).not.toContain(credential);
    expect(error.message).not.toContain(credential);
    const answer = makeEnvelope(questions) as any;
    answer.answers.c.extra = credential;
    expect(() => validateZenResponse(answer, questions, credential)).toThrow();
  });

  it("rejects an oversized Zen response and cancels it without exposing its contents", async () => {
    const marker = "sensitive-body-marker";
    let cancelled = false;
    const bytes = new Uint8Array(1_048_577);
    bytes.set(new TextEncoder().encode(`${marker}-${credential}`));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); },
      cancel() { cancelled = true; },
    }));
    const wire = scriptedFetch([response]);
    const error = await evaluateZen(await backend(), request, { fetch: wire.fetch, timeoutMs: 50, maxRetries: 0 }).catch(e => e);
    expect(error.code).toBe("API_ERROR");
    expect(JSON.stringify(error)).not.toContain(marker);
    expect(JSON.stringify(error)).not.toContain(credential);
    expect(cancelled).toBe(true);
    expect(wire.requests).toHaveLength(1);
  });

  it("rejects a decoded credential containing a quotation mark before returning a Zen answer", async () => {
    const quotedCredential = 'synthetic"quoted-canary';
    process.env.JEV_BACKEND = "opencode-zen";
    process.env.OPENCODE_API_KEY = quotedCredential;
    const envelope = makeEnvelope(questions);
    (envelope.answers.c as { extra?: string }).extra = `echo-${quotedCredential}`;
    const wire = scriptedFetch([json(envelope)]);
    const error = await evaluateZen(await resolveBackend({}), request, { fetch: wire.fetch, maxRetries: 0 }).catch(e => e);
    expect(error.code).toBe("API_ERROR");
    expect(error.message).not.toContain(quotedCredential);
    expect(wire.requests).toHaveLength(1);
  });

  it.each([
    [401, "AUTH_REQUIRED"], [403, "API_REJECTED"], [400, "VALIDATION_ERROR"],
    [422, "VALIDATION_ERROR"], [404, "API_ERROR"],
  ] as const)("maps HTTP %i to %s without server content", async (status, code) => {
    const wire = scriptedFetch([new Response(`<html>${credential} secret-body</html>`, { status, headers: { "content-type": "text/html" } })]);
    const error = await evaluateZen(await backend(), request, { fetch: wire.fetch, maxRetries: 0 }).catch(e => e);
    expect(error.code).toBe(code);
    expect(JSON.stringify(error)).not.toContain(credential);
    expect(JSON.stringify(error)).not.toContain("secret-body");
    if (status === 401) {
      expect(error.message).toMatch(/Console.*OPENCODE_API_KEY/);
      expect(JSON.stringify(error)).not.toContain("TYPESAFE_API_KEY");
    }
  });

  it.each([[429, "RATE_LIMITED"], [529, "OVERLOADED"]] as const)("retries HTTP %i twice then returns %s", async (status, code) => {
    vi.useFakeTimers();
    try {
      const wire = scriptedFetch(Array.from({ length: 3 }, () => new Response(null, { status, headers: { "retry-after": "0" } })));
      const result = evaluateZen(await backend(), request, { fetch: wire.fetch });
      const rejected = expect(result).rejects.toMatchObject({ code });
      await vi.runAllTimersAsync();
      await rejected;
      expect(wire.requests).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  });

  it("honors zero retries and caps excessive Retry-After to SDK backoff", async () => {
    const once = scriptedFetch([new Response(null, { status: 429 })]);
    await expect(evaluateZen(await backend(), request, { fetch: once.fetch, maxRetries: 0 })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(once.requests).toHaveLength(1);
    vi.useFakeTimers();
    try {
      const wire = scriptedFetch([new Response(null, { status: 429, headers: { "retry-after": "9999" } }), json(makeEnvelope(questions))]);
      const result = evaluateZen(await backend(), request, { fetch: wire.fetch, maxRetries: 1 });
      await vi.advanceTimersByTimeAsync(501);
      await expect(result).resolves.toMatchObject({ model: "jev-1.13.0" });
      expect(wire.requests).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("times out while delivering the response body and cancels it", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    try {
      const response = new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }));
      const wire = scriptedFetch([response]);
      const result = evaluateZen(await backend(), request, { fetch: wire.fetch, timeoutMs: 10, maxRetries: 0 });
      const rejected = expect(result).rejects.toMatchObject({ code: "NETWORK" });
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      expect(cancelled).toBe(true);
      expect(wire.requests).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});
