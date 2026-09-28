import { describe, expect, it, vi } from "vitest";
import { cacheScope, readCached, writeCached } from "../src/response-cache.js";

// Keep real filesystem I/O; only model a platform that exposes no O_NOFOLLOW flag.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, constants: { ...fs.constants, O_NOFOLLOW: undefined } };
});

describe("response cache without O_NOFOLLOW", () => {
  it.skipIf(process.platform === "win32")("misses rather than opening an entry without no-follow protection", () => {
    const scope = cacheScope({ name: "typesafe", endpoint: "https://api.typesafe.ai/v1/systemone", defaultModel: "free", hasCredential: false, credentialSource: "none", credential: () => undefined });
    if (!scope) throw Error("scope missing");
    const now = Date.parse("2026-09-17T12:00:00Z");
    const questions = { q: { type: "noul" as const, instructions: "Is this relevant?" } };
    writeCached(scope, "free", "context", questions, { model: "version-a", answers: { q: { type: "noul" as const, noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 1 } }, now);
    expect(readCached(scope, "free", "context", questions, now)).toBeUndefined();
  });
});
