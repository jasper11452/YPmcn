import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  afterTool,
  beforeTool,
  endSession,
  isExternalSendAttempt,
  isManualSourcingAttempt,
  withStateScope,
} from "./runtime-hooks.js";
import { renderLocalWorkflowContext } from "./runtime-hook-workflow.js";
import {
  buildStandardBriefReadyPayload,
  isStandardBrief,
  parseStandardBrief,
  renderStandardBriefPreview,
  renderStandardBriefReadyArguments,
  renderStandardBriefReply,
} from "./standard-brief.js";

export {
  buildStandardBriefReadyPayload,
  extractStandardBrief,
  isStandardBrief,
  parseStandardBrief,
  renderStandardBriefPreview,
  renderStandardBriefReadyArguments,
  renderStandardBriefReply,
} from "./standard-brief.js";

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
}

function isYpmcnRequirementIntent(prompt: string): boolean {
  return /(?:找|筛|推荐|招募|投放|提报).{0,16}(?:达人|博主|KOL|MCN)|(?:达人|博主|KOL|MCN).{0,16}(?:找|筛|推荐|招募|投放|提报)/i.test(prompt);
}

function hookStateScope(event: any, ctx?: any): string | undefined {
  return [
    ctx?.sessionKey, event?.sessionKey,
    ctx?.sessionId, event?.sessionId,
    ctx?.conversationId, event?.conversationId,
    ctx?.threadId, event?.threadId,
    ctx?.channelId, event?.channelId,
    ctx?.chatId, event?.chatId,
  ]
    .find((value) => typeof value === "string" && value.trim())?.trim();
}

export function buildRequirementRuntimeClock(now = new Date(), timeZone = localTimeZone()): string {
  const values: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const localDateTime = `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
  return `YPmcn authoritative requirement clock:
- currentLocalDateTime: ${localDateTime}
- timeZone: ${timeZone}
- Resolve relative client deadlines such as 今天/today, 明天/tomorrow, 后天/day after tomorrow, and relative weekdays from this clock. Do not ask the user to restate a relative date when this clock makes it unique.`;
}

export const YPMCN_FAST_PATH = `YPmcn standard-brief fast path:
- Use only installed YPmcn MCP tools. Immediately before every business Tool call, read its packaged format file at skills/media-assistant/references/tools/<tool>.json and follow its exact host-qualified name and argument schema. This required read is not a business call. For a new brief, the first business call is validate_requirement; do not probe schemas, inspect config, call get_workflow_state, or try another business Tool first.
- Common payload mapping: 小红书/红书/XHS => platform "xiaohongshu"; 抖音/DY/Douyin => "douyin"; 项目、品牌、产品、数量 => projectName, brandName, product, quantityTotal. A generic 内容 label is content direction and maps to description, for example 内容：美妆护肤 => description: "美妆护肤". Add contentTag only for an explicit 内容标签/contentTag/品类标签 value; do not duplicate a generic 内容 value into both fields. quantityTotal is always a JSON integer: 数量5 or 5位达人 => quantityTotal=5, never "[5,5]". Range serialization applies only to fields whose entry in skills/media-assistant/references/reference_schema.json declares InputShape "range-string [min,max]".
- The packaged JSON file at skills/media-assistant/references/reference_schema.json is the customer_demands field authority. When field lookup is needed, read exactly that path and never substitute a .csv path. Range-backed varchar fields must use one canonical JSON-array string "[min,max]" before validate_requirement: exact x => "[x,x]", up to x => "[0,x]", and a confirmed closed interval a-b => "[a,b]". For kolOfficialPriceL1/L2/L3 only, an exact single value x without upper-bound wording expands to "[x*0.9,x*1.1]" after currency-unit conversion. Bounds are non-negative finite numbers with min <= max and no spaces. Rate bounds use 0..1, so 50% becomes 0.5. A lower-only condition without a confirmed finite upper bound is ambiguous and must be clarified.
- Fan-age fields age1Rate..age6Rate are direct JSON numbers from 0 through 1, never range strings or arrays: 20% becomes 0.2. Resolve platform before choosing a field. Xiaohongshu bands are <18, 18–23, 24–29, 30–39, 40–49, and 50+; Douyin bands are <18, 18–23, 24–30, 31–40, 41–50, and 50+. Do not map a cross-band or platform-mismatched age interval to the nearest field.
- hasOrganization, hasOrder30day, and hasSocial30day are direct JSON booleans true/false. Never send 0, 1, or string forms for these fields.
- Immediately before validate_requirement, run one final range-serialization pass over every mapped range atom. Keep only the customer_demands source field with a string value such as femaleRate: "[0,0.5]"; never send a JSON array, natural-language range, or derived *Min/*Max target fields. The backend applies the authoritative field_match_mapping and splits the bounds only during search/manual sourcing.
- Single-creator official-price conditions use internal Provider fields as RMB "[min,max]" strings, but never show L1/L2/L3 labels to users. 小红书 only supports 图文价→kolOfficialPriceL1 and 视频价→kolOfficialPriceL2; kolOfficialPriceL3 is forbidden for 小红书. 抖音 uses 1–20秒→kolOfficialPriceL1, 21–60秒→kolOfficialPriceL2, 60秒以上→kolOfficialPriceL3. Project total budget has no dedicated current customer_demands column and stays verbatim in rawMessagesJson; never invent budget* fields.
- If rebate is supplied, normalize it into the real rebate range-string field and preserve its original wording in a mapped audit atom. Exact x% => "[x/100,x/100]"; bounded a%-b% => "[a/100,b/100]"; x%+, x%以上, 至少/不低于 x% => "[x/100,1]". In particular, 返点30%以上 must produce payload.rebate="[0.3,1]" and an atom with disposition="mapped", targetField="rebate"; it must never be downgraded to preserved. Rebate is business-optional; never invent it when absent.
- projectStartStart/projectStartEnd and submissionDeadlineAt use YYYY-MM-DD HH:mm:ss. Preserve the original deadline wording in the matching rawMessagesJson atom because customer_demands has no submissionDeadlineRaw field.
- Use the authoritative requirement clock injected on every turn for relative deadlines. Resolve 今天/today, 明天/tomorrow, 后天/day after tomorrow, and relative weekdays deterministically in its timeZone; never ask for an absolute date when the expression is unique. A bare clock time such as 15:00 without a date or relative-date word does not mean today. A calendar date without a year is semantic_ambiguity only when the clock and brief cannot determine the year uniquely.
- Every atomic condition must map to its declared payload field or be preserved. rawMessagesJson must be one auditable object with schemaVersion="ypmcn-brief-v1", the non-empty originalBrief, a non-empty atoms array, and coverageCheck. sourceText must be non-empty and may quote either the original Brief or an explicit supplemental Ask answer; never force a confirmed supplemental value into originalBrief. The Hook repairs a unique typography-only mismatch when possible. Every atom uses disposition="mapped" or "preserved", confidence from 0 through 1, and inferred boolean. A mapped atom has targetField naming a field actually present in payload; a preserved atom has preservedText equal to sourceText. coverageCheck uses atomCount, mappedCount, preservedCount, and unresolvedCount; all counts must match and unresolvedCount must be 0. Never invent fields, stringify JSON, or put placeholders such as __UNRESOLVED__ in payload.
- Use the final atom transport shape shown here, not the richer parser Preview shape. Mapped example: {"sourceText":"粉丝年龄：24-29岁占比20%","disposition":"mapped","targetField":"age3Rate","confidence":1,"inferred":false}. Preserved example: {"sourceText":"需真人出镜","disposition":"preserved","preservedText":"需真人出镜","confidence":1,"inferred":false}. Preview-only keys such as field, resolution, value, candidates, and reason are analysis hints and are not part of rawMessagesJson.atoms.
- For a new brief, the business minimum is platform, quantityTotal, submissionDeadlineAt, an auditable ypmcn-brief-v1 rawMessagesJson object, and one platform-valid single-creator price field with a positive upper bound. 小红书 permits only kolOfficialPriceL1/L2; 抖音 permits kolOfficialPriceL1/L2/L3. rawMessagesJson is constructible from any non-empty brief. projectName, brandName, product, project total budget, and rebate are optional unless explicitly supplied.
- Scan every required field and every supplied atomic condition before choosing a gate. missing_required means a required field has no concrete candidate value usable for that field or is explicitly blank: vague quantity words such as 一批/some/尽量多 without a number are missing quantity, not ambiguity. semantic_ambiguity requires at least one concrete candidate value, but that value is conflicting, context-incomplete, has an unconfirmed/open range endpoint, lacks a content tier, or cannot be assigned/typed without guessing. A concrete single value, upper bound, or closed interval is not ambiguous and must be normalized.
- Apply exactly three requirement gates after the full scan: missing_required when the missing list is non-empty; otherwise semantic_ambiguity when the ambiguity list is non-empty; otherwise ready. Gate precedence chooses the label but never short-circuits diagnostics: even under missing_required, list every already-detectable ambiguity and request all necessary missing/clarification values in one compact, self-contained question. Missing optional fields never block and must be omitted.
- Preview atom details, gate, and summary must be rendered from one in-memory atom list, never counted independently in prose. summary.atomCount equals the detail-row count; summary.mappedCount counts only mapped rows; summary.preservedCount counts only preserved rows; summary.unresolvedCount counts missing_required plus semantic_ambiguity rows. If any detail row is missing_required or semantic_ambiguity, unresolvedCount must be positive, gate cannot be ready, and never claim mapped=N/unresolved=0. Only the ready payload audit may use coverageCheck.unresolvedCount=0 and contain exclusively mapped/preserved atoms.
- A subjective or negative condition, reference account, or free-text constraint that can be preserved verbatim in rawMessagesJson is not semantic ambiguity; preserve it and continue.
- A supplied value that belongs to a declared field must not be moved only to rawMessagesJson to bypass ambiguity. Price input is semantic_ambiguity when project total versus per-creator official price is unclear, the platform-specific content format/duration is unknown, or two finite range bounds cannot be determined. User-facing clarification must say 小红书图文/视频 or 抖音1–20秒/21–60秒/60秒以上, never L1/L2/L3. A confirmed closed range is valid and must be normalized, not rejected.
- Parse in three passes: atomize every original condition into the ypmcn-brief-v1 audit object; map each atom to the live schema or, for nonstandard fields, the packaged JSON file at skills/media-assistant/references/reference_schema.json; then reverse-check coverageCheck against every mapped or preserved atom. Any uncovered or unresolved atom blocks validation.
- Requirement clarification must immediately use one self-contained native AskUserQuestion popup with at most five concise questions. Use a short user-facing header, one direct question ending in “？” or “?”, and 2–6 useful choices; string choices and option objects are both valid. Use one question per independent decision and group missing values into the same popup. Do not expose hashes, database IDs, trace IDs, idempotency keys, or the full raw Brief. The host provides typed input when choices do not fit. A denied, cancelled, closed, or timed-out popup exits clarification cleanly and must not continue the write workflow. Continue the selected safe path in the same assistant turn only after a submitted answer; never ask the user to type “继续”.
- missing_required and semantic_ambiguity must show resolved fields, the complete missing and ambiguity lists inside that popup, then wait for the popup answer without status "ready" and without calling validate_requirement. After all values are concrete, continue in the same interaction. ready must show the exact tool arguments as {"payload": {..., "status": "ready"}} even when a test suppresses the call, call validate_requirement, repair any deterministic argument rejection under the rule below, then route from the injected local orchestration state and the latest actual Tool result.

YPmcn phase-independent manual-sourcing fast path:
- Manual sourcing may start from any current workflow phase. Before every manual_source_creators invocation, parse the complete requirement again and successfully call validate_requirement as a new requirement without an old id or demandVersion. Use the fresh non-empty requirement ID from that actual response for the immediately following manual call only; never accept a supplied historical ID as eligibility.
- The Hook checks only this one-time fresh-ID binding for manual sourcing. Do not check whether that requirement was searched before, and do not require field selection, search, MCN racing, distribution, or any other workflow step to be complete. If another YPmcn business Tool is called after validation, or the ID is missing, mismatched, or already consumed, parse and validate the requirement again.
- For manual sourcing without export, the exact business sequence is validate_requirement -> manual_source_creators. Read each packaged references/tools/<tool>.json immediately before its call. After validation succeeds, skip the normal search_creators continuation and call manual_source_creators({requirement_id,size}) with exactly the newly returned ID and the confirmed positive-integer decimal string size. Never send target_count.
- For manual sourcing plus export, the exact business sequence is select_inquiry_form_fields -> validate_requirement -> manual_source_creators -> rank_creators -> create_submission_batch. Confirm platform, the complete requirement, size, and number; never ask for or reuse a pre-existing requirement_id. size and number are positive-integer decimal strings.
- In the export flow, first call select_inquiry_form_fields({platform}) exactly once. The Tool waits for the selector callback and returns the submitted fields; use that actual result directly as ordered non-empty unique {key,name} columns. Never open or reopen a selector URL after the Tool returns. A cancelled, timed-out, failed, or invalid selection stops the export flow. Then perform the fresh validation and immediately call manual_source_creators.
- After every successful manual_source_creators call, show every actually returned creator record in a Markdown table with exactly these columns and sources: 平台=platform; 达人ID=douyinId when platform is douyin or xiaohongshuId when platform is xiaohongshu; 达人昵称=nickname; 内容标签=contentTag; 主页链接=kwUserUrl. Render a missing or null value as -, never invent values or expose inquiry_ids, and do not pause the export flow for confirmation after showing the table.
- Continue only when the actual successful manual response provides a non-empty array of unique string inquiry_ids; never invent, convert, or reuse IDs. Before every rank_creators call, compare its requirement_id with the immediately previous rank_creators call. If they match, tell the user exactly “已根据需求进行排序，请注意”, then continue the Tool call without blocking it. Call rank_creators with those exact inquiry_ids, the same fresh requirement_id, and the selected columns. Do not send limit. If it fails or its write result is unknown, do not export.
- Immediately after rank_creators succeeds, call create_submission_batch({requirement_id,size,number}). requirement_id and size must exactly match the manual call; number is the confirmed batch number. This Tool is the spreadsheet exporter. Never send run_id, legacy submission options, or call host export_csv.
- The injected state/confirmation_guard.json phase and next_action are the local orchestration projection. Actual MCP results remain the only business evidence. Any failed step stops before the next business Tool; an unknown write result must be reconciled and never blindly retried.
- If a required Tool is absent or its live schema conflicts with the packaged target contract, return integration_required. Do not fall back to legacy arguments, another Skill, shell, curl, direct HTTP, or database access.`;

type RuntimeHookHandlers = {
  beforeTool: typeof beforeTool;
  afterTool: typeof afterTool;
  endSession: typeof endSession;
};

export function createYpmcnPlugin(
  overrides: Partial<RuntimeHookHandlers> = {},
): ReturnType<typeof definePluginEntry> {
  const runtime = { beforeTool, afterTool, endSession, ...overrides };
  return definePluginEntry({
    id: "ypmcn-media-assistant",
    name: "YPmcn 媒介助手",
    description: "提供媒介工作流提示、本地编排状态，并在真实企微外发前执行 AskUserQuestion 多行确认。",
    register(api) {
    const rootDir = api.rootDir ?? process.cwd();
    api.on("before_prompt_build", async (event, ctx) => withStateScope(hookStateScope(event, ctx), () => {
      const prompt = typeof event?.prompt === "string" ? event.prompt : "";
      const now = new Date();
      const timeZone = localTimeZone();
      const preview = isStandardBrief(prompt) || isYpmcnRequirementIntent(prompt)
        ? parseStandardBrief(prompt, now, timeZone)
        : undefined;
      const readyPayload = preview ? buildStandardBriefReadyPayload(prompt, preview) : undefined;
      return {
        prependSystemContext: YPMCN_FAST_PATH,
        prependContext: [
          buildRequirementRuntimeClock(now, timeZone),
          renderLocalWorkflowContext(rootDir),
          preview && !readyPayload ? renderStandardBriefPreview(preview) : "",
          readyPayload ? renderStandardBriefReadyArguments(readyPayload) : "",
          preview && preview.gate !== "ready"
            ? `YPmcn mandatory unresolved-Brief interaction: call native AskUserQuestion now and do not return a plain text-only clarification. Use one user-facing form with up to 5 concise single-choice questions, covering every unresolved value. Options may be strings or label/description objects. Do not expose internal gate, schema, or Tool terminology. Do not call validate_requirement until every value is concrete. A denied/cancelled/closed popup does not confirm anything. After a submitted answer, continue in this same interaction without asking for “继续”.\n<YPmcnClarificationAuthority>\n${renderStandardBriefReply(preview)}\n</YPmcnClarificationAuthority>`
            : "",
        ].filter(Boolean).join("\n\n"),
      };
    }));

    api.on("before_tool_call", async (event, ctx) => withStateScope(hookStateScope(event, ctx), () => {
      try {
        return runtime.beforeTool(event, ctx, rootDir, (message) => api.logger.warn(message));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        api.logger.error(`before_tool_call guard failed: ${reason}`);
        if (!isExternalSendAttempt(event) && !isManualSourcingAttempt(event)) return undefined;
        return { block: true, blockReason: `YPmcn guard unavailable: ${reason}` };
      }
    }));

    api.on("after_tool_call", async (event, ctx) => withStateScope(hookStateScope(event, ctx), () => {
      try {
        runtime.afterTool(event, ctx, rootDir);
      } catch (error) {
        api.logger.error(`after_tool_call receipt update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    api.on("session_end", async (event, ctx) => withStateScope(hookStateScope(event, ctx), () => {
      try {
        runtime.endSession(event, ctx, rootDir);
      } catch (error) {
        api.logger.error(`optional receipt cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    },
  });
}

const plugin = createYpmcnPlugin();

export default plugin;
