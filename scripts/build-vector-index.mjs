// Build vector index from real MySQL creator data
// Output: /tmp/ypmcn-vectors.json (FakeQdrant persistence format)
import mysql from 'mysql2/promise';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB = {host:"d-oa-test.eshypdata.com",port:3306,user:"ypmcn",password:"Yp123456!@#",database:"ypmcn"};
const OUT = "/tmp/ypmcn-vectors.json";
const DIM = 128;

// -- Fake embedding (deterministic, same as vector-mcp) --
function hashToFloat(text, seed) {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) % 100000) / 100000;
}

function fakeEmbed(texts) {
  return texts.map(text => {
    const vec = new Float32Array(DIM); let norm = 0;
    for (let d = 0; d < DIM; d++) { const v = hashToFloat(text, d) * 2 - 1; vec[d] = v; norm += v * v; }
    const mag = Math.sqrt(norm) || 1;
    for (let d = 0; d < DIM; d++) vec[d] /= mag;
    return Array.from(vec);
  });
}

// -- Cosine similarity --
function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// -- Tokenizer (Chinese-aware) --
function tokenize(text) {
  const tokens = [];
  const words = text.toLowerCase().split(/[\s,，。！？、；：""''（）\[\]{}<>|\\/`~!@#$%^&*()+=\-_]+/).filter(Boolean);
  tokens.push(...words);
  for (const ch of text) { if (ch.trim().length > 0) tokens.push(ch); }
  return tokens;
}

// -- Main --
async function main() {
  const db = await mysql.createPool({...DB, waitForConnections:true, connectionLimit:3});
  console.log("Reading xhs_creator_accounts...");
  const [rows] = await db.query(`
    SELECT kw_uid, content_type_label, content_theme_label, industry_tag_label,
           talent_type_label, xt_talent_type_label, grow_talent_type_label,
           nickname, kw_city, followercount, kol_official_price_l1, organization
    FROM xhs_creator_accounts WHERE date IS NOT NULL
  `);
  console.log(`Got ${rows.length} creators`);

  // Build points: one per creator, tags from content type fields
  const points = [];
  for (const r of rows) {
    const tags = [
      ...(r.content_type_label || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean),
      ...(r.content_theme_label || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean),
      ...(r.industry_tag_label || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean),
      ...(r.talent_type_label || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean),
    ];
    const uniqueTags = [...new Set(tags)];
    if (uniqueTags.length === 0) uniqueTags.push("综合");

    const normalizedText = uniqueTags.sort().join("|");
    const vector = fakeEmbed([normalizedText])[0];

    points.push({
      id: `xhs:${r.kw_uid}:content:v1`,
      vector,
      payload: {
        platform: "xhs",
        platform_account_id: r.kw_uid,  // KEY: maps to creator_candidate_pool.kw_uid
        kw_uid: r.kw_uid,
        raw_tags: uniqueTags,
        normalized_text: normalizedText,
        nickname: r.nickname,
        city: r.kw_city,
        followers: r.followercount,
        price: Number(r.kol_official_price_l1) || 0,
        organization: r.organization,
        tag_type: "content",
        source_table: "xhs_creator_accounts",
        source_updated_at: new Date().toISOString(),
        embedding_model_id: `fake-embedding-${DIM}`,
        vector_version: "v1",
      },
    });
  }

  // Write persistence format (same as FakeQdrant.saveToFile)
  const dir = dirname(OUT);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = {
    schemas: [{ collectionName: "creator_tags", vectorSize: DIM, distance: "Cosine", payloadIndexes: ["platform","platform_account_id","tag_type"] }],
    points,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(OUT, JSON.stringify(data));
  console.log(`Written ${points.length} vectors to ${OUT}`);

  // Verify
  const stats = {};
  for (const p of points) {
    for (const tag of p.payload.raw_tags) {
      stats[tag] = (stats[tag] || 0) + 1;
    }
  }
  const top = Object.entries(stats).sort((a,b) => b[1] - a[1]).slice(0, 15);
  console.log("Top tags:", top.map(([t,c]) => `${t}(${c})`).join(", "));
  console.log("Done. Vector index ready for search_creators.");
  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
