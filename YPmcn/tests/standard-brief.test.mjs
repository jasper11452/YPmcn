import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseStandardBrief, renderStandardBriefReply } from "../dist/standard-brief.js";

const EXACT_BRIEF = "品牌：阿里巴巴；项目：千问61儿童节；平台：小红书；档期：2026-07-30至2026-07-31；价格：4w以下；返点：30%以上；内容：类似于AI帮忙送儿童节礼物；账号类型：母婴类，亲子相关；数量：5个；提报截止：2026-07-20 11:00。";

function assertExactPreview(preview) {
  assert.equal(preview.gate, "semantic_ambiguity");
  assert.deepEqual(preview.missingRequired, []);
  assert.deepEqual(preview.semanticAmbiguities, ["creatorPriceTier", "accountTaxonomy"]);
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
    preservedCount: 0,
    unresolvedCount: 2,
  });

  const schedules = preview.atoms.filter((atom) => atom.field === "projectStartStart" || atom.field === "projectStartEnd");
  assert.equal(schedules.length, 2);
  assert.ok(schedules.every((atom) => atom.sourceText === "档期：2026-07-30至2026-07-31"));
  assert.equal(preview.atoms.find((atom) => atom.field === "creatorPriceTier")?.value, "[0,40000]");
  assert.equal(preview.atoms.find((atom) => atom.field === "accountTaxonomy")?.sourceText, "账号类型：母婴类，亲子相关");
  assert.ok(preview.atoms.every((atom) => !atom.sourceText || /[\p{L}\p{N}]/u.test(atom.sourceText)));
}

describe("deterministic standard Brief parser", () => {
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

  it("extracts the labeled Brief from operator instructions and renders one exact reply", () => {
    const preview = parseStandardBrief(`请输出权威预览并且确认前不要调用任何 Tool。${EXACT_BRIEF}`);
    assertExactPreview(preview);
    const reply = renderStandardBriefReply(preview);
    assert.match(reply, /"gate": "semantic_ambiguity"/);
    assert.match(reply, /"unresolvedCount": 2/);
    assert.match(reply, /价格口径/);
    assert.match(reply, /账号类型/);
    assert.match(reply, /确认完成前不得调用任何 Tool/);
    assert.doesNotMatch(reply, /请输出权威预览/);
  });
});
