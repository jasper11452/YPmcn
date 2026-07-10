#!/usr/bin/env node
/**
 * test-wecom-send.mjs — 企微消息发送测试脚本
 *
 * 用法：
 *   # 通过 webhook 直接发送（最简单）
 *   WECOM_WEBHOOK_URL="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=XXXXX" \
 *     node scripts/test-wecom-send.mjs --msg "测试消息"
 *
 *   # 指定群名称（从 DB 查找 chat_id）
 *   WECOM_CORP_ID=xxx WECOM_CORP_SECRET=yyy \
 *     node scripts/test-wecom-send.mjs --group "123" --msg "测试消息"
 *
 *   # 发送项目分发通知
 *   WECOM_WEBHOOK_URL="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=XXXXX" \
 *     node scripts/test-wecom-send.mjs --distribution \
 *       --project "测试项目" --deadline "2026-07-15T18:00:00+08:00" \
 *       --supplier "123"
 *
 *   # 列出所有企微群配置
 *   node scripts/test-wecom-send.mjs --list
 */

import mysql from "mysql2/promise";
import {
  sendWecomMarkdown,
  sendWecomText,
  buildTestMessage,
  buildDistributionMessage,
  lookupSupplierWecomGroup,
  sendDistributionToSupplier,
} from "../src/send_wecom.mjs";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
const DB = {
  host: "d-oa-test.eshypdata.com",
  port: 3306,
  user: "ypmcn",
  password: requiredEnv("MYSQL_PASSWORD"),
  database: "ypmcn",
  connectTimeout: 5000,
};

async function getPool() {
  return mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 3 });
}

async function listGroups(db) {
  const [groups] = await db.query(
    "SELECT w.id, w.name as group_name, w.chat_id, w.chat_type, w.is_active, " +
    "s.id as supplier_id, s.name as supplier_name " +
    "FROM core_wecomgroupchat w " +
    "LEFT JOIN core_supplier s ON s.wechat_group_chat_id = w.id " +
    "ORDER BY w.name"
  );
  console.log("\n=== 企微群配置列表 ===\n");
  for (const g of groups) {
    const status = g.is_active ? "✓ 启用" : "✗ 停用";
    console.log(`  [${status}] ${g.group_name}`);
    console.log(`    chat_id: ${g.chat_id}`);
    console.log(`    类型:    ${g.chat_type}`);
    if (g.supplier_name) {
      console.log(`    供应商:  ${g.supplier_name} (${g.supplier_id})`);
    }
    console.log("");
  }
  console.log(`共 ${groups.length} 个群\n`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { list: false, distribution: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--list": opts.list = true; break;
      case "--distribution": opts.distribution = true; break;
      case "--msg": opts.message = args[++i]; break;
      case "--group": opts.group = args[++i]; break;
      case "--supplier": opts.supplier = args[++i]; break;
      case "--project": opts.projectName = args[++i]; break;
      case "--deadline": opts.deadline = args[++i]; break;
      case "--description": opts.description = args[++i]; break;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const db = await getPool();

  try {
    // --list: 列出所有群配置
    if (opts.list) {
      await listGroups(db);
      return;
    }

    // --distribution: 发送项目分发通知
    if (opts.distribution) {
      if (!opts.supplier) {
        console.error("错误：--distribution 模式需要 --supplier <供应商名称或ID>");
        process.exit(1);
      }
      if (!opts.projectName) {
        console.error("错误：--distribution 模式需要 --project <项目名称>");
        process.exit(1);
      }

      const group = await lookupSupplierWecomGroup(db, opts.supplier);
      if (!group) {
        console.error(`未找到供应商 "${opts.supplier}" 的企微群配置`);
        console.error("请使用 node scripts/test-wecom-send.mjs --list 查看可用配置");
        process.exit(1);
      }

      console.log(`供应商: ${group.supplierName}`);
      console.log(`企微群: ${group.groupName} (chat_id: ${group.chatId})`);
      console.log("");

      const result = await sendDistributionToSupplier(db, {
        supplierId: opts.supplier,
        projectName: opts.projectName,
        deadline: opts.deadline || "2026-12-31T18:00:00+08:00",
        description: opts.description || "",
        formUrl: "https://ypmcn.eshypdata.com/form?projectId=test&token=test",
      });

      console.log(`发送结果: ${result.success ? "✓ 成功" : "✗ 失败"}`);
      console.log(`模式: ${result.mode}`);
      console.log(`群名: ${result.groupName}`);
      if (result.error) {
        console.log(`错误: ${result.error}`);
      }
      return;
    }

    // --msg: 发送普通测试消息
    if (opts.message) {
      const message = buildTestMessage(opts.message);

      if (opts.group) {
        // 通过群名查找 chat_id
        const [groups] = await db.query(
          "SELECT chat_id, name FROM core_wecomgroupchat WHERE name = ? OR chat_id = ?",
          [opts.group, opts.group]
        );
        if (groups.length === 0) {
          console.error(`未找到企微群 "${opts.group}"`);
          process.exit(1);
        }
        const chatId = groups[0].chat_id;
        console.log(`目标群: ${groups[0].name} (chat_id: ${chatId})`);
        try {
          const result = await sendWecomMarkdown(message, chatId);
          console.log(`发送成功! mode=${result.mode}, msgId=${result.msgId || "N/A"}`);
        } catch (e) {
          console.error(`发送失败: ${e.message}`);
          process.exit(1);
        }
      } else {
        // 直接通过 webhook 发送
        try {
          const result = await sendWecomMarkdown(message);
          console.log(`发送成功! mode=${result.mode}, msgId=${result.msgId || "N/A"}`);
        } catch (e) {
          console.error(`发送失败: ${e.message}`);
          console.error("");
          console.error("配置方法：");
          console.error("  方法1 (推荐): 群设置 → 群机器人 → 添加 → 复制 webhook → 设置 WECOM_WEBHOOK_URL");
          console.error("  方法2: 设置 WECOM_CORP_ID + WECOM_CORP_SECRET 并使用 --group 指定群");
          process.exit(1);
        }
      }
      return;
    }

    // 无参数：显示帮助
    console.log("企微消息发送测试工具");
    console.log("");
    console.log("用法:");
    console.log("  node scripts/test-wecom-send.mjs --list");
    console.log("  WECOM_WEBHOOK_URL=... node scripts/test-wecom-send.mjs --msg \"hello\"");
    console.log("  WECOM_WEBHOOK_URL=... node scripts/test-wecom-send.mjs --distribution --supplier 123 --project \"测试\"");
    console.log("");
    console.log("环境变量:");
    console.log("  WECOM_WEBHOOK_URL      群机器人 webhook 地址 (推荐)");
    console.log("  WECOM_CORP_ID          企业微信 Corp ID (corp API 模式)");
    console.log("  WECOM_CORP_SECRET      企业微信 Corp Secret (corp API 模式)");

  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error("执行出错:", e.message);
  process.exit(1);
});
