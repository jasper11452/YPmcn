/**
 * Recall baseline harness — runs 10 diverse client briefs through vector-mcp
 * in REAL mode (SiliconFlow embedding/reranker + MySQL data source) and
 * writes the full recall results to .omo/evidence/recall-baseline.json.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const evidenceDir = join(projectRoot, ".omo/evidence");
const evidencePath = join(evidenceDir, "recall-baseline.json");
mkdirSync(evidenceDir, { recursive: true });

const env = {
  ...process.env,
  VECTOR_MCP_MODE: "real",
  SILICONFLOW_API_KEY: "sk-xzqmgshuguqetlittqimmlktzwqdkbjtekholkxotqsgpvxa",
  MYSQL_HOST: "d-oa-test.eshypdata.com",
  MYSQL_PORT: "3306",
  MYSQL_USER: "ypmcn",
  MYSQL_PASSWORD: "Yp123456!@#",
  MYSQL_DATABASE: "ypmcn",
};

const briefs = [
  { brief_id: "B01", scenario: "母婴亲子 (千问61儿童节 style)", content_requirements: ["母婴", "亲子互动", "新手妈妈", "儿童节"], negative_requirements: [], platform: "xhs", geo: null, relevance_keywords: ["母婴", "亲子", "育儿", "妈妈", "辣妈", "宝宝", "儿童", "幼儿", "母婴用品", "母婴类", "亲子类", "亲子互动", "新手妈妈", "全职妈妈", "母婴亲子", "宝妈", "宝贝", "萌娃", "亲子育儿", "婴幼", "早教", "宝宝穿搭", "宝宝日常", "宝宝食谱", "儿童礼物", "儿童教育", "toddler", "婴儿", "童装", "童品", "母婴号"] },
  { brief_id: "B02", scenario: "时尚穿搭 + 探店 + 沈阳 (安踏沈阳 style)", content_requirements: ["时尚穿搭", "OOTD", "探店", "沈阳"], negative_requirements: [], platform: "xhs", geo: "沈阳", relevance_keywords: ["穿搭", "时尚", "OOTD", "搭配", "服饰", "服装", "街拍", "潮", "显瘦", "显高", "时尚穿搭", "日常穿搭", "通勤穿搭", "职场穿搭", "平价穿搭", "韩系穿搭", "运动穿搭", "街头穿搭", "时尚博主", "探店", "沈阳", "沈阳探店", "沈阳打卡", "沈阳穿搭", "本地生活", "沈阳本地生活", "东北", "辽沈", "沈城"] },
  { brief_id: "B03", scenario: "食品测评 + 广东 (金龙鱼 style)", content_requirements: ["食品测评", "厨房好物", "广东"], negative_requirements: [], platform: "dy", geo: "广东", relevance_keywords: ["食品", "测评", "厨房", "美食", "零食", "烘焙", "料理", "菜谱", "食材", "调味", "粮油", "食品测评", "厨房好物", "美食测评", "食品饮料", "零食测评", "家常菜", "做饭", "吃播", "探店", "广东", "粤", "粤语", "广东本土", "广州", "深圳", "粤菜", "广东话", "广式", "广式美食", "广东菜", "顺德"] },
  { brief_id: "B04", scenario: "AI科技/知识 (AI教程/数码测评)", content_requirements: ["AI深度使用", "AI教程", "科技测评", "数码"], negative_requirements: [], platform: "xhs", geo: null, relevance_keywords: ["AI", "数码", "科技", "测评", "知识", "教程", "编程", "智能", "人工智能", "机器学习", "深度学习", "AI教程", "AI深度使用", "科技测评", "数码测评", "效率工具", "创作者成长", "知识分享", "科普", "电子产品", "开箱", "横评", "对比测评", "AI应用", "AI工具", "AI绘画", "ChatGPT", "大模型", "AI博主"] },
  { brief_id: "B05", scenario: "颜值/P图教程", content_requirements: ["颜值", "P图教程", "修图"], negative_requirements: [], platform: "xhs", geo: null, relevance_keywords: ["颜值", "P图", "修图", "美颜", "滤镜", "拍照", "摄影", "后期", "图像", "P图教程", "修图教程", "调色", "人像修图", "自拍", "写真", "颜值博主", "颜值类", "颜值号", "美照", "拍照技巧", "出片", "氛围感", "拍照姿势"] },
  { brief_id: "B06", scenario: "健身/运动户外", content_requirements: ["运动户外", "运动装备", "健身"], negative_requirements: [], platform: "dy", geo: null, relevance_keywords: ["健身", "运动", "户外", "跑步", "瑜伽", "器械", "训练", "健美", "运动户外", "运动装备", "户外运动", "健身博主", "运动博主", "减脂", "增肌", "塑形", "马拉松", "越野", "徒步", "登山", "骑行", "滑雪", "冲浪", "潜水", "飞盘", "露营"] },
  { brief_id: "B07", scenario: "剧情/搞笑 (dy vertical match)", content_requirements: ["剧情", "搞笑", "段子"], negative_requirements: [], platform: "dy", geo: null, relevance_keywords: ["剧情", "搞笑", "段子", "沙雕", "整蛊", "恶作剧", "戏精", "扮傻", "诙谐", "幽默", "反转", "情景剧", "情侣日常", "街头采访", "搞笑博主", "剧情号", "段子手", "娱乐博主", "整活", "爆笑", "逗趣", "欢乐", "戏精博主", "沙雕博主"] },
  { brief_id: "B08", scenario: "本地生活 + 探店 (dy generic)", content_requirements: ["本地生活", "探店", "美食"], negative_requirements: [], platform: "dy", geo: null, relevance_keywords: ["探店", "本地", "美食", "餐厅", "咖啡", "打卡", "网红", "吃货", "本地生活", "本地探店", "美食探店", "美食博主", "美食达人", "探店达人", "探店博主", "餐饮", "美食推荐", "美食分享", "吃播", "美食测评", "下饭", "深夜食堂"] },
  { brief_id: "B09", scenario: "美妆护肤 (xhs extra)", content_requirements: ["美妆", "护肤", "好物分享"], negative_requirements: [], platform: "xhs", geo: null, relevance_keywords: ["美妆", "护肤", "化妆", "彩妆", "口红", "粉底", "眼影", "面膜", "精华", "面霜", "水乳", "洁面", "卸妆", "防晒", "隔离", "美妆博主", "护肤博主", "成分党", "敏感肌", "平价彩妆", "化妆教程", "学生党", "彩妆教程", "日常妆容", "妆容分享", "好物分享", "种草", "测评", "新品"] },
  { brief_id: "B10", scenario: "剧情/搞笑 (xhs extra)", content_requirements: ["剧情", "搞笑", "段子"], negative_requirements: [], platform: "xhs", geo: null, relevance_keywords: ["剧情", "搞笑", "段子", "沙雕", "整蛊", "恶作剧", "戏精", "扮傻", "诙谐", "幽默", "反转", "情景剧", "情侣日常", "搞笑博主", "剧情号", "段子手", "娱乐博主", "整活", "爆笑", "日常", "生活", "分享"] },
];

function isMatchRelevant(match, keywords) {
  if (!match) return false;
  const text = [...(match.matched_tags || []), match.matched_text || "", match.normalized_text || ""].join(" ").toLowerCase();
  return keywords.some((k) => text.includes(k.toLowerCase()));
}

function judgeVerdict(matches, keywords) {
  if (!matches || matches.length === 0) return { verdict: "FAIL", reason: "no matches returned" };
  const top3 = matches.slice(0, 3);
  const top5 = matches.slice(0, 5);
  const top3Rel = top3.filter((m) => isMatchRelevant(m, keywords)).length;
  const top5Rel = top5.filter((m) => isMatchRelevant(m, keywords)).length;
  if (top3Rel === 3) return { verdict: "PASS", reason: `all top 3 relevant (3/3)` };
  if (top3Rel >= 1 || top5Rel >= 1) return { verdict: "PARTIAL", reason: `top3=${top3Rel}/3 top5=${top5Rel}/5` };
  return { verdict: "FAIL", reason: `0/5 relevant` };
}

const p = spawn("node", ["dist/server.js"], { cwd: projectRoot, env, stdio: ["pipe", "pipe", "pipe"] });
let nextId = 0, stdoutBuf = "";
const pending = new Map();

p.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const resp = JSON.parse(line);
      if (resp.id !== undefined && pending.has(resp.id)) {
        const { resolve, reject, timer } = pending.get(resp.id);
        clearTimeout(timer);
        pending.delete(resp.id);
        if (resp.error) reject(new Error(JSON.stringify(resp.error)));
        else resolve(resp.result);
      }
    } catch (e) { console.error(`[parse] ${e.message}`); }
  }
});
p.stderr.on("data", (c) => { const m = c.toString().trim(); if (m) console.error(`[server] ${m}`); });
p.on("exit", (code) => { console.error(`[server] exited code=${code}`); });
process.on("SIGINT", () => { p.kill(); process.exit(1); });

function call(method, params, timeoutMs = 300000) {
  nextId += 1;
  const id = nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function main() {
  await new Promise((r) => setTimeout(r, 1000));
  console.log("→ initialize");
  const init = await call("initialize", {});
  console.log(`   server: ${init.serverInfo?.name} v${init.serverInfo?.version}`);
  const tools = await call("tools/list", {});
  console.log(`   tools: ${tools.tools.map(t => t.name).join(", ")}`);

  const briefResults = [];
  for (const brief of briefs) {
    console.log(`\n→ ${brief.brief_id} | ${brief.scenario}`);
    const t0 = Date.now();
    try {
      const args = { positiveRequirements: brief.content_requirements, negativeRequirements: brief.negative_requirements, platform: brief.platform, limit: 10 };
      if (brief.geo) args.geo = brief.geo;
      const result = await call("tools/call", { name: "search_creator_tag_vectors", arguments: args }, 300000);
      const elapsed = Date.now() - t0;
      const data = result.data || {};
      const matches = data.matches || [];
      const top10 = matches.slice(0, 10).map((m) => ({
        platform: m.platform,
        platform_account_id: m.platform_account_id,
        matched_tags: m.matched_tags,
        raw_score: Number(m.raw_score?.toFixed?.(4) ?? m.raw_score),
        rerank_score: m.rerank_score === null ? null : Number(m.rerank_score?.toFixed?.(4) ?? m.rerank_score),
        reason: m.reason,
        negative_matched: m.negative_matched,
      }));
      const judge = judgeVerdict(matches, brief.relevance_keywords);
      console.log(`  ✓ ${elapsed}ms | total=${data.total_candidates} | matches=${matches.length} | ${judge.verdict} | ${judge.reason}`);
      console.log(`  top3: ${top10.slice(0,3).map(m => `${m.platform_account_id}(${m.rerank_score ?? m.raw_score})`).join(", ")}`);
      briefResults.push({ brief_id: brief.brief_id, scenario: brief.scenario, content_requirements: brief.content_requirements, negative_requirements: brief.negative_requirements, platform: brief.platform, geo: brief.geo, top_10: top10, total_candidates: data.total_candidates, positive_query: data.positive_query, negative_terms: data.negative_terms, elapsed_ms: elapsed, self_verdict: judge.verdict, verdict_reason: judge.reason });
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.error(`  ✗ FAILED ${elapsed}ms: ${err.message}`);
      briefResults.push({ brief_id: brief.brief_id, scenario: brief.scenario, content_requirements: brief.content_requirements, negative_requirements: brief.negative_requirements, platform: brief.platform, geo: brief.geo, error: err.message, elapsed_ms: elapsed, self_verdict: "FAIL", verdict_reason: `error: ${err.message}`, top_10: [] });
    }
  }

  const summary = {
    pass: briefResults.filter(r => r.self_verdict === "PASS").length,
    partial: briefResults.filter(r => r.self_verdict === "PARTIAL").length,
    fail: briefResults.filter(r => r.self_verdict === "FAIL").length,
  };

  const evidence = {
    generated_at: new Date().toISOString(),
    mode: "real",
    server: init.serverInfo,
    tools: tools.tools.map(t => t.name),
    mysql_host: env.MYSQL_HOST,
    total_briefs: briefs.length,
    briefs: briefResults,
    summary,
  };

  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf-8");
  console.log(`\n──────────────────────────────────────────────────────────`);
  console.log(`Evidence: ${evidencePath}`);
  console.log(`Summary: PASS=${summary.pass} PARTIAL=${summary.partial} FAIL=${summary.fail} (total=${briefs.length})`);

  p.kill("SIGTERM");
  process.exit(0);
}
main().catch((err) => { console.error("Fatal:", err); p.kill("SIGTERM"); process.exit(1); });
