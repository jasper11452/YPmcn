import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectCreatorText } from "../dist/source/projection.js";

describe("creator source projection allowlist", () => {
  it("includes every approved dy/xhs content field and keeps commercial fields separate", () => {
    const projected = projectCreatorText({
      data_json: {
        verifiedreason: "认证理由",
        contentThemeLabel: "内容主题",
        industryTagLabel: "行业标签",
        xtTalentTypeLabel: "星图达人类型",
        growTalentTypeLabel: "成长达人类型",
        talentTypeLabel: "达人类型",
        kolPersonaLabel: "达人画像",
        contentFeatureLabel: "内容特征",
        pgyBloggerTypeLabel: "蒲公英博主类型",
        growBloggerTypeLabel: "成长博主类型",
        contentTag: "内容标签",
        tagBrand: "合作品牌",
        businessIndustry: "商业行业",
      },
    });

    assert.equal(projected.contentText, [
      "认证理由",
      "内容主题",
      "行业标签",
      "星图达人类型",
      "成长达人类型",
      "达人类型",
      "达人画像",
      "内容特征",
      "蒲公英博主类型",
      "成长博主类型",
      "内容标签",
    ].join(" | "));
    assert.equal(projected.commercialText, "合作品牌 | 商业行业");
  });

  it("excludes identity, profile, organization, demographic, geography, metric and arbitrary fields", () => {
    const projected = projectCreatorText({
      data_json: {
        verifiedreason: "认证 13800138000 https://approved.example/id ABCD1234567890123456",
        tagBrand: "品牌 a@example.com",
        kwUid: "secret-kw-uid",
        douyinId: "secret-douyin-id",
        xiaohongshuId: "secret-xhs-id",
        nickname: "秘密昵称",
        profileUrl: "https://excluded.example/profile",
        organization: "秘密机构",
        gender: "女",
        age: "25岁",
        province: "浙江",
        city: "杭州",
        followerCount: "99999粉丝",
        engagementRate: "12%互动率",
        arbitraryField: "任意秘密字段",
      },
    });

    assert.equal(projected.contentText, "认证 [PHONE] [URL] [ID]");
    assert.equal(projected.commercialText, "品牌 [EMAIL]");
    assert.doesNotMatch(JSON.stringify(projected), /secret|秘密|浙江|杭州|99999|互动率|任意/);
  });
});
