import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function json(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}

describe("root workspace installation", () => {
  it("locks every buildable component for one root npm ci", () => {
    const expectedWorkspaces = ["YPmcn"];
    const rootPackage = json("package.json");
    const rootLock = json("package-lock.json");

    assert.deepEqual(rootPackage.workspaces, expectedWorkspaces);
    assert.deepEqual(rootLock.packages[""].workspaces, expectedWorkspaces);

    for (const workspace of expectedWorkspaces) {
      const workspacePackage = json(`${workspace}/package.json`);
      const workspaceLock = json(`${workspace}/package-lock.json`);
      const rootWorkspaceEntry = rootLock.packages[workspace];
      const rootLinkEntry = rootLock.packages[`node_modules/${workspacePackage.name}`];

      assert.ok(rootWorkspaceEntry, `missing root lock entry for ${workspace}`);
      assert.equal(rootWorkspaceEntry.version, workspacePackage.version);
      assert.deepEqual(
        rootWorkspaceEntry.dependencies ?? {},
        workspacePackage.dependencies ?? {},
      );
      assert.deepEqual(
        rootWorkspaceEntry.devDependencies ?? {},
        workspacePackage.devDependencies ?? {},
      );
      assert.deepEqual(workspaceLock.packages[""].dependencies ?? {}, workspacePackage.dependencies ?? {});
      assert.deepEqual(
        workspaceLock.packages[""].devDependencies ?? {},
        workspacePackage.devDependencies ?? {},
      );
      assert.deepEqual(rootLinkEntry, { resolved: workspace, link: true });
    }
  });
});
