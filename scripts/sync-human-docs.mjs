#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = fileURLToPath(new URL("..", import.meta.url));
const domainDescriptions = {
  database: "表、不变量与写入归属",
  mcp: "Tool、输入输出、错误与副作用",
  hooks: "确定性守卫与生命周期事件",
  skills: "Skill 可用 Tool、前置条件与禁区",
  workflow: "阶段、转换与恢复顺序",
  errors: "错误码、重试与对账语义",
  algorithms: "算法定义就绪状态",
};

function read(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function json(root, relativePath) {
  return JSON.parse(read(root, relativePath));
}

function digestEntries(entries) {
  const hash = createHash("sha256");
  for (const [path, source] of entries) {
    hash.update(path);
    hash.update("\0");
    hash.update(String(Buffer.byteLength(source)));
    hash.update("\0");
    hash.update(source);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectSpecFacts(root) {
  const manifest = json(root, "spec/manifest.json");
  const contractEntries = Object.entries(manifest.contracts);
  const compatibilityEntries = Object.entries(manifest.compatibilityProfiles ?? {});
  const specPaths = [
    "manifest.json",
    ...contractEntries.map(([, path]) => path),
    ...compatibilityEntries.map(([, path]) => path),
  ].filter((path, index, paths) => paths.indexOf(path) === index).sort();
  const specDigest = digestEntries(
    specPaths.map((path) => [path, read(root, `spec/${path}`)]),
  );
  const mcp = json(root, `spec/${manifest.contracts.mcp}`);
  const workflow = json(root, `spec/${manifest.contracts.workflow}`);
  const hooks = json(root, `spec/${manifest.contracts.hooks}`);
  const database = json(root, `spec/${manifest.contracts.database}`);
  const algorithms = json(root, `spec/${manifest.contracts.algorithms}`);

  return {
    manifest,
    contractEntries,
    compatibilityEntries,
    specDigest,
    requiredToolCount: mcp.requiredTools.length,
    optionalToolCount: mcp.optionalTools.length,
    phaseCount: workflow.phases.length,
    hookEventCount: Object.keys(hooks.events).length,
    databaseInvariantCount: database.invariants.length,
    databaseReadiness: database.readinessStatus,
    algorithmReadiness: algorithms.readinessStatus,
  };
}

function collectChanges(root) {
  const names = readdirSync(join(root, "changes"))
    .filter((name) => /^CHG-\d{4}-\d{3}-.+\.md$/.test(name))
    .filter((name) => !name.endsWith("-impact.md"))
    .sort();
  const entries = names.map((name) => {
    const source = read(root, `changes/${name}`);
    const id = name.match(/^(CHG-\d{4}-\d{3})-/)?.[1] ?? name;
    const heading = source.split("\n", 1)[0].replace(/^#\s*/, "").trim();
    const title = heading.replace(new RegExp(`^${id}[：:\\s-]*`), "");
    const status = source.match(/^status:\s*"?([^"\n]+)"?\s*$/m)?.[1].trim() ?? "UNKNOWN";
    return { id, name, source, status, title };
  });
  return {
    entries: entries.sort((left, right) => right.id.localeCompare(left.id)),
    digest: digestEntries(entries.map(({ name, source }) => [name, source])),
  };
}

function block(key, lines) {
  return [
    `<!-- human-docs:${key}:start -->`,
    "<!-- 由 pre-commit hook 或 npm run docs:sync 生成；不要手工编辑本区块。 -->",
    ...lines,
    `<!-- human-docs:${key}:end -->`,
  ].join("\n");
}

function renderSpecSummary(facts) {
  const compatibility = facts.compatibilityEntries.map(([name]) => `\`${name}\``).join("、") || "无";
  const totalTools = facts.requiredToolCount + facts.optionalToolCount;
  return block("spec-summary", [
    "",
    "| 当前事实 | 值 |",
    "| --- | --- |",
    `| Profile / 状态 | \`${facts.manifest.profile}\` / \`${facts.manifest.status}\` |`,
    `| 正式契约域 | ${facts.contractEntries.length} 个 |`,
    `| MCP Tool | ${totalTools} 个（必需 ${facts.requiredToolCount}，可选 ${facts.optionalToolCount}） |`,
    `| Workflow / Hook | ${facts.phaseCount} 个阶段 / ${facts.hookEventCount} 个事件 |`,
    `| 数据库证明 | ${facts.databaseInvariantCount} 项不变量，\`${facts.databaseReadiness}\` |`,
    `| 算法定义 | \`${facts.algorithmReadiness}\` |`,
    `| 兼容检测 | ${compatibility} |`,
    `| Spec 摘要 | \`sha256:${facts.specDigest}\` |`,
  ]);
}

function renderContractMap(facts) {
  const rows = facts.contractEntries.map(([domain, path]) => (
    `| ${domain} | [\`spec/${path}\`](../spec/${path}) | ${domainDescriptions[domain] ?? "正式契约"} |`
  ));
  return block("contract-map", [
    "",
    `Spec 摘要：\`sha256:${facts.specDigest}\``,
    "",
    "| 领域 | 唯一权威 | 人类理解 |",
    "| --- | --- | --- |",
    ...rows,
  ]);
}

function renderChangeIndex(facts, changes) {
  const rows = changes.entries.map(({ id, name, status, title }) => (
    `| ${id} | \`${status}\` | [${title}](../changes/${name}) |`
  ));
  return block("change-index", [
    "",
    `当前 Spec：\`${facts.manifest.profile}\` · \`sha256:${facts.specDigest}\``,
    `变更记录摘要：\`sha256:${changes.digest}\``,
    "",
    "| 变更 | 状态 | 决策主题 |",
    "| --- | --- | --- |",
    ...rows,
  ]);
}

function generatedBlocks(root) {
  const facts = collectSpecFacts(root);
  const changes = collectChanges(root);
  return [
    { path: "docs/README.md", key: "spec-summary", content: renderSpecSummary(facts) },
    { path: "docs/PROJECT_MAP.md", key: "contract-map", content: renderContractMap(facts) },
    { path: "docs/EVOLUTION.md", key: "change-index", content: renderChangeIndex(facts, changes) },
  ];
}

function replaceBlock(source, { key, content, path }) {
  const start = `<!-- human-docs:${key}:start -->`;
  const end = `<!-- human-docs:${key}:end -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex || source.lastIndexOf(start) !== startIndex || source.lastIndexOf(end) !== endIndex) {
    throw new Error(`${path} must contain exactly one ${key} marker pair`);
  }
  return `${source.slice(0, startIndex)}${content}${source.slice(endIndex + end.length)}`;
}

function expectedDocuments(root) {
  return generatedBlocks(root).map((generated) => {
    if (!existsSync(join(root, generated.path))) return { ...generated, current: null, expected: null };
    const current = read(root, generated.path);
    return { ...generated, current, expected: replaceBlock(current, generated) };
  });
}

export function collectHumanDocDrift(root = defaultRepoRoot) {
  return expectedDocuments(root)
    .filter(({ current, expected }) => current === null || current !== expected)
    .map(({ path }) => path);
}

export function syncHumanDocs(root = defaultRepoRoot) {
  const documents = expectedDocuments(root);
  for (const { path, current, expected } of documents) {
    if (current === null) throw new Error(`${path} does not exist`);
    if (current !== expected) writeFileSync(join(root, path), expected);
  }
  return documents.filter(({ current, expected }) => current !== expected).map(({ path }) => path);
}

function parseArgs(args) {
  if (args.length === 0) return { check: false };
  if (args.length === 1 && args[0] === "--check") return { check: true };
  throw new Error("Usage: node scripts/sync-human-docs.mjs [--check]");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const { check } = parseArgs(process.argv.slice(2));
    if (check) {
      const drift = collectHumanDocDrift();
      if (drift.length > 0) throw new Error(`stale human docs: ${drift.join(", ")}; run npm run docs:sync`);
      process.stdout.write("[human-docs] synchronized\n");
    } else {
      const updated = syncHumanDocs();
      process.stdout.write(`[human-docs] ${updated.length > 0 ? `updated ${updated.join(", ")}` : "already current"}\n`);
    }
  } catch (error) {
    process.stderr.write(`[human-docs] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
