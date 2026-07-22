import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

  it("publishes deterministic same-platform requirement units from one raw Brief", async () => {
    const brief = [
      "项目：同项目双需求",
      "平台：小红书",
      "单达人L1官方报价：8000元以内",
      "数量：2位达人",
      "母婴类达人且粉丝2万以上",
      "科技类达人且粉丝1万以上",
      "提报截止：2099-07-20 11:00",
    ].join("；");
    const intake = await hooks.get("before_prompt_build")({ prompt: brief, messages: [] }, {});
    const serialized = intake.prependContext.split("\n").find((line) => line.startsWith('{"payloads":'));
    const { payloads } = JSON.parse(serialized);

    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads.map(({ contentTag, followercount }) => ({ contentTag, followercount })), [
      { contentTag: "母婴", followercount: "[20000,999999999]" },
      { contentTag: "科技", followercount: "[10000,999999999]" },
    ]);
    assert.ok(payloads.every((payload) => payload.rawMessagesJson.originalBrief === brief));
  });

  it("runs split Brief units in stable order and resumes the next unit after completion", async () => {
    const context = { sessionKey: "public-split-execution-order" };
    const brief = [
      "项目：同项目双需求执行",
      "平台：小红书",
      "单达人L1官方报价：8000元以内",
      "数量：2位达人",
      "母婴类达人且粉丝2万以上",
      "科技类达人且粉丝1万以上",
      "提报截止：2099-07-20 11:00",
    ].join("；");
    const intake = await hooks.get("before_prompt_build")({ prompt: brief, messages: [] }, context);
    const serialized = intake.prependContext.split("\n").find((line) => line.startsWith('{"payloads":'));
    const { payloads } = JSON.parse(serialized);
    const requirementIds = [301, 302].map((value) => value.toString(16).padStart(32, "0"));

    for (const [index, payload] of payloads.entries()) {
      await hooks.get("after_tool_call")({
        toolName: "mcp__ypmcn__validate_requirement",
        params: { payload },
        result: { success: true, data: { id: requirementIds[index] }, error: null },
      }, context);
    }

    const stateFile = join(
      rootDir,
      "state",
      "sessions",
      createHash("sha256").update(context.sessionKey).digest("hex").slice(0, 24),
      "confirmation_guard.json",
    );
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    const unitIds = requirementIds.map((id) => state.requirement_execution_unit_ids[
      createHash("sha256").update(id).digest("hex")
    ]);
    assert.deepEqual(
      state.execution_unit_order.filter((id) => unitIds.includes(id)),
      unitIds,
    );

    await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__rank_mcns",
      params: { id: requirementIds[0], platform: "xiaohongshu" },
    }, context);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__record_client_feedback",
      params: {},
      result: { success: true, data: {}, error: null },
    }, context);

    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.execution_units[unitIds[0]].status, "completed");
    assert.equal(state.active_execution_unit_id, unitIds[1]);
    assert.equal(state.execution_units[unitIds[1]].status, "active");
    assert.equal(state.workflow.next_action, "search_creators");
  });

  it("accepts equivalent Brief line endings and blank-line layout without accepting text changes", async () => {
    const compactBrief = READY_BRIEF.replace("美妆护肤", "空行归一化测试");
    const blankLineBrief = compactBrief.split("\n").join("\r\n\r\n");
    await hooks.get("before_prompt_build")({ prompt: blankLineBrief, messages: [] }, {});

    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { rawMessagesJson: { originalBrief: compactBrief } } },
    }, {}), undefined);
    const changed = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { rawMessagesJson: { originalBrief: compactBrief.replace("空行归一化测试", "文字已改变") } } },
    }, {});
    assert.equal(changed.errorCode, "INVALID_INPUT");
  });

  it("authorizes validate_requirement from the persisted session Brief receipt", async () => {
    const sessionId = "persisted-brief-receipt";
    const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    const brief = READY_BRIEF.replace("美妆护肤", "持久回执测试");
    const context = { sessionId };
    const intake = await hooks.get("before_prompt_build")({ prompt: brief, messages: [] }, context);
    assert.match(intake.prependContext, /authoritative originalBrief for validate_requirement/);
    assert.match(intake.prependContext, /持久回执测试/);

    const persisted = JSON.parse(readFileSync(
      join(rootDir, "state", "sessions", sessionHash, "confirmation_guard.json"),
      "utf8",
    ));
    assert.ok(Object.values(persisted.requirement_brief_receipts).every((expiresAt) => expiresAt > Date.now()));

    const call = {
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { rawMessagesJson: { originalBrief: brief } } },
    };
    assert.equal(await hooks.get("before_tool_call")(call, context), undefined);
    assert.equal(await hooks.get("before_tool_call")(call, {}), undefined);

    const missing = await hooks.get("before_tool_call")({
      ...call,
      params: { payload: { rawMessagesJson: { originalBrief: `${brief}被修改` } } },
    }, {});
    assert.equal(missing.errorCode, "INVALID_INPUT");
    assert.match(missing.blockReason, /does not match any active persisted Brief receipt/);
  });

  it("keeps the exact Brief available after AskUserQuestion and accepts the next validation", async () => {
    const brief = [
      "品牌：阿里巴巴",
      "项目：千问61儿童节",
      "平台：抖音",
      "内容形式：视频",
      "档期：7.30-7.31",
      "单价：4w以下",
      "返点：26%以上",
      "内容：类似于AI帮忙送儿童节礼物",
      "账号类型：母婴类，亲子相关",
      "数量：5个",
      "提报时间：7月25号上午11:00",
    ].join("\n\n");
    const wrapped = `[Current user request]\n单独调用validate_requirements工具：\n${brief}`;
    const context = { sessionId: "brief-after-ask" };
    const first = await hooks.get("before_prompt_build")({ prompt: wrapped, messages: [] }, context);
    assert.match(first.prependContext, /"platform":"douyin"/);
    assert.match(first.prependContext, /"missingRequired":\[\]/);

    const afterAsk = await hooks.get("before_prompt_build")({
      prompt: "1–20秒视频",
      messages: [{ role: "user", content: wrapped }],
    }, context);
    const authoritativeLine = afterAsk.prependContext.split("\n")
      .find((line) => line.startsWith('{"originalBrief":'));
    assert.equal(JSON.parse(authoritativeLine).originalBrief, brief);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { rawMessagesJson: { originalBrief: brief } } },
    }, context), undefined);
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

  it("keeps the real client Brief across host wrapping and requirement JSON follow-ups", async () => {
    const originalBrief = READY_BRIEF.replace("美妆护肤", "母婴亲子");
    const wrappedPrompt = [
      "Sender (untrusted metadata):",
      "```json",
      '{"name":"LobsterAI"}',
      "```",
      "[LobsterAI system instructions]",
      "Apply the instructions below as the highest-priority guidance for this session.",
      "[Current user request]",
      originalBrief,
    ].join("\n");
    const first = await hooks.get("before_prompt_build")({ prompt: wrappedPrompt, messages: [] }, {});
    const firstArgs = JSON.parse(first.prependContext.trim().split("\n").at(-1));
    assert.equal(firstArgs.payload.rawMessagesJson.originalBrief, originalBrief);
    assert.doesNotMatch(first.prependContext, /Sender \(untrusted metadata\)/);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: firstArgs,
    }, {}), undefined);

    const payloadBrief = originalBrief.replace("母婴亲子", "被改写的结构化内容");
    const payloadFollowUp = [
      "我之前这样写过：",
      JSON.stringify({
        payload: {
          rawMessagesJson: {
            schemaVersion: "ypmcn-brief-v1",
            originalBrief: payloadBrief,
          },
        },
      }),
    ].join("\n");
    const second = await hooks.get("before_prompt_build")({
      prompt: `[Current user request]\n${payloadFollowUp}`,
      messages: [{ role: "user", content: wrappedPrompt }],
    }, {});
    assert.doesNotMatch(second.prependContext, /YPmcnInternalRequirementPreview/);
    assert.doesNotMatch(second.prependContext, /ready-to-use validate_requirement argument example/);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: firstArgs,
    }, {}), undefined);

    const rewritten = structuredClone(firstArgs);
    rewritten.payload.rawMessagesJson.originalBrief = payloadBrief;
    const blocked = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: rewritten,
    }, {});
    assert.equal(blocked.errorCode, "INVALID_INPUT");
  });

  it("uses an explicit payload originalBrief only as a no-history compatibility fallback", async () => {
    const originalBrief = READY_BRIEF.replace("美妆护肤", "无历史兼容需求");
    const artifact = JSON.stringify({
      payload: {
        rawMessagesJson: {
          schemaVersion: "ypmcn-brief-v1",
          originalBrief,
        },
      },
    });
    const result = await hooks.get("before_prompt_build")({ prompt: artifact, messages: [] }, {});
    assert.doesNotMatch(result.prependContext, /YPmcnInternalRequirementPreview/);
    assert.equal(await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { rawMessagesJson: { originalBrief } } },
    }, {}), undefined);
    const wholeArtifact = await hooks.get("before_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload: { rawMessagesJson: { originalBrief: artifact } } },
    }, {});
    assert.equal(wholeArtifact.errorCode, "INVALID_INPUT");
  });

  it("keeps one exact multi-platform Brief across independently validated payloads", async () => {
    const originalBrief = "我在做千问7月推广，要找母婴或亲子达人，抖音图文预算2万到4万，小红书视频预算3万到4万，下周三前提报";
    const intake = await hooks.get("before_prompt_build")({ prompt: originalBrief, messages: [] }, {});
    assert.match(intake.prependContext, /authoritative multi-platform intake/);
    assert.match(intake.prependContext, /抖音 -> 小红书/);
    assert.match(intake.prependContext, /never ask which platform to process first/);
    assert.match(intake.prependContext, /call one native AskUserQuestion containing every necessary question/);
    assert.match(intake.prependContext, /Ask one question per shared missing value, not one copy per platform/);
    assert.match(intake.prependContext, /Continue the remaining platform automatically/);
    assert.doesNotMatch(intake.prependContext, /YPmcnInternalRequirementPreview/);
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
