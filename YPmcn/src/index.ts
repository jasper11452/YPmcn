import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { afterTool, beforeTool, endSession } from "./runtime-hooks.js";

export const YPMCN_FAST_PATH = `YPmcn standard-brief fast path:
- Use only installed YPmcn MCP tools. For a new brief, the first business call is validate_requirement; do not read Skill files, probe schemas, inspect config, call get_workflow_state, or try another business tool first.
- Common payload mapping: 小红书/红书/XHS => platform "xiaohongshu"; 抖音/DY/Douyin => "douyin"; 项目、行业、数量 => projectName, businessIndustry, quantityTotal.
- L1/L2/L3 creator official prices are RMB values in kolOfficialPriceL1/L2/L3. Only an explicit project total budget uses budgetMinCents/budgetMaxCents in cents.
- Rebate percentages must be divided by 100 into rebateMinRate/rebateMaxRate and retained in rebateRaw.
- projectStartStart/projectStartEnd and submissionDeadlineAt use YYYY-MM-DD HH:mm:ss; retain the deadline wording in submissionDeadlineRaw.
- Every atomic condition must map to its declared payload field; use rawMessagesJson only when no dedicated field exists. If any required value is empty or ambiguous, ask one minimal clarification and do not call validate_requirement. Only complete unambiguous input uses status "ready".
- Before calling, show the exact payload and unresolved items briefly. Call validate_requirement once, then route only from the latest successful response's workflow_state and allowed_actions.

YPmcn continuous-workflow fast path:
- Reuse the latest successful response. Do not call get_workflow_state between continuous steps; use it only when taking over an existing demand, after context loss/state conflict/unknown write result, or immediately before irreversible external distribution.
- Omit optional and null fields unless the user or actual prior response supplies their value. Never send legacy fields or invent an ID.
- A timeout, connection error, or generic tool failure gets no automatic retry. Do not add/change optional arguments (including timeout_seconds), switch tools, or run diagnostics after failure. Report the first error once; retry only when the tool explicitly returns a retryable instruction or the user asks.
- If the required YPmcn MCP tool is absent because the server did not connect, return integration_required immediately. Do not read mcporter or another Skill, inspect Gateway/config, use shell/curl, or search for an alternative tool.
- Identity sources never mix: validate_requirement.data.id (stringified if required by the host schema) is the id for search_creators and rank_mcns and the requirement_id for rank_creators; demand_id+demand_version are only for state/recovery; project_id+mcn_id+requirement_id identify a distribution; inquiry_id identifies ingest; rank_creators.run_id identifies run detail, adjustment, submission, and feedback.
- requirement_ready + allowed search_creators => search_creators({id}). After success, compute and show the fielded supply plan: demand_count=validated quantityTotal, database_candidate_count=actual search count, supply_demand_ratio=database_candidate_count/demand_count, recommended_mcn_count, recommended_manual_count, and recommended_mcn_manual_ratio. If any input is unavailable, stop instead of guessing. AskUserQuestion must confirm this plan before rank_mcns; only “确认供给方案” continues.
- After supply-plan confirmation, candidate_pool_ready + allowed rank_mcns => rank_mcns({id, platform}); omit all rank options unless explicitly confirmed. After rank_mcns, show the returned MCN list/gaps and stop for the user's MCN choice.
- After MCN choice, call select_inquiry_form_fields({}) exactly once unless a custom URL/timeout was explicitly supplied before the call. Show only the actual returned description and stop for field/message confirmation; on timeout, stop without retry.
- Before create_with_distributions, first reconcile get_workflow_state({demand_id,demand_version}). Build projectName, deadline, columns, supplierIds, prefillRows, and prefillRowsBySupplier only from confirmed choices and actual prior results. The first send is expected to return YP_CONFIRMATION_REQUIRED; ask once with its marker, then retry the exact same arguments only after explicit confirmation.
- manual_source_creators is optional pre-send enrichment only: call it after supply-plan confirmation when real verifiable manual_results exist, and always before create_with_distributions. It never substitutes for WeCom send or recovery completion.
- After distribution success, call sync_mcn_inquiry_status({requirement_id,project_id,mcn_id}) for identities returned by that write. While waiting, do not poll repeatedly. Recovery order is sync -> ingest_mcn_submissions({inquiry_id,items}) only when real returned/user-provided items exist -> sync. Never invent recovery items.
- Only a successful WeCom distribution plus completed recovery may yield candidate_pool_enriched. Then and only when allowed_actions contains rank_creators, call rank_creators({requirement_id,limit}); use the explicitly confirmed shortlist size, otherwise the validated quantityTotal, otherwise ask once. Save the actual run_id.
- recommendation_ready: audit_manual_adjustment only for explicit adjustments with reason/operator; otherwise create_submission_batch({run_id}) after the user confirms the recommendation. Omit submission options unless explicit. submission_batch_ready + concrete client feedback => record_client_feedback({run_id,feedback_items}); never infer feedback status.
- get_creator_detail and get_recommendation_run_detail are read-only checks and never advance the workflow. manual_source_creators requires real verifiable manual_results. Read the media-assistant Skill/reference only for nonstandard fields, ambiguity, recovery details, or a schema conflict.`;

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "ypmcn-media-assistant",
  name: "YPmcn 媒介助手",
  description: "按 mvp-v2 契约执行语义 ID 链路、人工门禁和可恢复回收状态机。",
  register(api) {
    const rootDir = api.rootDir ?? process.cwd();
    api.on("before_prompt_build", async () => ({ prependSystemContext: YPMCN_FAST_PATH }));

    api.on("before_tool_call", async (event, ctx) => {
      try {
        return beforeTool(event, ctx, rootDir);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        api.logger.error(`before_tool_call guard failed: ${reason}`);
        return { block: true, blockReason: `YPmcn guard unavailable: ${reason}` };
      }
    });

    api.on("after_tool_call", async (event, ctx) => {
      try {
        afterTool(event, ctx, rootDir);
      } catch (error) {
        api.logger.error(`after_tool_call receipt update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    api.on("session_end", async (event, ctx) => {
      try {
        endSession(event, ctx, rootDir);
      } catch (error) {
        api.logger.error(`optional receipt cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  },
});

export default plugin;
