import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  afterTool,
  beforeTool,
  beginPromptTurn,
  blockedToolTurnFailure,
  endSession,
  recordBlockedToolResult,
} from "./runtime-hooks.js";
import {
  isStandardBrief,
  parseStandardBrief,
  renderStandardBriefPreview,
  renderStandardBriefReply,
} from "./standard-brief.js";

export {
  extractStandardBrief,
  isStandardBrief,
  parseStandardBrief,
  renderStandardBriefPreview,
  renderStandardBriefReply,
} from "./standard-brief.js";

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
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
- Every atomic condition must map to its declared payload field or be preserved. rawMessagesJson must be one auditable object with schemaVersion="ypmcn-brief-v1", the non-empty originalBrief, a non-empty atoms array, and coverageCheck. Every atom has sourceText copied as an exact originalBrief substring, disposition="mapped" or "preserved", confidence from 0 through 1, and inferred boolean. A mapped atom has targetField naming a field actually present in payload; a preserved atom has preservedText exactly equal to sourceText. coverageCheck uses atomCount, mappedCount, preservedCount, and unresolvedCount; all counts must match and unresolvedCount must be 0. Never invent fields, stringify JSON, or put placeholders such as __UNRESOLVED__ in payload.
- For a new brief, the business minimum is platform, quantityTotal, submissionDeadlineAt, an auditable ypmcn-brief-v1 rawMessagesJson object, and one valid kolOfficialPriceL1/L2/L3 "[min,max]" string with a positive upper bound representing the confirmed single-creator budget tier. This business one-of rule applies even though the three database columns are nullable. rawMessagesJson is constructible from any non-empty brief. projectName, brandName, product, project total budget, and rebate are optional unless explicitly supplied.
- Scan every required field and every supplied atomic condition before choosing a gate. missing_required means a required field has no concrete candidate value usable for that field or is explicitly blank: vague quantity words such as 一批/some/尽量多 without a number are missing quantity, not ambiguity. semantic_ambiguity requires at least one concrete candidate value, but that value is conflicting, context-incomplete, has an unconfirmed/open range endpoint, lacks a content tier, or cannot be assigned/typed without guessing. A concrete single value, upper bound, or closed interval is not ambiguous and must be normalized.
- Apply exactly three requirement gates after the full scan: missing_required when the missing list is non-empty; otherwise semantic_ambiguity when the ambiguity list is non-empty; otherwise ready. Gate precedence chooses the label but never short-circuits diagnostics: even under missing_required, list every already-detectable ambiguity and request all necessary missing/clarification values in one compact, self-contained question. Missing optional fields never block and must be omitted.
- Preview atom details, gate, and summary must be rendered from one in-memory atom list, never counted independently in prose. summary.atomCount equals the detail-row count; summary.mappedCount counts only mapped rows; summary.preservedCount counts only preserved rows; summary.unresolvedCount counts missing_required plus semantic_ambiguity rows. If any detail row is missing_required or semantic_ambiguity, unresolvedCount must be positive, gate cannot be ready, and never claim mapped=N/unresolved=0. Only the ready payload audit may use coverageCheck.unresolvedCount=0 and contain exclusively mapped/preserved atoms.
- A subjective or negative condition, reference account, or free-text constraint that can be preserved verbatim in rawMessagesJson is not semantic ambiguity; preserve it and continue.
- A supplied value that belongs to a declared field must not be moved only to rawMessagesJson to bypass ambiguity. Price input is semantic_ambiguity when project total versus per-creator official price is unclear, the official price lacks an L1/L2/L3 tier, or two finite range bounds cannot be determined. A confirmed closed range is valid and must be normalized, not rejected.
- Parse in three passes: atomize every original condition into the ypmcn-brief-v1 audit object; map each atom to the live schema or, for nonstandard fields, the packaged customer_demands reference CSV; then reverse-check coverageCheck against every mapped or preserved atom. Any uncovered or unresolved atom blocks validation.
- Requirement clarification must use one self-contained AskUserQuestion titled “需求确认”. Its question body is exactly three labeled parts: 已确认, 需确认, 影响. Ask at most three focused questions with 2–3 mutually exclusive business interpretations; never ask for database IDs, trace IDs, or idempotency keys.
- missing_required and semantic_ambiguity must show resolved fields, the complete missing and ambiguity lists, plus one self-contained combined clarification, then stop without status "ready" and without calling validate_requirement. ready must show the exact tool arguments as {"payload": {..., "status": "ready"}} even when a test suppresses the call, call validate_requirement once, then route only from the latest successful response's workflow_state and allowed_actions.

YPmcn continuous-workflow fast path:
- Reuse the latest successful response. Do not call get_workflow_state between continuous steps; use it only when taking over an existing demand, after context loss/state conflict/unknown write result, or immediately before irreversible external distribution.
- Omit optional and null fields unless the user or actual prior response supplies their value. Never send legacy fields or invent an ID.
- A timeout, connection error, generic tool failure, or any host Tool result with block=true / details.status="blocked" gets no automatic retry, regardless of whether its code starts with BLOCKED_ or is INVALID_INPUT/INTEGRATION_REQUIRED. Attribute the failure from Tool result provenance before summarizing it: details.deniedReason="plugin-before-tool-call" is a local Hook denial and means the request did not reach MCP/Provider, so never call it an MCP server rejection. Attribute a rejection to MCP/Provider only when the result contains actual remote MCP response evidence; if origin evidence is absent, report the origin as unknown. Do not add/change optional arguments (including timeout_seconds), reinterpret one identifier as another lookup mode, switch tools, or run diagnostics after failure. Report the first error once; retry only in a later user turn when the tool explicitly returns a supported continuation instruction or the user asks.
- If the required YPmcn MCP tool is absent because the server did not connect, return integration_required immediately. Do not read mcporter or another Skill, inspect Gateway/config, use shell/curl, or search for an alternative tool.
- Identity sources never mix: validate_requirement.data.id (stringified if required by the host schema) is the id for search_creators and rank_mcns and the requirement_id for rank_creators; demand_id+demand_version are only for state/recovery; project_id+mcn_id+requirement_id identify a distribution; inquiry_id identifies ingest; rank_creators.run_id identifies run detail, adjustment, submission, and feedback.
- requirement_ready + allowed search_creators => search_creators({id}). After success, show only provider-backed supply-plan fields: demand_count; database_candidate_count=distinct hard-filter-passed creators; supply_demand_ratio=database_candidate_count/demand_count; target_submission_count; estimated_valid_return_count; estimated_gap_count; recommended_mcn_count; mcn_covered_creator_count; recommended_manual_creator_count=max(ceil(demand_count*20%),estimated_gap_count); and mcn_manual_creator_ratio=mcn_covered_creator_count:recommended_manual_creator_count. Institution count and creator count must never be divided. If search_creators does not return every nontrivial input, stop with integration_required instead of guessing. AskUserQuestion must confirm this unchanged plan before rank_mcns; only “确认供给方案” continues.
- After supply-plan confirmation, candidate_pool_ready + allowed rank_mcns => rank_mcns({id, platform}); omit all rank options unless explicitly confirmed. After rank_mcns, show the returned MCN list/gaps and stop for the user's MCN choice.
- After MCN choice, call select_inquiry_form_fields({}) exactly once unless a custom URL/timeout was explicitly supplied before the call. Show only the actual returned description and stop for field/message confirmation; on timeout, stop without retry.
- Before create_with_distributions, first reconcile get_workflow_state({demand_id,demand_version}); the result must identify the same projectName and explicitly allow create_with_distributions, otherwise the Hook blocks. Build projectName, deadline, columns, supplierIds, prefillRows, and prefillRowsBySupplier only from confirmed choices and actual prior results. Build the WeCom preview in this fixed order: title; platform from platform; optional brand/product from brandName/product; content requirement from contentTag then description (or only a media-confirmed content audit atom when both are empty); creator count from quantityTotal; every supplied kolOfficialPrice L1/L2/L3 tier and range; deadline from submissionDeadlineAt; confirmed column names in order; form_link. Only pass notification_template when the live tool schema advertises it; otherwise report the provider gap and do not claim the fixed message was sent. The send confirmation binds the packaged WeCom template ID/hash plus the exact request summary; ask once with its marker, then retry the exact same arguments only after explicit confirmation.
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
    api.on("before_agent_reply", async (event) => {
      const prompt = typeof event?.cleanedBody === "string" ? event.cleanedBody : "";
      if (!isStandardBrief(prompt)) return;
      const preview = parseStandardBrief(prompt, new Date(), localTimeZone());
      if (preview.gate === "ready") return;
      beginPromptTurn(rootDir, preview);
      return {
        handled: true,
        reply: { text: renderStandardBriefReply(preview) },
        reason: `ypmcn_requirement_${preview.gate}`,
      };
    });

    api.on("before_prompt_build", async (event) => {
      const prompt = typeof event?.prompt === "string" ? event.prompt : "";
      const now = new Date();
      const timeZone = localTimeZone();
      const preview = isStandardBrief(prompt) ? parseStandardBrief(prompt, now, timeZone) : undefined;
      beginPromptTurn(rootDir, preview);
      return {
        prependSystemContext: YPMCN_FAST_PATH,
        prependContext: [
          buildRequirementRuntimeClock(now, timeZone),
          preview ? renderStandardBriefPreview(preview) : "",
          preview && preview.gate !== "ready"
            ? `YPmcn mandatory unresolved-Brief response: do not call any Tool. Return the following response exactly, without recounting, paraphrasing, or adding text:\n<YPmcnExactReply>\n${renderStandardBriefReply(preview)}\n</YPmcnExactReply>`
            : "",
        ].filter(Boolean).join("\n\n"),
      };
    });

    api.on("before_tool_call", async (event, ctx) => {
      try {
        const previousBlock = blockedToolTurnFailure(rootDir);
        if (previousBlock) return previousBlock;
        const result = runtime.beforeTool(event, ctx, rootDir);
        recordBlockedToolResult(rootDir, result);
        return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        api.logger.error(`before_tool_call guard failed: ${reason}`);
        return { block: true, blockReason: `YPmcn guard unavailable: ${reason}` };
      }
    });

    api.on("after_tool_call", async (event, ctx) => {
      try {
        runtime.afterTool(event, ctx, rootDir);
      } catch (error) {
        api.logger.error(`after_tool_call receipt update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    api.on("session_end", async (event, ctx) => {
      try {
        runtime.endSession(event, ctx, rootDir);
      } catch (error) {
        api.logger.error(`optional receipt cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    },
  });
}

const plugin = createYpmcnPlugin();

export default plugin;
