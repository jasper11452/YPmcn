import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function packageFiles() {
  const packageJson = JSON.parse(readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  return packageJson.files;
}

describe("plugin packaging", () => {
  it("does not include scripts directory", () => {
    const files = packageFiles();
    assert.ok(!files.some((path) => path.startsWith("scripts/")));
  });

  it("includes skill references", () => {
    const files = packageFiles();
    assert.ok(files.some((path) => path.startsWith("skills/")));
  });
});
