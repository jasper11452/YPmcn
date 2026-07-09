/**
 * send_wecom.mjs — 企微消息发送模块
 *
 * 支持两种模式：
 * 1. Webhook 模式（推荐，最简单）：设置 WECOM_WEBHOOK_URL
 * 2. 企业应用 API 模式：设置 WECOM_CORP_ID + WECOM_CORP_SECRET
 *
 * Webhook 获取方式：群聊 → 群设置 → 群机器人 → 添加 → 复制 webhook 地址
 * URL 格式：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=XXXXX
 */

const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL || "";
const WECOM_CORP_ID = process.env.WECOM_CORP_ID || "";
const WECOM_CORP_SECRET = process.env.WECOM_CORP_SECRET || "";

// 缓存 access_token
let _cachedToken = null;
let _tokenExpiresAt = 0;

/**
 * 获取企业微信 access_token（corp API 模式）
 */
async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 60000) {
    return _cachedToken;
  }
  if (!WECOM_CORP_ID || !WECOM_CORP_SECRET) {
    throw new Error("WECOM_CORP_ID 和 WECOM_CORP_SECRET 未设置");
  }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${WECOM_CORP_ID}&corpsecret=${WECOM_CORP_SECRET}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.errcode !== 0) {
    throw new Error(`获取 access_token 失败: ${data.errmsg} (errcode=${data.errcode})`);
  }
  _cachedToken = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;
  return _cachedToken;
}

/**
 * 通过 webhook 发送 markdown 消息（最简单）
 */
async function sendViaWebhook(markdownContent) {
  if (!WECOM_WEBHOOK_URL) {
    throw new Error("WECOM_WEBHOOK_URL 未设置");
  }
  const body = {
    msgtype: "markdown",
    markdown: { content: markdownContent },
  };
  const resp = await fetch(WECOM_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.errcode !== 0) {
    throw new Error(`企微 webhook 发送失败: ${data.errmsg} (errcode=${data.errcode})`);
  }
  return { success: true, msgId: data.msgid || null };
}

/**
 * 通过企业应用 API 发送 markdown 消息到群聊
 */
async function sendViaCorpApi(chatId, markdownContent) {
  const token = await getAccessToken();
  if (!chatId) {
    throw new Error("chatId 不能为空");
  }
  const body = {
    chatid: chatId,
    msgtype: "markdown",
    markdown: { content: markdownContent },
    safe: 0,
  };
  const url = `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${token}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.errcode !== 0) {
    throw new Error(`企微 API 发送失败: ${data.errmsg} (errcode=${data.errcode})`);
  }
  return { success: true, msgId: data.msgid || null };
}

/**
 * 发送 markdown 消息到企微
 *
 * @param {string} markdownContent - 企微 markdown 格式消息
 * @param {string} [chatId] - 群聊 chat_id（corp API 模式需要，webhook 模式忽略）
 * @returns {Promise<{success: boolean, msgId: string|null, mode: string}>}
 */
export async function sendWecomMarkdown(markdownContent, chatId) {
  if (WECOM_WEBHOOK_URL) {
    return { ...(await sendViaWebhook(markdownContent)), mode: "webhook" };
  }
  if (WECOM_CORP_ID && WECOM_CORP_SECRET && chatId) {
    return { ...(await sendViaCorpApi(chatId, markdownContent)), mode: "corp_api" };
  }
  throw new Error(
    "未配置企微发送凭据。" +
    " 请设置: WECOM_WEBHOOK_URL (群机器人 webhook) " +
    "或 WECOM_CORP_ID + WECOM_CORP_SECRET (企业应用 API)"
  );
}

/**
 * 发送文本消息到企微（简单模式）
 *
 * @param {string} text - 纯文本消息
 * @param {string} [chatId] - 群聊 chat_id
 */
export async function sendWecomText(text, chatId) {
  // 将纯文本转为 markdown（企微 markdown 基本兼容纯文本）
  return sendWecomMarkdown(text, chatId);
}

/**
 * 构建项目分发通知的 markdown 消息
 *
 * @param {object} opts
 * @param {string} opts.projectName - 项目名称
 * @param {string} opts.deadline - 截止时间
 * @param {string} opts.description - 项目描述
 * @param {Array<{supplierName: string, formUrl: string}>} opts.distributions - 分发列表
 * @returns {string} markdown 格式消息
 */
export function buildDistributionMessage({ projectName, deadline, description, distributions }) {
  const lines = [
    `## 📋 供应商提报通知`,
    ``,
    `**项目名称**：${projectName}`,
    `**截止时间**：${deadline}`,
  ];
  if (description) {
    lines.push(`**项目说明**：${description}`);
  }
  lines.push(``);

  if (distributions && distributions.length > 0) {
    lines.push(`### 提报链接`);
    for (const d of distributions) {
      const label = d.supplierName || "供应商";
      lines.push(`- **${label}**：[点击填写](${d.formUrl})`);
    }
  }

  lines.push(``);
  lines.push(`> 请在截止时间前完成达人信息填写。`);
  lines.push(`> 如有疑问请联系媒介同事。`);

  return lines.join("\n");
}

/**
 * 构建通用的企微测试消息
 *
 * @param {string} content - 消息内容
 * @returns {string} markdown 格式消息
 */
export function buildTestMessage(content) {
  return [
    `## 🧪 MockMCP 测试消息`,
    ``,
    content,
    ``,
    `> 发送时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    `> 来源：YPmcn MockMCP`,
  ].join("\n");
}

/**
 * 从数据库查找供应商对应的企微群 chat_id
 *
 * @param {object} dbPool - mysql2 连接池
 * @param {string} supplierId - 供应商 ID 或名称
 * @returns {Promise<{chatId: string, groupName: string, supplierName: string}|null>}
 */
export async function lookupSupplierWecomGroup(dbPool, supplierId) {
  try {
    const [suppliers] = await dbPool.query(
      "SELECT s.id, s.name as supplier_name, s.wechat_group_chat_id, w.chat_id, w.name as group_name " +
      "FROM core_supplier s " +
      "JOIN core_wecomgroupchat w ON s.wechat_group_chat_id = w.id " +
      "WHERE s.id = ? OR s.name = ?",
      [supplierId, supplierId]
    );
    if (suppliers.length === 0) return null;
    const s = suppliers[0];
    return {
      chatId: s.chat_id,
      groupName: s.group_name,
      supplierName: s.supplier_name,
    };
  } catch (e) {
    console.error("lookupSupplierWecomGroup error:", e.message);
    return null;
  }
}

/**
 * 发送项目分发通知到指定供应商的企微群
 *
 * @param {object} dbPool - mysql2 连接池
 * @param {object} opts
 * @param {string} opts.supplierId - 供应商 ID
 * @param {string} opts.projectName - 项目名称
 * @param {string} opts.deadline - 截止时间
 * @param {string} [opts.description] - 项目描述
 * @param {string} [opts.formUrl] - 表单链接
 * @returns {Promise<{success: boolean, supplierName: string, groupName: string, mode: string, error?: string}>}
 */
export async function sendDistributionToSupplier(dbPool, opts) {
  const { supplierId, projectName, deadline, description, formUrl } = opts;

  const group = await lookupSupplierWecomGroup(dbPool, supplierId);
  if (!group) {
    return {
      success: false,
      supplierName: supplierId,
      groupName: "未知",
      mode: "none",
      error: `未找到供应商 "${supplierId}" 的企微群配置`,
    };
  }

  const message = buildDistributionMessage({
    projectName,
    deadline,
    description,
    distributions: formUrl
      ? [{ supplierName: group.supplierName, formUrl }]
      : [],
  });

  try {
    const result = await sendWecomMarkdown(message, group.chatId);
    return {
      success: true,
      supplierName: group.supplierName,
      groupName: group.groupName,
      mode: result.mode,
    };
  } catch (e) {
    return {
      success: false,
      supplierName: group.supplierName,
      groupName: group.groupName,
      mode: "none",
      error: e.message,
    };
  }
}
