import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scannerUrl = new URL("../scripts/scan-secrets.mjs", import.meta.url);

function withTempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), "ypmcn-secret-scan-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

describe("secret release scanner", () => {
  it("reports API keys and DB passwords without returning their values", async (t) => {
    const { scanPaths } = await import(scannerUrl);
    const directory = withTempDir(t);
    const sourcePath = join(directory, "synthetic-config.mjs");
    const secret = ["sk", "synthetic", "A".repeat(24)].join("-");
    const password = ["local", "db", "password"].join("-");

    writeFileSync(
      sourcePath,
      [
        `const apiKey = ${JSON.stringify(secret)};`,
        `const db = { password: ${JSON.stringify(password)} };`,
      ].join("\n"),
    );

    const findings = scanPaths([sourcePath]);

    assert.equal(findings.length, 2);
    assert.equal(findings[0].rule, "generic-api-key");
    assert.equal(findings[1].rule, "literal-db-password");
    assert.deepEqual(Object.keys(findings[0]).sort(), ["file", "line", "rule"]);
    assert.equal(JSON.stringify(findings).includes(secret), false);
    assert.equal(JSON.stringify(findings).includes(password), false);
  });

  it("reports all-uppercase API keys and DB passwords", async (t) => {
    const { scanPaths } = await import(scannerUrl);
    const directory = withTempDir(t);
    const sourcePath = join(directory, "uppercase-config.mjs");
    const secret = "A".repeat(24);
    const password = "P".repeat(18);

    writeFileSync(
      sourcePath,
      [
        `const apiKey = ${JSON.stringify(secret)};`,
        `const db = { password: ${JSON.stringify(password)} };`,
      ].join("\n"),
    );

    const findings = scanPaths([sourcePath]);

    assert.equal(findings.length, 2);
    assert.equal(findings[0].rule, "generic-api-key");
    assert.equal(findings[1].rule, "literal-db-password");
    assert.equal(JSON.stringify(findings).includes(secret), false);
    assert.equal(JSON.stringify(findings).includes(password), false);
  });

  it("reports multiline literal API-key and DB-password assignments", async (t) => {
    const { scanPaths } = await import(scannerUrl);
    const directory = withTempDir(t);
    const sourcePath = join(directory, "multiline-config.mjs");
    const secret = ["opaque", "multiline", "A".repeat(24)].join("-");
    const password = ["multiline", "db", "B".repeat(18)].join("-");

    writeFileSync(
      sourcePath,
      [
        "const apiKey =",
        `  ${JSON.stringify(secret)};`,
        "const db = {",
        "  password:",
        `    ${JSON.stringify(password)},`,
        "};",
      ].join("\n"),
    );

    const findings = scanPaths([sourcePath]);

    assert.deepEqual(
      findings.map(({ rule, line }) => ({ rule, line })),
      [
        { rule: "generic-api-key", line: 1 },
        { rule: "literal-db-password", line: 4 },
      ],
    );
    assert.equal(JSON.stringify(findings).includes(secret), false);
    assert.equal(JSON.stringify(findings).includes(password), false);
  });

  it("reports a DB-password literal fallback after an environment read", async (t) => {
    const { scanPaths } = await import(scannerUrl);
    const directory = withTempDir(t);
    const sourcePath = join(directory, "password-fallback.mjs");
    const password = ["fallback", "db", "C".repeat(18)].join("-");

    writeFileSync(
      sourcePath,
      `const db = { password: process.env.MYSQL_PASSWORD || ${JSON.stringify(password)} };\n`,
    );

    const findings = scanPaths([sourcePath]);

    assert.deepEqual(
      findings.map(({ rule, line }) => ({ rule, line })),
      [{ rule: "literal-db-password", line: 1 }],
    );
    assert.equal(JSON.stringify(findings).includes(password), false);
  });

  it("does not exempt real-looking credentials containing placeholder substrings", async (t) => {
    const { scanPaths } = await import(scannerUrl);
    const directory = withTempDir(t);
    const sourcePath = join(directory, "placeholder-substrings.mjs");
    const markers = [
      ["te", "st"].join(""),
      ["mo", "ck"].join(""),
      ["fa", "ke"].join(""),
      ["dum", "my"].join(""),
    ];
    const lines = markers.flatMap((marker, index) => {
      const apiKey = ["opaque", marker, "D".repeat(24)].join("-");
      const password = ["opaque", marker, "E".repeat(18)].join("-");
      return [
        `const service${index}ApiKey = ${JSON.stringify(apiKey)};`,
        `const db${index} = { password: ${JSON.stringify(password)} };`,
      ];
    });

    writeFileSync(sourcePath, lines.join("\n"));

    const findings = scanPaths([sourcePath]);

    assert.deepEqual(
      findings.map(({ rule }) => rule),
      markers.flatMap(() => ["generic-api-key", "literal-db-password"]),
    );
  });

  it("ignores assignment-like text inside JS strings and composed placeholder values", async (t) => {
    const { scanPaths } = await import(scannerUrl);
    const directory = withTempDir(t);
    const sourcePath = join(directory, "safe-fixtures.mjs");
    const guidePath = join(directory, "safe-guide.md");
    const urlLine = [
      "const firstUrl = `https://example.invalid/get?corpsecret=",
      "${corpSecret}",
      "`;",
    ].join("");
    const secondUrlLine = [
      "const secondUrl = `https://example.invalid/send?access_token=",
      "${token}",
      "`;",
    ].join("");

    writeFileSync(
      sourcePath,
      [
        urlLine,
        "throw new Error(\"request failed\");",
        secondUrlLine,
        `const password = ["${["syn", "thetic"].join("")}", "parts"].join("-");`,
        "const dbPassword = \"P\".repeat(18);",
      ].join("\n"),
    );
    writeFileSync(
      guidePath,
      [
        "| setup | `export SILICONFLOW_API_KEY=sk-xxx` | placeholder only |",
        "",
        "```bash",
        "node -e \"console.log('ready')\"",
        "```",
      ].join("\n"),
    );

    assert.deepEqual(scanPaths([sourcePath, guidePath]), []);
  });

  it("scans npm tarballs without extracting them", async (t) => {
    const { scanPaths } = await import(scannerUrl);
    const directory = withTempDir(t);
    const packageDirectory = join(directory, "package");
    const sourcePath = join(packageDirectory, "index.mjs");
    const archivePath = join(directory, "fixture.tgz");
    const secret = ["sk", "archive", "B".repeat(24)].join("-");

    mkdirSync(packageDirectory);
    writeFileSync(sourcePath, `export const apiKey = ${JSON.stringify(secret)};\n`);
    execFileSync("tar", ["-czf", archivePath, "-C", directory, "package"]);

    const findings = scanPaths([archivePath]);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "generic-api-key");
    assert.match(findings[0].file, /fixture\.tgz:package\/index\.mjs$/);
    assert.equal(JSON.stringify(findings).includes(secret), false);
    assert.equal(existsSync(join(directory, "extracted")), false);
  });

  it("detects a literal API-key fallback after an environment read", async (t) => {
    const { scanPaths } = await import(scannerUrl);
    const directory = withTempDir(t);
    const sourcePath = join(directory, "fallback-config.mjs");
    const secret = ["opaque", "C".repeat(24)].join("-");

    writeFileSync(
      sourcePath,
      `const apiKey = process.env.SERVICE_API_KEY || ${JSON.stringify(secret)};\n`,
    );

    const findings = scanPaths([sourcePath]);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "generic-api-key");
    assert.equal(JSON.stringify(findings).includes(secret), false);
  });

  it("ignores explicit redaction markers and dummy test keys", async (t) => {
    const { scanPaths } = await import(scannerUrl);
    const directory = withTempDir(t);
    const sourcePath = join(directory, "redacted-config.mjs");

    writeFileSync(
      sourcePath,
      [
        `const config = { password: "${"*".repeat(3)}", apiKey: "${["dummy", "key"].join("-")}" };`,
        `const fixtureA = { password: "${["pa", "ss"].join("")}" };`,
        `const fixtureB = { password: "${["sec", "ret"].join("")}" };`,
      ].join("\n"),
    );

    assert.deepEqual(scanPaths([sourcePath]), []);
  });

  it("ignores tracked files deleted from the working tree", (t) => {
    const directory = withTempDir(t);
    const deletedPath = join(directory, "deleted.mjs");

    execFileSync("git", ["init", "-q"], { cwd: directory });
    writeFileSync(deletedPath, "export const value = 1;\n");
    execFileSync("git", ["add", "deleted.mjs"], { cwd: directory });
    rmSync(deletedPath);

    const result = spawnSync(
      process.execPath,
      [fileURLToPath(scannerUrl), "--tracked"],
      { cwd: directory, encoding: "utf8" },
    );

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), []);
  });
});

describe("packaged plugin security boundary", () => {
  it("does not auto-fork the root-only mock or log customer Brief previews", () => {
    const indexSource = readFileSync(join(repoRoot, "YPmcn/src/index.ts"), "utf8");

    assert.doesNotMatch(indexSource, /fork|YPMCN_START_LOCAL_MCP/);
    assert.doesNotMatch(indexSource, /startMcpServer|raw_messages_preview/);
    assert.equal(existsSync(join(repoRoot, "YPmcn/mock-mcp.mjs")), false);
  });

  it("fails the explicit root mock closed when the DB password is missing", () => {
    const env = { ...process.env };
    for (const name of [
      "MYSQL_PASSWORD",
      "SILICONFLOW_API_KEY",
      "YPMCN_API_KEY",
      "YP_WECOM_API_KEY",
    ]) {
      delete env[name];
    }

    const result = spawnSync(process.execPath, ["mock-mcp.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 1_000,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("MYSQL_PASSWORD"), true);
  });

  it("fails the explicit root mock closed when its backend API credential is missing", () => {
    const env = {
      ...process.env,
      MYSQL_PASSWORD: ["synthetic", "db", "password"].join("-"),
    };
    delete env.YPMCN_API_KEY;
    delete env.YP_WECOM_API_KEY;

    const result = spawnSync(process.execPath, ["mock-mcp.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 1_000,
    });
    const mockSource = readFileSync(join(repoRoot, "mock-mcp.mjs"), "utf8");

    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("YPMCN_API_KEY"), true);
    assert.doesNotMatch(mockSource, /mock_no_backend/);
  });
});
