import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTagText, extractVectorQuery, } from "./normalize.js";
describe("normalizeTagText", () => {
    it("normalizes content tags from array", () => {
        const result = normalizeTagText("content", ["母婴", "亲子", "育儿"]);
        assert.equal(result.tagType, "content");
        assert.deepEqual(result.rawTags, ["母婴", "亲子", "育儿"]);
        assert.equal(result.normalizedText, "母婴 亲子 育儿");
    });
    it("normalizes grow tags from comma-separated string", () => {
        const result = normalizeTagText("grow", "头部,腰部,尾部");
        assert.equal(result.tagType, "grow");
        assert.deepEqual(result.rawTags, ["头部", "腰部", "尾部"]);
        assert.equal(result.normalizedText, "头部 腰部 尾部");
    });
    it("handles mixed delimiters: comma, Chinese comma, slash, semicolon", () => {
        const result = normalizeTagText("content", "母婴，亲子/育儿；宝贝");
        assert.deepEqual(result.rawTags, ["母婴", "亲子", "育儿", "宝贝"]);
    });
    it("trims whitespace and filters empty values", () => {
        const result = normalizeTagText("content", "  母婴  ,  , 亲子 ,  ");
        assert.deepEqual(result.rawTags, ["母婴", "亲子"]);
    });
    it("de-duplicates tags", () => {
        const result = normalizeTagText("content", ["母婴", "亲子", "母婴", "育儿", "亲子"]);
        assert.deepEqual(result.rawTags, ["母婴", "亲子", "育儿"]);
    });
    it("handles non-array, non-string input gracefully", () => {
        const result = normalizeTagText("content", 123);
        assert.deepEqual(result.rawTags, []);
        assert.equal(result.normalizedText, "");
    });
    it("handles null/undefined input gracefully", () => {
        const result = normalizeTagText("grow", null);
        assert.deepEqual(result.rawTags, []);
        assert.equal(result.normalizedText, "");
    });
});
describe("extractVectorQuery", () => {
    it("extracts positive terms from semantic fields", () => {
        const input = {
            content_requirements: "母婴亲子内容",
            creator_type_requirements: "颜值高",
            tone_requirements: "温馨风格",
        };
        const result = extractVectorQuery(input);
        assert.deepEqual(result.positiveTerms, ["母婴亲子内容", "颜值高", "温馨风格"]);
        assert.equal(result.positiveQuery, "母婴亲子内容 颜值高 温馨风格");
        assert.equal(result.error, undefined);
    });
    it("separates negative requirements from positive", () => {
        const input = {
            content_requirements: ["母婴亲子", "颜值高", "不要硬广口播"],
            negative_requirements: "拒绝低质量",
        };
        const result = extractVectorQuery(input);
        assert.deepEqual(result.positiveTerms, ["母婴亲子", "颜值高"]);
        assert.deepEqual(result.negativeTerms, ["硬广口播", "低质量"]);
        assert.equal(result.positiveQuery, "母婴亲子 颜值高");
    });
    it("excludes brand, project_name, product from positive query", () => {
        const input = {
            content_requirements: "母婴内容，品牌安踏，项目宝宝计划",
            brand: "安踏",
            project_name: "宝宝计划",
            product: "婴儿车",
        };
        const result = extractVectorQuery(input);
        assert.deepEqual(result.positiveTerms, ["母婴内容"]);
        assert.equal(result.positiveQuery, "母婴内容");
        assert.deepEqual(result.excludedFields.brand, "安踏");
        assert.deepEqual(result.excludedFields.project_name, "宝宝计划");
        assert.deepEqual(result.excludedFields.product, "婴儿车");
    });
    it("excludes numeric/KPI thresholds from positive query", () => {
        const input = {
            content_requirements: ["母婴亲子", "CTR>3%", "预算5万", "阅读量10万+"],
            budget_raw: "5万",
            quantity_total: 10,
        };
        const result = extractVectorQuery(input);
        assert.deepEqual(result.positiveTerms, ["母婴亲子"]);
        assert.equal(result.positiveQuery, "母婴亲子");
        assert.deepEqual(result.excludedFields.budget_raw, "5万");
        assert.deepEqual(result.excludedFields.quantity_total, 10);
    });
    it("returns NO_SEMANTIC_QUERY_TERMS when no positive terms remain", () => {
        const input = {
            content_requirements: "CTR>3%，预算5万",
            brand: "安踏",
        };
        const result = extractVectorQuery(input);
        assert.equal(result.error, "NO_SEMANTIC_QUERY_TERMS");
        assert.equal(result.positiveQuery, "");
        assert.deepEqual(result.positiveTerms, []);
    });
    it("includes semantic fields from requirements_json", () => {
        const input = {
            content_requirements: "母婴内容",
            requirements_json: {
                reference_materials: "参考账号@小红书母婴",
                style: "温馨治愈",
                topics: ["育儿经验", "亲子活动"],
                performance_thresholds: {
                    CTR: 3,
                    reading_volume: 100000,
                },
                filter_rules: [
                    { field: "follower_count", operator: ">=", value: 50000 },
                ],
            },
        };
        const result = extractVectorQuery(input);
        assert.ok(result.positiveTerms.includes("母婴内容"));
        assert.ok(result.positiveTerms.includes("参考账号@小红书母婴"));
        assert.ok(result.positiveTerms.includes("温馨治愈"));
        assert.ok(result.positiveTerms.includes("育儿经验"));
        assert.ok(result.positiveTerms.includes("亲子活动"));
        // performance_thresholds and filter_rules should NOT be included
        assert.equal(result.positiveTerms.includes("3"), false);
        assert.equal(result.positiveTerms.includes("100000"), false);
        assert.equal(result.positiveTerms.includes("50000"), false);
    });
    it("extracts negative requirements from requirements_json", () => {
        const input = {
            content_requirements: "母婴内容",
            requirements_json: {
                negative_requirements: ["不要硬广", "拒绝低质"],
            },
        };
        const result = extractVectorQuery(input);
        assert.deepEqual(result.positiveTerms, ["母婴内容"]);
        assert.deepEqual(result.negativeTerms, ["硬广", "低质"]);
    });
    it("handles the fixture: 母婴亲子、颜值高、不要硬广口播、CTR>3%、品牌安踏", () => {
        const input = {
            content_requirements: "母婴亲子、颜值高、不要硬广口播、CTR>3%、品牌安踏",
            brand: "安踏",
        };
        const result = extractVectorQuery(input);
        // Positive: 母婴亲子, 颜值高
        assert.ok(result.positiveTerms.includes("母婴亲子"));
        assert.ok(result.positiveTerms.includes("颜值高"));
        // Negative: 硬广口播 (from 不要硬广口播)
        assert.ok(result.negativeTerms.includes("硬广口播"));
        // Excludes CTR and brand
        assert.equal(result.positiveTerms.some((t) => t.includes("CTR")), false);
        assert.equal(result.positiveTerms.some((t) => t.includes("安踏")), false);
        // Negative terms not in positive query
        assert.equal(result.positiveQuery.includes("硬广口播"), false);
    });
    it("does not include negative terms in positiveQuery", () => {
        const input = {
            content_requirements: ["母婴内容", "不要硬广"],
            negative_requirements: "拒绝低质",
        };
        const result = extractVectorQuery(input);
        assert.equal(result.positiveQuery.includes("硬广"), false);
        assert.equal(result.positiveQuery.includes("低质"), false);
        assert.ok(result.negativeTerms.includes("硬广"));
        assert.ok(result.negativeTerms.includes("低质"));
    });
    it("handles empty input gracefully", () => {
        const result = extractVectorQuery({});
        assert.equal(result.error, "NO_SEMANTIC_QUERY_TERMS");
        assert.equal(result.positiveQuery, "");
        assert.deepEqual(result.positiveTerms, []);
        assert.deepEqual(result.negativeTerms, []);
    });
});
