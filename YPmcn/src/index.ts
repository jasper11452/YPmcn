import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { callGatewayTool } from "openclaw/plugin-sdk/browser-setup-tools";
import {
  afterTool,
  beforeTool,
  endSession,
  isExternalSendAttempt,
  withStateScope,
} from "./runtime-hooks.js";
import { normalize, renderLocalWorkflowContext } from "./runtime-hook-workflow.js";
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

const DEMAND_FIELD_SELECTOR_URL = "https://agenta.eshypdata.com/demand-field-selector";

async function openHostUrl(url: string): Promise<void> {
  await callGatewayTool(
    "browser.request",
    { timeoutMs: 15_000 },
    {
      method: "POST",
      path: "/tabs/open",
      body: { url },
      timeoutMs: 15_000,
    },
    { scopes: ["operator.write"] },
  );
}

function isInquiryFieldSelectionCall(event: any): boolean {
  const raw = String(event?.toolName ?? event?.name ?? "").trim();
  return normalize(raw) === "select_inquiry_form_fields";
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
- Common payload mapping: 小红书/红书/XHS => platform "xiaohongshu"; 抖音/DY/Douyin => "douyin"; 项目、品牌、产品、数量 => projectName, brandName, product, quantityTotal; industry/content wording maps only to the real contentTag/description/label fields when their meaning is exact. quantityTotal is always a JSON integer: 数量5 or 5位达人 => quantityTotal=5, never "[5,5]". Range serialization applies only to fields whose schema/CSV declares a range-backed varchar.
- The packaged customer_demands CSV is the field authority. Range-backed varchar fields must use one canonical JSON-array string "[min,max]" before validate_requirement: exact x => "[x,x]", up to x => "[0,x]", and a confirmed closed interval a-b => "[a,b]". Bounds are non-negative finite numbers with min <= max and no spaces. Rate bounds use 0..1, so 50% becomes 0.5. A lower-only condition without a confirmed finite upper bound is ambiguous and must be clarified.
- Immediately before validate_requirement, run one final range-serialization pass over every mapped range atom. Keep only the customer_demands source field with a string value such as femaleRate: "[0,0.5]"; never send a JSON array, natural-language range, or derived *Min/*Max target fields. The backend applies the authoritative field_match_mapping and splits the bounds only during search/manual sourcing.
- Single-creator official-price conditions use internal Provider fields as RMB "[min,max]" strings, but never show L1/L2/L3 labels to users. 小红书 only supports 图文价→kolOfficialPriceL1 and 视频价→kolOfficialPriceL2; kolOfficialPriceL3 is forbidden for 小红书. 抖音 uses 1–20秒→kolOfficialPriceL1, 21–60秒→kolOfficialPriceL2, 60秒以上→kolOfficialPriceL3. Project total budget has no dedicated current customer_demands column and stays verbatim in rawMessagesJson; never invent budget* fields.
- If rebate is supplied, normalize it into the real rebate range-string field and preserve its original wording in a mapped audit atom. Exact x% => "[x/100,x/100]"; bounded a%-b% => "[a/100,b/100]"; x%+, x%以上, 至少/不低于 x% => "[x/100,1]". In particular, 返点30%以上 must produce payload.rebate="[0.3,1]" and an atom with disposition="mapped", targetField="rebate"; it must never be downgraded to preserved. Rebate is business-optional; never invent it when absent.
- projectStartStart/projectStartEnd and submissionDeadlineAt use YYYY-MM-DD HH:mm:ss. Preserve the original deadline wording in the matching rawMessagesJson atom because customer_demands has no submissionDeadlineRaw field.
- Use the authoritative requirement clock injected on every turn for relative deadlines. Resolve 今天/today, 明天/tomorrow, 后天/day after tomorrow, and relative weekdays deterministically in its timeZone; never ask for an absolute date when the expression is unique. A bare clock time such as 15:00 without a date or relative-date word does not mean today. A calendar date without a year is semantic_ambiguity only when the clock and brief cannot determine the year uniquely.
- Every atomic condition must map to its declared payload field or be preserved. rawMessagesJson must be one auditable object with schemaVersion="ypmcn-brief-v1", the non-empty originalBrief, a non-empty atoms array, and coverageCheck. sourceText must be non-empty and may quote either the original Brief or an explicit supplemental Ask answer; never force a confirmed supplemental value into originalBrief. The Hook repairs a unique typography-only mismatch when possible. Every atom uses disposition="mapped" or "preserved", confidence from 0 through 1, and inferred boolean. A mapped atom has targetField naming a field actually present in payload; a preserved atom has preservedText equal to sourceText. coverageCheck uses atomCount, mappedCount, preservedCount, and unresolvedCount; all counts must match and unresolvedCount must be 0. Never invent fields, stringify JSON, or put placeholders such as __UNRESOLVED__ in payload.
- For a new brief, the business minimum is platform, quantityTotal, submissionDeadlineAt, an auditable ypmcn-brief-v1 rawMessagesJson object, and one platform-valid single-creator price field with a positive upper bound. 小红书 permits only kolOfficialPriceL1/L2; 抖音 permits kolOfficialPriceL1/L2/L3. rawMessagesJson is constructible from any non-empty brief. projectName, brandName, product, project total budget, and rebate are optional unless explicitly supplied.
- Scan every required field and every supplied atomic condition before choosing a gate. missing_required means a required field has no concrete candidate value usable for that field or is explicitly blank: vague quantity words such as 一批/some/尽量多 without a number are missing quantity, not ambiguity. semantic_ambiguity requires at least one concrete candidate value, but that value is conflicting, context-incomplete, has an unconfirmed/open range endpoint, lacks a content tier, or cannot be assigned/typed without guessing. A concrete single value, upper bound, or closed interval is not ambiguous and must be normalized.
- Apply exactly three requirement gates after the full scan: missing_required when the missing list is non-empty; otherwise semantic_ambiguity when the ambiguity list is non-empty; otherwise ready. Gate precedence chooses the label but never short-circuits diagnostics: even under missing_required, list every already-detectable ambiguity and request all necessary missing/clarification values in one compact, self-contained question. Missing optional fields never block and must be omitted.
- Preview atom details, gate, and summary must be rendered from one in-memory atom list, never counted independently in prose. summary.atomCount equals the detail-row count; summary.mappedCount counts only mapped rows; summary.preservedCount counts only preserved rows; summary.unresolvedCount counts missing_required plus semantic_ambiguity rows. If any detail row is missing_required or semantic_ambiguity, unresolvedCount must be positive, gate cannot be ready, and never claim mapped=N/unresolved=0. Only the ready payload audit may use coverageCheck.unresolvedCount=0 and contain exclusively mapped/preserved atoms.
- A subjective or negative condition, reference account, or free-text constraint that can be preserved verbatim in rawMessagesJson is not semantic ambiguity; preserve it and continue.
- A supplied value that belongs to a declared field must not be moved only to rawMessagesJson to bypass ambiguity. Price input is semantic_ambiguity when project total versus per-creator official price is unclear, the platform-specific content format/duration is unknown, or two finite range bounds cannot be determined. User-facing clarification must say 小红书图文/视频 or 抖音1–20秒/21–60秒/60秒以上, never L1/L2/L3. A confirmed closed range is valid and must be normalized, not rejected.
- Parse in three passes: atomize every original condition into the ypmcn-brief-v1 audit object; map each atom to the live schema or, for nonstandard fields, the packaged customer_demands reference CSV; then reverse-check coverageCheck against every mapped or preserved atom. Any uncovered or unresolved atom blocks validation.
- Requirement clarification must immediately use one self-contained native AskUserQuestion popup with at most five concise questions. Use a short user-facing header, one direct question ending in “？” or “?”, and 2–6 useful choices; string choices and option objects are both valid. Use one question per independent decision and group missing values into the same popup. Do not expose hashes, database IDs, trace IDs, idempotency keys, or the full raw Brief. The host provides typed input when choices do not fit. A denied, cancelled, closed, or timed-out popup exits clarification cleanly and must not continue the write workflow. Continue the selected safe path in the same assistant turn only after a submitted answer; never ask the user to type “继续”.
- missing_required and semantic_ambiguity must show resolved fields, the complete missing and ambiguity lists inside that popup, then wait for the popup answer without status "ready" and without calling validate_requirement. After all values are concrete, continue in the same interaction. ready must show the exact tool arguments as {"payload": {..., "status": "ready"}} even when a test suppresses the call, call validate_requirement, repair any deterministic argument rejection under the rule below, then route from the injected local orchestration state and the latest actual Tool result.

YPmcn continuous-workflow fast path:
- The injected state/confirmation_guard.json workflow object is the orchestration authority for phase and next_action because Provider workflow_state/allowed_actions are not stable enough to drive the Agent. It never turns a failed Tool call into success; actual Tool results remain the authority for business facts and IDs. Hooks record state but do not block ordinary Tool order or parameters.
- Every submitted native AskUserQuestion answer is an executable user command. Immediately perform the selected safe next action in the same assistant turn; never return an acknowledgement-only message and never ask the user to type “继续”. Requirement questions use the concise form above. Never expose internal hashes or raw IDs.
- Reuse the latest successful response and local state. get_workflow_state is reconciliation-only after context loss or an unknown write result; Provider phase text must not overwrite the local phase.
- Omit optional and null fields unless the user or actual prior response supplies their value. Never send legacy fields or invent an ID.
- validate_requirement has a mandatory argument-repair loop. When a local Hook or remote validation returns INVALID_INPUT, CANONICAL_INPUT_CONFLICT, VALUE_RANGE_INVALID, DEADLINE_ORDER_INVALID, CONSTRAINT_GRAMMAR_INVALID, BLOCKED_REQUIREMENT_INCOMPLETE, BLOCKED_REQUIREMENT_AUDIT_CONFLICT, or BLOCKED_REQUIREMENT_PREVIEW_MISMATCH, and the already-confirmed Brief uniquely determines the fix, preserve originalBrief and every confirmed business fact, correct only the reported payload field, serialization, mapping, or audit count, and call validate_requirement again in the same assistant turn. Repeat for each newly reported deterministic argument conflict until the Tool succeeds; do not ask the user, wait for “继续”, or stop merely because the Agent built invalid Tool arguments. If the fix requires a business choice not present in the user's confirmed input, use one parameter-confirmation popup instead of guessing, then resume this loop in the same interaction.
- The argument-repair loop never applies to a timeout, connection error, integration/schema incompatibility, generic backend failure, unknown write outcome, unchanged blind retry, or any downstream business Tool. Outside that exception, a host Tool result with block=true / details.status="blocked" gets no automatic retry. The sole expected continuation marker is EXTERNAL_SEND_CONFIRMATION_REQUIRED: it proves the first create_with_distributions invocation stopped locally before MCP/Provider, and must be handled only by the exact AskUserQuestion flow below. Attribute every other failure from Tool result provenance before showing it: details.deniedReason="plugin-before-tool-call" is a local Hook denial and means the request did not reach MCP/Provider, so never call it an MCP server rejection. Attribute a rejection to MCP/Provider only when the result contains actual remote MCP response evidence; if origin evidence is absent, report the origin as unknown. Do not add/change unrelated optional arguments (including timeout_seconds), reinterpret one identifier as another lookup mode, switch tools, or run diagnostics after failure.
- Never end a recoverable failure with a plain “blocked” paragraph or require a new “继续” message. In the same assistant turn, call native AskUserQuestion: for missing/invalid user values that the confirmed Brief cannot determine, title it “参数确认”, identify the exact field and offer concrete choices plus typed input; for a definite remote backend failure, title it “服务异常”, state “后端错误，请稍后再试” with the real safe error code, and offer “重试一次” and “停止”; for an unknown write outcome, offer “查询状态” and “停止”, then reconcile state instead of retrying the write. A popup choice is explicit user input: continue only the selected safe path in the same turn. An unchanged retry is allowed at most once only when the prior result proves the write did not occur; if the same Tool fails again, do not retry it again and show a final “查看错误详情” / “结束” choice.
- If the required YPmcn MCP tool is absent because the server did not connect, return integration_required immediately. Do not read mcporter or another Skill, inspect Gateway/config, use shell/curl, or search for an alternative tool.
- Identity sources never mix: validate_requirement.data.id is the id for search_creators and rank_mcns and the requirement_id for create_with_distributions/rank_creators; demand_id+demand_version are reconciliation identities; project_id+supplierIds+requirement_id identify a distribution batch; inquiry_ids identify the batch to ingest; rank_creators.run_id identifies run detail, adjustment, submission, and feedback.
- After validate_requirement succeeds, immediately read search_creators.json and call search_creators({id}) in the same turn. Do not stop, narrate a checkpoint, ask for confirmation, or call another Tool between them.
- After search_creators succeeds, do not call rank_mcns yet. Using only the validated quantity and actual search response, build one complete supply summary with: demand quantity, actual matched count, supply-demand ratio as <actual count>/<quantityTotal>（<ratio>:1）, suggested expansion count (Provider suggestion, otherwise the clearly labelled minimum shortfall max(quantityTotal-actual count,0)), and the next step. Output it under “### 达人供给结果”. Then call one AskUserQuestion with header “供给确认”; its question must repeat the complete decision information with real newlines in this exact order: “需求达人数量：<quantityTotal>\n当前符合条件达人数量：<actual count>\n供需比：<actual count>/<quantityTotal>（<ratio>:1）\n建议拓展达人数量：<same suggestion shown above>\n\n是否按此供给建议开始MCN赛马？”. Never replace these details with “以上” or another reference to text outside the popup. Use choices “确认并开始MCN赛马” and “调整拓展数量”. Wait for the popup result; a submitted confirmation must immediately continue to rank_mcns in the same turn.
- rank_mcns is an MCN race, never a fixed five-MCN recommendation. Derive and pass minimum_mcn_count from the confirmed supply plan and actual available institutions; do not rely on the Provider default 5. After success, show the actual race size, coverage/gaps, and recommended institutions by institution name only. Never display supplier_id, mcn_id, recommendation IDs, or a hardcoded five-item list. Keep selected IDs only for downstream supplierIds.
- If search_creators or rank_mcns fails, do not call the next business Tool. In the same turn use the native AskUserQuestion recovery rule above to clarify invalid input or let the user choose the safe error path.
- After MCN choice, call select_inquiry_form_fields({}) exactly once unless a custom URL/timeout was explicitly supplied before the call. The host opens the browser selector out of band and cannot report whether it opened successfully, so after this Tool call always stop and tell the user: “请在浏览器中完成字段选择，然后将生成的字段粘贴到这里。” Do this even when the Tool result reports failure or timeout; do not treat that result as proof that the browser failed, do not retry, and do not continue to create_with_distributions until the user supplies the generated fields.
- create_with_distributions uses exactly requirement_id, supplierIds, columns, and description. requirement_id comes from validate_requirement.data.id; supplierIds are the confirmed institution ID array; columns are the user-confirmed field object list, and every column object must contain the selector's non-empty key. If pasted selector output uses field_key, rename field_key to key before calling while preserving the remaining field metadata. Never send a column object that lacks key. AI must organize description from the confirmed user requirement as a recipient-ready WeChat/WeCom plain-text message, using natural wording and actual line breaks when helpful. Do not JSON-serialize it, wrap it in a code fence, expose internal field names, or invent facts; use platform-specific price labels rather than L-level labels. The business names requirement_ID and colums map to the live keys requirement_id and columns; never send those misspelled aliases. Do not send retired projectName/deadline/prefillRows/prefillRowsBySupplier fields.
- Build the final create_with_distributions parameters once, then invoke it for the local confirmation preflight. The before_tool_call Hook verifies that the requirement identity matches the latest successful rank_mcns result when that evidence exists. MCN names are optional: show each available name and use “名称未提供” for any unnamed recipient; a missing name alone must never block sending. EXTERNAL_SEND_CONFIRMATION_REQUIRED means Provider was not called: immediately call AskUserQuestion with the exact JSON arguments embedded between <AskUserQuestionInput> tags, preserving every option and newline. The single question uses header “企微外发确认”, a multiline warning with the available MCN names or unnamed placeholders, fields, and the full message, plus “确认发送” / “取消发送”. Only a returned “确认发送” authorizes one immediate second create_with_distributions invocation with exactly the same parameter values and structure; this is the confirmed continuation, not a blind retry. Cancel, deny, close, timeout, tool failure, modified popup arguments, or changed send parameters must not call Provider. Revised parameters start a fresh preflight and every later send needs a new confirmation.
- manual_source_creators is optional pre-send enrichment only: call manual_source_creators({requirement_id}) after supply-plan confirmation only when real verifiable manual results are already associated with that requirement, and always before create_with_distributions. It never substitutes for WeCom send or recovery completion.
- After distribution success, call sync_mcn_inquiry_status({requirement_id,project_id,supplierIds}) with the same confirmed supplier IDs. While waiting, do not poll repeatedly. Recovery order is sync -> ingest_mcn_submissions({inquiry_ids}) using only positive inquiry IDs returned by sync -> sync. Never invent inquiry IDs.
- Only a successful WeCom distribution plus completed recovery may yield candidate_pool_enriched. Then and only when allowed_actions contains rank_creators, call rank_creators({requirement_id,limit}); use the explicitly confirmed shortlist size, otherwise the validated quantityTotal, otherwise ask once. Save the actual run_id.
- recommendation_ready: audit_manual_adjustment only for explicit adjustments with reason/operator; otherwise create_submission_batch({run_id}) after the user confirms the recommendation. Omit submission options unless explicit. After a successful batch, a host export_csv tool may render the fixed customer CSV columns in this exact order: 排名, 平台, 达人昵称, 达人ID, 来源, 机构名称, 官方报价（元）, 提报报价（元）, 提报返点（%）, 推荐得分, 推荐理由, 风险提示. Use only returned facts, keep missing values empty, and name the file ypmcn_submission_<demandId>_v<demandVersion>_batch_<batchNo>.csv. submission_batch_ready + concrete client feedback => record_client_feedback({run_id,feedback_items}); never infer feedback status.
- get_creator_detail and get_recommendation_run_detail are read-only checks and never advance the workflow. manual_source_creators accepts only requirement_id and requires real verifiable manual results already associated with it. Always read the current Tool's packaged JSON format immediately before its call; read the broader Skill references only for nonstandard fields, ambiguity, recovery details, or a schema conflict.`;

type RuntimeHookHandlers = {
  beforeTool: typeof beforeTool;
  afterTool: typeof afterTool;
  endSession: typeof endSession;
  openUrl: (url: string) => Promise<unknown> | unknown;
};

export function createYpmcnPlugin(
  overrides: Partial<RuntimeHookHandlers> = {},
): ReturnType<typeof definePluginEntry> {
  const runtime = { beforeTool, afterTool, endSession, openUrl: openHostUrl, ...overrides };
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
        return runtime.beforeTool(event, ctx, rootDir);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        api.logger.error(`before_tool_call guard failed: ${reason}`);
        if (!isExternalSendAttempt(event)) return undefined;
        return { block: true, blockReason: `YPmcn guard unavailable: ${reason}` };
      }
    }));

    api.on("after_tool_call", async (event, ctx) => withStateScope(hookStateScope(event, ctx), async () => {
      try {
        runtime.afterTool(event, ctx, rootDir);
      } catch (error) {
        api.logger.error(`after_tool_call receipt update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isInquiryFieldSelectionCall(event)) return;
      try {
        await runtime.openUrl(DEMAND_FIELD_SELECTOR_URL);
      } catch (error) {
        api.logger.error(`failed to open inquiry field selector: ${error instanceof Error ? error.message : String(error)}`);
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
