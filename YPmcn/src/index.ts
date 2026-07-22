import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  afterTool,
  beforeTool,
  endSession,
  isExternalSendAttempt,
  isManualSourcingAttempt,
  isRequirementGuardAttempt,
  withStateScope,
} from "./runtime-hooks.js";
import {
  recordPostValidationIntent,
  recordRequirementBriefReceipt,
  renderLocalWorkflowContext,
} from "./runtime-hook-workflow.js";
import { denyStructured } from "./runtime-hook-state.js";
import {
  buildStandardBriefReadyPayload,
  extractStandardBrief,
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
    ctx?.sessionID, event?.sessionID,
    ctx?.conversationId, event?.conversationId,
    ctx?.threadId, event?.threadId,
    ctx?.channelId, event?.channelId,
    ctx?.chatId, event?.chatId,
  ]
    .find((value) => typeof value === "string" && value.trim())?.trim();
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return messageText(record.text ?? record.content ?? record.message);
}

function clientRequestText(value: string): string {
  const markers = [...value.matchAll(/(?:^|\r?\n)\s*\[Current user request\]\s*(?:\r?\n|$)/g)];
  const marker = markers.at(-1);
  return (marker ? value.slice((marker.index ?? 0) + marker[0].length) : value).trim();
}

function embeddedOriginalBrief(value: string): string | undefined {
  const match = value.match(/["']originalBrief["']\s*:\s*("(?:\\.|[^"\\])*")/u);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isRequirementInteractionArtifact(value: string): boolean {
  const isRequirementPayload = /["']rawMessagesJson["']\s*:/u.test(value) &&
    /["']originalBrief["']\s*:/u.test(value) && /ypmcn-brief-v1/u.test(value);
  const isAskPayload = /["']questions["']\s*:/u.test(value) &&
    /["']question["']\s*:/u.test(value) && /["']options["']\s*:/u.test(value);
  return isRequirementPayload || isAskPayload;
}

function requirementBriefCandidates(prompt: string, messages: unknown): string[] {
  const inputs = Array.isArray(messages)
    ? messages.flatMap((message) => {
        if (!message || typeof message !== "object" || (message as Record<string, unknown>).role !== "user") {
          return [];
        }
        const value = messageText(message);
        return value ? [value] : [];
      })
    : [];
  inputs.push(prompt);

  const direct: string[] = [];
  const embeddedFallbacks: string[] = [];
  for (const input of inputs) {
    const clientRequest = clientRequestText(input);
    const embedded = embeddedOriginalBrief(clientRequest);
    if (isRequirementInteractionArtifact(clientRequest)) {
      if (embedded) embeddedFallbacks.push(embedded);
      continue;
    }
    if (isStandardBrief(clientRequest) || isYpmcnRequirementIntent(clientRequest)) {
      direct.push(extractStandardBrief(clientRequest));
    }
  }
  return [...new Set((direct.length > 0 ? direct : embeddedFallbacks).filter(Boolean))];
}

function postValidationIntent(prompt: string, messages: unknown): "manual" | "search" | undefined {
  if (/(?:拓展达人|(?:启动|开始|继续)拓展|直接(?:走|启动)?拓展|人工(?:筛|找|搜)|manual\s+sourc)/iu.test(prompt)) {
    return "manual";
  }
  if (/^\s*(?:继续|好的?|可以|开始|确认)\s*[。.!！]?\s*$/u.test(prompt) && Array.isArray(messages)) {
    const previousAssistant = [...messages].reverse().find((message) =>
      message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant"
    );
    if (previousAssistant && /(?:拓展达人|人工(?:筛|找|搜)|manual\s+sourc)/iu.test(messageText(previousAssistant))) {
      return "manual";
    }
  }
  return isStandardBrief(prompt) || isYpmcnRequirementIntent(prompt) ? "search" : undefined;
}

type RequirementPlatform = "xiaohongshu" | "douyin";

function requirementPlatforms(prompt: string): RequirementPlatform[] {
  const platforms: RequirementPlatform[] = [];
  for (const match of prompt.matchAll(/小红书|红书|\bXHS\b|抖音|Douyin|\bDY\b/giu)) {
    const platform = /抖音|Douyin|\bDY\b/iu.test(match[0]) ? "douyin" : "xiaohongshu";
    if (!platforms.includes(platform)) platforms.push(platform);
  }
  return platforms;
}

function renderMultiPlatformRequirementGuidance(platforms: RequirementPlatform[]): string {
  const labels = platforms.map((platform) => platform === "douyin" ? "抖音" : "小红书");
  return `YPmcn authoritative multi-platform intake:
- Explicit platforms in first-appearance order: ${labels.join(" -> ")}. Platform presence and execution order are resolved; never ask which platform to process first.
- Create and execute one independent requirement per platform in this order. Every payload keeps the same exact complete originalBrief and preserves the other platform clauses as audit atoms.
- Scan all shared and platform-specific requirements before pausing. If concrete required values are still absent or semantically ambiguous, call one native AskUserQuestion containing every necessary question; never split dependent clarification across several popups. Keep the host-provided custom-input entry available in every popup.
- Ask one question per shared missing value, not one copy per platform. For quantity, ask how many creators each platform needs and accept one shared choice or typed platform-specific counts through that same popup's custom-input entry.
- Do not reconfirm an explicit Xiaohongshu 图文/视频 price form or an explicit Douyin duration. Douyin 图文 alone does not imply a video duration, so only that unresolved tier may be asked when a Provider price field is required.
- Completing one platform is not a terminal state while another explicit platform remains. Continue the remaining platform automatically without a prose question or a request for “继续”.`;
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

export const YPMCN_HITL_POLICY = `YPmcn human-in-the-loop invariant:
- Only a native AskUserQuestion call may request conversational user input. Ordinary assistant text may report facts but must never ask “是否继续”, “要怎么推进”, present a next-step menu, or request confirmation for a deterministic next_action. If AskUserQuestion is unavailable when truly required, stop with integration_required instead of asking in prose.
- When a fact summary exposes a decision, invoke AskUserQuestion in that same assistant turn immediately after the summary. Never end the turn with a question, alternatives, or an invitation to reply in chat and defer the popup until a later “继续”.
- Ask only for an unresolved required or semantically ambiguous business value that cannot be uniquely derived, an evidence-bound business branch, an irreversible external send, or a non-deterministic safe recovery choice. Never ask for optional omissions, already explicit facts, uniquely resolvable dates or mappings, platform execution order, deterministic argument repair, or permission to continue.
- Before any nonterminal workflow stop or pause that still requires a human decision about recovery, changed inputs, or the next action, invoke AskUserQuestion first. Never ask in prose and then stop. A terminal failure with no safe human decision branch may be reported directly.
- Collect every independently unresolved requirement value in one self-contained popup. For dependent choices, combine them into one question or provide all valid combined choices; do not open a second popup merely because the first answer selects a platform or price family. Every popup must keep at least one host-provided custom-input entry available; never disable, hide, or replace it with fixed choices.
- A submitted AskUserQuestion answer is an executable command: perform the selected safe next action in the same assistant turn. Never return only an acknowledgement and never require a later “继续”. A cancelled, denied, closed, timed-out, or failed popup stops without the following business write; an explicit later resume may reopen the same complete unresolved form, not a fragmented subset.
- waiting_for="user" means invoke the named native AskUserQuestion gate immediately, unless the user already selected an explicit pause that requires new business data. waiting_for=null continues automatically; waiting_for="provider" reports the external wait without asking the user to continue.
- An explicit latest user command to start or continue manual sourcing, including “启动拓展”, is already the decision: route to the phase-independent fresh validate_requirement -> manual_source_creators path. If required manual-sourcing inputs are still missing, collect only those missing inputs through AskUserQuestion.
- A valid search_creators result continues immediately to rank_mcns in the same turn. Do not show a supply popup, ask whether to race, or pause for “继续” between them. Only invalid search evidence may enter recovery.
- Map evidence-bound gates exactly: confirm_post_race_manual_sourcing -> header “赛后补量”; confirm_mcn_selection -> header “MCN确认” with “确认MCN方案”; confirm_inquiry_fields -> header “字段确认” with “确认字段”. Invoke the matching popup immediately from actual evidence; never print these as a prose menu.
- The “赛后补量” popup is mandatory after every successful rank_mcns result, including medium-risk and safe results. Its question must show, from actual evidence: demand creator count, selected MCN count, estimated deduplicated institutional-creator coverage, coverage multiplier, recommended manual-expansion creator count, and the institution/manual creator allocation ratio formatted as demand_count:manual_sourcing_gap_count. Always render the manual count and ratio even when the manual count is 0 (for example 2:0). If rank_mcns returns cumulative coverage milestones, also show the actual top-N institution counts and their supply multipliers; never invent milestones. For a positive manual count offer “一键发起拓展达人补量” / “追加机构后重新计算” / “暂不补量，继续询价”. For a zero manual count offer “确认机构方案，继续询价” / “追加机构后重新计算”; never offer a zero-size manual task.
- The select_inquiry_form_fields webpage is exclusively user-operated. Call it exactly once for the active MCN flow, then wait for the user to choose fields and submit the webpage callback; never click, infer, preselect, or submit fields on the user's behalf. Do not open another selector while waiting or after success, cancellation, timeout, or invalid callback. After a valid callback returns, consume its actual ordered fields directly and do not add a redundant chat confirmation.
- If required Tool evidence or the local success projection is invalid, do not report business success from generic success wording and do not offer downstream actions unsupported by that evidence.`;

export const YPMCN_FAST_PATH = `${YPMCN_HITL_POLICY}

YPmcn standard-brief fast path:
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
- Every atomic condition must map to its declared payload field or be preserved. rawMessagesJson must be one auditable object with schemaVersion="ypmcn-brief-v1", the non-empty originalBrief, a non-empty atoms array, and coverageCheck. originalBrief must exactly match a real client Brief captured by the Hook from the current conversation: host prompt envelopes and later AskUserQuestion or Tool-argument JSON do not replace an earlier Brief, so never ask the client to resend solely because clarification occurred. Never add retry/deduplication markers, silently rewrite wording, or reconstruct a platform-specific replacement. When one Brief contains multiple platforms, every independently validated payload keeps the same complete originalBrief and preserves the other platform clause as an atom. sourceText must be non-empty and may quote either the original Brief or an explicit supplemental Ask answer; never force a confirmed supplemental value into originalBrief. Every supplemental quantity, format/duration, or exact deadline answer needs its own audit atom. Every atom uses disposition="mapped" or "preserved", confidence from 0 through 1, and inferred boolean. A mapped atom has targetField naming a field actually present in payload; a preserved atom has preservedText equal to sourceText. coverageCheck uses atomCount, mappedCount, preservedCount, and unresolvedCount; all counts must match and unresolvedCount must be 0. Never invent fields, stringify JSON, or put placeholders such as __UNRESOLVED__ in payload.
- Use the final atom transport shape shown here, not the richer parser Preview shape. Mapped example: {"sourceText":"粉丝年龄：24-29岁占比20%","disposition":"mapped","targetField":"age3Rate","confidence":1,"inferred":false}. Preserved example: {"sourceText":"需真人出镜","disposition":"preserved","preservedText":"需真人出镜","confidence":1,"inferred":false}. Preview-only keys such as field, resolution, value, candidates, and reason are analysis hints and are not part of rawMessagesJson.atoms.
- For a new brief, the business minimum is platform, quantityTotal, submissionDeadlineAt, an auditable ypmcn-brief-v1 rawMessagesJson object, and one platform-valid single-creator price field with a positive upper bound. 小红书 permits only kolOfficialPriceL1/L2; 抖音 permits kolOfficialPriceL1/L2/L3. rawMessagesJson is constructible from any non-empty brief. projectName, brandName, product, project total budget, and rebate are optional unless explicitly supplied.
- Scan every required field and every supplied atomic condition before choosing a gate. missing_required means a required field has no concrete candidate value usable for that field or is explicitly blank: vague quantity words such as 一批/some/尽量多 without a number are missing quantity, not ambiguity. semantic_ambiguity requires at least one concrete candidate value, but that value is conflicting, context-incomplete, has an unconfirmed/open range endpoint, lacks a content tier, or cannot be assigned/typed without guessing. A concrete single value, upper bound, or closed interval is not ambiguous and must be normalized.
- Apply exactly three requirement gates after the full scan: missing_required when the missing list is non-empty; otherwise semantic_ambiguity when the ambiguity list is non-empty; otherwise ready. Gate precedence chooses the label but never short-circuits diagnostics: even under missing_required, list every already-detectable ambiguity and request all necessary missing/clarification values in one compact, self-contained question. Missing optional fields never block and must be omitted.
- Preview atom details, gate, and summary must be rendered from one in-memory atom list, never counted independently in prose. summary.atomCount equals the detail-row count; summary.mappedCount counts only mapped rows; summary.preservedCount counts only preserved rows; summary.unresolvedCount counts missing_required plus semantic_ambiguity rows. If any detail row is missing_required or semantic_ambiguity, unresolvedCount must be positive, gate cannot be ready, and never claim mapped=N/unresolved=0. Only the ready payload audit may use coverageCheck.unresolvedCount=0 and contain exclusively mapped/preserved atoms.
- A subjective or negative condition, reference account, or free-text constraint that can be preserved verbatim in rawMessagesJson is not semantic ambiguity; preserve it and continue.
- A supplied value that belongs to a declared field must not be moved only to rawMessagesJson to bypass ambiguity. Price input is semantic_ambiguity when project total versus per-creator official price is unclear, the platform-specific content format/duration is unknown, or two finite range bounds cannot be determined. User-facing clarification must say 小红书图文/视频 or 抖音1–20秒/21–60秒/60秒以上, never L1/L2/L3. A confirmed closed range is valid and must be normalized, not rejected.
- Parse in three passes: atomize every original condition into the ypmcn-brief-v1 audit object; map each atom to the live schema or, for nonstandard fields, the packaged JSON file at skills/media-assistant/references/reference_schema.json; then reverse-check coverageCheck against every mapped or preserved atom. Any uncovered or unresolved atom blocks validation.
- Requirement clarification must immediately use one self-contained native AskUserQuestion popup with at most five concise questions. Use a short user-facing header, one direct question ending in “？” or “?”, and 2–6 useful choices; string choices and option objects are both valid. Use one question per independent decision and group missing values into the same popup. Never expose hashes, database IDs, trace IDs, idempotency keys, raw Brief text, or internal price-field names such as kolOfficialPriceL1/L2/L3. Ask only with 小红书图文/视频 or 抖音1–20秒/21–60秒/60秒以上 wording, without claiming a content form implies a duration. Every popup must preserve the host-provided typed custom-input entry for values that choices do not fit. A denied, cancelled, closed, or timed-out popup exits clarification cleanly and must not continue the write workflow. Continue the selected safe path in the same assistant turn only after a submitted answer; never ask the user to type “继续”.
- missing_required and semantic_ambiguity must show resolved fields, the complete missing and ambiguity lists inside that popup, then wait for the popup answer without status "ready" and without calling validate_requirement. After all values are concrete, continue in the same interaction. ready must show the exact tool arguments as {"payload": {..., "status": "ready"}} even when a test suppresses the call, call validate_requirement, repair any deterministic argument rejection under the rule below, then route from the injected local orchestration state and the latest actual Tool result.
- A Brief with both supported platforms is not a platform ambiguity. Follow the injected multi-platform authority, ask shared and platform-specific unresolved values once, validate each platform independently in source order, and never pause between platforms merely to ask whether to continue.

YPmcn phase-independent manual-sourcing fast path:
- Manual sourcing may start from any current workflow phase. Before every manual_source_creators invocation, parse the complete requirement again and successfully call validate_requirement as a new requirement without an old id or demandVersion. Use only the fresh 32-character data.id primary key from that actual response for the immediately following manual call; data.demand_id and demand_version are never Tool IDs.
- A latest explicit “启动拓展”, “开始拓展”, “继续拓展”, or “拓展达人” command takes precedence over a stale supply-confirmation next_action. It is executable authorization for this safe branch, so do not ask for supply confirmation again; Ask only for genuinely missing requirement or size values.
- The Hook checks only this one-time fresh-ID binding for manual sourcing. Do not check whether that requirement was searched before, and do not require field selection, search, MCN racing, distribution, or any other workflow step to be complete. A numeric or wrong-namespace ID is corrected from the existing validate response without another validation. When before_tool_call lacks host session context, continue through the plugin-owned one-time handoff receipt; never revalidate or retry. A well-formed mismatched, intervened, or already consumed ID requires a new requirement validation.
- For manual sourcing without export, the exact business sequence is validate_requirement -> manual_source_creators. Read each packaged references/tools/<tool>.json immediately before its call. After validation succeeds, skip the normal search_creators continuation and call manual_source_creators({requirement_id,size}) with exactly the newly returned ID and the confirmed positive-integer decimal string size. Never send target_count.
- Manual sourcing already exports the Provider spreadsheet. The exact business sequence for sourcing with or without export is validate_requirement -> manual_source_creators; do not call select_inquiry_form_fields, rank_creators, or create_submission_batch afterward.
- A direct manual call is successful only when its actual successful response contains one non-empty excel_file_path. Show that exact file entry to the user without rewriting or inventing a filename, path, URL, inquiry ID, or creator rows. Generic success=true without excel_file_path is invalid evidence and stops the flow.
- rank_creators belongs only to the separate MCN inquiry-recovery chain and receives inquiry_ids from sync_mcn_inquiry_status, never from manual_source_creators or the field-selector callback.
- The injected state/confirmation_guard.json phase and next_action are the local orchestration projection. Actual MCP results remain the only business evidence. Any failed step stops before the next business Tool; an unknown write result must be reconciled and never blindly retried. search_creators.id follows the same data.id rule. A DEMAND_NOT_FOUND response is not evidence of Provider deduplication, cleanup, replacement, or propagation delay; never invent such explanations or create duplicate requirements to probe them.
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
    description: "提供媒介工作流提示、本地编排状态、统一 AskUserQuestion 人机门禁与企微外发确认。",
    register(api) {
    const rootDir = api.rootDir ?? process.cwd();
    api.on("before_prompt_build", async (event, ctx) => withStateScope(hookStateScope(event, ctx), () => {
      const hostPrompt = typeof event?.prompt === "string" ? event.prompt : "";
      const prompt = clientRequestText(hostPrompt);
      const now = new Date();
      const timeZone = localTimeZone();
      const requirementLike = !isRequirementInteractionArtifact(prompt) &&
        (isStandardBrief(prompt) || isYpmcnRequirementIntent(prompt));
      const platforms = requirementLike ? requirementPlatforms(prompt) : [];
      const multiPlatformGuidance = platforms.length > 1
        ? renderMultiPlatformRequirementGuidance(platforms)
        : "";
      const preview = requirementLike && platforms.length <= 1
        ? parseStandardBrief(prompt, now, timeZone)
        : undefined;
      const readyPayload = preview ? buildStandardBriefReadyPayload(prompt, preview) : undefined;
      for (const brief of requirementBriefCandidates(hostPrompt, event?.messages)) {
        recordRequirementBriefReceipt(brief, rootDir);
      }
      const intent = postValidationIntent(prompt, event?.messages);
      if (intent) recordPostValidationIntent(intent, rootDir);
      return {
        prependSystemContext: YPMCN_FAST_PATH,
        prependContext: [
          buildRequirementRuntimeClock(now, timeZone),
          renderLocalWorkflowContext(rootDir),
          multiPlatformGuidance,
          preview && !readyPayload ? renderStandardBriefPreview(preview) : "",
          readyPayload ? renderStandardBriefReadyArguments(readyPayload) : "",
          preview && preview.gate !== "ready"
            ? `YPmcn mandatory unresolved-Brief interaction: call native AskUserQuestion now and do not return a plain text-only clarification. Use one user-facing form with up to 5 concise single-choice questions, covering every unresolved value, and keep at least one host-provided custom-input entry available. Options may be strings or label/description objects. Do not expose internal gate, schema, or Tool terminology. Do not call validate_requirement until every value is concrete. A denied/cancelled/closed popup does not confirm anything. After a submitted answer, continue in this same interaction without asking for “继续”.\n<YPmcnClarificationAuthority>\n${renderStandardBriefReply(preview)}\n</YPmcnClarificationAuthority>`
            : "",
        ].filter(Boolean).join("\n\n"),
      };
    }));

    api.on("before_tool_call", async (event, ctx) => {
      const scope = hookStateScope(event, ctx);
      return withStateScope(scope, () => {
      try {
        return runtime.beforeTool(
          event,
          ctx,
          rootDir,
          (message) => (api.logger as any).warn?.(message),
          Boolean(scope),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        api.logger.error(`before_tool_call guard failed: ${reason}`);
        if (!isExternalSendAttempt(event) && !isManualSourcingAttempt(event) && !isRequirementGuardAttempt(event)) {
          return undefined;
        }
        return denyStructured("INTEGRATION_REQUIRED", `YPmcn guard unavailable: ${reason}`);
      }
      });
    });

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
