// Build REAL vector index — incremental save, resume-capable
import mysql from 'mysql2/promise';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB = {host:"d-oa-test.eshypdata.com",port:3306,user:"ypmcn",password:"Yp123456!@#",database:"ypmcn"};
const OUT = "/tmp/ypmcn-vectors-real.json";
const API_KEY = process.env.SILICONFLOW_API_KEY;
const API_URL = "https://api.siliconflow.cn/v1/embeddings";
const MODEL = "Qwen/Qwen3-Embedding-8B";
const BATCH = 20;

if (!API_KEY) { console.error("SILICONFLOW_API_KEY not set"); process.exit(1); }

async function embed(texts) {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts, encoding_format: "float" }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    if (resp.status === 429) { console.log("  rate limited, waiting 5s..."); await new Promise(r => setTimeout(r, 5000)); return embed(texts); }
    throw new Error(`Embedding error ${resp.status}: ${err}`);
  }
  const json = await resp.json();
  json.data.sort((a,b) => a.index - b.index);
  return json.data.map(d => d.embedding);
}

async function main() {
  const db = await mysql.createPool({...DB, waitForConnections:true, connectionLimit:3});

  let doneSet = new Set();
  let existingPoints = [];
  if (existsSync(OUT)) {
    try {
      const d = JSON.parse(readFileSync(OUT, "utf-8"));
      existingPoints = d.points || [];
      doneSet = new Set(existingPoints.map(p => p.payload.kw_uid));
      console.log(`Resuming: ${existingPoints.length} points already embedded`);
    } catch (_) {}
  }

  console.log("Reading xhs_creator_accounts...");
  const [rows] = await db.query(`
    SELECT kw_uid, content_type_label, content_theme_label, industry_tag_label,
           talent_type_label, nickname, kw_city, followercount, kol_official_price_l1, organization
    FROM xhs_creator_accounts WHERE date IS NOT NULL
  `);
  console.log(`Total: ${rows.length}, need: ${rows.length - doneSet.size}`);

  const pending = rows.filter(r => !doneSet.has(r.kw_uid)).map(r => {
    const tags = [
      ...(r.content_type_label || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean),
      ...(r.content_theme_label || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean),
      ...(r.industry_tag_label || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean),
      ...(r.talent_type_label || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean),
    ];
    const uniqueTags = [...new Set(tags)];
    if (uniqueTags.length === 0) uniqueTags.push("综合");
    return { r, uniqueTags, text: uniqueTags.sort().join(" | ") };
  });

  if (pending.length === 0) { console.log("Already complete."); await db.end(); return; }

  const totalBatches = Math.ceil(pending.length / BATCH);
  for (let bi = 0; bi < totalBatches; bi++) {
    const batch = pending.slice(bi * BATCH, (bi + 1) * BATCH);
    const vecs = await embed(batch.map(i => i.text));
    for (let j = 0; j < batch.length; j++) {
      existingPoints.push({
        id: `xhs:${batch[j].r.kw_uid}:content:v2`,
        vector: vecs[j],
        payload: {
          platform: "xhs", platform_account_id: batch[j].r.kw_uid, kw_uid: batch[j].r.kw_uid,
          raw_tags: batch[j].uniqueTags, normalized_text: batch[j].text,
          nickname: batch[j].r.nickname, city: batch[j].r.kw_city,
          followers: batch[j].r.followercount, price: Number(batch[j].r.kol_official_price_l1) || 0,
          organization: batch[j].r.organization, tag_type: "content",
          source_table: "xhs_creator_accounts", source_updated_at: new Date().toISOString(),
          embedding_model_id: MODEL, vector_version: "v2",
        },
      });
    }
    const dir = dirname(OUT);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(OUT, JSON.stringify({
      schemas: [{ collectionName: "creator_tags", vectorSize: 1024, distance: "Cosine" }],
      points: existingPoints, savedAt: new Date().toISOString(), model: MODEL,
    }));
    const pct = ((existingPoints.length/rows.length)*100).toFixed(0);
    console.log(`  batch ${bi+1}/${totalBatches}: ${existingPoints.length}/${rows.length} (${pct}%)`);
    if (bi < totalBatches - 1) await new Promise(r => setTimeout(r, 200));
  }

  console.log(`Complete: ${existingPoints.length} vectors saved.`);
  await db.end();
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
