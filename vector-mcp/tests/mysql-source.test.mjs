import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MysqlReadonlySource,
  mysqlSourceConfigFromEnv,
} from "../dist/db/mysql-source.js";
import { projectCreatorText } from "../dist/source/projection.js";

const DY_SELECT = "SELECT kwUid, update_time, date, description, kwProvince AS province, kwCity AS city, followercount AS follower_count, douyinId, verifiedreason, tagBrand, contentThemeLabel, industryTagLabel, xtTalentTypeLabel, growTalentTypeLabel, talentTypeLabel FROM `dy_mz`";
const XHS_SELECT = "SELECT kwUid, update_time, date, description, kwProvince AS province, kwCity AS city, followercount AS follower_count, xiaohongshuId, verifiedreason, tagBrand, kolPersonaLabel, contentFeatureLabel, talentTypeLabel, pgyBloggerTypeLabel, growBloggerTypeLabel, contentTag, businessIndustry FROM `xhs_mz`";

function config(overrides = {}) {
  return {
    host: "localhost",
    port: 3306,
    user: "test",
    password: "",
    database: "test",
    dyTable: "dy_mz",
    xhsTable: "xhs_mz",
    projectTable: "core_project",
    allowedTables: ["dy_mz", "xhs_mz", "core_project"],
    ...overrides,
  };
}

describe("read-only MySQL creator source", () => {
  it("defaults to the two authoritative YP creator tables", () => {
    const resolved = mysqlSourceConfigFromEnv({});
    assert.equal(resolved.dyTable, "dy_mz");
    assert.equal(resolved.xhsTable, "xhs_mz");
    assert.deepEqual(resolved.allowedTables, ["dy_mz", "xhs_mz", "core_project"]);
  });

  it("uses the fixed Douyin projection and maps only approved semantic data", async () => {
    const calls = [];
    const raw = {
      kwUid: "dy-kw-1",
      update_time: "2026-07-15 10:00:00.000",
      date: "2026-07-15",
      description: "户外测评",
      province: "浙江",
      city: "杭州",
      follower_count: "12000",
      douyinId: "douyin-account-1",
      verifiedreason: "优质创作者",
      tagBrand: "山野品牌",
      contentThemeLabel: "露营",
      industryTagLabel: "户外",
      xtTalentTypeLabel: "测评达人",
      growTalentTypeLabel: "成长达人",
      talentTypeLabel: "生活方式",
      nickname: "不得进入投影",
      profileUrl: "https://example.test/profile",
      organization: "不得进入投影",
    };
    const source = new MysqlReadonlySource(config(), {
      query: async (sql, values) => {
        calls.push({ sql, values });
        return [[raw]];
      },
    });

    const result = await source.readCreators("dy");

    assert.equal(calls[0].sql, `${DY_SELECT} ORDER BY update_time ASC, kwUid ASC`);
    assert.deepEqual(calls[0].values, []);
    assert.deepEqual(result.rows[0], {
      platform: "dy",
      kwUid: "dy-kw-1",
      sourceTable: "dy_mz",
      sourceRowId: "dy-kw-1",
      sourceSnapshotDate: "2026-07-15",
      sourceUpdatedAt: "2026-07-15 10:00:00.000",
      douyinId: "douyin-account-1",
      description: "户外测评",
      province: "浙江",
      city: "杭州",
      followerCount: 12000,
      dataJson: {
        description: "户外测评",
        verifiedreason: "优质创作者",
        tagBrand: "山野品牌",
        contentThemeLabel: "露营",
        industryTagLabel: "户外",
        xtTalentTypeLabel: "测评达人",
        growTalentTypeLabel: "成长达人",
        talentTypeLabel: "生活方式",
      },
    });
    assert.deepEqual(projectCreatorText({
      description: result.rows[0].description,
      data_json: result.rows[0].dataJson,
    }), {
      contentText: "户外测评 | 优质创作者 | 露营 | 户外 | 测评达人 | 成长达人 | 生活方式",
      commercialText: "山野品牌",
    });
    assert.equal(result.cursor, "2026-07-15 10:00:00.000");
  });

  it("uses the fixed Xiaohongshu projection and excludes IDs and metrics from semantic data", async () => {
    const calls = [];
    const raw = {
      kwUid: "xhs-kw-1",
      update_time: "2026-07-15 11:00:00.000",
      date: "2026-07-14",
      description: "通勤穿搭",
      province: "上海",
      city: "上海",
      follower_count: 8800,
      xiaohongshuId: "xhs-account-1",
      verifiedreason: "时尚博主",
      tagBrand: "服饰品牌",
      kolPersonaLabel: "都市白领",
      contentFeatureLabel: "实用教程",
      talentTypeLabel: "穿搭达人",
      pgyBloggerTypeLabel: "种草型",
      growBloggerTypeLabel: "潜力博主",
      contentTag: "通勤",
      businessIndustry: "服装",
      price: 5000,
      gender: "女",
    };
    const source = new MysqlReadonlySource(config(), {
      query: async (sql, values) => {
        calls.push({ sql, values });
        return [[raw]];
      },
    });

    const result = await source.readCreators("xhs", { cursor: "2026-07-14", limit: 20 });

    assert.equal(calls[0].sql, `${XHS_SELECT} WHERE update_time > ? ORDER BY update_time ASC, kwUid ASC LIMIT ?`);
    assert.deepEqual(calls[0].values, ["2026-07-14", 20]);
    assert.deepEqual(result.rows[0].dataJson, {
      description: "通勤穿搭",
      verifiedreason: "时尚博主",
      tagBrand: "服饰品牌",
      kolPersonaLabel: "都市白领",
      contentFeatureLabel: "实用教程",
      talentTypeLabel: "穿搭达人",
      pgyBloggerTypeLabel: "种草型",
      growBloggerTypeLabel: "潜力博主",
      contentTag: "通勤",
      businessIndustry: "服装",
    });
    assert.deepEqual(projectCreatorText({
      description: result.rows[0].description,
      data_json: result.rows[0].dataJson,
    }), {
      contentText: "通勤穿搭 | 时尚博主 | 都市白领 | 实用教程 | 穿搭达人 | 种草型 | 潜力博主 | 通勤",
      commercialText: "服饰品牌 | 服装",
    });
    assert.equal(result.rows[0].sourceRowId, "xhs-kw-1");
    assert.equal(result.rows[0].douyinId, undefined);
  });

  it("rehydrates deterministically and preserves missing-source behavior", async () => {
    const calls = [];
    const source = new MysqlReadonlySource(config(), {
      query: async (sql, values) => {
        calls.push({ sql, values });
        return [[{
          kwUid: "xhs-kw-2",
          update_time: "2026-07-15 12:00:00.000",
          date: "2026-07-15",
          description: "美妆教程",
          tagBrand: "美妆品牌",
        }]];
      },
    });

    const rows = await source.rehydrate("xhs", ["xhs-kw-2", "xhs-kw-1", "xhs-kw-2"]);
    assert.equal(calls[0].sql, `${XHS_SELECT} WHERE kwUid IN (?, ?) ORDER BY kwUid ASC, update_time DESC`);
    assert.deepEqual(calls[0].values, ["xhs-kw-1", "xhs-kw-2"]);
    assert.deepEqual(rows.map(({ kwUid }) => kwUid), ["xhs-kw-2"]);

    const missing = Object.assign(new Error("missing"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
    const unavailable = new MysqlReadonlySource(config(), { query: async () => { throw missing; } });
    assert.deepEqual(await unavailable.readCreators("dy"), {
      status: "unavailable",
      platform: "dy",
      rows: [],
      reason: "source_table_missing",
    });
    assert.deepEqual(await unavailable.rehydrate("xhs", ["xhs-kw-1"]), []);

    const unconfigured = new MysqlReadonlySource(config({ xhsTable: undefined }), { query: async () => assert.fail("must not query") });
    assert.deepEqual(await unconfigured.readCreators("xhs"), {
      status: "unavailable",
      platform: "xhs",
      rows: [],
      reason: "source_not_configured",
    });
  });
});
