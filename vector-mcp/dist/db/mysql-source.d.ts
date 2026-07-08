/**
 * MySQL real data source for creator rows.
 *
 * Connects to MySQL and fetches creator data from 小红书达人表 and 抖音达人表.
 * Requires mysql2 package: npm install mysql2
 *
 * Real table names: xhs_creator_accounts, dy_creator_accounts
 *
 * xhs 向量化字段: pugongying_category, grow_category, persona_tags, content_feature_tags, tone_tags, other_tags
 * dy  向量化字段: xingtu_creator_type, grow_creator_type, content_topic_tags, industry_tags
 *
 * 所有 JSON 标签数组合并为 content_tags，grow_tags 留空占位。
 */
import type { CreatorSourceRow } from "../vector/sync.js";
import type { SourceMappings } from "../source/contract.js";
export interface MysqlSourceConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}
export declare function fetchCreatorRows(config: MysqlSourceConfig, _sourceMapping: SourceMappings, maxRows?: number): Promise<CreatorSourceRow[]>;
export declare function mysqlConfigFromEnv(): MysqlSourceConfig;
