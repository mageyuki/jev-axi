import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { mergedUsageLine, usageLine } from "../src/format.js";
import { costTotals, dailySeries, estimateEntryCost, formatEstimatedCost, type UsageEntry } from "../src/usage.js";
import type { EvalResult } from "../src/client.js";

const entry = (over: Partial<UsageEntry> = {}): UsageEntry => ({ ts: "2026-09-16T10:00:00Z", cmd: "check", model: "jev-1.13", backend: "opencode-zen", requestedModel: "jev-1.13-free", in: 1_000_000, out: 500_000, ms: 10, q: 1, cached: false, project: "alpha", ...over });

describe("requested-model estimates", () => {
  const result = (e: UsageEntry): EvalResult => ({ model: e.model, requestedModel: e.requestedModel, backend: e.backend, cached: e.cached, ms: e.ms, usage: { input_tokens: e.in, output_tokens: e.out }, answers: {} });
  it("prices free, paid, unknown, and legacy entries independently of returned model", () => {
    expect(estimateEntryCost(entry())).toBe(0);
    expect(estimateEntryCost(entry({ requestedModel: "jev-1.13" }))).toBe(0.042);
    expect(estimateEntryCost(entry({ requestedModel: "future" }))).toBeNull();
    expect(estimateEntryCost(entry({ backend: undefined, requestedModel: undefined }))).toBe(0.042);
    expect(estimateEntryCost(entry(), { price: { input: 1, output: 2 } })).toBe(0);
    expect(estimateEntryCost(entry({ requestedModel: "jev-1.13", in: 0, out: 1_000_000 }), { price: { output: 0.5 } })).toBe(0.5);
  });

  it("needs only prices for nonzero unknown components and never borrows the legacy default", () => {
    const unknown = entry({ requestedModel: "future", in: 1_000_000, out: 2_000_000 });
    expect(estimateEntryCost(unknown, { price: { input: 0.25 } })).toBeNull();
    expect(estimateEntryCost(unknown, { price: { input: 0.25, output: 0.5 } })).toBe(1.25);
    expect(estimateEntryCost(entry({ requestedModel: "future", in: 0, out: 1_000_000 }), { price: { output: 0.5 } })).toBe(0.5);
    expect(estimateEntryCost(entry({ requestedModel: "future", in: 0, out: 0 }))).toBe(0);
    expect(formatEstimatedCost(null)).toBe("unknown");
  });

  it("separates cached savings and propagates unknown totals per side", () => {
    const free = entry();
    const paid = entry({ requestedModel: "jev-1.13", cached: true });
    const unknown = entry({ requestedModel: "future", in: 10, out: 10 });
    expect(costTotals([free, paid, unknown])).toEqual({ cost: null, saved: 0.042, unknown_cost_calls: 1, unknown_saved_calls: 0 });
    expect(costTotals([paid, entry({ ...unknown, cached: true })])).toEqual({ cost: 0, saved: null, unknown_cost_calls: 0, unknown_saved_calls: 1 });
    expect(dailySeries([unknown, paid], 2, new Date("2026-09-16T12:00:00Z"))).toEqual([
      { day: "2026-09-15", calls: 0, questions: 0, input: 0, cost: 0, unknown_cost_calls: 0 },
      { day: "2026-09-16", calls: 2, questions: 2, input: 10, cost: null, unknown_cost_calls: 1 },
    ]);
  });

  it("renders immediate single and merged usage without assigning unknown spend a number", () => {
    expect(usageLine(result(entry()))).toBe("1000000in/500000out 10ms jev-1.13 $0");
    expect(usageLine(result(entry({ requestedModel: "jev-1.13", cached: true })))).toContain("saved $0.0420");
    expect(usageLine(result(entry({ requestedModel: "future" })))).toContain("unknown");
    expect(mergedUsageLine([result(entry()), result(entry({ requestedModel: "future" }))])).toContain("unknown");
  });

  it("reports saved paid cost when all merged calls are cached", () => {
    const paidHit = result(entry({ requestedModel: "jev-1.13", cached: true }));
    expect(mergedUsageLine([paidHit, paidHit])).toBe("2000000in/1000000out 20ms 2 calls (2 cached) jev-1.13 saved $0.0840");
  });

  it("reports unknown when a merged call has unpriced cached savings", () => {
    const paidHit = result(entry({ requestedModel: "jev-1.13", cached: true }));
    const unknownHit = result(entry({ requestedModel: "future", cached: true }));
    expect(mergedUsageLine([paidHit, unknownHit])).toBe("2000000in/1000000out 20ms 2 calls (2 cached) jev-1.13 unknown");
  });
});

describe("usage and home ledger views", () => {
  let output = "";
  const stdout = { write: (s: string) => { output += s; return true; } };
  let dir: string;
  beforeEach(() => {
    output = "";
    dir = mkdtempSync(join(tmpdir(), "jev-price-"));
    process.env["XDG_CONFIG_HOME"] = join(dir, "config");
    process.env["XDG_STATE_HOME"] = join(dir, "state");
    process.env["XDG_CACHE_HOME"] = join(dir, "cache");
  });
  afterEach(() => { process.exitCode = 0; });
  const ledger = (rows: UsageEntry[]) => {
    const folder = join(process.env["XDG_CONFIG_HOME"]!, "jev-axi", "stats");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "usage.jsonl");
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return file;
  };

  it("reports incomplete totals and nonzero unknown counts in usage JSON without changing ledger bytes", async () => {
    const now = new Date().toISOString();
    const file = ledger([entry({ ts: now }), entry({ ts: now, requestedModel: "jev-1.13", cached: true }), entry({ ts: now, requestedModel: "future" }), entry({ ts: now, requestedModel: "future", cached: true })]);
    const before = readFileSync(file, "utf8");
    await main(["usage", "--json"], stdout);
    const result = JSON.parse(output);
    expect(result.cost).toBeNull();
    expect(result.saved).toBeNull();
    expect(result.unknown_cost_calls).toBe(1);
    expect(result.unknown_saved_calls).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("omits zero unknown counts, renders unknown group cost, and shows today on home", async () => {
    const now = new Date().toISOString();
    ledger([entry({ ts: now, cmd: "free" }), entry({ ts: now, cmd: "mystery", requestedModel: "future" })]);
    await main(["usage", "--json"], stdout);
    expect(JSON.parse(output).unknown_saved_calls).toBeUndefined();
    output = "";
    await main(["usage"], stdout);
    expect(output).toContain("unknown");
    expect(output).not.toContain("NaN");
    output = "";
    await main([], stdout);
    expect(output).toContain("unknown");
  });
});
