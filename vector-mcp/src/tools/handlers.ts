// @ts-nocheck
/**
 * Tool call handlers for the vector MCP server.
 *
 * Supports two modes via VECTOR_MCP_MODE env var:
 * - "fake" (default): deterministic fake embeddings + in-memory Qdrant
 * - "real": SiliconFlow embedding/reranker + MySQL data source
 */
import { randomUUID } from "node:crypto";
import { extractVectorQuery, } from "../query/normalize.js";
import { FakeQdrantClient, } from "../vector/qdrant.js";
import { reciprocalRankFusion } from "../vector/rrf.js";
import { buildVectorPoints } from "../vector/sync.js";
import { createFakeEmbeddingProvider, createFakeRerankProvider, } from "../config/providers.js";
import { buildCollectionSchema } from "../vector/qdrant.js";
import { createSiliconFlowEmbeddingProvider, createSiliconFlowRerankerProvider, } from "../providers/index.js";
import { fetchCreatorRows } from "../db/index.js";
import { loadSourceMapping } from "../source/contract.js";
import {
  MODE,
  FAKE_PERSIST_PATH,
  REAL_PERSIST_PATH,
  requireSiliconFlowApiKey,
  FORCE_RESYNC,
  SOURCE_MAPPING_PATH,
  MYSQL_FETCH_LIMIT,
  mysqlConfigFromEnv,
  HAS_SILICONFLOW_API_KEY,
  HAS_MYSQL_CONFIG,
} from "../config/runtime-config.js";
// ── Fake dataset ────────────────────────────────────────────────────────────
const FAKE_VECTOR_VERSION = "v1";
const FAKE_DIM = 128;
const FAKE_ROWS = [
    // ── xhs: 母婴亲子类 (3) ──────────────────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_mom_001",
        source_table: "xhs_creator",
        content_tags: ["母婴", "亲子", "育儿", "宝宝穿搭"],
        grow_tags: ["母婴博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "小妈咪穿搭日记",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_mom_002",
        source_table: "xhs_creator",
        content_tags: ["辅食", "宝宝食谱", "母婴", "儿童教育"],
        grow_tags: ["母婴博主", "尾部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "辅食妈妈小厨房",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_mom_003",
        source_table: "xhs_creator",
        content_tags: ["亲子", "育儿", "早教", "绘本推荐"],
        grow_tags: ["母婴博主", "新锐博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "早教妈妈Linda",
    },
    // ── xhs: 美妆护肤类 (3) ──────────────────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_beauty_001",
        source_table: "xhs_creator",
        content_tags: ["美妆", "护肤", "好物分享", "平价彩妆"],
        grow_tags: ["美妆博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "成分党小美",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_beauty_002",
        source_table: "xhs_creator",
        content_tags: ["护肤", "成分党", "敏感肌", "好物分享"],
        grow_tags: ["美妆博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "敏感肌急救站",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_beauty_003",
        source_table: "xhs_creator",
        content_tags: ["美妆", "化妆教程", "平价彩妆", "学生党"],
        grow_tags: ["美妆博主", "新锐博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "学生党化妆间",
    },
    // ── xhs: AI/科技类 (2) ───────────────────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_ai_creator_001",
        source_table: "xhs_creator",
        content_tags: ["AI深度使用", "AI教程", "创作者成长"],
        grow_tags: ["知识博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "AI创作者小明",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_tech_002",
        source_table: "xhs_creator",
        content_tags: ["科技测评", "效率工具", "AI教程", "数码"],
        grow_tags: ["知识博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "效率工具控",
    },
    // ── xhs: 时尚穿搭类 (2) ──────────────────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_fashion_001",
        source_table: "xhs_creator",
        content_tags: ["穿搭", "OOTD", "时尚", "日常穿搭"],
        grow_tags: ["腰部达人", "时尚博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "每日穿搭日志",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_fashion_002",
        source_table: "xhs_creator",
        content_tags: ["职场穿搭", "通勤穿搭", "OL风", "穿搭"],
        grow_tags: ["腰部达人", "时尚博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "职场穿搭Coco",
    },
    // ── xhs: 探店/本地生活 (2) ───────────────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_local_001",
        source_table: "xhs_creator",
        content_tags: ["探店", "美食", "本地生活", "打卡"],
        grow_tags: ["尾部达人", "生活博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "魔都探店王",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_local_002",
        source_table: "xhs_creator",
        content_tags: ["探店", "咖啡", "本地生活", "网红打卡"],
        grow_tags: ["尾部达人", "生活博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "咖啡地图小陈",
    },
    // ── xhs: 剧情搞笑类 (2) ──────────────────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_fun_creator_002",
        source_table: "xhs_creator",
        content_tags: ["剧情", "搞笑", "段子"],
        grow_tags: ["娱乐博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "搞笑达人小红",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_fun_002",
        source_table: "xhs_creator",
        content_tags: ["搞笑", "段子", "日常", "情景剧"],
        grow_tags: ["娱乐博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "段子手阿杰",
    },
    // ── xhs: 颜值/P图类 (1) ─────────────────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_face_001",
        source_table: "xhs_creator",
        content_tags: ["颜值", "P图教程", "修图", "沈阳"],
        grow_tags: ["新锐博主", "颜值博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "修图小教室",
    },
    // ── dy: 剧情搞笑 (3) ─────────────────────────────────────────────
    {
        platform: "dy",
        platform_account_id: "dy_fun_001",
        source_table: "dy_creator",
        content_tags: ["剧情", "搞笑", "段子", "反转"],
        grow_tags: ["娱乐博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "搞笑兄妹档",
    },
    {
        platform: "dy",
        platform_account_id: "dy_fun_002",
        source_table: "dy_creator",
        content_tags: ["剧情", "搞笑", "情侣日常"],
        grow_tags: ["娱乐博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "情侣搞笑日记",
    },
    {
        platform: "dy",
        platform_account_id: "dy_fun_003",
        source_table: "dy_creator",
        content_tags: ["搞笑", "段子", "街头采访"],
        grow_tags: ["娱乐博主", "新锐博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "街头搞事王",
    },
    // ── dy: 美食探店 (2) ─────────────────────────────────────────────
    {
        platform: "dy",
        platform_account_id: "dy_food_creator_003",
        source_table: "dy_creator",
        content_tags: ["美食", "探店", "吃播", "沈阳"],
        grow_tags: ["美食博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "美食达人小刚",
    },
    {
        platform: "dy",
        platform_account_id: "dy_food_002",
        source_table: "dy_creator",
        content_tags: ["美食", "探店", "本地生活", "做饭"],
        grow_tags: ["美食博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "家常菜小馆",
    },
    // ── dy: 时尚穿搭 (2) ─────────────────────────────────────────────
    {
        platform: "dy",
        platform_account_id: "dy_fashion_001",
        source_table: "dy_creator",
        content_tags: ["穿搭", "OOTD", "时尚", "街拍", "沈阳"],
        grow_tags: ["时尚博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "街拍潮人小李",
    },
    {
        platform: "dy",
        platform_account_id: "dy_fashion_002",
        source_table: "dy_creator",
        content_tags: ["穿搭", "日常穿搭", "平价穿搭"],
        grow_tags: ["时尚博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "平价穿搭达人",
    },
    // ── dy: 知识/测评 (2) ────────────────────────────────────────────
    {
        platform: "dy",
        platform_account_id: "dy_knowledge_001",
        source_table: "dy_creator",
        content_tags: ["知识分享", "测评", "科普", "效率工具"],
        grow_tags: ["知识博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "测评老王",
    },
    {
        platform: "dy",
        platform_account_id: "dy_knowledge_002",
        source_table: "dy_creator",
        content_tags: ["AI教程", "科技测评", "数码"],
        grow_tags: ["知识博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "数码小课堂",
    },
    // ── dy: 颜值/舞蹈 (1) ───────────────────────────────────────────
    {
        platform: "dy",
        platform_account_id: "dy_dance_001",
        source_table: "dy_creator",
        content_tags: ["颜值", "舞蹈", "翻跳"],
        grow_tags: ["颜值博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "舞蹈少女小美",
    },
    // ── xhs: 探店/本地生活 — 沈阳 (2) ──────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_explore_001",
        source_table: "xhs_creator",
        content_tags: ["沈阳探店", "沈阳本地生活", "沈阳打卡"],
        grow_tags: ["生活博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "沈阳探店小达人",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_explore_002",
        source_table: "xhs_creator",
        content_tags: ["沈阳探店", "沈阳本地生活", "沈阳打卡", "美食探店"],
        grow_tags: ["生活博主", "尾部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "沈阳吃喝玩乐",
    },
    // ── xhs: 母婴亲子 — AI crossover (1) ───────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_mom_ai_001",
        source_table: "xhs_creator",
        content_tags: ["AI亲子", "母婴", "AI深度使用", "儿童礼物", "亲子互动"],
        grow_tags: ["母婴博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "AI辣妈育儿记",
    },
    // ── xhs: 母婴亲子 — 额外 (1) ──────────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_mom_004",
        source_table: "xhs_creator",
        content_tags: ["母婴", "亲子", " toddler穿搭", "宝宝日常"],
        grow_tags: ["母婴博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "萌宝日常记录",
    },
    // ── xhs: 探店/时尚穿搭 — 沈阳 (1) ─────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_explore_sy_001",
        source_table: "xhs_creator",
        content_tags: ["沈阳探店", "沈阳打卡", "时尚穿搭", "本地生活"],
        grow_tags: ["时尚博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "沈阳潮人探店",
    },
    // ── xhs: 时尚穿搭 — 额外 (1) ──────────────────────────────────
    {
        platform: "xhs",
        platform_account_id: "xhs_fashion_003",
        source_table: "xhs_creator",
        content_tags: ["穿搭", "沈阳穿搭", "日常穿搭", "显瘦穿搭"],
        grow_tags: ["时尚博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "沈阳穿搭日记",
    },
    // ── dy: 食品测评/厨房 (2) ──────────────────────────────────────
    {
        platform: "dy",
        platform_account_id: "dy_guangdong_001",
        source_table: "dy_creator",
        content_tags: ["广东本土", "粤语", "测评", "食品测评", "厨房好物"],
        grow_tags: ["测评博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "广东测评阿哥",
    },
    {
        platform: "dy",
        platform_account_id: "dy_food_review_001",
        source_table: "dy_creator",
        content_tags: ["食品测评", "厨房好物", "美食测评", "测评", "广东", "粤语"],
        grow_tags: ["测评博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "粤味测评官",
    },
    // ── dy: 运动户外 (2) ───────────────────────────────────────────
    {
        platform: "dy",
        platform_account_id: "dy_sport_001",
        source_table: "dy_creator",
        content_tags: ["运动户外", "运动装备", "健身"],
        grow_tags: ["运动博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "健身达人阿力",
    },
    {
        platform: "dy",
        platform_account_id: "dy_sport_002",
        source_table: "dy_creator",
        content_tags: ["运动", "跑步", "户外运动", "沈阳"],
        grow_tags: ["运动博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "沈阳跑步侠",
    },
    // ── xhs: 颜值/P图/修图/自拍 (10) — enrich sparse vertical ────
    {
        platform: "xhs",
        platform_account_id: "xhs_face_002",
        source_table: "xhs_creator",
        content_tags: ["颜值", "P图教程", "修图", "自拍", "人像精修"],
        grow_tags: ["颜值博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "修图达人小美",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_face_003",
        source_table: "xhs_creator",
        content_tags: ["P图", "修图教程", "滤镜", "调色", "人像修图"],
        grow_tags: ["颜值博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "人像精修工作室",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_face_004",
        source_table: "xhs_creator",
        content_tags: ["颜值", "自拍教程", "拍照技巧", "出片", "氛围感"],
        grow_tags: ["颜值博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "自拍达人小美",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_face_005",
        source_table: "xhs_creator",
        content_tags: ["修图", "P图", "后期", "调色", "滤镜", "颜值"],
        grow_tags: ["颜值博主", "新锐博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "后期修图师",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_face_006",
        source_table: "xhs_creator",
        content_tags: ["P图教程", "修图", "美颜", "自拍", "人像美化"],
        grow_tags: ["颜值博主", "尾部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "美颜P图小课堂",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_face_007",
        source_table: "xhs_creator",
        content_tags: ["颜值", "P图", "修图", "写真", "拍照姿势"],
        grow_tags: ["颜值博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "写真修图达人",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_face_008",
        source_table: "xhs_creator",
        content_tags: ["颜值", "P图教程", "拍照技巧", "修图", "美照"],
        grow_tags: ["颜值博主", "新锐博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "美照制造机",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_face_009",
        source_table: "xhs_creator",
        content_tags: ["P图", "修图", "颜值", "摄影后期", "人像精修"],
        grow_tags: ["颜值博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "人像精修小馆",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_face_010",
        source_table: "xhs_creator",
        content_tags: ["颜值", "P图", "修图", "自拍", "美颜", "滤镜"],
        grow_tags: ["颜值博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "颜值修图工作室",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_face_011",
        source_table: "xhs_creator",
        content_tags: ["修图教程", "P图", "拍照", "颜值", "美颜相机"],
        grow_tags: ["颜值博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "美颜修图师",
    },
    // ── xhs: 沈阳时尚穿搭 extra (3) — enrich geo+fashion vertical ──
    {
        platform: "xhs",
        platform_account_id: "xhs_explore_sy_002",
        source_table: "xhs_creator",
        content_tags: ["沈阳探店", "沈阳时尚", "时尚穿搭", "本地生活", "沈阳打卡"],
        grow_tags: ["时尚博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "沈阳时尚探店",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_explore_sy_003",
        source_table: "xhs_creator",
        content_tags: ["沈阳穿搭", "OOTD", "时尚", "本地探店", "沈阳"],
        grow_tags: ["时尚博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "沈阳潮人穿搭",
    },
    {
        platform: "xhs",
        platform_account_id: "xhs_explore_sy_004",
        source_table: "xhs_creator",
        content_tags: ["时尚穿搭", "探店", "OOTD", "沈阳本地生活", "东北"],
        grow_tags: ["时尚博主", "新锐博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "沈阳东北探店穿搭",
    },
    // ── dy: 广东食品测评 extra (3) — enrich geo+food vertical ─────
    {
        platform: "dy",
        platform_account_id: "dy_food_review_002",
        source_table: "dy_creator",
        content_tags: ["食品测评", "美食测评", "广东", "粤语", "厨房好物"],
        grow_tags: ["测评博主", "头部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "广东美食测评官",
    },
    {
        platform: "dy",
        platform_account_id: "dy_food_review_003",
        source_table: "dy_creator",
        content_tags: ["食品测评", "零食测评", "广东本土", "广式美食", "测评"],
        grow_tags: ["测评博主", "腰部达人"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "广东零食测评达人",
    },
    {
        platform: "dy",
        platform_account_id: "dy_food_review_004",
        source_table: "dy_creator",
        content_tags: ["厨房好物", "食品测评", "广东", "深圳", "美食"],
        grow_tags: ["测评博主", "新锐博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "深圳厨房测评官",
    },
];
// ── Singleton fake infrastructure ───────────────────────────────────────────
let _fakeQdrant = null;
let _seeded = false;
const FAKE_QDRANT_CONFIG = {
    url: "fake://localhost",
    collectionName: "creator_tags",
    vectorSize: FAKE_DIM,
    distance: "Cosine",
};

async function getSeededQdrant() {
    if (_fakeQdrant && _seeded)
        return _fakeQdrant;
    const qdrant = new FakeQdrantClient();
    if (qdrant.loadFromFile(FAKE_PERSIST_PATH)) {
        _fakeQdrant = qdrant;
        _seeded = true;
        return qdrant;
    }
    const embeddingProvider = createFakeEmbeddingProvider(FAKE_DIM);
    const schema = buildCollectionSchema(FAKE_QDRANT_CONFIG);
    const points = await buildVectorPoints(FAKE_ROWS, embeddingProvider, FAKE_VECTOR_VERSION);
    await qdrant.ensureCollection(schema);
    qdrant.setPersistencePath(FAKE_PERSIST_PATH);
    await qdrant.upsert(points);
    _fakeQdrant = qdrant;
    _seeded = true;
    return qdrant;
}
// ── Real-mode infrastructure ────────────────────────────────────────────────
let _realQdrant = null;
let _realSeeded = false;
let _realEmbeddingProvider = null;
let _realRerankProvider = null;
const REAL_VECTOR_VERSION = "v1";
const REAL_DIM = 1024;
const REAL_QDRANT_CONFIG = {
    url: "real://siliconflow",
    collectionName: "creator_tags",
    vectorSize: REAL_DIM,
    distance: "Cosine",
};
function getRealEmbeddingProvider() {
    if (!_realEmbeddingProvider) {
        const apiKey = requireSiliconFlowApiKey();
        _realEmbeddingProvider = createSiliconFlowEmbeddingProvider({ apiKey });
    }
    return _realEmbeddingProvider;
}
function getRealRerankProvider() {
    if (!_realRerankProvider) {
        const apiKey = requireSiliconFlowApiKey();
        _realRerankProvider = createSiliconFlowRerankerProvider({ apiKey });
    }
    return _realRerankProvider;
}

function forceResync(): boolean {
    return FORCE_RESYNC;
}

async function getRealSeededQdrant() {
    if (_realQdrant && _realSeeded)
        return _realQdrant;

    const qdrant = new FakeQdrantClient();

    if (!forceResync() && qdrant.loadFromFile(REAL_PERSIST_PATH)) {
        process.stderr.write(`[vector-mcp] loaded ${qdrant.pointCount} points from ${REAL_PERSIST_PATH}\n`);
        _realQdrant = qdrant;
        _realSeeded = true;
        return qdrant;
    }

    const embeddingProvider = getRealEmbeddingProvider();
    const mysqlConfig = mysqlConfigFromEnv();
    let sourceMapping;
    try {
        sourceMapping = loadSourceMapping(SOURCE_MAPPING_PATH);
    }
    catch {
        sourceMapping = {
            xhs: {
                platform: "platform",
                platform_account_id: "xhs_creator_id",
                display_name: "xhs_nickname",
                content_tags: "xhs_content_tags_json",
                grow_tags: "xhs_grow_tags_json",
                source_updated_at: "xhs_updated_at",
                source_table: "xhs_source_table",
                profile_url: "xhs_homepage_url",
            },
            dy: {
                platform: "platform",
                platform_account_id: "dy_creator_id",
                display_name: "dy_nickname",
                content_tags: "dy_content_tags_json",
                grow_tags: "dy_grow_tags_json",
                source_updated_at: "dy_updated_at",
                source_table: "dy_source_table",
                profile_url: "dy_homepage_url",
            },
        };
    }
    const maxRows = MYSQL_FETCH_LIMIT;
    const rows = await fetchCreatorRows(mysqlConfig, sourceMapping, maxRows);
    const schema = buildCollectionSchema(REAL_QDRANT_CONFIG);
    const points = await buildVectorPoints(rows, embeddingProvider, REAL_VECTOR_VERSION);
    await qdrant.ensureCollection(schema);
    qdrant.setPersistencePath(REAL_PERSIST_PATH);
    await qdrant.upsert(points);
    process.stderr.write(`[vector-mcp] synced ${points.length} points, persisted to ${REAL_PERSIST_PATH}\n`);
    _realQdrant = qdrant;
    _realSeeded = true;
    return qdrant;
}
function deduplicateByAccountId(candidates) {
    const groups = new Map();
    for (const c of candidates) {
        const key = c.payload.platform_account_id;
        const group = groups.get(key);
        if (group) {
            group.push(c);
        }
        else {
            groups.set(key, [c]);
        }
    }
    const result = [];
    for (const group of groups.values()) {
        group.sort((a, b) => b.score - a.score);
        const kept = group[0];
        if (group.length === 1) {
            result.push(kept);
        }
        else {
            const mergedTags = [...new Set([
                    ...kept.payload.raw_tags,
                    ...group.slice(1).flatMap((c) => c.payload.raw_tags),
                ])];
            const mergedTagTypes = [...new Set([
                    kept.payload.tag_type,
                    ...group.slice(1).map((c) => c.payload.tag_type),
                ])];
            result.push({
                ...kept,
                payload: {
                    ...kept.payload,
                    raw_tags: mergedTags,
                    tag_type: mergedTagTypes.join("+"),
                    normalized_text: mergedTags.sort().join("|"),
                },
            });
        }
    }
    return result;
}
// ── Negative filtering ──────────────────────────────────────────────────────
function findNegativeMatches(payload, negativeTerms) {
    const matched = [];
    const textToSearch = [
        ...payload.raw_tags,
        payload.normalized_text,
    ]
        .join(" ")
        .toLowerCase();
    for (const term of negativeTerms) {
        if (term.length > 0 && textToSearch.includes(term.toLowerCase())) {
            matched.push(term);
        }
    }
    return matched;
}
function buildQueryInput(args) {
    // Support both direct arrays and QueryExtractionInput shape
    const input = {};
    if (args.content_requirements !== undefined) {
        input.content_requirements = args.content_requirements;
    }
    if (args.creator_type_requirements !== undefined) {
        input.creator_type_requirements = args.creator_type_requirements;
    }
    if (args.tone_requirements !== undefined) {
        input.tone_requirements = args.tone_requirements;
    }
    if (args.negative_requirements !== undefined) {
        input.negative_requirements = args.negative_requirements;
    }
    if (args.requirements_json !== undefined) {
        input.requirements_json = args.requirements_json;
    }
    if (args.brand !== undefined)
        input.brand = args.brand;
    if (args.project_name !== undefined)
        input.project_name = args.project_name;
    if (args.product !== undefined)
        input.product = args.product;
    if (args.budget_raw !== undefined)
        input.budget_raw = args.budget_raw;
    if (args.quantity_total !== undefined)
        input.quantity_total = args.quantity_total;
    if (args.submission_deadline_raw !== undefined)
        input.submission_deadline_raw = args.submission_deadline_raw;
    // Map positiveRequirements → content_requirements if no explicit semantic fields
    if (args.positiveRequirements !== undefined &&
        input.content_requirements === undefined &&
        input.creator_type_requirements === undefined &&
        input.tone_requirements === undefined) {
        input.content_requirements = args.positiveRequirements;
    }
    // Map negativeRequirements → negative_requirements if not already set
    if (args.negativeRequirements !== undefined &&
        input.negative_requirements === undefined) {
        input.negative_requirements = args.negativeRequirements;
    }
    return input;
}
// ── Main handler ────────────────────────────────────────────────────────────
async function handleSearch(params, traceId) {
    const args = (params ?? {});
    const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 10;
    const platformFilter = typeof args.platform === "string" && args.platform.length > 0
        ? args.platform
        : undefined;
    // 1. Extract query
    const queryInput = buildQueryInput(args);
    const queryResult = extractVectorQuery(queryInput);
    if (queryResult.error === "NO_SEMANTIC_QUERY_TERMS") {
        return {
            success: false,
            error: {
                code: "NO_SEMANTIC_QUERY_TERMS",
                message: "No semantic query terms found after excluding brand, project, numeric/KPI fields",
            },
            trace_id: traceId,
        };
    }
    const { positiveQuery: basePositiveQuery, negativeTerms } = queryResult;
    const geoTerm = typeof args.geo === "string" && args.geo.length > 0 ? args.geo : undefined;
    const positiveQuery = geoTerm
        ? `${basePositiveQuery} ${geoTerm}`
        : basePositiveQuery;
    const isRealMode = MODE === "real";
    const qdrant = isRealMode
        ? await getRealSeededQdrant()
        : await getSeededQdrant();
    const embeddingProvider = isRealMode
        ? getRealEmbeddingProvider()
        : createFakeEmbeddingProvider(FAKE_DIM);
    const [queryVec] = await embeddingProvider.embed([positiveQuery]);
    // Geo pre-filter: restrict search pool to creators with geo in raw_tags
    let geoPreFiltered = false;
    let geoFilteredCount = 0;
    if (geoTerm) {
        const geoFiltered = qdrant.points.filter((p: Record<string, unknown>) =>
            (p.payload as Record<string, unknown>).raw_tags.some((tag: string) => tag.includes(geoTerm))
        );
        geoFilteredCount = geoFiltered.length;
        if (geoFiltered.length === 0) {
        } else {
            qdrant.points = geoFiltered;
            geoPreFiltered = true;
        }
    }
    // Dense search — fetch all candidates
    const searchLimit = 1000;
    const [denseResults, sparseResults] = await Promise.all([
        qdrant.search({
            vector: Array.from(queryVec),
            limit: searchLimit,
            score_threshold: -1,
        }),
        qdrant.bm25Search({ query: basePositiveQuery, limit: searchLimit }),
    ]);
    // Restore original points if geo pre-filter was applied
    if (geoPreFiltered) {
        if (isRealMode) {
            _realQdrant = null;
            _realSeeded = false;
        } else {
            _fakeQdrant = null;
            _seeded = false;
        }
    }
    // RRF fusion
    const denseScored = denseResults.map((r: { id: string; score: number; payload: Record<string, unknown> }) => ({
        id: r.id,
        score: r.score,
        payload: r.payload,
    }));
    const sparseScored = sparseResults.map((r: { id: string; score: number; payload: Record<string, unknown> }) => ({
        id: r.id,
        score: r.score,
        payload: r.payload,
    }));
    const fused = reciprocalRankFusion(denseScored, sparseScored, 60);
    // Platform filter (post-search)
    const filtered = platformFilter
        ? fused.filter((r) => (r.payload as Record<string, unknown>).platform === platformFilter)
        : fused;
    // Negative filtering + annotation
    const candidates = [];
    for (const r of filtered) {
        const payload = r.payload as { raw_tags: string[]; normalized_text: string; platform: string; platform_account_id: string; source_table: string; tag_type: string; source_updated_at: string; embedding_model_id: string; vector_version: string };
        const negMatched = findNegativeMatches(payload, negativeTerms);
        candidates.push({
            id: r.id,
            score: r.score,
            payload: payload,
            negativeMatched: negMatched,
        });
    }
    // 6. Deduplicate by platform_account_id
    const deduped = deduplicateByAccountId(candidates);
    // Separate safe (no negative match) and penalized candidates
    const safe = deduped.filter((c) => c.negativeMatched.length === 0);
    const penalized = deduped.filter((c) => c.negativeMatched.length > 0);
    // 7. Rerank safe candidates (mode-aware)
    const reranker = isRealMode
        ? getRealRerankProvider()
        : createFakeRerankProvider();
    let rerankMap = null;
    if (safe.length > 0) {
        const RERANK_CAP = 50;
        const indexed = safe.map((c, i) => ({ candidate: c, originalIndex: i }));
        indexed.sort((a, b) => b.candidate.score - a.candidate.score);
        const topCandidates = indexed.slice(0, RERANK_CAP);
        const docs = topCandidates.map((c) => c.candidate.payload.normalized_text);
        const rerankResults = await reranker.rerank(positiveQuery, docs, docs.length);
        rerankMap = new Map();
        for (const rr of rerankResults) {
            const originalIdx = topCandidates[rr.index].originalIndex;
            rerankMap.set(originalIdx, rr.score);
        }
    }
    // 8. Build results: safe first (reranked), then penalized
    const matches = [];
    const belowThreshold = [];
    const safeWithRerank = safe.map((c, idx) => ({
        candidate: c,
        rerankScore: rerankMap ? (rerankMap.get(idx) ?? 0) : null,
    }));
    safeWithRerank.sort((a, b) => {
        const scoreA = a.rerankScore !== null ? a.rerankScore : a.candidate.score;
        const scoreB = b.rerankScore !== null ? b.rerankScore : b.candidate.score;
        return scoreB - scoreA;
    });
    for (const { candidate, rerankScore } of safeWithRerank) {
        const isBelowThreshold = rerankScore !== null
            ? rerankScore < 0.05
            : candidate.score < 0.01;
        const entry = {
            platform: candidate.payload.platform,
            platform_account_id: candidate.payload.platform_account_id,
            source_table: candidate.payload.source_table,
            tag_type: candidate.payload.tag_type,
            matched_tags: candidate.payload.raw_tags,
            raw_tags: candidate.payload.raw_tags,
            matched_text: candidate.payload.normalized_text,
            normalized_text: candidate.payload.normalized_text,
            raw_score: candidate.score,
            rerank_score: rerankScore,
            reason: isBelowThreshold
                ? "below_relevance_threshold"
                : `vector_similarity${rerankScore !== null ? `+rerank(${rerankScore.toFixed(3)})` : ""}`,
            negative_matched: isBelowThreshold ? ["below_threshold"] : [],
        };
        if (isBelowThreshold) {
            belowThreshold.push(entry);
        }
        else if (matches.length < limit) {
            matches.push(entry);
        }
    }
    for (const c of penalized) {
        if (matches.length >= limit)
            break;
        matches.push({
            platform: c.payload.platform,
            platform_account_id: c.payload.platform_account_id,
            source_table: c.payload.source_table,
            tag_type: c.payload.tag_type,
            matched_tags: c.payload.raw_tags,
            raw_tags: c.payload.raw_tags,
            matched_text: c.payload.normalized_text,
            normalized_text: c.payload.normalized_text,
            raw_score: c.score,
            rerank_score: null,
            reason: `negative_matched:${c.negativeMatched.join(",")}`,
            negative_matched: c.negativeMatched,
        });
    }
    return {
        success: true,
        data: {
            matches,
            below_threshold: belowThreshold,
            positive_query: positiveQuery,
            negative_terms: negativeTerms,
            total_candidates: candidates.length,
            deduped_candidates: deduped.length,
            platform_filter: platformFilter ?? null,
        },
        trace_id: traceId,
    };
}
// ── Router ──────────────────────────────────────────────────────────────────
export async function handleToolCall(name, params) {
    const traceId = randomUUID();
    switch (name) {
        case "sync_creator_tag_vectors": {
            if (MODE === "real") {
                try {
                    const qdrant = await getRealSeededQdrant();
                    return {
                        success: true,
                        data: {
                            status: "SYNCED",
                            mode: "real",
                            provider: "siliconflow",
                            echo: params,
                        },
                        trace_id: traceId,
                    };
                }
                catch (err) {
                    return {
                        success: false,
                        error: {
                            code: "SYNC_FAILED",
                            message: err instanceof Error ? err.message : String(err),
                        },
                        trace_id: traceId,
                    };
                }
            }
            return {
                success: true,
                data: {
                    status: "NOT_CONFIGURED",
                    detail: "sync_creator_tag_vectors: use VECTOR_MCP_MODE=real for real sync",
                    echo: params,
                },
                trace_id: traceId,
            };
        }
        case "search_creator_tag_vectors":
            return handleSearch(params, traceId);
        case "health_check_vector_store": {
            if (MODE === "real") {
                const hasApiKey = HAS_SILICONFLOW_API_KEY;
                const hasMysql = HAS_MYSQL_CONFIG;
                return {
                    success: true,
                    data: {
                        mode: "real",
                        embedding: hasApiKey ? "configured" : "missing_api_key",
                        reranker: hasApiKey ? "configured" : "missing_api_key",
                        mysql: hasMysql ? "configured" : "missing_config",
                        provider: "siliconflow",
                    },
                    trace_id: traceId,
                };
            }
            return {
                success: true,
                data: {
                    mode: "fake",
                    qdrant: "in_memory",
                    mysql: "not_used",
                    embedding: "fake",
                    reranker: "fake",
                },
                trace_id: traceId,
            };
        }
        default:
            return {
                success: false,
                error: {
                    code: "UNKNOWN_TOOL",
                    message: `Unknown tool: ${name}`,
                },
                trace_id: traceId,
            };
    }
}
