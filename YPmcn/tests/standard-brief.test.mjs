import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildStandardBriefReadyPayload,
  extractStandardBrief,
  parseStandardBrief,
  parseStandardBriefRequirements,
  renderStandardBriefReply,
} from "../dist/standard-brief.js";

const EXACT_BRIEF = "品牌：阿里巴巴；项目：千问61儿童节；平台：小红书；档期：2026-07-30至2026-07-31；价格：4w以下；返点：30%以上；内容：类似于AI帮忙送儿童节礼物；账号类型：母婴类，亲子相关；数量：5个；提报截止：2026-07-20 11:00。";

function assertExactPreview(preview) {
  assert.equal(preview.gate, "semantic_ambiguity");
  assert.deepEqual(preview.missingRequired, []);
  assert.deepEqual(preview.semanticAmbiguities, ["creatorPriceTier"]);
  assert.deepEqual(preview.projection, {
    brandName: "阿里巴巴",
    projectName: "千问61儿童节",
    platform: "xiaohongshu",
    projectStartStart: "2026-07-30 00:00:00",
    projectStartEnd: "2026-07-31 23:59:59",
    rebate: "[0.3,1]",
    description: "类似于AI帮忙送儿童节礼物",
    quantityTotal: 5,
    submissionDeadlineAt: "2026-07-20 11:00:00",
  });
  assert.deepEqual(preview.summary, {
    atomCount: 11,
    mappedCount: 9,
    preservedCount: 1,
    unresolvedCount: 1,
  });

  const schedules = preview.atoms.filter((atom) => atom.field === "projectStartStart" || atom.field === "projectStartEnd");
  assert.equal(schedules.length, 2);
  assert.ok(schedules.every((atom) => atom.sourceText === "档期：2026-07-30至2026-07-31"));
  assert.equal(preview.atoms.find((atom) => atom.field === "creatorPriceTier")?.value, "[0,40000]");
  assert.equal(preview.atoms.find((atom) => atom.field === "accountTaxonomy")?.sourceText, "账号类型：母婴类，亲子相关");
  assert.ok(preview.atoms.every((atom) => !atom.sourceText || /[\p{L}\p{N}]/u.test(atom.sourceText)));
}

describe("deterministic standard Brief parser", () => {
  it("keeps fields before a content-form line and asks only for the Douyin duration tier", () => {
    const brief = [
      "品牌：阿里巴巴",
      "项目：千问61儿童节",
      "平台：抖音",
      "内容形式：视频",
      "档期：7.30-7.31",
      "单价：4w以下",
      "返点：26%以上",
      "内容：类似于AI帮忙送儿童节礼物",
      "账号类型：母婴类，亲子相关",
      "数量：5个",
      "提报时间：7月25号上午11:00",
    ].join("\n");
    const preview = parseStandardBrief(brief, new Date("2026-07-23T04:00:00Z"), "Asia/Shanghai");

    assert.equal(extractStandardBrief(brief), brief);
    assert.equal(preview.projection.brandName, "阿里巴巴");
    assert.equal(preview.projection.projectName, "千问61儿童节");
    assert.equal(preview.projection.platform, "douyin");
    assert.deepEqual(preview.missingRequired, []);
    assert.deepEqual(preview.semanticAmbiguities, ["creatorPriceTier"]);
    assert.deepEqual(preview.atoms.find((atom) => atom.field === "creatorPriceTier")?.candidates, [
      "抖音1–20秒视频价格",
      "抖音21–60秒视频价格",
      "抖音60秒以上视频价格",
    ]);
  });

  it("keeps the legacy single-requirement result unchanged", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    assert.deepEqual(
      parseStandardBriefRequirements(EXACT_BRIEF, now, "Asia/Shanghai"),
      [parseStandardBrief(EXACT_BRIEF, now, "Asia/Shanghai")],
    );
  });

  it("splits explicit same-platform variants while inheriting shared fields", () => {
    const brief = [
      "项目：同项目双需求",
      "平台：小红书",
      "档期：2026-08-01至2026-08-05",
      "单达人 L1 官方报价：8000元以内",
      "数量：2个",
      "母婴类粉丝要求2万粉丝以上",
      "科技类粉丝要求1万以上",
      "提报截止：2026-07-30 18:00",
    ].join("；");
    const previews = parseStandardBriefRequirements(brief);

    assert.equal(previews.length, 2);
    assert.deepEqual(previews.map(({ projection }) => ({
      projectName: projection.projectName,
      platform: projection.platform,
      price: projection.kolOfficialPriceL1,
      quantity: projection.quantityTotal,
      contentTag: projection.contentTag,
      followercount: projection.followercount,
    })), [{
      projectName: "同项目双需求",
      platform: "xiaohongshu",
      price: "[0,8000]",
      quantity: 2,
      contentTag: "母婴",
      followercount: "[20000,999999999]",
    }, {
      projectName: "同项目双需求",
      platform: "xiaohongshu",
      price: "[0,8000]",
      quantity: 2,
      contentTag: "科技",
      followercount: "[10000,999999999]",
    }]);
    const payloads = previews.map((preview) => buildStandardBriefReadyPayload(brief, preview));
    assert.ok(payloads.every(Boolean));
    assert.ok(payloads.every((payload) => payload.rawMessagesJson.originalBrief === brief));
  });

  it("parses the exact semicolon-delimited Brief without greedily consuming fields", () => {
    assertExactPreview(parseStandardBrief(EXACT_BRIEF));
  });

  it("returns byte-for-byte equivalent output on repeated deterministic parses", () => {
    const first = parseStandardBrief(EXACT_BRIEF, new Date("2026-07-18T00:00:00Z"), "Asia/Shanghai");
    for (let index = 0; index < 5; index += 1) {
      assert.deepEqual(parseStandardBrief(EXACT_BRIEF, new Date("2026-07-18T00:00:00Z"), "Asia/Shanghai"), first);
    }
  });

  it("supports newlines and ASCII/Chinese comma or semicolon field separators while preserving taxonomy commas", () => {
    for (const separator of ["\n", ";", "，", ","]) {
      const brief = EXACT_BRIEF.replace(/；/g, separator);
      const preview = parseStandardBrief(brief);
      assert.equal(preview.projection.brandName, "阿里巴巴");
      assert.equal(preview.projection.description, "类似于AI帮忙送儿童节礼物");
      assert.equal(preview.projection.quantityTotal, 5);
      assert.match(preview.atoms.find((atom) => atom.field === "accountTaxonomy")?.sourceText ?? "", /母婴类，亲子相关/);
      assert.equal(preview.gate, "semantic_ambiguity");
    }
  });

  it("resolves a yearless Chinese deadline from the authoritative clock and preserves account direction", () => {
    const brief = [
      "品牌：阿里巴巴",
      "项目：千问61儿童节",
      "平台：小红书",
      "合作形式：图文",
      "档期：7.30-7.31",
      "单价：4w以下",
      "返点：30%以上",
      "内容：类似于AI帮忙送儿童节礼物",
      "账号类型：母婴类，亲子相关",
      "数量：5个",
      "提报时间：7月20号上午11:00",
    ].join("\n");
    const preview = parseStandardBrief(brief, new Date("2026-07-18T15:44:56Z"), "Asia/Shanghai");

    assert.equal(preview.gate, "ready");
    assert.deepEqual(preview.missingRequired, []);
    assert.deepEqual(preview.semanticAmbiguities, []);
    assert.equal(preview.projection.submissionDeadlineAt, "2026-07-20 11:00:00");
    assert.equal(preview.projection.kolOfficialPriceL1, "[0,40000]");
    assert.deepEqual(preview.summary, { atomCount: 11, mappedCount: 8, preservedCount: 3, unresolvedCount: 0 });
    assert.deepEqual(preview.atoms.find((atom) => atom.field === "accountTaxonomy"), {
      sourceText: "账号类型：母婴类，亲子相关",
      field: "accountTaxonomy",
      resolution: "preserved",
      disposition: "preserved",
      preservedText: "账号类型：母婴类，亲子相关",
      confidence: 1,
      inferred: false,
    });
  });

  it("accepts an explicit single-creator L1 official-price label without asking again", () => {
    const brief = [
      "品牌：悦普测试",
      "产品：YP Action",
      "项目：E2E-YPmcn-20260719-UX04",
      "平台：小红书",
      "档期：2026-07-30至2026-07-31",
      "数量：1位达人",
      "提报截止：2026-07-20 18:00",
      "单达人 L1 官方报价：4万元以内",
      "返点：25%以上",
      "账号类型：母婴类",
    ].join("\n");
    const preview = parseStandardBrief(brief, new Date("2026-07-19T02:00:00Z"), "Asia/Shanghai");

    assert.equal(preview.gate, "ready");
    assert.deepEqual(preview.missingRequired, []);
    assert.deepEqual(preview.semanticAmbiguities, []);
    assert.equal(preview.projection.submissionDeadlineAt, "2026-07-20 18:00:00");
    assert.equal(preview.projection.kolOfficialPriceL1, "[0,40000]");
    assert.equal(preview.atoms.find((atom) => atom.field === "creatorPriceTier")?.sourceText, "单达人 L1 官方报价：4万元以内");
  });

  it("expands exact single-creator official prices by 10% for every supported tier", () => {
    for (const [platform, label, expectedField] of [
      ["小红书", "单达人 L1 官方报价", "kolOfficialPriceL1"],
      ["小红书", "单达人 L2 官方报价", "kolOfficialPriceL2"],
      ["抖音", "单达人 L3 官方报价", "kolOfficialPriceL3"],
    ]) {
      const brief = [
        `平台：${platform}`,
        "数量：1位达人",
        `${label}：4万元`,
        "提报截止：2026-07-20 18:00",
      ].join("\n");
      const preview = parseStandardBrief(brief);

      assert.equal(preview.gate, "ready");
      assert.equal(preview.projection[expectedField], "[36000,44000]");
    }
  });

  it("keeps explicit upper bounds and closed official-price ranges unchanged", () => {
    for (const [price, expected] of [
      ["4万元以内", "[0,40000]"],
      ["3万-5万元", "[30000,50000]"],
    ]) {
      const brief = [
        "平台：小红书",
        "数量：1位达人",
        `单达人 L1 官方报价：${price}`,
        "提报截止：2026-07-20 18:00",
      ].join("\n");
      const preview = parseStandardBrief(brief);

      assert.equal(preview.gate, "ready");
      assert.equal(preview.projection.kolOfficialPriceL1, expected);
    }
  });

  it("rejects the third internal price field for Xiaohongshu and asks with platform wording", () => {
    const brief = [
      "平台：小红书",
      "数量：3位达人",
      "单达人 L3 官方报价：8000元以内",
      "提报截止：2026-07-20 18:00",
    ].join("\n");
    const preview = parseStandardBrief(brief);
    const price = preview.atoms.find((atom) => atom.field === "creatorPriceTier");
    assert.equal(preview.gate, "semantic_ambiguity");
    assert.equal(preview.projection.kolOfficialPriceL3, undefined);
    assert.deepEqual(price.candidates, ["小红书图文价格", "小红书视频价格"]);
    const reply = renderStandardBriefReply(preview);
    assert.match(reply, /图文价格或视频价格/);
    assert.doesNotMatch(reply, /请确认 L1|L1、L2|L2 或 L3/);
  });

  it("maps Douyin prices by video duration while keeping duration wording user-facing", () => {
    const brief = [
      "平台：抖音",
      "数量：3位达人",
      "内容：60秒以上视频",
      "单达人官方报价：8000元以内",
      "提报截止：2026-07-20 18:00",
    ].join("\n");
    const preview = parseStandardBrief(brief);
    assert.equal(preview.gate, "ready");
    assert.equal(preview.projection.kolOfficialPriceL3, "[0,8000]");
  });

  it("maps fan-age percentages to direct numbers with platform-specific age bands", () => {
    for (const [platform, ageRequirement, expected] of [
      [
        "小红书",
        "18岁以下占比5%，18-23岁占比10%，24-29岁占比20%，30-39岁占比25%，40-49岁占比25%，50岁以上占比15%",
        [0.05, 0.1, 0.2, 0.25, 0.25, 0.15],
      ],
      [
        "抖音",
        "18岁以下占比5%，18-23岁占比10%，24-30岁占比20%，31-40岁占比25%，41-50岁占比25%，50岁以上占比15%",
        [0.05, 0.1, 0.2, 0.25, 0.25, 0.15],
      ],
    ]) {
      const brief = [
        `平台：${platform}`,
        "数量：3位达人",
        "单达人 L1 官方报价：8000元以内",
        `粉丝年龄：${ageRequirement}`,
        "提报截止：2026-07-20 18:00",
      ].join("\n");
      const preview = parseStandardBrief(brief);

      assert.equal(preview.gate, "ready");
      expected.forEach((value, index) => {
        const field = `age${index + 1}Rate`;
        assert.equal(preview.projection[field], value, `${platform}:${field}`);
        assert.equal(typeof preview.projection[field], "number", `${platform}:${field}`);
      });
    }
  });

  it("does not coerce a platform-mismatched fan-age band to the nearest field", () => {
    const brief = [
      "平台：小红书",
      "数量：3位达人",
      "单达人 L1 官方报价：8000元以内",
      "粉丝年龄：24-30岁占比20%",
      "提报截止：2026-07-20 18:00",
    ].join("\n");
    const preview = parseStandardBrief(brief);

    assert.equal(preview.gate, "ready");
    assert.equal(preview.projection.age3Rate, undefined);
    assert.ok(preview.atoms.some((atom) =>
      atom.disposition === "preserved" && /24-30岁占比20%/.test(atom.sourceText)
    ));
  });

  it("normalizes legacy 0/1 and yes/no wording to JSON booleans", () => {
    const brief = [
      "平台：小红书",
      "数量：3位达人",
      "单达人 L1 官方报价：8000元以内",
      "是否有机构：0",
      "近30天是否有订单：是",
      "近30天是否有发文：否",
      "提报截止：2026-07-20 18:00",
    ].join("\n");
    const preview = parseStandardBrief(brief);

    assert.equal(preview.gate, "ready");
    assert.equal(preview.projection.hasOrganization, false);
    assert.equal(preview.projection.hasOrder30day, true);
    assert.equal(preview.projection.hasSocial30day, false);
    assert.ok(["hasOrganization", "hasOrder30day", "hasSocial30day"]
      .every((field) => typeof preview.projection[field] === "boolean"));
  });

  it("selects the last complete structured Brief instead of a field label quoted in operator instructions", () => {
    const brief = [
      "品牌：阿里巴巴",
      "项目：千问61儿童节",
      "平台：小红书",
      "合作形式：图文",
      "档期：7.30-7.31",
      "单价：4w以下",
      "返点：25%以上",
      "内容：类似于AI帮忙送儿童节礼物",
      "账号类型：母婴类，亲子相关",
      "数量：5个",
      "提报时间：7月20号上午11:00",
    ].join("\n");
    const prompt = [
      "只使用权威 Preview，尤其是“返点：25%以上”）。若校验成功",
      "再调用一次 search_creators",
      "任何 Hook/MCP 失败立即停止",
      "不重试。继续禁止所有外发。",
      "```brief",
      brief,
      "```",
    ].join("\n");

    assert.equal(extractStandardBrief(prompt), brief);
    const preview = parseStandardBrief(prompt, new Date("2026-07-18T15:44:56Z"), "Asia/Shanghai");
    const payload = buildStandardBriefReadyPayload(prompt, preview);
    assert.equal(preview.gate, "ready");
    assert.deepEqual(preview.summary, { atomCount: 11, mappedCount: 8, preservedCount: 3, unresolvedCount: 0 });
    assert.equal(preview.projection.rebate, "[0.25,1]");
    assert.equal(payload.rawMessagesJson.originalBrief, brief);
    assert.equal(payload.rawMessagesJson.atoms.length, 11);
    assert.ok(payload.rawMessagesJson.atoms.every((atom) => !/search_creators|Hook\/MCP|禁止所有外发/.test(atom.sourceText)));
  });

  it("extracts the labeled Brief from operator instructions and renders one exact reply", () => {
    const preview = parseStandardBrief(`请输出权威预览并且确认前不要调用任何 Tool。${EXACT_BRIEF}`);
    assertExactPreview(preview);
    const reply = renderStandardBriefReply(preview);
    assert.match(reply, /"gate": "semantic_ambiguity"/);
    assert.match(reply, /"unresolvedCount": 1/);
    assert.match(reply, /价格口径/);
    assert.doesNotMatch(reply, /若为 taxonomy/);
    assert.match(reply, /确认完成前不得调用任何 Tool/);
    assert.doesNotMatch(reply, /请输出权威预览/);
  });
});
