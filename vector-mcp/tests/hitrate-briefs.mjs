/**
 * Hit-rate test harness — runs briefs through vector-mcp in REAL mode.
 *
 * Briefs designed based on actual tag distribution:
 *   ABUNDANT:  美食探店(53), 科技数码(48), 时尚穿搭(45), 母婴亲子(45),
 *              教育职场(42), 健身运动(42), 美妆护肤(37)
 *   MODERATE:  家居生活(38), 萌宠(37), 汽车出行(30), 旅行户外(41)
 *   NARROW:    Cross-category intersections
 *   ZERO:      Categories absent from db
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const evidenceDir = join(projectRoot, ".omo/evidence");
const evidencePath = join(evidenceDir, "hitrate-briefs.json");
mkdirSync(evidenceDir, { recursive: true });

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
const env = {
  ...process.env,
  VECTOR_MCP_MODE: "real",
  SILICONFLOW_API_KEY: requiredEnv("SILICONFLOW_API_KEY"),
  MYSQL_HOST: "d-oa-test.eshypdata.com",
  MYSQL_PORT: "3306",
  MYSQL_USER: "ypmcn",
  MYSQL_PASSWORD: requiredEnv("MYSQL_PASSWORD"),
  MYSQL_DATABASE: "ypmcn",
};

const briefs = [
  // ═══════════════ HIGH (abundant categories, 37-53 records) ═══════
  {
    brief_id: "H01", expected: "HIGH",
    scenario: "美食探店 — 广州（最大品类53条）",
    content_requirements: ["美食探店", "咖啡测评", "广州"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
  {
    brief_id: "H02", expected: "HIGH",
    scenario: "科技数码 — 深圳（48条）",
    content_requirements: ["科技数码", "手机测评", "效率工具"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
  {
    brief_id: "H03", expected: "HIGH",
    scenario: "母婴亲子 — 上海（45条）",
    content_requirements: ["母婴亲子", "育儿经验", "早教启蒙"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
  {
    brief_id: "H04", expected: "HIGH",
    scenario: "时尚穿搭 — 北京（45条）",
    content_requirements: ["时尚穿搭", "通勤穿搭", "OOTD"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
  {
    brief_id: "H05", expected: "HIGH",
    scenario: "美妆护肤 — 成分党（37条）",
    content_requirements: ["美妆护肤", "成分党", "护肤测评"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
  {
    brief_id: "H06", expected: "HIGH",
    scenario: "健身运动 — dy（41条）",
    content_requirements: ["健身运动", "塑形计划", "健康饮食"],
    negative_requirements: [], platform: "douyin", geo: null,
  },

  // ═══════════════ MEDIUM (non-dominant, or with negative) ═══════
  {
    brief_id: "M01", expected: "MEDIUM",
    scenario: "汽车出行 — 试驾体验（xhs 30条，品类收窄）",
    content_requirements: ["汽车出行", "试驾体验", "新能源车"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
  {
    brief_id: "M02", expected: "MEDIUM",
    scenario: "家居生活 — 收纳改造（dy 38条）",
    content_requirements: ["家居生活", "收纳改造", "清洁技巧"],
    negative_requirements: [], platform: "douyin", geo: null,
  },
  {
    brief_id: "M03", expected: "MEDIUM",
    scenario: "萌宠 — 养猫（dy 41条，子品类收窄）",
    content_requirements: ["萌宠", "养猫日记", "宠物用品"],
    negative_requirements: [], platform: "douyin", geo: null,
  },
  {
    brief_id: "M04", expected: "MEDIUM",
    scenario: "教育职场 — 英语提升（xhs 42条，话题收窄）",
    content_requirements: ["教育职场", "英语提升", "考证经验"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },

  // ═══════════════ CROSS-CATEGORY (intersection narrow) ═══════════
  {
    brief_id: "C01", expected: "LOW",
    scenario: "母婴+科技跨界 — 早教机器人（双品类交叉极窄）",
    content_requirements: ["母婴亲子", "科技数码", "AI早教"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
  {
    brief_id: "C02", expected: "LOW",
    scenario: "宠物+家居 — 猫家具好物（dy双品类交义）",
    content_requirements: ["萌宠", "家居生活", "猫爬架"],
    negative_requirements: [], platform: "douyin", geo: null,
  },
  {
    brief_id: "C03", expected: "LOW",
    scenario: "旅行+科技 — 数码旅行装备（xhs交叉）",
    content_requirements: ["旅行户外", "科技数码", "摄影器材"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
  {
    brief_id: "C04", expected: "LOW",
    scenario: "健身+美食 — 减脂餐（dy双品类）",
    content_requirements: ["健身运动", "美食探店", "健康饮食"],
    negative_requirements: [], platform: "douyin", geo: null,
  },

  // ═══════════════ WITH NEGATIVE FILTER ══════════════════════════
  {
    brief_id: "N01", expected: "MEDIUM-LOW",
    scenario: "时尚穿搭但排除通勤风（xhs负向过滤）",
    content_requirements: ["时尚穿搭", "高级感", "小个子"],
    negative_requirements: ["通勤穿搭", "胶囊衣橱"],
    platform: "xiaohongshu", geo: null,
  },

  // ═══════════════ ZERO / ABSENT CATEGORY ════════════════════════
  {
    brief_id: "Z01", expected: "ZERO",
    scenario: "剧情搞笑（db中无此品类，应返回0）",
    content_requirements: ["剧情", "搞笑", "段子"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
  {
    brief_id: "Z02", expected: "ZERO",
    scenario: "颜值/P图（db中无此品类，应返回0）",
    content_requirements: ["颜值", "P图教程", "修图"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
  {
    brief_id: "Z03", expected: "ZERO",
    scenario: "财经投资（db中无此标签，应返回0）",
    content_requirements: ["财经", "基金", "理财"],
    negative_requirements: [], platform: "xiaohongshu", geo: null,
  },
];

// ── MCP stdio communication ─────────────────────────────────────────
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
    } catch (e) { /* skip partial */ }
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

function describeMatch(m) {
  const tags = m.matched_tags ? m.matched_tags.slice(0,4).join("、") : "";
  const score = m.rerank_score !== null ? m.rerank_score.toFixed(3) : m.raw_score.toFixed(4);
  return `[${tags} ${score}]`;
}

async function main() {
  await new Promise((r) => setTimeout(r, 1000));
  const init = await call("initialize", {});

  const briefResults = [];
  for (const brief of briefs) {
    console.log(`\n${brief.brief_id} [expect ${brief.expected}] | ${brief.scenario}`);
    const t0 = Date.now();
    try {
      const args = {
        positiveRequirements: brief.content_requirements,
        negativeRequirements: brief.negative_requirements,
        platform: brief.platform,
        limit: 10,
      };
      const result = await call("tools/call", { name: "search_creator_tag_vectors", arguments: args }, 300000);
      const elapsed = Date.now() - t0;
      const data = result.data || {};
      const matches = data.matches || [];
      const top5 = matches.slice(0, 5).map((m) => ({
        platform: m.platform,
        platform_account_id: m.platform_account_id,
        matched_tags: m.matched_tags,
        raw_score: Number(m.raw_score?.toFixed?.(4) ?? m.raw_score),
        rerank_score: m.rerank_score === null ? null : Number(m.rerank_score?.toFixed?.(4) ?? m.rerank_score),
        reason: m.reason,
        negative_matched: m.negative_matched,
      }));
      console.log(`   ${elapsed}ms | candidates=${data.total_candidates} | matches=${matches.length}`);
      if (top5.length > 0) {
        console.log(`   top3: ${top5.slice(0,3).map(describeMatch).join(" | ")}`);
        if (data.negative_terms && data.negative_terms.length > 0) {
          console.log(`   negative_filter: ${data.negative_terms.join(",")}`);
        }
      } else {
        console.log(`   (no matches)`);
      }
      briefResults.push({
        ...brief, top_5: top5, total_candidates: data.total_candidates,
        positive_query: data.positive_query, negative_terms: data.negative_terms,
        elapsed_ms: elapsed,
      });
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.error(`   FAILED ${elapsed}ms: ${err.message}`);
      briefResults.push({ ...brief, error: err.message, elapsed_ms: elapsed, top_5: [] });
    }
  }

  // Aggregate hit rate stats
  const stats = { HIGH: { count:0, total:0 }, MEDIUM: { count:0, total:0 }, LOW: { count:0, total:0 }, ZERO: { count:0, total:0 }, OTHER: { count:0, total:0 } };
  for (const r of briefResults) {
    const n = r.top_5 ? r.top_5.filter(m => m.reason !== "below_relevance_threshold").length : 0;
    const key = stats[r.expected] ? r.expected : "OTHER";
    stats[key].count++;
    stats[key].total += n;
  }

  const evidence = {
    generated_at: new Date().toISOString(),
    mode: "real",
    mysql_host: env.MYSQL_HOST,
    total_briefs: briefs.length,
    stats,
    briefs: briefResults,
  };

  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf-8");
  console.log(`\n──────────────────────────────────────────────────────`);
  console.log(`Evidence: ${evidencePath}`);
  for (const [k, v] of Object.entries(stats)) {
    const avg = v.count > 0 ? (v.total / v.count).toFixed(1) : "-";
    console.log(`  ${k}: ${v.count} briefs, avg top-5 hits = ${avg}`);
  }

  p.kill("SIGTERM");
  process.exit(0);
}
main().catch((err) => { console.error("Fatal:", err); p.kill("SIGTERM"); process.exit(1); });
