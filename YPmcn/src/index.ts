import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  afterTool,
  beforeTool,
  beginPromptTurn,
  blockedToolTurnFailure,
  endSession,
  recordBlockedToolResult,
  withStateScope,
} from "./runtime-hooks.js";
import {
  buildStandardBriefReadyPayload,
  isStandardBrief,
  parseStandardBrief,
  renderStandardBriefPreview,
  renderStandardBriefReadyArguments,
  renderStandardBriefReply,
} from "./standard-brief.js";
import { isAskTool } from "./runtime-hook-workflow.js";

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
  return [ctx?.sessionKey, event?.sessionKey, ctx?.sessionId, event?.sessionId]
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
- Use only installed YPmcn MCP tools. For a new brief, the first business call is validate_requirement; do not read Skill files, probe schemas, inspect config, call get_workflow_state, or try another business tool first.
- Common payload mapping: 小红书/红书/XHS => platform "xiaohongshu"; 抖音/DY/Douyin => "douyin"; 项目、品牌、产品、数量 => projectName, brandName, product, quantityTotal; industry/content wording maps only to the real contentTag/description/label fields when their meaning is exact. quantityTotal is always a JSON integer: 数量5 or 5位达人 => quantityTotal=5, never "[5,5]". Range serialization applies only to fields whose schema/CSV declares a range-backed varchar.
- The packaged customer_demands CSV is the field authority. Range-backed varchar fields must use one canonical JSON-array string "[min,max]" before validate_requirement: exact x => "[x,x]", up to x => "[0,x]", and a confirmed closed interval a-b => "[a,b]". Bounds are non-negative finite numbers with min <= max and no spaces. Rate bounds use 0..1, so 50% becomes 0.5. A lower-only condition without a confirmed finite upper bound is ambiguous and must be clarified.
- Immediately before validate_requirement, run one final range-serialization pass over every mapped range atom. Keep only the customer_demands source field with a string value such as femaleRate: "[0,0.5]"; never send a JSON array, natural-language range, or derived *Min/*Max target fields. The backend applies the authoritative field_match_mapping and splits the bounds only during search/manual sourcing.
- Single-creator official-price conditions use kolOfficialPriceL1/L2/L3 as RMB "[min,max]" strings. At least one tier is mandatory. Project total budget has no dedicated current customer_demands column and stays verbatim in rawMessagesJson; never invent budget* fields.
- If rebate is supplied, normalize it into the real rebate range-string field and preserve its original wording in a mapped audit atom. Exact x% => "[x/100,x/100]"; bounded a%-b% => "[a/100,b/100]"; x%+, x%以上, 至少/不低于 x% => "[x/100,1]". In particular, 返点30%以上 must produce payload.rebate="[0.3,1]" and an atom with disposition="mapped", targetField="rebate"; it must never be downgraded to preserved. Rebate is business-optional; never invent it when absent.
- projectStartStart/projectStartEnd and submissionDeadlineAt use YYYY-MM-DD HH:mm:ss. Preserve the original deadline wording in the matching rawMessagesJson atom because customer_demands has no submissionDeadlineRaw field.
- Use the authoritative requirement clock injected on every turn for relative deadlines. Resolve 今天/today, 明天/tomorrow, 后天/day after tomorrow, and relative weekdays deterministically in its timeZone; never ask for an absolute date when the expression is unique. A bare clock time such as 15:00 without a date or relative-date word does not mean today. A calendar date without a year is semantic_ambiguity only when the clock and brief cannot determine the year uniquely.
- Every atomic condition must map to its declared payload field or be preserved. rawMessagesJson must be one auditable object with schemaVersion="ypmcn-brief-v1", the non-empty originalBrief, a non-empty atoms array, and coverageCheck. sourceText must be non-empty and may quote either the original Brief or an explicit supplemental Ask answer; never force a confirmed supplemental value into originalBrief. The Hook repairs a unique typography-only mismatch when possible. Every atom uses disposition="mapped" or "preserved", confidence from 0 through 1, and inferred boolean. A mapped atom has targetField naming a field actually present in payload; a preserved atom has preservedText equal to sourceText. coverageCheck uses atomCount, mappedCount, preservedCount, and unresolvedCount; all counts must match and unresolvedCount must be 0. Never invent fields, stringify JSON, or put placeholders such as __UNRESOLVED__ in payload.
- For a new brief, the business minimum is platform, quantityTotal, submissionDeadlineAt, an auditable ypmcn-brief-v1 rawMessagesJson object, and one valid kolOfficialPriceL1/L2/L3 "[min,max]" string with a positive upper bound representing the confirmed single-creator budget tier. This business one-of rule applies even though the three database columns are nullable. rawMessagesJson is constructible from any non-empty brief. projectName, brandName, product, project total budget, and rebate are optional unless explicitly supplied.
- Scan every required field and every supplied atomic condition before choosing a gate. missing_required means a required field has no concrete candidate value usable for that field or is explicitly blank: vague quantity words such as 一批/some/尽量多 without a number are missing quantity, not ambiguity. semantic_ambiguity requires at least one concrete candidate value, but that value is conflicting, context-incomplete, has an unconfirmed/open range endpoint, lacks a content tier, or cannot be assigned/typed without guessing. A concrete single value, upper bound, or closed interval is not ambiguous and must be normalized.
- Apply exactly three requirement gates after the full scan: missing_required when the missing list is non-empty; otherwise semantic_ambiguity when the ambiguity list is non-empty; otherwise ready. Gate precedence chooses the label but never short-circuits diagnostics: even under missing_required, list every already-detectable ambiguity and request all necessary missing/clarification values in one compact, self-contained question. Missing optional fields never block and must be omitted.
- Preview atom details, gate, and summary must be rendered from one in-memory atom list, never counted independently in prose. summary.atomCount equals the detail-row count; summary.mappedCount counts only mapped rows; summary.preservedCount counts only preserved rows; summary.unresolvedCount counts missing_required plus semantic_ambiguity rows. If any detail row is missing_required or semantic_ambiguity, unresolvedCount must be positive, gate cannot be ready, and never claim mapped=N/unresolved=0. Only the ready payload audit may use coverageCheck.unresolvedCount=0 and contain exclusively mapped/preserved atoms.
- A subjective or negative condition, reference account, or free-text constraint that can be preserved verbatim in rawMessagesJson is not semantic ambiguity; preserve it and continue.
- A supplied value that belongs to a declared field must not be moved only to rawMessagesJson to bypass ambiguity. Price input is semantic_ambiguity when project total versus per-creator official price is unclear, the official price lacks an L1/L2/L3 tier, or two finite range bounds cannot be determined. A confirmed closed range is valid and must be normalized, not rejected.
- Parse in three passes: atomize every original condition into the ypmcn-brief-v1 audit object; map each atom to the live schema or, for nonstandard fields, the packaged customer_demands reference CSV; then reverse-check coverageCheck against every mapped or preserved atom. Any uncovered or unresolved atom blocks validation.
- Requirement clarification must immediately use one self-contained native AskUserQuestion popup with at most five concise questions. Use a short user-facing header, one direct question ending in “？” or “?”, and 2–6 useful choices; string choices and option objects are both valid. Use one question per independent decision and group missing values into the same popup. Do not expose hashes, database IDs, trace IDs, idempotency keys, or the full raw Brief. The host provides typed input when choices do not fit. A denied, cancelled, closed, or timed-out popup exits clarification cleanly and must not continue the write workflow. Continue the selected safe path in the same assistant turn only after a submitted answer; never ask the user to type “继续”.
- missing_required and semantic_ambiguity must show resolved fields, the complete missing and ambiguity lists inside that popup, then wait for the popup answer without status "ready" and without calling validate_requirement. After all values are concrete, continue in the same interaction. ready must show the exact tool arguments as {"payload": {..., "status": "ready"}} even when a test suppresses the call, call validate_requirement once, then route only from the latest successful response's workflow_state and allowed_actions.

YPmcn continuous-workflow fast path:
- Every native AskUserQuestion popup is a user-facing decision screen, not a log dump. Requirement questions use the concise form above. For supply/send confirmations, pass the recognized header and required choices; the Hook injects the authoritative bound summary, so do not copy or recalculate long Tool output. Never expose internal hashes or raw IDs.
- Reuse the latest successful response. Do not call get_workflow_state between continuous steps; use it only when taking over an existing demand, after context loss/state conflict/unknown write result, or immediately before irreversible external distribution.
- Omit optional and null fields unless the user or actual prior response supplies their value. Never send legacy fields or invent an ID.
- A timeout, connection error, generic tool failure, or any host Tool result with block=true / details.status="blocked" gets no automatic retry, regardless of whether its code starts with BLOCKED_ or is INVALID_INPUT/INTEGRATION_REQUIRED. Attribute the failure from Tool result provenance before showing it: details.deniedReason="plugin-before-tool-call" is a local Hook denial and means the request did not reach MCP/Provider, so never call it an MCP server rejection. Attribute a rejection to MCP/Provider only when the result contains actual remote MCP response evidence; if origin evidence is absent, report the origin as unknown. Do not add/change optional arguments (including timeout_seconds), reinterpret one identifier as another lookup mode, switch tools, or run diagnostics after failure.
- Never end a recoverable failure with a plain “blocked” paragraph or require a new “继续” message. In the same assistant turn, call native AskUserQuestion: for missing/invalid user values, title it “参数确认”, identify the exact field and offer concrete choices plus typed input; for a definite remote backend failure, title it “服务异常”, state “后端错误，请稍后再试” with the real safe error code, and offer “重试一次” and “停止”; for an unknown write outcome, offer “查询状态” and “停止”, then reconcile state instead of retrying the write. A popup choice is explicit user input: continue only the selected safe path in the same turn. An unchanged retry is allowed at most once only when the prior result proves the write did not occur; if the same Tool fails again, do not retry it again and show a final “查看错误详情” / “结束” choice.
- If the required YPmcn MCP tool is absent because the server did not connect, return integration_required immediately. Do not read mcporter or another Skill, inspect Gateway/config, use shell/curl, or search for an alternative tool.
- Identity sources never mix: validate_requirement.data.id (stringified if required by the host schema) is the id for search_creators and rank_mcns and the requirement_id for rank_creators; demand_id+demand_version are only for state/recovery; project_id+mcn_id+requirement_id identify a distribution; inquiry_id identifies ingest; rank_creators.run_id identifies run detail, adjustment, submission, and feedback.
- requirement_ready + allowed search_creators => search_creators({id}). On success, candidate_pool_ready + allowed rank_mcns => immediately call rank_mcns({id, platform}) as the next Tool in the same turn; do not insert AskUserQuestion, a prose checkpoint, get_workflow_state, or another Tool between them. Reuse validate_requirement.data.id and the already confirmed platform, and include only schema-valid ranking options explicitly requested by the user.
- If search_creators or rank_mcns fails, do not call the next business Tool. In the same turn use the native AskUserQuestion recovery rule above to clarify invalid input or let the user choose the safe error path. After rank_mcns succeeds, show the actual MCN list/gaps and the Provider-backed supply plan, then stop for the user's supply-plan and MCN choices before field/message confirmation.
- After MCN choice, call select_inquiry_form_fields({}) exactly once unless a custom URL/timeout was explicitly supplied before the call. Show only the actual returned description and stop for field/message confirmation; on timeout, stop without retry.
- Before create_with_distributions, first reconcile get_workflow_state({demand_id,demand_version}); the result must identify the same projectName and explicitly allow create_with_distributions, otherwise the Hook blocks. Build projectName, deadline, columns, supplierIds, prefillRows, and prefillRowsBySupplier only from confirmed choices and actual prior results. Build the WeCom preview in this fixed order: title; platform from platform; optional brand/product from brandName/product; content requirement from contentTag then description (or only a media-confirmed content audit atom when both are empty); creator count from quantityTotal; every supplied kolOfficialPrice L1/L2/L3 tier and range; deadline from submissionDeadlineAt; confirmed column names in order; form_link. Only pass notification_template when the live tool schema advertises it; otherwise report the provider gap and do not claim the fixed message was sent. For confirmation, use header “外发确认” and choices including “确认发送” and “需要修改”; optional “自定义消息”, “稍后再说”, or “取消” choices are valid. The Hook injects the bound user-facing summary and keeps its hash internal. Only explicit “确认发送” authorizes the request.
- manual_source_creators is optional pre-send enrichment only: call manual_source_creators({requirement_id}) after supply-plan confirmation only when real verifiable manual results are already associated with that requirement, and always before create_with_distributions. It never substitutes for WeCom send or recovery completion.
- After distribution success, call sync_mcn_inquiry_status({requirement_id,project_id,mcn_id}) for identities returned by that write. While waiting, do not poll repeatedly. Recovery order is sync -> ingest_mcn_submissions({inquiry_id,items}) only when real returned/user-provided items exist -> sync. Never invent recovery items.
- Only a successful WeCom distribution plus completed recovery may yield candidate_pool_enriched. Then and only when allowed_actions contains rank_creators, call rank_creators({requirement_id,limit}); use the explicitly confirmed shortlist size, otherwise the validated quantityTotal, otherwise ask once. Save the actual run_id.
- recommendation_ready: audit_manual_adjustment only for explicit adjustments with reason/operator; otherwise create_submission_batch({run_id}) after the user confirms the recommendation. Omit submission options unless explicit. After a successful batch, a host export_csv tool may render the fixed customer CSV columns in this exact order: 排名, 平台, 达人昵称, 达人ID, 来源, 机构名称, 官方报价（元）, 提报报价（元）, 提报返点（%）, 推荐得分, 推荐理由, 风险提示. Use only returned facts, keep missing values empty, and name the file ypmcn_submission_<demandId>_v<demandVersion>_batch_<batchNo>.csv. submission_batch_ready + concrete client feedback => record_client_feedback({run_id,feedback_items}); never infer feedback status.
- get_creator_detail and get_recommendation_run_detail are read-only checks and never advance the workflow. manual_source_creators accepts only requirement_id and requires real verifiable manual results already associated with it. Read the media-assistant Skill/reference only for nonstandard fields, ambiguity, recovery details, or a schema conflict.`;

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
    description: "按 mvp-v2 契约执行语义 ID 链路、人工门禁和可恢复回收状态机。",
    register(api) {
    const rootDir = api.rootDir ?? process.cwd();
    api.on("before_agent_reply", async (event, ctx) => withStateScope(hookStateScope(event, ctx), () => {
      const prompt = typeof event?.cleanedBody === "string" ? event.cleanedBody : "";
      if (!isStandardBrief(prompt) && !isYpmcnRequirementIntent(prompt)) return;
      const preview = parseStandardBrief(prompt, new Date(), localTimeZone());
      if (preview.gate === "ready") return;
      beginPromptTurn(rootDir, preview);
      return;
    }));

    api.on("before_prompt_build", async (event, ctx) => withStateScope(hookStateScope(event, ctx), () => {
      const prompt = typeof event?.prompt === "string" ? event.prompt : "";
      const now = new Date();
      const timeZone = localTimeZone();
      const preview = isStandardBrief(prompt) || isYpmcnRequirementIntent(prompt)
        ? parseStandardBrief(prompt, now, timeZone)
        : undefined;
      const readyPayload = preview ? buildStandardBriefReadyPayload(prompt, preview) : undefined;
      beginPromptTurn(rootDir, preview, readyPayload);
      return {
        prependSystemContext: YPMCN_FAST_PATH,
        prependContext: [
          buildRequirementRuntimeClock(now, timeZone),
          preview ? renderStandardBriefPreview(preview) : "",
          readyPayload ? renderStandardBriefReadyArguments(readyPayload) : "",
          preview && preview.gate !== "ready"
            ? `YPmcn mandatory unresolved-Brief interaction: call native AskUserQuestion now and do not return a plain text-only clarification. Use one user-facing form with up to 5 concise single-choice questions, covering every unresolved value. Options may be strings or label/description objects. Do not expose internal gate, schema, or Tool terminology. Do not call validate_requirement until every value is concrete. A denied/cancelled/closed popup does not confirm anything. After a submitted answer, continue in this same interaction without asking for “继续”.\n<YPmcnClarificationAuthority>\n${renderStandardBriefReply(preview)}\n</YPmcnClarificationAuthority>`
            : "",
        ].filter(Boolean).join("\n\n"),
      };
    }));

    api.on("before_tool_call", async (event, ctx) => withStateScope(hookStateScope(event, ctx), () => {
      try {
        const raw = String(event?.toolName ?? "").trim();
        const previousBlock = isAskTool(raw) ? undefined : blockedToolTurnFailure(rootDir, raw);
        if (previousBlock) return previousBlock;
        const result = runtime.beforeTool(event, ctx, rootDir);
        recordBlockedToolResult(rootDir, result);
        return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        api.logger.error(`before_tool_call guard failed: ${reason}`);
        const result = { block: true, blockReason: `YPmcn guard unavailable: ${reason}` };
        recordBlockedToolResult(rootDir, result);
        return result;
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
