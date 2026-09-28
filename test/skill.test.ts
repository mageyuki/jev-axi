import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateSkill } from "../scripts/build-skill.js";

const good = (frontmatter: string, body = "# jev-axi\n") => `---\n${frontmatter}\n---\n${body}`;

describe("skill validation", () => {
  it("accepts the committed skill", () => {
    expect(validateSkill()).toEqual([]);
  });

  it("keeps fork-safe installation and backend alternatives in the shipped skill", () => {
    const skill = readFileSync(new URL("../skills/jev-axi/SKILL.md", import.meta.url), "utf8");
    expect(skill).not.toMatch(/npm install -g jev-axi|npx -y jev-axi/);
    const compatibility = skill.match(/^compatibility: ([^\r\n]+)$/m)?.[1];
    expect(compatibility).toMatch(/Zen/);
    expect(compatibility).toMatch(/Console|OPENCODE_API_KEY/);
    expect(compatibility).toMatch(/TypeSafe/);
    expect(compatibility).toMatch(/Laya/);
    expect(compatibility).toMatch(/\bor\b/i);
  });

  it("flags spec violations in frontmatter", () => {
    const msgs = (fm: string, body?: string) => validateSkill(good(fm, body), "/x/jev-axi").map((p) => p.message).join("\n");
    expect(msgs("name: Jev-Axi\ndescription: Ranks files. Use when searching.")).toMatch(/lowercase/);
    expect(msgs("name: other\ndescription: Ranks files. Use when searching.")).toMatch(/must match its directory/);
    expect(msgs(`name: jev-axi\ndescription: ${"x".repeat(1100)} Use when.`)).toMatch(/max 1024/);
    expect(msgs("name: jev-axi\ndescription: I can rank your files. Use when searching.")).toMatch(/third person/);
    expect(msgs("name: jev-axi\ndescription: Ranks files.")).toMatch(/when to use/);
    expect(msgs("name: jev-axi\ndescription: Ranks files. Use when searching.\ncolor: blue")).toMatch(/unknown frontmatter field/);
    expect(msgs("name: jev-axi\ndescription: Ranks files. Use when searching.", "See [x](references/missing.md)")).toMatch(/does not exist/);
  });
});
