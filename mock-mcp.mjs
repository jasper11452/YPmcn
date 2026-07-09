/**
 * Mock YPmcn MCP 2.1.0 — 带请求日志
 */
import http from "node:http";
import { writeFileSync } from "node:fs";

const PORT = 19876;
const LOG = "/tmp/mock-mcp-log.jsonl";

function log(id, method, params) {
  writeFileSync(LOG, JSON.stringify({ t: Date.now(), id, method, params }) + "\n", { flag: "a" });
}

const TOOLS = [
  { name: "business_health", description: "检查 MCP 业务服务状态", inputSchema: { type: "object", properties: {} } },
  { name: "validate_requirement", description: "验证需求—接受结构化字段作为顶层参数", inputSchema: { type: "object", properties: { platform: { type: "string" }, quantity_total: { type: "number" }, submission_deadline_at: { type: "string" }, budget_min_cents: { type: "number" }, budget_max_cents: { type: "number" }, budget_raw: { type: "string" }, rebate_min_rate: { type: "number" }, rebate_max_rate: { type: "number" }, rebate_raw: { type: "string" }, content_requirements: { type: "string" }, followercount: { type: "object" }, project_name: { type: "string" }, brand: { type: "string" }, product: { type: "string" }, category_requirements: { type: "array", items: { type: "string" } }, raw_messages: { type: "array", items: { type: "object" } }, project_context: { type: "object" }, existing_demand_id: { type: "string" }, existing_demand_version: { type: "integer" }, requirements_json: { type: "string" }, creator_type_requirements: { type: "string" } } } },
  { name: "search_creators", description: "搜索创作者", inputSchema: { type: "object", properties: { id: { type: "string" }, platform: { type: "string" }, category_requirements: { type: "array", items: { type: "string" } } } } },
  { name: "rank_mcns", description: "MCN 排序", inputSchema: { type: "object", properties: { id: { type: "string" }, platform: { type: "string" }, medium_risk_confirmed: { type: "boolean" } } } },
  { name: "create_with_distributions", description: "创建项目并分发供应商", inputSchema: { type: "object", properties: { deadline: { type: "string" }, supplierIds: { type: "array", items: { type: "string" } }, project: { type: "object" }, preview_only: { type: "boolean" }, remindAt: { type: "string" }, usageScope: { type: "string" }, sendWechatNotification: { type: "boolean" }, supplier_ids: { type: "array", items: { type: "string" } } }, required: ["deadline", "supplierIds"] } },
  { name: "rank_creators", description: "创作者精排", inputSchema: { type: "object", properties: { id: { type: "string" }, ranking_strategy: { type: "string" }, platform: { type: "string" } } } },
  { name: "create_submission_batch", description: "创建提报批次", inputSchema: { type: "object", properties: { run_id: { type: "string" }, allow_need_confirm_with_risk: { type: "boolean" } } } },
  { name: "get_creator_detail", description: "获取创作者详情", inputSchema: { type: "object", properties: { creator_id: { type: "string" } } } },
  { name: "get_recommendation_run_detail", description: "获取推荐运行详情", inputSchema: { type: "object", properties: { run_id: { type: "string" } } } },
  { name: "record_client_feedback", description: "记录客户反馈", inputSchema: { type: "object", properties: { submission_batch_id: { type: "string" }, feedback_type: { type: "string" }, feedback_content: { type: "string" } } } },
  { name: "manual_source_creators", description: "手动补充创作者", inputSchema: { type: "object", properties: { id: { type: "string" }, creator_ids: { type: "array", items: { type: "string" } } } } },
  { name: "audit_manual_adjustment", description: "审核手动调整", inputSchema: { type: "object", properties: { adjustment_id: { type: "string" }, action: { type: "string" } } } },
  { name: "ingest_mcn_submissions", description: "导入 MCN 提报", inputSchema: { type: "object", properties: { mcn_id: { type: "string" }, demand_id: { type: "string" } } } },
];

function mockResponse(toolName, params) {
  const trace_id = `mock-trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const base = (data, extra = {}) => ({ success: true, data, error: null, trace_id, ...extra });
  switch (toolName) {
    case "business_health": return base({ status: "ok", server: "Mock YPmcn MCP 2.1.0", timestamp: new Date().toISOString(), tools: TOOLS.map(t => t.name) });
    case "validate_requirement": return base({ id: `demand-mock-${Date.now()}`, status: "ready", demand_id: `demand-mock-${Date.now()}`, demand_version: 1, requirement_parsed: { platforms: [params?.platform || "xhs"], quantity_total: params?.quantity_total || 5, budget_max_cents: params?.budget_max_cents || 3000000, budget_raw: params?.budget_raw || "3万", rebate_min_rate: params?.rebate_min_rate || 0.2 } }, { workflow_state: { phase: "requirement_ready", pending_gate: null, allowed_actions: ["search_creators"], platform_states: { xhs: { mcn_phase: "not_started", risk_level: null } } }, allowed_actions: ["search_creators"] });
    case "search_creators": return base({ id: `candidate-pool-${Date.now()}`, creators: [{ creator_id: "c_001", nickname: "美妆达人A", platform: "xhs", followers: 50000, estimated_price: 2500 }, { creator_id: "c_002", nickname: "美妆达人B", platform: "xhs", followers: 80000, estimated_price: 3000 }, { creator_id: "c_003", nickname: "美妆达人C", platform: "xhs", followers: 30000, estimated_price: 1500 }, { creator_id: "c_004", nickname: "美妆达人D", platform: "xhs", followers: 120000, estimated_price: 4000 }, { creator_id: "c_005", nickname: "美妆达人E", platform: "xhs", followers: 60000, estimated_price: 2000 }], total_count: 5 }, { workflow_state: { phase: "candidate_pool_ready", pending_gate: null, allowed_actions: ["rank_mcns"] } });
    case "rank_mcns": return base({ id: `mcn-plan-${Date.now()}`, mcns: [{ mcn_id: "mcn_001", name: "星瀚传媒", match_count: 3, score: 0.92, risk_level: "normal" }, { mcn_id: "mcn_002", name: "聚星传媒", match_count: 2, score: 0.85, risk_level: "normal" }, { mcn_id: "mcn_003", name: "柠檬MCN", match_count: 1, score: 0.78, risk_level: "low" }, { mcn_id: "mcn_004", name: "光芒传媒", match_count: 1, score: 0.72, risk_level: "low" }] }, { workflow_state: { phase: "mcn_planning", pending_gate: null, allowed_actions: ["create_with_distributions", "rank_creators"], platform_states: { xhs: { mcn_phase: "ingested", risk_level: null } } } });
    case "create_with_distributions": return params?.preview_only ? base({ preview: true, message_content: "测试消息", suppliers: ["mcn_001", "mcn_002"] }) : base({ distribution_id: `dist-${Date.now()}`, status: "sent", sent_to: params.supplierIds || ["mcn_001", "mcn_002"], sent_at: new Date().toISOString() });
    case "rank_creators": return base({ run_id: `run-rank-${Date.now()}`, ranked_creators: [{ creator_id: "c_002", final_rank: 1, score: 0.95, estimated_price: 3000, need_confirm: false }, { creator_id: "c_001", final_rank: 2, score: 0.91, estimated_price: 2500, need_confirm: false }, { creator_id: "c_005", final_rank: 3, score: 0.87, estimated_price: 2000, need_confirm: false }, { creator_id: "c_003", final_rank: 4, score: 0.82, estimated_price: 1500, need_confirm: false }, { creator_id: "c_004", final_rank: 5, score: 0.76, estimated_price: 4000, need_confirm: true }] }, { workflow_state: { phase: "recommendation_ready", pending_gate: null, allowed_actions: ["create_submission_batch"] } });
    case "create_submission_batch": return base({ submission_batch_id: `sb-${Date.now()}`, status: "submitted", submitted_count: 4, need_confirm_count: 1 });
    default: return base({ status: "ok", note: `mock for ${toolName}` });
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST") { res.writeHead(405); res.end("Method Not Allowed"); return; }

  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    try {
      const msg = JSON.parse(body);

      if (msg.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-ypmcn-mcp", version: "2.1.0" } } }));
        return;
      }

      if (msg.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } }));
        return;
      }

      if (msg.method === "tools/call") {
        const toolName = msg.params?.name || "";
        const args = msg.params?.arguments || {};
        log(msg.id, toolName, args);
        const response = mockResponse(toolName, args);
        log(msg.id, `${toolName}_reply`, { success: response.success, platform: args?.platform, budget: args?.budget_max_cents });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(response) }], isError: false } }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message } }));
    }
  });
});

// 清日志
writeFileSync(LOG, "");

server.listen(PORT, () => {
  console.log(`🎭 Mock YPmcn MCP 2.1.0 (with request logging)`);
  console.log(`   URL: http://localhost:${PORT}/sse`);
  console.log(`   Log: ${LOG}`);
});
