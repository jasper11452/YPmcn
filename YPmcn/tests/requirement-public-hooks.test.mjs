import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  "提报截止：2099-07-20 11:00。",
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

  it("keeps ordinary tools available while enforcing Brief and primary-key preflights", async () => {
    await hooks.get("before_prompt_build")({ prompt: INCOMPLETE_BRIEF, messages: [] }, {});
    const persistedState = readFileSync(join(rootDir, "state", "confirmation_guard.json"), "utf8");
    assert.doesNotMatch(persistedState, new RegExp(INCOMPLETE_BRIEF));
    assert.match(persistedState, /"source_brief_sha256": "[0-9a-f]{64}"/);
    for (const [toolName, params] of [
      ["read", { file_path: "/tmp/SKILL.md" }],
      ["ypmcn-mcp__prompts_get", { name: "media-assistant" }],
    ]) {
      assert.equal(await hooks.get("before_tool_call")({ toolName, params }, {}), undefined, toolName);
    }
    const exactBrief = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { rawMessagesJson: { originalBrief: INCOMPLETE_BRIEF } } },
    }, {});
    assert.equal(exactBrief, undefined);
    const truncatedBrief = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { rawMessagesJson: { originalBrief: INCOMPLETE_BRIEF.slice(0, -1) } } },
    }, {});
    assert.equal(truncatedBrief.errorCode, "INVALID_INPUT");
    const badSearch = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__search_creators",
      params: { id: "1784689136279241" },
    }, {});
    assert.equal(badSearch.errorCode, "INVALID_INPUT");
    assert.match(badSearch.blockReason, /data\.id/);
  });

  it("does not bind a ready preview to validate_requirement as the only permitted Tool", async () => {
    const ready = await hooks.get("before_prompt_build")({ prompt: READY_BRIEF, messages: [] }, {});
    const args = JSON.parse(ready.prependContext.trim().split("\n").at(-1));
    assert.equal(args.payload.rawMessagesJson.originalBrief, READY_BRIEF);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__get_creator_detail",
      params: { kwUid: "untrusted-but-provider-validated" },
    }, {}), undefined);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: args,
    }, {}), undefined);
    const modified = structuredClone(args);
    modified.payload.rawMessagesJson.originalBrief = `需求A-20260722：${modified.payload.rawMessagesJson.originalBrief}`;
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: modified,
    }, {});
    assert.equal(blocked.errorCode, "INVALID_INPUT");
    assert.match(blocked.blockReason, /never add retry markers/);
  });

  it("keeps one exact multi-platform Brief across independently validated payloads", async () => {
    const originalBrief = "我在做千问7月推广，要找母婴或亲子达人，抖音图文预算2万到4万，小红书视频预算3万到4万，下周三前提报";
    await hooks.get("before_prompt_build")({ prompt: originalBrief, messages: [] }, {});
    const payloadFor = (platform, targetField, preservedText) => ({
      platform,
      quantityTotal: 10,
      [targetField]: platform === "douyin" ? "[20000,40000]" : "[30000,40000]",
      rawMessagesJson: {
        schemaVersion: "ypmcn-brief-v1",
        originalBrief,
        atoms: [{
          sourceText: preservedText,
          disposition: "preserved",
          preservedText,
          confidence: 1,
          inferred: false,
        }],
        coverageCheck: { atomCount: 1, mappedCount: 0, preservedCount: 1, unresolvedCount: 0 },
      },
      status: "ready",
    });
    const douyin = payloadFor("douyin", "kolOfficialPriceL1", "小红书视频预算3万到4万");
    const xiaohongshu = payloadFor("xiaohongshu", "kolOfficialPriceL2", "抖音图文预算2万到4万");
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: douyin },
    }, {}), undefined);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: xiaohongshu },
    }, {}), undefined);
    assert.equal(douyin.rawMessagesJson.originalBrief, xiaohongshu.rawMessagesJson.originalBrief);

    xiaohongshu.rawMessagesJson.originalBrief = originalBrief.replace("抖音图文预算2万到4万，", "");
    const reconstructed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: xiaohongshu },
    }, {});
    assert.equal(reconstructed.errorCode, "INVALID_INPUT");
  });
});
