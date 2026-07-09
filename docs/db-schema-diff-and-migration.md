# YPmcn 数据库 Schema 差异 & 迁移方案

> 生成日期：2026-07-09
> 对比对象：`d-oa-test.eshypdata.com` / `ypmcn` vs `20260709-02-YPmcn-MVP最小数据库表.md`
> 数据库版本：MySQL 8.0 (utf8mb4_0900_ai_ci)

---

## 0. 总览

| | 数量 |
|---|---|
| DB 总表数 | 44 |
| 文档 MVP 表数 | 13 |
| MVP 表全部存在 | ✅ |
| 完全匹配 | 0 / 13 |
| 🔴 P0 阻塞级差异 | 4 张表 |
| 🟡 P1 功能级差异 | 8 张表 |
| 🟢 P2 命名/注释差异 | 全表 |

---

## 1. P0 — 阻塞链路（必须先修）

### 1.1 `core_supplier` / `mcn_agencies` — MCN 数据双表共存

**问题**：文档要求 MCN 数据在 `mcn_agencies`，但实际数据全在 `core_supplier`。`mcn_agencies` 是空壳表（只有 6 个字段，无数据实质）。所有 FK 引用（`creator_supply_offers.mcn_id`）指向 `core_supplier.id`。

**方案**：废弃 `mcn_agencies`，将 `core_supplier` 补齐后重命名为 `mcn_agencies` 的事实表。后续所有 FK 统一指向此表。

**差距清单**：
- `core_supplier` 缺 `backend_name`（后台简称/别名）
- `core_supplier` 字段名映射：`name` → `agency_name`，`wechat_group_chat_id` → `wecom_group_id`

```sql
-- ============================================================
-- 1.1 core_supplier → mcn_agencies 迁移
-- ============================================================

-- Step 1: 给 core_supplier 添加文档要求的缺失字段
ALTER TABLE core_supplier
  ADD COLUMN backend_name VARCHAR(255) DEFAULT NULL COMMENT '后台简称/别名' AFTER name;

-- Step 2: 重命名 core_supplier 的字段以匹配文档（保留原字段，用 GENERATED 列做别名）
-- 实际上建议直接 RENAME COLUMN，但 MySQL 8.0 支持：
ALTER TABLE core_supplier
  RENAME COLUMN name TO agency_name,
  RENAME COLUMN wechat_group_chat_id TO wecom_group_id;

-- Step 3: 删除空的 mcn_agencies 表
DROP TABLE IF EXISTS mcn_agencies;

-- Step 4: 将 core_supplier 重命名为 mcn_agencies
RENAME TABLE core_supplier TO mcn_agencies;

-- Step 5: 重新创建原 mcn_agencies 被依赖的索引/约束（如有）
-- core_supplier 原有的 UNIQUE KEY `name` 现在对应 `agency_name`
ALTER TABLE mcn_agencies
  DROP INDEX name,
  ADD UNIQUE KEY uq_mcn_agencies_agency_name (agency_name);

-- Step 6: 修正 creator_supply_offers 的 FK（表名变了，需要重建 FK）
-- 注意：FK 名称会自动适配，但需要确认
-- 先检查现有 FK：
-- SHOW CREATE TABLE creator_supply_offers;
-- 如果有 fk_creator_supply_offers_supplier，执行：
ALTER TABLE creator_supply_offers
  DROP FOREIGN KEY fk_creator_supply_offers_supplier;

ALTER TABLE creator_supply_offers
  ADD CONSTRAINT fk_creator_supply_offers_mcn
    FOREIGN KEY (mcn_id) REFERENCES mcn_agencies (id);
```

---

### 1.2 `xhs_creator_accounts` — 内容标签字段错乱 + 混入抖音字段

**问题**：
- 缺少小红书专属标签字段：`kol_persona_label`, `content_feature_label`, `content_tag`
- 混入了 ~30 个抖音专属字段（`douyin_id`, `xt_*`, `interaction_rate`, `cpe_l3`, `cpm_l3` 等）
- 有抖音风格的 `content_theme_label`, `industry_tag_label`（应删除）
- PK 是 `id` 而非文档要求的 `unique(kw_uid)`
- `platform` 为 nullable，应为 NOT NULL DEFAULT 'xhs'

```sql
-- ============================================================
-- 1.2 xhs_creator_accounts 字段清理 + 补充
-- ============================================================

-- Step 1: 删除抖音专属字段（xhs 表不应有这些）
ALTER TABLE xhs_creator_accounts
  DROP COLUMN douyin_id,
  DROP COLUMN userfavoritscount,
  DROP COLUMN userlikecount,
  DROP COLUMN has_shop_entry,
  DROP COLUMN interaction_rate,
  DROP COLUMN download_price_source_l3,
  DROP COLUMN download_price_l3,
  DROP COLUMN age6_rate,
  DROP COLUMN kw_sec_uid,
  DROP COLUMN zjx_followercount,
  DROP COLUMN month_reach_user_count,
  DROP COLUMN month_deep_reach_user_count,
  DROP COLUMN hot_video_rate,
  DROP COLUMN xt_excepted_view_count,
  DROP COLUMN kol_official_price_other,
  DROP COLUMN cpe_xt,
  DROP COLUMN cpe_grow,
  DROP COLUMN cpm_xt,
  DROP COLUMN cpm_grow,
  DROP COLUMN xt_id,
  DROP COLUMN content_theme_label,
  DROP COLUMN industry_tag_label,
  DROP COLUMN bussiness_interaction_rate,
  DROP COLUMN xt_talent_type_label,
  DROP COLUMN grow_talent_type_label,
  DROP COLUMN kol_official_price_l3,
  DROP COLUMN kol_predict_price_l3,
  DROP COLUMN cpe_l3,
  DROP COLUMN cpm_l3,
  DROP COLUMN avgview;

-- Step 2: 添加小红书专属标签字段
ALTER TABLE xhs_creator_accounts
  ADD COLUMN kol_persona_label TEXT COMMENT '达人人设标签' AFTER content_type_label,
  ADD COLUMN content_feature_label TEXT COMMENT '内容特征标签' AFTER kol_persona_label,
  ADD COLUMN content_tag TEXT COMMENT '内容类目' AFTER content_feature_label;

-- Step 3: 修正 platform 列
ALTER TABLE xhs_creator_accounts
  MODIFY COLUMN platform VARCHAR(32) NOT NULL DEFAULT 'xhs' COMMENT '平台：固定 xhs';

-- Step 4: 添加 UNIQUE(kw_uid)
-- 先检查是否有重复 kw_uid（如果有，需先处理）
-- SELECT kw_uid, COUNT(*) FROM xhs_creator_accounts WHERE kw_uid IS NOT NULL GROUP BY kw_uid HAVING COUNT(*) > 1;
ALTER TABLE xhs_creator_accounts
  ADD UNIQUE KEY uq_xhs_kw_uid (kw_uid);

-- Step 5: 修正字段注释（关键字段）
ALTER TABLE xhs_creator_accounts
  MODIFY COLUMN kw_uid VARCHAR(64) COMMENT '小红书达人唯一账号标识',
  MODIFY COLUMN content_type_label TEXT COMMENT '内容类型标签(26.02.04下线)',
  MODIFY COLUMN organization VARCHAR(255) COMMENT 'MCN/机构名称',
  MODIFY COLUMN kol_official_price_l1 DECIMAL(18,2) COMMENT '图文官方报价',
  MODIFY COLUMN kol_official_price_l2 DECIMAL(18,2) COMMENT '视频官方报价',
  MODIFY COLUMN kol_predict_price_l1 DECIMAL(18,2) COMMENT '图文预估报价',
  MODIFY COLUMN kol_predict_price_l2 DECIMAL(18,2) COMMENT '视频预估报价',
  MODIFY COLUMN cpe_l1 DECIMAL(18,4) COMMENT '图文CPE',
  MODIFY COLUMN cpe_l2 DECIMAL(18,4) COMMENT '视频CPE',
  MODIFY COLUMN cpm_l1 DECIMAL(18,4) COMMENT '图文CPM',
  MODIFY COLUMN cpm_l2 DECIMAL(18,4) COMMENT '视频CPM',
  MODIFY COLUMN view_medium BIGINT COMMENT '日常笔记阅读中位数',
  MODIFY COLUMN bussiness_view_medium BIGINT COMMENT '商单笔记阅读中位数',
  MODIFY COLUMN date DATETIME COMMENT '数据日期';
```

---

### 1.3 `dy_creator_accounts` — 内容标签字段错乱 + 混入小红书字段

**问题**：
- 缺少抖音专属标签字段：`content_theme_label`, `industry_tag_label`
- 混入了 ~10 个小红书专属字段（`xiaohongshu_id`, `pgy_blogger_type_label`, `grow_blogger_type_label`, `view_rate3s` 等）
- 有小红书风格的 `kol_persona_label`, `content_feature_label`（应删除）
- PK 是 `id` 而非文档要求的 `unique(kw_uid)`
- `platform` 为 nullable，应为 NOT NULL DEFAULT 'dy'

```sql
-- ============================================================
-- 1.3 dy_creator_accounts 字段清理 + 补充
-- ============================================================

-- Step 1: 删除小红书专属字段
ALTER TABLE dy_creator_accounts
  DROP COLUMN xiaohongshu_id,
  DROP COLUMN pgy_blogger_type_label,
  DROP COLUMN grow_blogger_type_label,
  DROP COLUMN view_rate3s,
  DROP COLUMN bussiness_view_rate3s,
  DROP COLUMN is_active,
  DROP COLUMN photo_interact,
  DROP COLUMN video_interact,
  DROP COLUMN explosive_rate,
  DROP COLUMN photo_view,
  DROP COLUMN video_view,
  DROP COLUMN daily_view,
  DROP COLUMN business_view,
  DROP COLUMN click_medium,
  DROP COLUMN bussiness_click_medium,
  DROP COLUMN active_fans_rate,
  DROP COLUMN view_fans_rate,
  DROP COLUMN interact_fans_rate,
  DROP COLUMN order_fans_rate;

-- Step 2: 添加抖音专属标签字段
ALTER TABLE dy_creator_accounts
  ADD COLUMN content_theme_label TEXT COMMENT '内容主题标签' AFTER content_type_label,
  ADD COLUMN industry_tag_label TEXT COMMENT '行业标签' AFTER content_theme_label;

-- Step 3: 删除混入的小红书标签字段（如果存在）
-- 确认字段存在再删除：
ALTER TABLE dy_creator_accounts
  DROP COLUMN IF EXISTS kol_persona_label,
  DROP COLUMN IF EXISTS content_feature_label;

-- Step 4: 修正 platform 列
ALTER TABLE dy_creator_accounts
  MODIFY COLUMN platform VARCHAR(32) NOT NULL DEFAULT 'dy' COMMENT '平台：固定 dy';

-- Step 5: 添加 UNIQUE(kw_uid)
ALTER TABLE dy_creator_accounts
  ADD UNIQUE KEY uq_dy_kw_uid (kw_uid);

-- Step 6: 修正字段注释（关键字段）
ALTER TABLE dy_creator_accounts
  MODIFY COLUMN kw_uid VARCHAR(64) COMMENT '抖音达人唯一账号标识',
  MODIFY COLUMN organization VARCHAR(255) COMMENT 'MCN/机构名称',
  MODIFY COLUMN kol_official_price_l1 DECIMAL(12,2) COMMENT '1-20S官方视频报价',
  MODIFY COLUMN kol_official_price_l2 DECIMAL(12,2) COMMENT '21-60S官方视频报价',
  MODIFY COLUMN kol_predict_price_l1 DECIMAL(12,2) COMMENT '1-20S预估视频报价',
  MODIFY COLUMN kol_predict_price_l2 DECIMAL(12,2) COMMENT '21-60S预估视频报价',
  MODIFY COLUMN cpe_l1 DECIMAL(12,4) COMMENT '1-20S视频预估CPE',
  MODIFY COLUMN cpe_l2 DECIMAL(12,4) COMMENT '21-60S视频预估CPE',
  MODIFY COLUMN cpm_l1 DECIMAL(12,4) COMMENT '1-20S视频预估CPM',
  MODIFY COLUMN cpm_l2 DECIMAL(12,4) COMMENT '21-60S视频预估CPM',
  MODIFY COLUMN view_medium BIGINT COMMENT '日常作品播放量中位数',
  MODIFY COLUMN bussiness_view_medium BIGINT COMMENT '商单作品播放量中位数',
  MODIFY COLUMN date DATETIME COMMENT '数据日期';
```

---

### 1.4 `mcn_inquiries` — 字段结构与文档差距最大

**问题**：
- 缺少 5 个核心字段：`supplier_id`, `remind_at`, `usage_scope`, `form_fields_json`, `token`
- 多个字段名/类型不匹配：`sent_message` (text) 应为 `wecom_message_json` (json)；`candidate_ids_sent` 语义不如 `prefill_rows_json`
- 有额外的重试/统计字段（`attempt_no`, `*_count` 等），应保留

```sql
-- ============================================================
-- 1.4 mcn_inquiries 字段补齐
-- ============================================================

-- Step 1: 添加缺失字段
ALTER TABLE mcn_inquiries
  ADD COLUMN supplier_id VARCHAR(128) DEFAULT NULL COMMENT '企微供应商ID' AFTER mcn_id,
  ADD COLUMN remind_at DATETIME DEFAULT NULL COMMENT '提醒时间' AFTER deadline_at,
  ADD COLUMN usage_scope VARCHAR(32) NOT NULL DEFAULT 'project' COMMENT '使用范围：固定 project' AFTER remind_at,
  ADD COLUMN form_fields_json JSON DEFAULT NULL COMMENT '表单字段定义' AFTER usage_scope,
  ADD COLUMN token VARCHAR(128) DEFAULT NULL COMMENT '唯一填报token' AFTER fill_form_url;

-- Step 2: 添加文档要求的 other 字段映射
-- sent_message → wecom_message_json：保留两者，wecom_message_json 作为规范化版本
ALTER TABLE mcn_inquiries
  ADD COLUMN wecom_message_json JSON DEFAULT NULL COMMENT '企微发送消息JSON' AFTER sent_message;

-- Step 3: prefill_rows_json（如果 candidate_ids_sent 语义不足）
ALTER TABLE mcn_inquiries
  ADD COLUMN prefill_rows_json JSON DEFAULT NULL COMMENT '当前MCN预填达人' AFTER candidate_ids_sent;

-- Step 4: 添加 returned_at
ALTER TABLE mcn_inquiries
  ADD COLUMN returned_at DATETIME DEFAULT NULL COMMENT '机构回填时间' AFTER response_at;

-- Step 5: 添加 UNIQUE(token)
ALTER TABLE mcn_inquiries
  ADD UNIQUE KEY uq_mcn_inquiries_token (token);

-- Step 6: 确保 response_status 有合理枚举
-- （MySQL 不支持直接 ADD CHECK 约束修改现有表，需要用 ENUM 或在应用层控制）
-- 当前为 VARCHAR(64)，建议应用层约束为 sent/returned/failed/cancelled
ALTER TABLE mcn_inquiries
  MODIFY COLUMN response_status VARCHAR(64) NOT NULL DEFAULT 'sent' COMMENT '响应状态：sent/returned/failed/cancelled';
```

---

## 2. P1 — 影响功能但可渐进修复

### 2.1 `creator_supply_offers`

**问题**：
- 缺 `kw_uid` 字段
- 返点用区间（`rebate_min_rate` + `rebate_max_rate`），文档要求单值 `rebate_rate`
- FK 指向 `core_supplier`（等 1.1 迁移后自动修正）

**决策**：保留 DB 现有的区间设计（更合理），文档同步更新。如果下游工具需要单值，取 `rebate_max_rate` 或中值。

```sql
-- ============================================================
-- 2.1 creator_supply_offers
-- ============================================================

ALTER TABLE creator_supply_offers
  ADD COLUMN kw_uid VARCHAR(64) DEFAULT NULL COMMENT '达人唯一账号标识（对应平台 kw_uid）' AFTER platform_account_id;

-- 添加索引
ALTER TABLE creator_supply_offers
  ADD INDEX idx_offer_kw_uid (platform, kw_uid);
```

---

### 2.2 `creator_candidate_pool`

**问题**：
- 缺 `price_cents`, `rebate_rate`
- 字段名不一致：`matched_json` vs `matched_fields_json`，`unmatched_json` vs `missing_fields_json`
- 缺 `score_snapshot_json`

**决策**：价格通过 `offer_id` JOIN `creator_supply_offers` 获取也可以，但为了查询性能建议冗余存储 `price_cents` 和 `rebate_rate`。

```sql
-- ============================================================
-- 2.2 creator_candidate_pool
-- ============================================================

ALTER TABLE creator_candidate_pool
  ADD COLUMN price_cents BIGINT UNSIGNED DEFAULT NULL COMMENT '本次候选报价，单位分' AFTER offer_id,
  ADD COLUMN rebate_rate DECIMAL(10,6) DEFAULT NULL COMMENT '本次返点' AFTER price_cents,
  ADD COLUMN score_snapshot_json JSON DEFAULT NULL COMMENT '初筛/软匹配分数快照' AFTER unmatched_json;

-- 字段别名（不改名，添加索引兼容）
ALTER TABLE creator_candidate_pool
  ADD INDEX idx_ccp_price_cents (price_cents);
```

---

### 2.3 `mcn_recommendation_items`

**问题**：
- 缺 `supply_ratio`, `manual_sourcing_ratio`
- 字段名不一致：`item_id` vs `mcn_recommendation_id`

```sql
-- ============================================================
-- 2.3 mcn_recommendation_items
-- ============================================================

ALTER TABLE mcn_recommendation_items
  ADD COLUMN supply_ratio DECIMAL(10,4) DEFAULT NULL COMMENT '当前供需倍数' AFTER estimated_creator_count,
  ADD COLUMN manual_sourcing_ratio DECIMAL(10,4) DEFAULT NULL COMMENT '建议手扒比例' AFTER supply_ratio;

-- 字段重命名（保留兼容）
ALTER TABLE mcn_recommendation_items
  RENAME COLUMN item_id TO mcn_recommendation_id,
  RENAME COLUMN estimated_creator_count TO candidate_count,
  RENAME COLUMN mcn_rank_score TO rank_score;
```

---

### 2.4 `mcn_submission_items`

**问题**：缺 `kw_uid`, `schedule_json`, `candidate_id`

```sql
-- ============================================================
-- 2.4 mcn_submission_items
-- ============================================================

ALTER TABLE mcn_submission_items
  ADD COLUMN kw_uid VARCHAR(64) DEFAULT NULL COMMENT '达人唯一账号标识' AFTER platform_account_id,
  ADD COLUMN schedule_json JSON DEFAULT NULL COMMENT '档期信息' AFTER submitted_rebate_rate,
  ADD COLUMN candidate_id BIGINT DEFAULT NULL COMMENT '写回候选池后的ID' AFTER validity_status;

ALTER TABLE mcn_submission_items
  ADD INDEX idx_msi_kw_uid (platform, kw_uid),
  ADD INDEX idx_msi_candidate_id (candidate_id);
```

---

### 2.5 `recommendation_runs`

**问题**：缺 `candidate_count`, `dedupe_summary_json`, `updated_at`

```sql
-- ============================================================
-- 2.5 recommendation_runs
-- ============================================================

ALTER TABLE recommendation_runs
  ADD COLUMN candidate_count INT DEFAULT NULL COMMENT '进入精排候选数' AFTER status,
  ADD COLUMN dedupe_summary_json JSON DEFAULT NULL COMMENT 'MCN回填/手扒/库内统一去重摘要' AFTER candidate_count,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间' AFTER finished_at;

-- 字段映射：ranking_weights_json 作为 weight_snapshot_json 的实现
ALTER TABLE recommendation_runs
  RENAME COLUMN ranking_weights_json TO weight_snapshot_json;
```

---

### 2.6 `creator_recommendation_items`

**问题**：缺 `kw_uid`

```sql
-- ============================================================
-- 2.6 creator_recommendation_items
-- ============================================================

ALTER TABLE creator_recommendation_items
  ADD COLUMN kw_uid VARCHAR(64) DEFAULT NULL COMMENT '达人唯一账号标识' AFTER platform_account_id;

ALTER TABLE creator_recommendation_items
  ADD INDEX idx_cri_kw_uid (platform, kw_uid);

-- 字段重命名
ALTER TABLE creator_recommendation_items
  RENAME COLUMN item_id TO recommendation_item_id;
```

---

### 2.7 `creator_submissions`

**问题**：缺 `kw_uid`

```sql
-- ============================================================
-- 2.7 creator_submissions
-- ============================================================

ALTER TABLE creator_submissions
  ADD COLUMN kw_uid VARCHAR(64) DEFAULT NULL COMMENT '达人唯一账号标识' AFTER platform_account_id;

ALTER TABLE creator_submissions
  ADD INDEX idx_cs_kw_uid (platform, kw_uid);
```

---

### 2.8 `submission_batches`

**问题**：缺 `target_submission_count`, `actual_submission_count`, `updated_at`；`submitted_by` vs `created_by` 命名不一致

```sql
-- ============================================================
-- 2.8 submission_batches
-- ============================================================

ALTER TABLE submission_batches
  ADD COLUMN target_submission_count INT DEFAULT NULL COMMENT '目标提报数' AFTER status,
  ADD COLUMN actual_submission_count INT DEFAULT NULL COMMENT '实际提报数' AFTER target_submission_count,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间' AFTER created_at;

-- 字段重命名
ALTER TABLE submission_batches
  RENAME COLUMN submitted_by TO created_by;
```

---

## 3. P2 — 命名统一 & 注释修正

### 3.1 `customer_demands` — 全字段注释修正

当前所有 ~120 个字段的 COMMENT 全是「小红书说明」，需逐字段修正为正确的平台说明。

```sql
-- ============================================================
-- 3.1 customer_demands 注释批量修正
-- ============================================================

-- 通用字段
ALTER TABLE customer_demands
  MODIFY COLUMN id CHAR(32) NOT NULL COMMENT '主键ID（32位uuid）',
  MODIFY COLUMN demand_id VARCHAR(64) NOT NULL COMMENT '稳定需求业务ID',
  MODIFY COLUMN demand_version INT NOT NULL COMMENT '需求版本',
  MODIFY COLUMN status VARCHAR(32) NOT NULL COMMENT '状态：draft/ready/screening/inquiring/submitted/closed/archived',
  MODIFY COLUMN note TEXT COMMENT '备注/额外需求',
  MODIFY COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',

  -- 业务必填字段
  MODIFY COLUMN submission_deadline_at DATETIME NOT NULL COMMENT '提交截止时间',
  MODIFY COLUMN submission_deadline_raw VARCHAR(255) NOT NULL COMMENT '提交时间原文',
  MODIFY COLUMN raw_messages_json JSON NOT NULL COMMENT '原始输入需求内容JSON',
  MODIFY COLUMN budget_min_cents BIGINT NOT NULL COMMENT '预算下限，单位分',
  MODIFY COLUMN budget_max_cents BIGINT NOT NULL COMMENT '预算上限，单位分',
  MODIFY COLUMN budget_raw VARCHAR(255) NOT NULL COMMENT '预算原文',
  MODIFY COLUMN rebate_min_rate DECIMAL(10,4) NOT NULL COMMENT '返点下限，0-1',
  MODIFY COLUMN rebate_max_rate DECIMAL(10,4) NOT NULL COMMENT '返点上限，0-1',
  MODIFY COLUMN rebate_raw VARCHAR(255) NOT NULL COMMENT '返点原文',
  MODIFY COLUMN quantity_total INT NOT NULL COMMENT '需要达人数量',

  -- 平台/品牌
  MODIFY COLUMN platform VARCHAR(32) NOT NULL COMMENT '目标平台：xhs/dy',
  MODIFY COLUMN project_name VARCHAR(255) COMMENT '项目名',
  MODIFY COLUMN brand VARCHAR(255) COMMENT '品牌',
  MODIFY COLUMN product VARCHAR(255) COMMENT '产品',
  MODIFY COLUMN project_start_start DATETIME COMMENT '项目起始时间',
  MODIFY COLUMN project_start_end DATETIME COMMENT '项目结束时间',

  -- kw_uid：这里做创作者主键，和 CSV 字典保持一致
  MODIFY COLUMN kw_uid VARCHAR(64) COMMENT '创作者唯一标识';
```

---

### 3.2 其他表的字段注释修正（关键字段摘要）

```sql
-- ============================================================
-- 3.2 通用字段注释修正
-- ============================================================

-- creator_supply_offers
ALTER TABLE creator_supply_offers
  MODIFY COLUMN platform VARCHAR(16) NOT NULL COMMENT '平台：xhs/dy',
  MODIFY COLUMN platform_account_id VARCHAR(128) NOT NULL COMMENT '平台账号ID',
  MODIFY COLUMN price_cents BIGINT UNSIGNED NOT NULL COMMENT '当前可用报价，单位分',
  MODIFY COLUMN source_channel VARCHAR(64) DEFAULT 'unknown' COMMENT '来源渠道：rate_card/manual_search/mcn_returned/similar_creator/unknown';

-- creator_candidate_pool
ALTER TABLE creator_candidate_pool
  MODIFY COLUMN candidate_source VARCHAR(32) NOT NULL DEFAULT 'rate_card' COMMENT '候选来源：rate_card/initial_filter/vector_match/similar_creator/manual_search/history_reuse/pool_replenish';

-- mcn_agencies (原 core_supplier)
ALTER TABLE mcn_agencies
  MODIFY COLUMN id CHAR(32) NOT NULL COMMENT 'MCN/供应商ID',
  MODIFY COLUMN agency_name VARCHAR(200) NOT NULL COMMENT '机构正式名称',
  MODIFY COLUMN cooperation_status VARCHAR(64) NOT NULL DEFAULT 'active' COMMENT '合作状态：active/inactive/blacklist';
```

---

## 4. 非 MVP 表说明

以下表存在于数据库中但不在 MVP 文档范围内，**本次不做修改**：

| 表分类 | 表名 | 说明 |
|---|---|---|
| Django 基础设施 | `auth_*`, `django_*` | Django 认证与会话管理 |
| 旧业务表 | `core_project`, `core_distribution`, `core_ratecard*`, `core_form*`, `core_notificationlog`, `core_ratecardnotificationlog`, `core_wecomgroupchat`, `core_apikey`, `core_auditlog`, `core_userprofile` | 旧版项目管理/报价/分发系统 |
| 审计日志 | `mcp_tool_call_ledger` | MCP 工具调用审计，建议保留 |
| 测试表 | `items` | 明显为测试数据表，确认后可删除 |

---

## 5. 执行顺序（严格按此顺序）

```
Phase 0 — 备份
  0.1 mysqldump ypcmcn > ypcmcn_backup_$(date +%Y%m%d).sql

Phase 1 — P0 阻塞级
  1.1 core_supplier → mcn_agencies（含 FK 重建）
  1.2 xhs_creator_accounts 字段清理 + 补充
  1.3 dy_creator_accounts 字段清理 + 补充
  1.4 mcn_inquiries 字段补齐

Phase 2 — P1 功能级（可并行执行）
  2.1 creator_supply_offers
  2.2 creator_candidate_pool
  2.3 mcn_recommendation_items
  2.4 mcn_submission_items
  2.5 recommendation_runs
  2.6 creator_recommendation_items
  2.7 creator_submissions
  2.8 submission_batches

Phase 3 — P2 注释修正
  3.1 customer_demands 全字段注释
  3.2 其他表注释修正
```

---

## 6. 已知风险 & 注意事项

1. **`DROP COLUMN IF EXISTS`**：MySQL 8.0.29+ 才支持 `IF EXISTS` 语法。如果版本较低，需要先确认列是否存在再执行 DROP。建议在执行前用 `SHOW COLUMNS` 验证。

2. **xhs/dy 平台表字段删除**：删除字段前请确认没有其他表或查询引用这些列。尤其检查 `customer_demands` 的 CSV 字段集——如果 `search_creators` 工具通过 `SELECT *` 读取平台表，删除列可能导致查询报错。

3. **`RENAME COLUMN`**：MySQL 8.0+ 才支持。确认数据库版本 ≥ 8.0。

4. **FK 重建**：`core_supplier → mcn_agencies` 重命名后，所有引用 `core_supplier` 的 FK 都会失效。除了 `creator_supply_offers`，还需检查 `core_distribution`, `core_formdatarow`, `core_ratecarddatarow`, `core_ratecarddistribution` 等表是否有 FK 指向 `core_supplier`。

5. **`UNIQUE(kw_uid)` 添加前检查**：如果现有数据有重复 `kw_uid`，`ADD UNIQUE KEY` 会失败。需先执行：
   ```sql
   SELECT kw_uid, COUNT(*) FROM xhs_creator_accounts WHERE kw_uid IS NOT NULL GROUP BY kw_uid HAVING COUNT(*) > 1;
   SELECT kw_uid, COUNT(*) FROM dy_creator_accounts WHERE kw_uid IS NOT NULL GROUP BY kw_uid HAVING COUNT(*) > 1;
   ```

6. **下游 MCP 工具兼容**：所有字段重命名和添加需和 MCP 工具代码同步更新。建议在 DB 迁移完成后，逐工具验证读写是否正常。

---

## 7. 验证 SQL

```sql
-- ============================================================
-- 迁移后验证查询
-- ============================================================

-- 7.1 检查所有 MVP 表存在
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'ypmcn'
AND TABLE_NAME IN (
  'customer_demands', 'xhs_creator_accounts', 'dy_creator_accounts',
  'creator_supply_offers', 'creator_candidate_pool', 'mcn_agencies',
  'mcn_recommendation_items', 'mcn_inquiries', 'mcn_submission_items',
  'recommendation_runs', 'creator_recommendation_items',
  'creator_submissions', 'submission_batches'
);

-- 7.2 检查 xhs_creator_accounts 关键字段
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'ypmcn' AND TABLE_NAME = 'xhs_creator_accounts'
AND COLUMN_NAME IN ('kw_uid', 'platform', 'kol_persona_label', 'content_feature_label', 'content_tag');

-- 7.3 检查已删除的 dy 专属字段不存在
SELECT COLUMN_NAME FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'ypmcn' AND TABLE_NAME = 'xhs_creator_accounts'
AND COLUMN_NAME IN ('douyin_id', 'interaction_rate', 'xt_id', 'cpe_l3', 'cpm_l3');
-- 期望结果：空集

-- 7.4 检查 dy_creator_accounts 关键字段
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'ypmcn' AND TABLE_NAME = 'dy_creator_accounts'
AND COLUMN_NAME IN ('kw_uid', 'platform', 'content_theme_label', 'industry_tag_label');

-- 7.5 检查 mcn_inquiries 新增字段
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'ypmcn' AND TABLE_NAME = 'mcn_inquiries'
AND COLUMN_NAME IN ('supplier_id', 'remind_at', 'usage_scope', 'form_fields_json', 'token', 'wecom_message_json', 'prefill_rows_json');

-- 7.6 检查 recommendation_runs 新增字段
SELECT COLUMN_NAME FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'ypmcn' AND TABLE_NAME = 'recommendation_runs'
AND COLUMN_NAME IN ('candidate_count', 'dedupe_summary_json', 'updated_at', 'weight_snapshot_json');

-- 7.7 检查 submission_batches 新增字段
SELECT COLUMN_NAME FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'ypmcn' AND TABLE_NAME = 'submission_batches'
AND COLUMN_NAME IN ('target_submission_count', 'actual_submission_count', 'updated_at', 'created_by');

-- 7.8 检查 FK 完整性
SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = 'ypmcn'
AND REFERENCED_TABLE_NAME = 'mcn_agencies';
```
