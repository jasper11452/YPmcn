import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

function run(command, args, cwd, expectedStatus = 0) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    expectedStatus,
    `${command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function git(cwd, ...args) {
  return run("git", args, cwd).stdout.trim();
}

function createGitFixture(t) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ypmcn-human-docs-git-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  for (const directory of ["spec", "changes", "docs", "scripts", ".githooks"]) {
    cpSync(join(repoRoot, directory), join(fixtureRoot, directory), { recursive: true });
  }
  git(fixtureRoot, "init", "-q");
  git(fixtureRoot, "config", "user.name", "Human Docs Test");
  git(fixtureRoot, "config", "user.email", "human-docs@example.invalid");
  git(fixtureRoot, "add", ".");
  git(fixtureRoot, "commit", "-q", "--no-verify", "-m", "baseline");
  return fixtureRoot;
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

    const developerWorkflow = read("docs/DEVELOPER_SPEC_WORKFLOW.md");
    const agentWorkflow = read("docs/AGENT_SPEC_WORKFLOW.md");
    const rootPackage = JSON.parse(read("package.json"));
    for (const source of [developerWorkflow, agentWorkflow]) {
      assert.match(source, /npm run docs:sync/);
      assert.match(source, /npm run verify:docs/);
      assert.match(source, /pre-commit/);
    }
    assert.equal(rootPackage.scripts["docs:sync"], "node scripts/sync-human-docs.mjs");
    assert.equal(rootPackage.scripts["verify:docs"], "node scripts/sync-human-docs.mjs --check");
    assert.equal(rootPackage.scripts.prepare, "node scripts/install-git-hooks.mjs");
  });

  it("installs the versioned pre-commit hook from the root npm lifecycle", (t) => {
    for (const relativePath of [
      ".githooks/pre-commit",
      "scripts/install-git-hooks.mjs",
      "scripts/pre-commit-human-docs.mjs",
    ]) {
      assert.equal(existsSync(join(repoRoot, relativePath)), true, relativePath);
    }
    const hookIndexEntry = git(repoRoot, "ls-files", "--stage", ".githooks/pre-commit");
    assert.match(hookIndexEntry, /^100755\s/, "hook must be executable in the Git index");

    const fixtureRoot = mkdtempSync(join(tmpdir(), "ypmcn-hook-install-"));
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
    mkdirSync(join(fixtureRoot, "scripts"));
    mkdirSync(join(fixtureRoot, ".githooks"));
    cpSync(join(repoRoot, "scripts/install-git-hooks.mjs"), join(fixtureRoot, "scripts/install-git-hooks.mjs"));
    cpSync(join(repoRoot, ".githooks/pre-commit"), join(fixtureRoot, ".githooks/pre-commit"));
    git(fixtureRoot, "init", "-q");

    run(process.execPath, ["scripts/install-git-hooks.mjs"], fixtureRoot);
    assert.equal(git(fixtureRoot, "config", "--local", "--get", "core.hooksPath"), ".githooks");

    const nonGitRoot = mkdtempSync(join(tmpdir(), "ypmcn-hook-no-git-"));
    t.after(() => rmSync(nonGitRoot, { recursive: true, force: true }));
    mkdirSync(join(nonGitRoot, "scripts"));
    mkdirSync(join(nonGitRoot, ".githooks"));
    cpSync(join(repoRoot, "scripts/install-git-hooks.mjs"), join(nonGitRoot, "scripts/install-git-hooks.mjs"));
    cpSync(join(repoRoot, ".githooks/pre-commit"), join(nonGitRoot, ".githooks/pre-commit"));
    const skipped = run(process.execPath, ["scripts/install-git-hooks.mjs"], nonGitRoot);
    assert.match(skipped.stdout, /skipped: not a Git working tree/);
  });

  it("automatically synchronizes and stages human docs for a relevant commit", async (t) => {
    const fixtureRoot = createGitFixture(t);
    run(process.execPath, ["scripts/install-git-hooks.mjs"], fixtureRoot);
    const errorSpec = join(fixtureRoot, "spec/errors.json");
    writeFileSync(errorSpec, `${readFileSync(errorSpec, "utf8").trimEnd()}\n\n`);
    git(fixtureRoot, "add", "spec/errors.json");

    git(fixtureRoot, "commit", "-q", "-m", "change spec");
    const committed = git(fixtureRoot, "show", "--pretty=format:", "--name-only", "HEAD")
      .split("\n")
      .filter(Boolean)
      .sort();
    assert.deepEqual(committed, [
      "docs/EVOLUTION.md",
      "docs/PROJECT_MAP.md",
      "docs/README.md",
      "spec/errors.json",
    ]);
    assert.equal(git(fixtureRoot, "status", "--short"), "");
    const { collectHumanDocDrift } = await import("../scripts/sync-human-docs.mjs");
    assert.deepEqual(collectHumanDocDrift(fixtureRoot), []);
  });

  it("skips unrelated commits and fails closed around unstaged relevant content", (t) => {
    const fixtureRoot = createGitFixture(t);
    run(process.execPath, ["scripts/install-git-hooks.mjs"], fixtureRoot);
    const originalDocs = humanDocs.map(({ path }) => [path, readFileSync(join(fixtureRoot, path), "utf8")]);

    writeFileSync(join(fixtureRoot, "notes.txt"), "unrelated\n");
    git(fixtureRoot, "add", "notes.txt");
    git(fixtureRoot, "commit", "-q", "-m", "unrelated");
    for (const [path, source] of originalDocs) assert.equal(readFileSync(join(fixtureRoot, path), "utf8"), source);

    const errorSpec = join(fixtureRoot, "spec/errors.json");
    writeFileSync(errorSpec, `${readFileSync(errorSpec, "utf8").trimEnd()}\n\n`);
    git(fixtureRoot, "add", "spec/errors.json");
    writeFileSync(errorSpec, `${readFileSync(errorSpec, "utf8")}\n`);
    const untrackedProposal = "changes/CHG-2099-999-untracked.md";
    writeFileSync(join(fixtureRoot, untrackedProposal), "# untracked proposal\n");

    const commit = run("git", ["commit", "-m", "unsafe partial change"], fixtureRoot, 1);
    assert.match(commit.stderr, /unsafe human-doc source state/);
    assert.match(commit.stderr, /spec\/errors\.json/);
    assert.match(commit.stderr, /CHG-2099-999-untracked\.md/);
    for (const [path, source] of originalDocs) assert.equal(readFileSync(join(fixtureRoot, path), "utf8"), source);
  });
});
