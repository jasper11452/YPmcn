import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { createYpmcnPlugin } from "../dist/index.js";

const rootDir = mkdtempSync(join(tmpdir(), "ypmcn-public-hooks-"));
const templateFile = join(rootDir, "skills", "media-assistant", "assets", "wecom_inquiry_template.txt");
const hooks = new Map();
const INCOMPLETE_BRIEF = "找一批达人推广新品，预算稍后确认。";
const READY_BRIEF = [
  "平台：小红书",
  "数量：5位达人",
  "单达人L1官方报价：5000元以内",
  "内容：美妆护肤",
  "粉丝年龄：24-29岁占比20%",
  "是否有机构：0",
  "提报截止：2099-07-20 11:00",
].join("\n");

before(() => {
  mkdirSync(dirname(templateFile), { recursive: true });
  copyFileSync(fileURLToPath(new URL("../skills/media-assistant/assets/wecom_inquiry_template.txt", import.meta.url)), templateFile);
  createYpmcnPlugin().register({
    rootDir,
    logger: { error() {} },
    on(name, handler) { hooks.set(name, handler); },
  });
});

after(() => rmSync(rootDir, { recursive: true, force: true }));

describe("requirement behavior through public plugin hooks", () => {
  it("keeps internal previews in clarification guidance and publishes one ready argument example", async () => {
    const unresolved = await hooks.get("before_prompt_build")({ prompt: INCOMPLETE_BRIEF, messages: [] }, {});
    assert.match(unresolved.prependContext, /YPmcn internal requirement-analysis guide for clarification only/);
    assert.doesNotMatch(unresolved.prependContext, /YPmcn ready-to-use validate_requirement argument example/);
    assert.match(unresolved.prependContext, /YPmcn mandatory unresolved-Brief interaction/);

    const ready = await hooks.get("before_prompt_build")({ prompt: READY_BRIEF, messages: [] }, {});
    assert.match(ready.prependContext, /YPmcn ready-to-use validate_requirement argument example/);
    assert.doesNotMatch(ready.prependContext, /YPmcnInternalRequirementPreview/);

    const args = JSON.parse(ready.prependContext.trim().split("\n").at(-1));
    assert.equal(args.payload.description, "美妆护肤");
    assert.equal(args.payload.contentTag, undefined);
    assert.equal(args.payload.age3Rate, 0.2);
    assert.equal(args.payload.hasOrganization, false);
    assert.ok(args.payload.rawMessagesJson.atoms.every((atom) =>
      !Object.hasOwn(atom, "field") && !Object.hasOwn(atom, "resolution") && !Object.hasOwn(atom, "value")
    ));
  });

  it("does not turn unresolved requirement guidance into a Tool permission gate", async () => {
    await hooks.get("before_prompt_build")({ prompt: INCOMPLETE_BRIEF, messages: [] }, {});
    for (const [toolName, params] of [
      ["read", { file_path: "/tmp/SKILL.md" }],
      ["ypmcn-mcp__prompts_get", { name: "media-assistant" }],
      ["mcp__ypmcn__validate_requirement", { payload: { status: "draft" } }],
      ["mcp__ypmcn__search_creators", { id: "any-id" }],
    ]) {
      assert.equal(await hooks.get("before_tool_call")({ toolName, params }, {}), undefined, toolName);
    }
  });

  it("does not bind a ready preview to validate_requirement as the only permitted Tool", async () => {
    await hooks.get("before_prompt_build")({ prompt: READY_BRIEF, messages: [] }, {});
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_creator_detail",
      params: { kwUid: "untrusted-but-provider-validated" },
    }, {}), undefined);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { status: "ready" } },
    }, {}), undefined);
  });
});
