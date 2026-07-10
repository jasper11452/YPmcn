import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/**
 * YPmcn 媒介助手 — OpenClaw Plugin Runtime
 *
 * 设计原则：
 * - validate_requirement 只校验当前运行时 inputSchema 已暴露的字段。
 * - workflow_state 存在时再执行状态、高风险和 gate 防护，不伪造未部署字段。
 * - MCP 响应细项不阻断主流程；只解析可选状态扩展用于恢复和 gate。
 * - 插件只注册 hooks；MCP 服务由宿主显式配置并独立管理生命周期。
 */

export interface ToolCallContext {
  toolName: string;
  params: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionState?: Record<string, unknown>;
  workflowState?: WorkflowState | null;
  operatorRole?: string;
}

export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    onResolution?: (decision: "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled") => Promise<void> | void;
  };
}

export interface ToolResultContext {
  toolName: string;
  success: boolean;
  data: unknown;
  params?: Record<string, unknown>;
  error?: { code: string; message: string; retryable?: boolean; retriable?: boolean } | null;
  traceId?: string;
  workflowState?: WorkflowState | null;
  allowedActions?: unknown;
}

export interface WorkflowState {
  phase: string;
  id?: string;
  requirement_id?: string;
  candidate_pool_id?: string;
  mcn_plan_id?: string;
  demand_id?: string;
  demand_version?: number;
  run_id?: string | null;
  batch_no?: number | null;
  platform_states?: Record<string, PlatformState>;
  pending_gate?: PendingGate | null;
  state_version?: number;
  allowed_actions?: string[];
}

export interface PlatformState {
  mcn_phase: string;
  risk_level?: string | null;
  inquiry_ids?: string[];
  suggested_mcn_ids?: string[];
  confirmed_mcn_ids?: string[];
}

export interface PendingGate {
  gate: string;
  gate_id: string;
  reason: string;
  required_fields: string[];
  created_at?: string;
  expires_at?: string;
}

export interface GuardError {
  guardId: string;
  message: string;
  severity: "block" | "warn";
}

/**
 * validate_requirement 入参校验：
 * 仅检查媒介/Agent 可传字段的基础类型。
 * id、demand_id、demand_version、status、created_at、updated_at 由 MCP/DB 生成，
 * 不作为 Agent 入参必填。
 * 其他字段（trace_id、parsed_requirement 等）全部放行，不拦截。
 */
const CSV_REQUIRED_FIELDS: Array<{ key: string; type: string; label: string }> = [
  // CSV 合并表中由媒介/Agent 提供的基础需求字段
  { key: "submission_deadline_at", type: "string", label: "提交时间" },
  { key: "submission_deadline_raw", type: "string", label: "提交时间原文" },
  { key: "raw_messages_json",    type: "string",  label: "原始输入的需求内容json" },
  { key: "budget_min_cents",     type: "number",  label: "预算下限" },
  { key: "budget_max_cents",     type: "number",  label: "预算上限" },
  { key: "budget_raw",           type: "string",  label: "预算原文" },
  { key: "rebate_min_rate",      type: "number",  label: "返点下限" },
  { key: "rebate_max_rate",      type: "number",  label: "返点上限" },
  { key: "rebate_raw",           type: "string",  label: "返点原文" },
  { key: "quantity_total",       type: "number",  label: "需要数量" },
  { key: "status",               type: "string",  label: "状态" },
  { key: "created_at",           type: "string",  label: "创建时间" },
  { key: "updated_at",           type: "string",  label: "更新时间" },
  // CSV 行 3 — platform 也是必填
  { key: "platform",             type: "string",  label: "平台" },
];

const RANKING_TOOLS = new Set(["rank_creators", "create_submission_batch"]);
const CLARIFY_GATE = "clarify_requirement";
const PROJECT_DISTRIBUTION_ACTION = "create_with_distributions";
const PROJECT_DISTRIBUTION_TOOL_NAMES = new Set([PROJECT_DISTRIBUTION_ACTION]);
const LEGACY_PROJECT_DISTRIBUTION_TOOL_NAMES = new Set(["create-with-distributions"]);
const EXEC_TOOL_NAMES = new Set(["exec", "bash", "shell", "powershell", "pwsh"]);
const WECOM_ROLES = new Set(["media", "procurement"]);
const PROJECT_USAGE_SCOPE = "project";
const PROJECT_USAGE_SCOPE_ALIASES = new Set([PROJECT_USAGE_SCOPE, "项目"]);
const PROJECT_USAGE_SCOPE_KEYS = ["usageScope", "usage_scope", "usageModule", "module"] as const;
const PROJECT_PAYLOAD_CONTAINER_KEYS = ["project", "body", "json", "payload"] as const;
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PROJECT_DISTRIBUTION_INVOCATION = /(?:^|(?:&&|\|\||;|\|)\s*)(?:(?:uv\s+run|npx|node|(?:[^\s"';&|]*\/)?python(?:3(?:\.\d+)?)?|powershell|pwsh)\s+)?["']?(?:[^\s"';&|]*\/)?create[-_]with[-_]distributions(?:\.(?:py|js|mjs|ts|ps1|sh))?["']?(?=\s|$)/;
const PROJECT_DISTRIBUTION_API_INVOCATION = /\/api\/projects\/create-with-distributions\/?/;

export interface ProjectDistributionInvocation {
  actionKey: string;
  command?: string;
  remindAt: string;
  remindAtMs: number;
}

export interface ProjectDistributionParseResult {
  invocation?: ProjectDistributionInvocation;
  error?: string;
}

interface ProjectDistributionParamsNormalization {
  params: Record<string, unknown>;
  changed: boolean;
  error?: string;
}

interface PendingProjectDistribution extends ProjectDistributionInvocation {
  toolCallId: string;
  sessionKey: string;
  agentId?: string;
  approved: boolean;
}

interface WaitingProjectDistributionSession {
  remindAt: string;
}

const YPMCN_TOOLS = new Set([
  "audit_manual_adjustment",
  "create_submission_batch",
  "get_creator_detail",
  "get_recommendation_run_detail",
  "ingest_mcn_submissions",
  "manual_source_creators",
  "rank_creators",
  "rank_mcns",
  "record_client_feedback",
  "search_creators",
  "validate_requirement",
]);

const workflowStateBySession = new Map<string, WorkflowState>();
const pendingProjectDistributions = new Map<string, PendingProjectDistribution>();
const completedProjectDistributions = new Set<string>();
const completedProjectDistributionSessions = new Set<string>();
const waitingProjectDistributionSessions = new Map<string, WaitingProjectDistributionSession>();
const visitedStepsBySession = new Map<string, string[]>();

const STEP_LABELS: Record<string, string> = {
  "validate_requirement": "需求录入",
  "search_creators": "创作者搜索",
  "rank_mcns": "MCN 排序",
  "create_with_distributions": "项目分发",
  "rank_creators": "达人精排",
  "create_submission_batch": "提报",
};

const PHASE_LABELS: Record<string, string> = {
  // MVP 新阶段名（来自 20260709 文档）
  requirement_draft: "需求待补",
  requirement_ready: "需求就绪",
  candidate_pool_ready: "候选池就绪",
  mcn_planning: "MCN 规划",
  waiting_mcn_return: "等待机构回填",
  candidate_pool_enriched: "候选池汇总完成",
  recommendation_ready: "精排完成",
  submission_batch_ready: "提报批次生成",
  feedback_routing: "客户反馈",
  // 兼容旧阶段名
  requirement: "需求录入",
  candidate_pool: "候选池",
  distribution: "项目分发",
  ranking: "达人精排",
  submission: "提报",
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function block(guardId: string, message: string): GuardError {
  return { guardId, message, severity: "block" };
}

export function normalizeYpmcnToolName(toolName: string): string | null {
  const bareName = toolName.includes("__") ? toolName.slice(toolName.lastIndexOf("__") + 2) : toolName;
  if (YPMCN_TOOLS.has(bareName)) return bareName;
  if (PROJECT_DISTRIBUTION_TOOL_NAMES.has(bareName)) return bareName;
  return null;
}

function resolveSessionKey(ctx?: Record<string, unknown>): string | null {
  if (nonEmptyString(ctx?.sessionKey)) return ctx.sessionKey;
  if (nonEmptyString(ctx?.sessionId)) return ctx.sessionId;
  return null;
}

function bareToolName(toolName: string): string {
  return toolName.includes("__") ? toolName.slice(toolName.lastIndexOf("__") + 2) : toolName;
}

function validateReminderTime(remindAt: unknown, missingMessage: string): ProjectDistributionParseResult {
  if (!remindAt) {
    return { error: missingMessage };
  }
  if (!nonEmptyString(remindAt)) {
    return { error: "deadline/remindAt 必须是非空字符串" };
  }
  if (!ISO_WITH_TIMEZONE.test(remindAt)) {
    return { error: "deadline/remindAt 必须是带时区的 ISO 8601 时间" };
  }

  const remindAtMs = Date.parse(remindAt);
  if (!Number.isFinite(remindAtMs)) {
    return { error: "deadline/remindAt 不是有效时间" };
  }
  if (remindAtMs <= Date.now()) {
    return { error: "deadline/remindAt 必须是未来时间" };
  }

  return { invocation: { actionKey: "", remindAt, remindAtMs } };
}

function findReminderTime(params: Record<string, unknown>): unknown {
  for (const key of ["remindAt", "remind_at", "remind-at", "deadline"]) {
    if (params[key] !== undefined) return params[key];
  }

  for (const key of ["project", "body", "json", "payload"]) {
    const nested = params[key];
    if (isObject(nested)) {
      const value = findReminderTime(nested);
      if (value !== undefined) return value;
    }
  }

  return undefined;
}

function findSupplierIds(params: Record<string, unknown>): unknown {
  if (params.supplierIds !== undefined) return params.supplierIds;
  if (params.supplier_ids !== undefined) return params.supplier_ids;
  return undefined;
}

function validateSupplierIds(params: Record<string, unknown>): string | null {
  const supplierIds = findSupplierIds(params);
  if (!Array.isArray(supplierIds) || supplierIds.length === 0) {
    return `${PROJECT_DISTRIBUTION_ACTION} 工具调用必须包含非空 supplierIds/supplier_ids`;
  }
  if (supplierIds.some((item) => !nonEmptyString(item))) {
    return "supplierIds/supplier_ids 必须是非空字符串数组";
  }
  return null;
}

function validateProjectDistributionPlanId(params: Record<string, unknown>): string | null {
  if (!nonEmptyString(params.id)) {
    return `${PROJECT_DISTRIBUTION_ACTION} 工具调用必须包含来自 rank_mcns.data.id 的 MCN 排序方案 id`;
  }
  return null;
}

function isMissingUsageScopeValue(value: unknown): boolean {
  return value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0);
}

function isProjectUsageScopeValue(value: unknown): value is string {
  return typeof value === "string" && PROJECT_USAGE_SCOPE_ALIASES.has(value.trim());
}

function hasProjectUsageScope(params: Record<string, unknown>): boolean {
  return PROJECT_USAGE_SCOPE_KEYS.some((key) => isProjectUsageScopeValue(params[key]));
}

function normalizeProjectUsageScopeValues(params: Record<string, unknown>): ProjectDistributionParamsNormalization {
  const seen = new Set<Record<string, unknown>>();
  const queue: Array<{ params: Record<string, unknown>; path: string; depth: number }> = [
    { params, path: "params", depth: 0 },
  ];
  const replacements: Array<{ params: Record<string, unknown>; key: typeof PROJECT_USAGE_SCOPE_KEYS[number] }> = [];

  for (const item of queue) {
    if (seen.has(item.params)) continue;
    seen.add(item.params);

    for (const key of PROJECT_USAGE_SCOPE_KEYS) {
      const value = item.params[key];
      if (isMissingUsageScopeValue(value)) continue;
      if (!isProjectUsageScopeValue(value)) {
        return {
          params,
          changed: false,
          error: `${item.path}.${key} 必须为 "${PROJECT_USAGE_SCOPE}" 或 "项目"`,
        };
      }
      if (value !== PROJECT_USAGE_SCOPE) {
        replacements.push({ params: item.params, key });
      }
    }

    if (item.depth >= 2) continue;
    for (const key of PROJECT_PAYLOAD_CONTAINER_KEYS) {
      const nested = item.params[key];
      if (isObject(nested)) {
        queue.push({ params: nested, path: `${item.path}.${key}`, depth: item.depth + 1 });
      }
    }
  }

  if (replacements.length === 0) return { params, changed: false };

  const cloneMap = new Map<Record<string, unknown>, Record<string, unknown>>();
  for (const item of seen) {
    cloneMap.set(item, { ...item });
  }
  for (const { params: target, key } of replacements) {
    cloneMap.get(target)![key] = PROJECT_USAGE_SCOPE;
  }
  for (const item of seen) {
    const cloned = cloneMap.get(item)!;
    for (const key of PROJECT_PAYLOAD_CONTAINER_KEYS) {
      const nested = item[key];
      if (isObject(nested) && cloneMap.has(nested)) {
        cloned[key] = cloneMap.get(nested);
      }
    }
  }

  return { params: cloneMap.get(params) ?? params, changed: true };
}

function normalizeProjectDistributionParams(params: Record<string, unknown>): ProjectDistributionParamsNormalization {
  const normalizedUsageScope = normalizeProjectUsageScopeValues(params);
  if (normalizedUsageScope.error) return normalizedUsageScope;
  params = normalizedUsageScope.params;

  const project = isObject(params.project) ? params.project : null;
  if (project) {
    if (hasProjectUsageScope(project) || hasProjectUsageScope(params)) {
      return { params, changed: normalizedUsageScope.changed };
    }
    return {
      params: {
        ...params,
        project: {
          ...project,
          usageScope: PROJECT_USAGE_SCOPE,
        },
      },
      changed: true,
    };
  }

  if (hasProjectUsageScope(params)) {
    return { params, changed: normalizedUsageScope.changed };
  }

  return {
    params: {
      ...params,
      usageScope: PROJECT_USAGE_SCOPE,
    },
    changed: true,
  };
}

export function parseProjectDistributionInvocation(toolName: string, params: Record<string, unknown>): ProjectDistributionParseResult | null {
  const bareName = bareToolName(toolName);

  if (LEGACY_PROJECT_DISTRIBUTION_TOOL_NAMES.has(bareName)) {
    return { error: `旧工具名 create-with-distributions 已停用；请改用 ${PROJECT_DISTRIBUTION_ACTION}` };
  }

  if (PROJECT_DISTRIBUTION_TOOL_NAMES.has(bareName)) {
    const planIdError = validateProjectDistributionPlanId(params);
    if (planIdError) return { error: planIdError };
    const parsed = validateReminderTime(
      findReminderTime(params),
      `${PROJECT_DISTRIBUTION_ACTION} 工具调用必须包含未来的 deadline/remindAt`,
    );
    if (!parsed.invocation) return parsed;
    const supplierIdsError = validateSupplierIds(params);
    if (supplierIdsError) return { error: supplierIdsError };
    return {
      invocation: {
        ...parsed.invocation,
        actionKey: `tool:${bareName}:${parsed.invocation.remindAt}`,
      },
    };
  }

  if (!EXEC_TOOL_NAMES.has(bareName)) return null;

  const command = nonEmptyString(params.command)
    ? params.command
    : nonEmptyString(params.cmd)
      ? params.cmd
      : null;
  if (!command || (!PROJECT_DISTRIBUTION_INVOCATION.test(command) && !PROJECT_DISTRIBUTION_API_INVOCATION.test(command))) return null;

  return {
    error: `不要通过 Bash/PowerShell/curl 直接调用 ${PROJECT_DISTRIBUTION_ACTION}；请使用 YP Action 工具 ${PROJECT_DISTRIBUTION_ACTION}，完成 allow-once 审批后发送企微询价。`,
  };
}

function waitingBlockReason(waiting: WaitingProjectDistributionSession): string {
  return "项目分发已执行；当前必须停止并等待用户明确继续";
}

function runBeforeProjectDistributionToolCall(
  event: Record<string, unknown>,
  ctx?: Record<string, unknown>,
): BeforeToolCallResult | undefined {
  const sessionKey = resolveSessionKey(ctx);
  const waiting = sessionKey ? waitingProjectDistributionSessions.get(sessionKey) : undefined;
  if (waiting) {
    // askuserquestion is exempt from wait-lock so Agent can prompt user for next action
    const rawToolName = String(event.toolName ?? "");
    if (bareToolName(rawToolName) === "askuserquestion") {
      return undefined;
    }
    return { block: true, blockReason: waitingBlockReason(waiting) };
  }

  const rawToolName = String(event.toolName ?? "");
  let params = isObject(event.params) ? event.params : {};
  let normalizedParams: ProjectDistributionParamsNormalization | undefined;
  if (PROJECT_DISTRIBUTION_TOOL_NAMES.has(bareToolName(rawToolName))) {
    normalizedParams = normalizeProjectDistributionParams(params);
    if (normalizedParams.error) return { block: true, blockReason: normalizedParams.error };
    params = normalizedParams.params;
    if (normalizedParams.changed) event.params = params;
  }

  const parsed = parseProjectDistributionInvocation(rawToolName, params);
  if (!parsed) return undefined;
  if (parsed.error) return { block: true, blockReason: parsed.error };
  if (!parsed.invocation) return { block: true, blockReason: `${PROJECT_DISTRIBUTION_ACTION} 调用无法解析` };
  if (!sessionKey) {
    // MCP 工具调用可能不带 sessionKey，允许发送但跳过等待锁状态追踪
    return normalizedParams?.changed ? { params } : undefined;
  }

  const toolCallId = nonEmptyString(event.toolCallId) ? event.toolCallId : null;
  if (!toolCallId) return { block: true, blockReason: `${PROJECT_DISTRIBUTION_ACTION} 缺少 toolCallId，无法安全去重` };

  pendingProjectDistributions.set(toolCallId, {
    ...parsed.invocation,
    toolCallId,
    sessionKey,
    agentId: nonEmptyString(ctx?.agentId) ? ctx.agentId : undefined,
    approved: true,
  });

  // requireApproval bypassed — gateway pairing not available in YP Action
  // Agent-level text table confirmation (mcn-wechat-send) provides user confirmation
  return normalizedParams?.changed ? { params } : undefined;
}

function findExitCode(result: unknown): number | null {
  if (!isObject(result)) return null;
  for (const key of ["exitCode", "exit_code", "code"] as const) {
    if (typeof result[key] === "number") return result[key];
  }
  return isObject(result.details) ? findExitCode(result.details) : null;
}

function projectDistributionToolCallSucceeded(event: Record<string, unknown>): boolean {
  if (nonEmptyString(event.error)) return false;
  const result = event.result;
  if (isObject(result) && (result.isError === true || result.success === false)) return false;
  const exitCode = findExitCode(result);
  return exitCode === null || exitCode === 0;
}

async function runAfterProjectDistributionToolCall(event: Record<string, unknown>): Promise<void> {
  const toolCallId = nonEmptyString(event.toolCallId) ? event.toolCallId : null;
  if (!toolCallId || completedProjectDistributions.has(toolCallId)) return;

  const pending = pendingProjectDistributions.get(toolCallId);
  if (!pending) return;
  const params = isObject(event.params) ? event.params : {};
  const parsed = parseProjectDistributionInvocation(String(event.toolName ?? ""), params);
  if (!parsed?.invocation || parsed.invocation.actionKey !== pending.actionKey || !pending.approved) {
    pendingProjectDistributions.delete(toolCallId);
    return;
  }
  if (!projectDistributionToolCallSucceeded(event)) {
    pendingProjectDistributions.delete(toolCallId);
    return;
  }

  // preview_only 模式不触发等待锁，允许后续真实发送
  if (params.preview_only === true) {
    pendingProjectDistributions.delete(toolCallId);
    return;
  }

  completedProjectDistributions.add(toolCallId);
  completedProjectDistributionSessions.add(pending.sessionKey);
  waitingProjectDistributionSessions.set(pending.sessionKey, { remindAt: pending.remindAt });
  pendingProjectDistributions.delete(toolCallId);
}

function cacheWorkflowState(ctx: Record<string, unknown> | undefined, workflowState: WorkflowState | null | undefined): void {
  const sessionKey = resolveSessionKey(ctx);
  if (sessionKey && workflowState && isObject(workflowState)) {
    workflowStateBySession.set(sessionKey, workflowState);
  }
}

function resolveWorkflowState(ctx: ToolCallContext): WorkflowState | null {
  if (ctx.workflowState && isObject(ctx.workflowState)) return ctx.workflowState;

  const sessionWorkflowState = ctx.sessionState?.workflow_state;
  if (isObject(sessionWorkflowState)) return sessionWorkflowState as unknown as WorkflowState;

  return null;
}

function resolveAllowedActions(ctx: ToolCallContext, workflowState: WorkflowState | null): string[] {
  const fromState = workflowState?.allowed_actions;
  if (Array.isArray(fromState)) return fromState.filter((item): item is string => typeof item === "string");

  return [];
}

function hasCompletedProjectDistribution(ctx: ToolCallContext): boolean {
  const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? null;
  if (sessionKey && completedProjectDistributionSessions.has(sessionKey)) return true;

  return ctx.sessionState?.project_distribution_completed === true ||
    ctx.sessionState?.create_with_distributions_completed === true;
}

function platformStatesAreSupplyReady(workflowState: WorkflowState | null): boolean {
  const platformStates = workflowState?.platform_states ?? {};
  const states = Object.values(platformStates);
  return states.length > 0 && states.every(
    (state) => state.mcn_phase === "not_required" || state.mcn_phase === "ingested",
  );
}

function hasSupplyReadyForRanking(ctx: ToolCallContext, workflowState: WorkflowState | null): boolean {
  const gateState = isObject(ctx.sessionState?.ypmcn_gate_state)
    ? ctx.sessionState.ypmcn_gate_state as Record<string, unknown>
    : null;

  if (gateState?.ranking_after_supply_ready_confirmed === true) return true;
  if (ctx.sessionState?.ranking_after_supply_ready_confirmed === true) return true;
  if (ctx.sessionState?.candidate_pool_supply_ready === true) return true;
  if (ctx.sessionState?.mcn_submissions_ingested === true) return true;
  if (platformStatesAreSupplyReady(workflowState)) return true;
  if (workflowState?.allowed_actions?.includes("rank_creators") && !workflowState.pending_gate) return true;

  return false;
}

function validateProjectDistributionBeforeRanking(ctx: ToolCallContext): GuardError[] {
  if (ctx.toolName !== "rank_creators") return [];
  const workflowState = resolveWorkflowState(ctx);

  if (!hasCompletedProjectDistribution(ctx)) {
    return [
      block(
        "state-guard",
        `rank_creators 前必须先调用 ${PROJECT_DISTRIBUTION_ACTION} 完成企微询价发送；不得跳过询价直接精排`,
      ),
    ];
  }

  if (!hasSupplyReadyForRanking(ctx, workflowState)) {
    return [
      block(
        "state-guard",
        "rank_creators 前必须等待机构回填/达人拓展结果回收到候选池，并完成 confirm-ranking-after-supply-ready 确认；不得企微发送后直接精排",
      ),
    ];
  }

  return [];
}

function isClarifyValidateRequirement(ctx: ToolCallContext, workflowState: WorkflowState | null): boolean {
  return (
    ctx.toolName === "validate_requirement" &&
    workflowState?.pending_gate?.gate === CLARIFY_GATE
  );
}

const PLATFORM_ENUM = new Set(["xhs", "dy"]);

function validatePlatformEnum(params: Record<string, unknown>): GuardError[] {
  const platform = params.platform;
  if (platform !== undefined && platform !== null) {
    if (typeof platform !== "string" || !PLATFORM_ENUM.has(platform)) {
      return [block("platform-enum", `platform 必须是 "xhs"（小红书）或 "dy"（抖音），当前值为 "${platform}"`)];
    }
  }
  return [];
}

const PLURAL_ALIASES: Record<string, string> = {
  "platforms": "platform",
  "quantities": "quantity_total",
  "budgets": "budget_max_cents",
};

function validatePluralAliases(ctx: ToolCallContext): GuardError[] {
  if (ctx.toolName !== "validate_requirement") return [];
  const params = ctx.params;
  for (const [plural, singular] of Object.entries(PLURAL_ALIASES)) {
    if (plural in params) {
      return [block("plural-alias", `参数 "${plural}" 不在 inputSchema 中。请用 "${singular}"（单数）。MCP schema 字段名以 CSV 为准。`)];
    }
  }
  return [];
}

const CHAIN_ID_REQUIREMENTS: Record<string, string> = {
  search_creators: "validate_requirement.data.id",
  rank_mcns: "search_creators.data.id",
};

function validateChainIdParams(ctx: ToolCallContext): GuardError[] {
  const source = CHAIN_ID_REQUIREMENTS[ctx.toolName];
  if (!source) return [];

  // demand_id/demand_version 不再校验 — 不管有没有传，都不报错
  if (!nonEmptyString(ctx.params.id)) {
    return [block("chain-id", `${ctx.toolName} 必须包含来自 ${source} 的非空 id`)];
  }
  return [];
}

export function validateProtocolEnvelope(ctx: ToolCallContext): GuardError[] {
  if (ctx.toolName !== "validate_requirement") return validateChainIdParams(ctx);

  const errors: GuardError[] = [...validatePlatformEnum(ctx.params), ...validatePluralAliases(ctx)];
  const params = ctx.params;

  // CSV 合并表必填字段非空校验 — 传了就必须有值
  for (const field of CSV_REQUIRED_FIELDS) {
    const value = params[field.key];
    if (value !== undefined && value !== null) {
      // 类型检查
      if (field.type === "string" && typeof value !== "string") {
        errors.push(block("protocol-envelope", `${field.key}(${field.label}) 必须为字符串`));
      } else if (field.type === "number" && typeof value !== "number") {
        errors.push(block("protocol-envelope", `${field.key}(${field.label}) 必须为数字`));
      } else if (field.type === "integer" && !Number.isInteger(value)) {
        errors.push(block("protocol-envelope", `${field.key}(${field.label}) 必须为整数`));
      }
    }
  }

  return errors;
}

function gateIsConfirmedByRuntimeField(ctx: ToolCallContext, pendingGate: PendingGate): boolean {
  if (pendingGate.gate === "confirm_medium_risk") {
    return ctx.toolName === "rank_mcns" && ctx.params.medium_risk_confirmed === true;
  }

  if (pendingGate.gate === "confirm_risky_submission") {
    return ctx.toolName === "create_submission_batch" && ctx.params.allow_need_confirm_with_risk === true;
  }

  return false;
}

function validateGateConfirmation(ctx: ToolCallContext, workflowState: WorkflowState): GuardError[] {
  const pendingGate = workflowState.pending_gate;
  if (!pendingGate) return [];

  if (isClarifyValidateRequirement(ctx, workflowState)) return [];
  if (gateIsConfirmedByRuntimeField(ctx, pendingGate)) return [];

  if (pendingGate.gate === "confirm_medium_risk" && ctx.toolName === "rank_mcns") {
    return [block("state-guard", "中风险继续执行前，rank_mcns.medium_risk_confirmed 必须为 true")];
  }

  if (pendingGate.gate === "confirm_risky_submission" && ctx.toolName === "create_submission_batch") {
    return [block("state-guard", "风险提报前，create_submission_batch.allow_need_confirm_with_risk 必须为 true")];
  }

  return [];
}

function validateStateGuard(ctx: ToolCallContext): GuardError[] {
  const workflowState = resolveWorkflowState(ctx);
  if (!workflowState) return [];

  const errors: GuardError[] = [];
  const allowedActions = resolveAllowedActions(ctx, workflowState);

  if (allowedActions.length > 0 && !allowedActions.includes(ctx.toolName)) {
    errors.push(block("state-guard", `当前状态不允许调用 ${ctx.toolName}，请检查 workflow_state.allowed_actions`));
  }

  errors.push(...validateGateConfirmation(ctx, workflowState));

  const platformStates = workflowState.platform_states ?? {};

  if (RANKING_TOOLS.has(ctx.toolName)) {
    for (const [platform, state] of Object.entries(platformStates)) {
      if (state.mcn_phase === "not_required") continue;
      if (state.mcn_phase !== "ingested") {
        errors.push(block("state-guard", `平台 ${platform} 的 mcn_phase=${state.mcn_phase}，未达 ingested，不得调用 ${ctx.toolName}`));
      }
    }
  }

  if (allowedActions.includes("rank_creators") || allowedActions.includes("create_submission_batch")) {
    const allReady = Object.values(platformStates).every(
      (state) => state.mcn_phase === "not_required" || state.mcn_phase === "ingested",
    );

    if (!allReady) {
      errors.push(block("state-guard", "MCP 返回的 allowed_actions 与 platform_states 矛盾——allowed_actions 包含 rank_creators/create_submission_batch 但存在平台 mcn_phase 未达 ingested，停止并报告 integration_required"));
    }
  }

  return errors;
}

function validateHighRiskGuard(ctx: ToolCallContext): GuardError[] {
  if (!RANKING_TOOLS.has(ctx.toolName)) return [];

  const workflowState = resolveWorkflowState(ctx);
  if (!workflowState) return [];

  const errors: GuardError[] = [];
  for (const [platform, state] of Object.entries(workflowState.platform_states ?? {})) {
    if (state.risk_level === "high_risk" && state.mcn_phase !== "ingested") {
      errors.push(block("high-risk-guard", `平台 ${platform} 供给风险为 high_risk，必须先通过 supply_recovery 补量或降低风险评估，不得直接进入 ${ctx.toolName}`));
    }
  }

  return errors;
}

function buildPendingGateApproval(ctx: ToolCallContext, workflowState: WorkflowState | null): BeforeToolCallResult["requireApproval"] | undefined {
  const pendingGate = workflowState?.pending_gate;
  if (!pendingGate) return undefined;
  if (pendingGate.gate === CLARIFY_GATE) return undefined;
  if (gateIsConfirmedByRuntimeField(ctx, pendingGate)) return undefined;

  const severity: "info" | "warning" | "critical" =
    pendingGate.gate === "supply_recovery" || pendingGate.gate === "manual_review_required"
      ? "critical"
      : pendingGate.gate === "confirm_medium_risk" || pendingGate.gate === "confirm_risky_submission"
        ? "warning"
        : "info";

  return {
    title: `YPmcn 需要确认：${pendingGate.gate}`,
    description: pendingGate.reason,
    severity,
    timeoutBehavior: "deny",
    allowedDecisions: ["allow-once", "deny"],
  };
}

function buildRankCreatorsApproval(ctx: ToolCallContext): BeforeToolCallResult["requireApproval"] | undefined {
  if (ctx.toolName !== "rank_creators") return undefined;
  // requireApproval bypassed — gateway pairing not available in YP Action
  // Agent-level askuserquestion confirmation (confirm-ranking-after-supply-ready) provides user confirmation
  return undefined;
}

function validateStagedGate(ctx: ToolCallContext): GuardError[] {
  const workflowState = resolveWorkflowState(ctx);
  const gateState = isObject(ctx.sessionState?.ypmcn_gate_state)
    ? ctx.sessionState.ypmcn_gate_state as Record<string, unknown>
    : null;

  const errors: GuardError[] = [];

  if (ctx.toolName === "search_creators") {
    const pendingGate = workflowState?.pending_gate;
    if (pendingGate && pendingGate.gate !== CLARIFY_GATE) {
      const isConfirmed = gateState ? gateState.structured_brief_confirmed === true : false;
      if (!isConfirmed) {
        errors.push(block("staged-gate", pendingGate.reason));
      }
    }
  }

  if (PROJECT_DISTRIBUTION_TOOL_NAMES.has(ctx.toolName)) {
    const pendingGate = workflowState?.pending_gate;
    if (pendingGate && pendingGate.gate !== CLARIFY_GATE) {
      const gateKey = pendingGate.gate.startsWith("confirm_")
        ? pendingGate.gate.replace("confirm_", "") + "_confirmed"
        : pendingGate.gate + "_confirmed";
      const isConfirmed = gateState ? gateState[gateKey] === true : false;
      if (!isConfirmed) {
        errors.push(block("staged-gate", pendingGate.reason));
      }
    }
  }

  return errors;
}

function validateWecomRole(ctx: ToolCallContext): GuardError[] {
  if (!PROJECT_DISTRIBUTION_TOOL_NAMES.has(ctx.toolName) && !LEGACY_PROJECT_DISTRIBUTION_TOOL_NAMES.has(ctx.toolName)) return [];

  const role = ctx.operatorRole ?? ctx.sessionState?.operator_role ?? ctx.sessionState?.operatorRole;
  if (typeof role === "string" && !WECOM_ROLES.has(role)) {
    return [block("wecom-role", `企微发送仅限媒介和采购角色，当前角色 ${role} 无权限`)];
  }

  return [];
}

export async function runBeforeToolCallGuards(ctx: ToolCallContext): Promise<BeforeToolCallResult | void> {
  const guardErrors = [
    ...validateProtocolEnvelope(ctx),
    ...validateHighRiskGuard(ctx),
    ...validateStateGuard(ctx),
    ...validateProjectDistributionBeforeRanking(ctx),
    ...validateStagedGate(ctx),
    ...validateWecomRole(ctx),
  ];

  const blockingErrors = guardErrors.filter((error) => error.severity === "block");
  if (blockingErrors.length > 0) {
    return {
      block: true,
      blockReason: blockingErrors.map((error) => error.message).join("; "),
    };
  }

  return undefined;
}

export function responseContractGuard(result: ToolResultContext): GuardError[] {
  return [];
}

function parseObjectJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;

  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function envelopeFromContent(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") return parseObjectJson(value);
  if (!Array.isArray(value)) return null;

  for (const item of value) {
    if (!isObject(item) || item.type !== "text") continue;
    const parsed = parseObjectJson(item.text);
    if (parsed) return parsed;
  }

  return null;
}

function looksLikeEnvelope(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  return ["success", "data", "error", "workflow_state", "allowed_actions"].some((key) => key in value);
}

function structuredContent(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const details = isObject(value.details) ? value.details : null;
  return details && isObject(details.structuredContent) ? details.structuredContent : null;
}

function resolveToolResultEnvelope(event: Record<string, unknown>): Record<string, unknown> {
  const message = isObject(event.message) ? event.message : null;
  const result = isObject(event.result) ? event.result : null;
  const candidates: unknown[] = [
    message ? structuredContent(message) : null,
    result ? structuredContent(result) : null,
    result?.structuredContent,
    message?.structuredContent,
    result?.envelope,
    event.envelope,
    message ? envelopeFromContent(message.content) : null,
    result ? envelopeFromContent(result.content) : null,
    result,
    event,
  ];

  return candidates.find(looksLikeEnvelope) ?? {};
}

function normalizeToolResultEvent(event: Record<string, unknown>): ToolResultContext | null {
  const message = isObject(event.message) ? event.message : null;
  const rawToolName = String(event.toolName ?? event.name ?? message?.toolName ?? "");
  const toolName = normalizeYpmcnToolName(rawToolName);
  if (!toolName) return null;

  const envelope = resolveToolResultEnvelope(event);

  return {
    toolName,
    success: Boolean(envelope.success),
    data: envelope.data,
    params: isObject(event.params) ? event.params : undefined,
    error: isObject(envelope.error) ? envelope.error as ToolResultContext["error"] : null,
    traceId: typeof envelope.trace_id === "string" ? envelope.trace_id : undefined,
    workflowState: isObject(envelope.workflow_state) ? envelope.workflow_state as unknown as WorkflowState : null,
    allowedActions: envelope.allowed_actions,
  };
}

export function rewriteInvalidToolResult(result: ToolResultContext): Record<string, unknown> | undefined {
  return undefined;
}

function buildStateSummary(sessionKey: string | null): string {
  if (!sessionKey) return "";

  const wf = workflowStateBySession.get(sessionKey);
  const visited = visitedStepsBySession.get(sessionKey) ?? [];
  const distDone = completedProjectDistributionSessions.has(sessionKey);
  const waitLock = waitingProjectDistributionSessions.has(sessionKey);

  const lines: string[] = ["[YPmcn 当前状态]"];
  if (wf?.phase && PHASE_LABELS[wf.phase]) {
    lines.push(`阶段: ${PHASE_LABELS[wf.phase]} (${wf.phase})`);
  }

  if (visited.length > 0) {
    const labels = visited.map((s) => STEP_LABELS[s] || s);
    lines.push(`已完成: ${labels.join(" → ")}`);
  }

  if (wf?.allowed_actions && wf.allowed_actions.length > 0) {
    const nextLabels = wf.allowed_actions.map((s) => STEP_LABELS[s] || s);
    lines.push(`允许动作: ${nextLabels.join(", ")}`);
  }

  if (distDone) lines.push("项目分发已完成（等待机构回填/达人拓展回收到候选池）");
  if (waitLock) lines.push("正在等待用户决策，请用 askuserquestion 弹窗");

  if (wf?.pending_gate) {
    lines.push(`等待确认: ${wf.pending_gate.gate} — ${wf.pending_gate.reason}`);
  }

  lines.push("按 SKILL.md 流程推进，字段名以 CSV 和 inputSchema 为准。");

  return lines.join("\n");
}

export function registerHooks(api: { on: (name: string, handler: (...args: any[]) => unknown, opts?: Record<string, unknown>) => void }): void {
  api.on(
    "message_received",
    (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      const sessionKey = resolveSessionKey(ctx) ?? (nonEmptyString(event.sessionKey) ? event.sessionKey : null);
      if (sessionKey) waitingProjectDistributionSessions.delete(sessionKey);
    },
    { priority: 90, timeoutMs: 5_000 },
  );

  api.on(
    "agent_turn_prepare",
    (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      const sessionKey = resolveSessionKey(ctx);
      if (!sessionKey) return;
      const summary = buildStateSummary(sessionKey);
      if (!summary) return;
      return { prependContext: summary };
    },
    { priority: 90, timeoutMs: 5_000 },
  );

  api.on(
    "before_tool_call",
    async (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      const projectDistributionResult = runBeforeProjectDistributionToolCall(event, ctx);
      if (projectDistributionResult?.block || projectDistributionResult?.requireApproval) {
        return projectDistributionResult;
      }

      const toolName = normalizeYpmcnToolName(String(event.toolName ?? ""));
      if (!toolName) return;

      const sessionKey = resolveSessionKey(ctx);
      const toolCtx: ToolCallContext = {
        toolName,
        params: isObject(event.params) ? event.params : {},
        agentId: typeof ctx?.agentId === "string" ? ctx.agentId : undefined,
        sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
        sessionId: typeof ctx?.sessionId === "string" ? ctx.sessionId : undefined,
        sessionState: isObject((ctx as Record<string, unknown> | undefined)?.sessionState)
          ? (ctx as { sessionState: Record<string, unknown> }).sessionState
          : undefined,
        workflowState: sessionKey ? workflowStateBySession.get(sessionKey) : undefined,
        operatorRole: typeof ctx?.operatorRole === "string" ? ctx.operatorRole : undefined,
      };
      if (toolName === "validate_requirement" && sessionKey) {
        completedProjectDistributionSessions.delete(sessionKey);
      }
      if (toolName === "validate_requirement") {
        const rawMessages = toolCtx.params.raw_messages;
        if (Array.isArray(rawMessages)) {
          let serialized: string;
          try {
            serialized = JSON.stringify(toolCtx.params.raw_messages);
          } catch (serializeError) {
            return {
              block: true,
              blockReason: `raw_messages 包含不可序列化对象，MCP 解析将失败: ${serializeError instanceof Error ? serializeError.message : String(serializeError)}`,
            };
          }
          try {
            JSON.parse(serialized);
          } catch (parseError) {
            return {
              block: true,
              blockReason: `raw_messages 包含不可序列化对象，MCP 解析将失败: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            };
          }
        }
      }
      const guardResult = await runBeforeToolCallGuards(toolCtx);
      if (guardResult) return guardResult;
      return projectDistributionResult?.params ? { params: projectDistributionResult.params } : undefined;
    },
    { priority: 90, timeoutMs: 5_000 },
  );

  api.on(
    "after_tool_call",
    async (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      await runAfterProjectDistributionToolCall(event);

      const normalized = normalizeToolResultEvent(event);
      if (!normalized) return;
      cacheWorkflowState(ctx, normalized.workflowState);

      // Track successful tool calls for state summary
      if (normalized.success && STEP_LABELS[normalized.toolName]) {
        const sessionKey = resolveSessionKey(ctx);
        if (sessionKey) {
          const visited = visitedStepsBySession.get(sessionKey) ?? [];
          if (!visited.includes(normalized.toolName)) {
            visited.push(normalized.toolName);
            visitedStepsBySession.set(sessionKey, visited);
          }
        }
      }
    },
    { priority: 90, timeoutMs: 5_000 },
  );

  api.on(
    "tool_result_persist",
    (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      const normalized = normalizeToolResultEvent(event);
      if (!normalized) return;
      const rewritten = rewriteInvalidToolResult(normalized);
      if (!rewritten) {
        cacheWorkflowState(ctx, normalized.workflowState);
        return;
      }
    },
    { priority: 90, timeoutMs: 5_000 },
  );
}

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "ypmcn-media-assistant",
  name: "YPmcn 媒介助手",
  description: "按业务阶段调用独立 MCP，并以人工 gate、短回复和可恢复状态管理达人提报流程。",
  register(api) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = api as any;
    registerHooks(a);
  },
});

export default plugin;
