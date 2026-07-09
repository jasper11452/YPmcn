import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

function packageFiles() {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const [pack] = JSON.parse(output);
  return pack.files.map(({ path }) => path);
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
