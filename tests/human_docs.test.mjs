import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const humanDocs = [
  { path: "docs/README.md", maxLines: 100, headings: ["# 人类入口", "## 先看结论"] },
  { path: "docs/PROJECT_MAP.md", maxLines: 140, headings: ["# 项目地图", "## 去哪里改"] },
  { path: "docs/EVOLUTION.md", maxLines: 120, headings: ["# 演进历程", "## 为什么演进"] },
];

function read(relativePath) {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function localMarkdownLinks(source) {
  return [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !target.startsWith("#") && !/^[a-z]+:/i.test(target));
}

describe("human documentation", () => {
  it("keeps generated facts synchronized with Spec and Change Proposals", async (t) => {
    const { collectHumanDocDrift, syncHumanDocs } = await import("../scripts/sync-human-docs.mjs");
    assert.deepEqual(collectHumanDocDrift(repoRoot), []);

    const fixtureRoot = mkdtempSync(join(tmpdir(), "ypmcn-human-docs-"));
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
    for (const directory of ["spec", "changes", "docs"]) {
      cpSync(join(repoRoot, directory), join(fixtureRoot, directory), { recursive: true });
    }

    const errorSpec = join(fixtureRoot, "spec/errors.json");
    writeFileSync(errorSpec, `${readFileSync(errorSpec, "utf8").trimEnd()}\n\n`);
    assert.deepEqual(collectHumanDocDrift(fixtureRoot), humanDocs.map(({ path }) => path));
    syncHumanDocs(fixtureRoot);
    assert.deepEqual(collectHumanDocDrift(fixtureRoot), []);

    const changeProposal = join(fixtureRoot, "changes/CHG-2026-004-human-documentation.md");
    writeFileSync(changeProposal, `${readFileSync(changeProposal, "utf8").trimEnd()}\n\n<!-- test-only-change -->\n`);
    assert.deepEqual(collectHumanDocDrift(fixtureRoot), ["docs/EVOLUTION.md"]);
    syncHumanDocs(fixtureRoot);
    assert.deepEqual(collectHumanDocDrift(fixtureRoot), []);
  });

  it("keeps the human entry concise, navigable, and part of the change workflow", () => {
    for (const document of humanDocs) {
      assert.equal(existsSync(join(repoRoot, document.path)), true, document.path);
      const source = read(document.path);
      const lineCount = source.trimEnd().split("\n").length;
      assert.ok(lineCount <= document.maxLines, `${document.path} has ${lineCount} lines`);
      assert.doesNotMatch(source, /\/Users\/|file:\/\//, document.path);
      for (const heading of document.headings) assert.match(source, new RegExp(`^${heading}$`, "m"));
      for (const target of localMarkdownLinks(source)) {
        const relativeTarget = decodeURIComponent(target.split("#", 1)[0]);
        const absoluteTarget = resolve(repoRoot, dirname(document.path), relativeTarget);
        assert.equal(existsSync(absoluteTarget), true, `${document.path} -> ${target}`);
      }
    }

    const rootReadme = read("README.md");
    for (const path of humanDocs.map((document) => document.path)) assert.match(rootReadme, new RegExp(path));

    const agentRules = read("AGENTS.md");
    const developerWorkflow = read("docs/DEVELOPER_SPEC_WORKFLOW.md");
    const agentWorkflow = read("docs/AGENT_SPEC_WORKFLOW.md");
    const rootPackage = JSON.parse(read("package.json"));
    for (const source of [agentRules, developerWorkflow, agentWorkflow]) {
      assert.match(source, /npm run docs:sync/);
      assert.match(source, /npm run verify:docs/);
    }
    assert.equal(rootPackage.scripts["docs:sync"], "node scripts/sync-human-docs.mjs");
    assert.equal(rootPackage.scripts["verify:docs"], "node scripts/sync-human-docs.mjs --check");
  });
});
