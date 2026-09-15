// =============================================================================
// Bedaya Enterprise Social Inbox Agent (v25.0: Telegram & Gmail Direct Hub)
// Worker URL: https://automation.nckalo018.workers.dev
// =============================================================================

const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";
const DEFAULT_ADMIN_KEY = "bedaya_admin_2026";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const AI_ROUTER_BASE = "https://ai.nckalo018.workers.dev/v1";
const AI_ROUTER_MODEL = "auto";

// الثوابت التشغيلية
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 أيام
const AUDIT_LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 أيام
const LOG_LIST_LIMIT = 50;

const MAX_AGENT_STEPS = 10;
const CALL_TIMEOUT_MS = 15000;
const AI_CALL_TIMEOUT_MS = 30000;
const AI_ROUTER_MAX_TOKENS = 1024;
const AUTO_CONTEXT_LIMIT = 10; // سياق آخر 10 رسائل

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zernio-key, x-connect-token, X-Connect-Token, X-Admin-Key',
};

// -----------------------------------------------------------------------------
// 1) أدوات مساعدة عامة
// -----------------------------------------------------------------------------

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders } });
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret, rawBody) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return bufferToHex(sig);
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function kvGetJSON(env, key) {
  try {
    const raw = await env.ZERNIO_KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

async function kvSetJSON(env, key, value, ttlSeconds) {
  try {
    await env.ZERNIO_KV.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  } catch (err) {}
}

function isoNow() { return new Date().toISOString(); }
function shortId() { return crypto.randomUUID().slice(0, 8); }

async function logActivity(env, entry) {
  await kvSetJSON(env, `log:${isoNow()}:${shortId()}`, entry, LOG_TTL_SECONDS);
}

function computeSinceDate(url) {
  const since = url.searchParams.get("since");
  if (since) {
    const d = new Date(since);
    if (!isNaN(d)) return d;
  }
  const range = url.searchParams.get("range");
  if (range === "1h") return new Date(Date.now() - 60 * 60 * 1000);
  if (range === "today") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  return null;
}

async function listRecentLogs(env, { limit = LOG_LIST_LIMIT, eventId = null, since = null } = {}) {
  try {
    const needsWideScan = Boolean(eventId || since);
    const listRes = await env.ZERNIO_KV.list({ prefix: "log:", limit: 1000 });
    let keys = listRes.keys.map((k) => k.name).sort().reverse();
    keys = keys.slice(0, needsWideScan ? 1000 : limit);

    let entries = (await Promise.all(keys.map((k) => kvGetJSON(env, k)))).filter(Boolean);
    if (eventId) entries = entries.filter((e) => e.eventId === eventId);
    if (since) {
      entries = entries.filter((e) => {
        const t = new Date((e.timing && e.timing.receivedAt) || e.ts || 0);
        return t >= since;
      });
    }
    return needsWideScan ? entries : entries.slice(0, limit);
  } catch (err) {
    return [];
  }
}

function redactSecret(text, secret) {
  if (!secret || typeof text !== "string") return text;
  return text.split(secret).join("[REDACTED]");
}

// -----------------------------------------------------------------------------
// 2) بوابات الإرسال المباشرة لـ Telegram و Gmail و Zernio
// -----------------------------------------------------------------------------

async function zernioFetch(env, path, options = {}) {
  const apiKey = (env.ZERNIO_API_KEY || WORKER_ZERNIO_API_KEY || '').trim();
  const url = `${ZERNIO_API_BASE}${path}`;
  const headers = Object.assign(
    { Authorization: `Bearer ${apiKey}` },
    options.body ? { "Content-Type": "application/json" } : {},
    options.headers || {}
  );
  const res = await Promise.race([
    fetch(url, { ...options, headers }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`انتهت مهلة نداء Zernio API: ${path}`)), CALL_TIMEOUT_MS)
    ),
  ]);
  const bodyText = await res.text();
  let data;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { data = { raw: bodyText.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
}

// إرسال مباشر لتليجرام بدون Zernio
async function sendTelegramDirect(env, chatId, text) {
  const token = (env.TELEGRAM_BOT_TOKEN || (await env.ZERNIO_KV?.get("telegram_bot_token")) || "").trim();
  if (!token) return { ok: false, status: 400, data: { error: "TELEGRAM_BOT_TOKEN غير مضبوط بالسيرفر" } };

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// إرسال مباشر لـ Gmail عبر Google Apps Script
async function sendGmailDirect(env, threadId, text, metadata = {}) {
  const scriptUrl = (env.GMAIL_SCRIPT_URL || (await env.ZERNIO_KV?.get("gmail_script_url")) || metadata.appsScriptCallbackUrl || "").trim();
  if (!scriptUrl) return { ok: false, status: 400, data: { error: "رابط Google Apps Script لـ Gmail غير مضبوط" } };

  const res = await fetch(scriptUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "reply",
      threadId: threadId || metadata.threadId,
      toEmail: metadata.fromEmail,
      subject: metadata.subject ? `Re: ${metadata.subject.replace(/^Re:\s*/i, '')}` : "رد خدمة العملاء",
      replyBody: text
    })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// -----------------------------------------------------------------------------
// 3) كتالوج أدوات الوكيل (Tools Handlers الموحدة لكل المنصات)
// -----------------------------------------------------------------------------

function missingArgsError(names) {
  return { ok: false, status: 0, data: { error: `الحقول المطلوبة مفقودة: ${names.join(", ")}` } };
}

const TOOL_DESCRIPTIONS = {
  listMessages: "جلب آخر رسائل محادثة DM (سياق)",
  sendMessage: "إرسال رسالة DM مباشرة للعميل (Meta, TikTok, Telegram, Gmail)",
  typingIndicator: "مؤشر الكتابة التلقائي",
  addReaction: "إضافة تفاعل Reaction على رسالة DM",
  removeReaction: "إزالة تفاعل Reaction من رسالة DM",
  listComments: "جلب تعليقات البوست (سياق)",
  replyToComment: "الرد على تعليق (فيسبوك، إنستغرام، تيك توك)",
  sendPrivateReply: "إرسال DM خاص لصاحب تعليق",
  deleteComment: "حذف تعليق",
  ignoreMessage: "تجاهل الرسالة تماماً بدون رد (في حالة السبام أو الإعلانات المزعجة)",
  saveToCrm: "تسجيل وحفظ بيانات العميل والطلب في نظام علاقات العملاء (CRM)",
};

const CALL_HANDLERS = {
  async listMessages(env, args) {
    const { conversationId, accountId, limit = AUTO_CONTEXT_LIMIT, sortOrder = "desc", cursor } = args || {};
    if (!conversationId || !accountId) return missingArgsError(["conversationId", "accountId"]);
    const qs = new URLSearchParams({ accountId, limit: String(limit), sortOrder });
    if (cursor) qs.set("cursor", cursor);
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages?${qs}`, { method: "GET" });
  },

  // أداة الإرسال الموحدة الذكية: تكتشف المنصة وتوجه الرسالة للمسار الصحيح
  async sendMessage(env, args, idempotencyKey) {
    const { conversationId, accountId, message, attachmentUrl, attachmentType, platform, metadata } = args || {};
    if (!conversationId || !accountId) return missingArgsError(["conversationId", "accountId"]);
    if (!message && !attachmentUrl) return missingArgsError(["message أو attachmentUrl"]);

    // 1. إذا كان الحساب تليجرام
    if (platform === "telegram" || accountId === "telegram_bot") {
      return sendTelegramDirect(env, conversationId, message);
    }

    // 2. إذا كان الحساب جيميل
    if (platform === "gmail" || accountId === "gmail_inbox") {
      return sendGmailDirect(env, conversationId, message, metadata);
    }

    // 3. منصات Zernio (Meta & TikTok)
    const body = { accountId };
    if (message) body.message = message;
    if (attachmentUrl) {
      body.attachmentUrl = attachmentUrl;
      body.attachmentType = attachmentType || "file";
    }
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    });
  },

  async typingIndicator(env, args) {
    const { conversationId, accountId, platform } = args || {};
    if (!conversationId || !accountId) return missingArgsError(["conversationId", "accountId"]);
    if (platform === "telegram" || platform === "gmail") return { ok: true, data: { status: "skipped" } };
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, {
      method: "POST",
      body: JSON.stringify({ accountId }),
    });
  },

  async addReaction(env, args) {
    const { conversationId, accountId, messageId, emoji } = args || {};
    if (!conversationId || !accountId || !messageId || !emoji) {
      return missingArgsError(["conversationId", "accountId", "messageId", "emoji"]);
    }
    return zernioFetch(
      env,
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: "POST", body: JSON.stringify({ accountId, emoji }) }
    );
  },

  async removeReaction(env, args) {
    const { conversationId, accountId, messageId } = args || {};
    if (!conversationId || !accountId || !messageId) {
      return missingArgsError(["conversationId", "accountId", "messageId"]);
    }
    const qs = new URLSearchParams({ accountId });
    return zernioFetch(
      env,
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions?${qs}`,
      { method: "DELETE" }
    );
  },

  async listComments(env, args) {
    const { postId, accountId, limit, cursor } = args || {};
    if (!postId || !accountId) return missingArgsError(["postId (platformPostId)", "accountId"]);
    const qs = new URLSearchParams({ accountId });
    if (limit) qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}?${qs}`, { method: "GET" });
  },

  async replyToComment(env, args, idempotencyKey) {
    const { postId, accountId, message, attachmentUrl, commentId } = args || {};
    if (!postId || !accountId || !message) return missingArgsError(["postId (platformPostId)", "accountId", "message"]);
    const body = { accountId, message };
    if (attachmentUrl) body.attachmentUrl = attachmentUrl;
    if (commentId) body.commentId = commentId;
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    });
  },

  async sendPrivateReply(env, args, idempotencyKey) {
    const { postId, commentId, accountId, message } = args || {};
    if (!postId || !commentId || !accountId || !message) {
      return missingArgsError(["postId (platformPostId)", "commentId", "accountId", "message"]);
    }
    const body = { accountId, message };
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/private-reply`, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    });
  },

  async deleteComment(env, args) {
    const { postId, accountId, commentId } = args || {};
    if (!postId || !accountId || !commentId) return missingArgsError(["postId (platformPostId)", "accountId", "commentId"]);
    const qs = new URLSearchParams({ accountId, commentId });
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}?${qs}`, { method: "DELETE" });
  },

  async ignoreMessage(env, args) {
    const { reason = "spam", notes = "" } = args || {};
    return {
      ok: true,
      status: 200,
      data: { action: "ignored", reason, notes, message: "تم تجاهل المحادثة بنجاح." }
    };
  },

  async saveToCrm(env, args) {
    const { leadData = {} } = args || {};
    if (env.ZERNIO_KV) {
      const leadId = `crm_lead:${isoNow()}:${shortId()}`;
      await kvSetJSON(env, leadId, { ...leadData, createdAt: isoNow() }, 60 * 24 * 60 * 60);
    }
    return {
      ok: true,
      status: 200,
      data: { action: "saved_to_crm", leadData, message: "تم تسجيل وحفظ بيانات العميل في الـ CRM بنجاح." }
    };
  }
};

function buildToolsManifest() {
  return Object.keys(CALL_HANDLERS).map((name) => `${name} — ${TOOL_DESCRIPTIONS[name] || ""}`);
}

const IDEMPOTENT_WRITE_OPS = new Set(["sendMessage", "replyToComment", "sendPrivateReply"]);

async function buildIdempotencyKey(eventId, name, args) {
  const raw = `${eventId || "noevent"}:${name}:${JSON.stringify(args || {})}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return bufferToHex(buf).slice(0, 40);
}

async function executeCalls(env, calls, eventId) {
  const results = [];
  const apiKey = (env.ZERNIO_API_KEY || WORKER_ZERNIO_API_KEY || '').trim();
  for (const c of calls) {
    const name = c && c.name;
    const handler = CALL_HANDLERS[name];
    if (!handler) {
      results.push({
        name,
        ok: false,
        data: { error: `اسم عملية غير معروف: "${name}". العمليات المتاحة: ${Object.keys(CALL_HANDLERS).join(", ")}` },
      });
      continue;
    }
    try {
      const idempotencyKey = IDEMPOTENT_WRITE_OPS.has(name) ? await buildIdempotencyKey(eventId, name, c.args) : undefined;
      const r = await handler(env, c.args || {}, idempotencyKey);
      results.push({ name, ok: r.ok, status: r.status, data: r.data });
    } catch (err) {
      results.push({ name, ok: false, data: { error: redactSecret(String((err && err.message) || err), apiKey) } });
    }
  }
  return results;
}

// -----------------------------------------------------------------------------
// 4) بناء الـ System Prompt الديناميكي (الملفات المحللة + أعمدة الـ CRM)
// -----------------------------------------------------------------------------

async function buildAgentSystemInstruction(env) {
  let customPrompt = "أنت وكيل ذكي بيرد على رسائل الـ Direct Messages والتعليقات والإيميلات باحترافية وسرعة.";
  let filesSection = "";
  let crmSection = "";

  if (env.ZERNIO_KV) {
    const savedPrompt = await env.ZERNIO_KV.get("custom_agent_prompt").catch(() => null);
    if (savedPrompt && savedPrompt.trim()) customPrompt = savedPrompt.trim();

    const analyzedFiles = await env.ZERNIO_KV.get("store_files_content").catch(() => null);
    if (analyzedFiles && analyzedFiles.trim()) {
      filesSection = `\n=== ملفات ومستندات النشاط التجاري (Store Knowledge Files) ===\nاستند بدقة للتفاصيل والمنتجات والأسعار التالية:\n${analyzedFiles.trim()}\n`;
    }

    const crmSchema = await env.ZERNIO_KV.get("crm_custom_schema").catch(() => null);
    if (crmSchema && crmSchema.trim()) {
      crmSection = `\n=== أعمدة تسجيل بيانات العملاء (CRM Schema) ===\nعند اتفاق العميل على الشراء أو طلب أوردر، استدعِ أداة saveToCrm بالحقول التالية:\n${crmSchema.trim()}\n`;
    }
  }

  return [
    "=== تعليمات وشخصية المتجر (أولوية قصوى) ===",
    customPrompt,
    filesSection,
    crmSection,
    "=== قواعد عمل نظام الوكيل والرد ===",
    "أنت وكيل ذكي بيرد على رسائل الـ DMs والتعليقات والإيميلات (Instagram, Facebook, TikTok, Telegram, Gmail).",
    "حدثين أساسيين: event = \"message.received\" أو event = \"comment.received\".",
    "",
    "طريقة الرد الإلزامية: كل رد منك لازم يكون كائن JSON واحد فقط:",
    '1) {"action": "call", "calls": [{"name": "اسم العملية", "args": {...}}], "done": true}',
    '2) {"action": "final", "text": "..."}',
    "",
    "القواعد:",
    "1. في حالة وصول رسالة سبام أو إعلانات مزعجة أو إساءة: استخدم أداة ignoreMessage مع done:true فوراً لعدم الرد.",
    "2. عند إتمام اتفاق أو طلب مع العميل وجمع بياناته: استخدم أداة saveToCrm لتسجيل البيانات في الـ CRM.",
    "3. في أداة sendMessage: مرر دائماً نفس conversationId و accountId ونفس platform و metadata المستخرجة من الحدث لضمان وصول الرد للمنصة الصحيحة.",
    "",
    "── كتالوج أدوات الـ DM والإيميل (event = message.received) ──",
    '- sendMessage — args: { conversationId, accountId, platform, metadata?, message, attachmentUrl? }',
    '- addReaction — args: { conversationId, accountId, messageId, emoji }',
    '- listMessages — args: { conversationId, accountId, limit? }',
    '- ignoreMessage — args: { reason ("spam"|"offensive"|"no_action_needed"), notes? }',
    '- saveToCrm — args: { leadData: { ... } }',
    "",
    "── كتالوج التعليقات (event = comment.received) ──",
    '- replyToComment — args: { postId (platformPostId!), accountId, message, attachmentUrl?, commentId? }',
    '- sendPrivateReply — args: { postId (platformPostId!), commentId, accountId, message }',
    '- ignoreMessage — args: { reason ("spam"|"offensive"|"no_action_needed"), notes? }',
    "",
    "طريقة عملك:",
    "1. حدد نوع الحدث والمنصة واستخرج الـ IDs بالظبط من النص الوارد.",
    "2. لو العملية هي آخر حاجة مطلوبة، استخدم done:true لإنهاء المعالجة فوراً."
  ].filter(Boolean).join("\n");
}

// -----------------------------------------------------------------------------
// 5) عميل الموديل ومحلل الملفات الذكي (AI Router & File Synthesizer)
// -----------------------------------------------------------------------------

function contentsToMessages(systemInstruction, contents) {
  const messages = [{ role: "system", content: systemInstruction }];
  for (const c of contents) {
    const text = (c.parts || []).map((p) => p.text || "").join("\n");
    messages.push({ role: c.role === "model" ? "assistant" : "user", content: text });
  }
  return messages;
}

function extractRouterText(data) {
  const choice = data && Array.isArray(data.choices) && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content === "string") return content;
  try { return JSON.stringify(data); } catch (_) { return String(data); }
}

async function callRouterTurn(env, contents, systemInstruction, attemptsLog) {
  const messages = contentsToMessages(systemInstruction, contents);
  const url = `${AI_ROUTER_BASE}/chat/completions`;
  const apiKey = env.AI_ROUTER_API_KEY || env.GEMINI_API_KEY || WORKER_ZERNIO_API_KEY;

  let res, bodyText;
  try {
    res = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: AI_ROUTER_MODEL,
          messages,
          temperature: 0.2,
          max_tokens: AI_ROUTER_MAX_TOKENS,
          response_format: { type: "json_object" },
        }),
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`انتهت مهلة نداء AI Router (${AI_CALL_TIMEOUT_MS / 1000}s)`)), AI_CALL_TIMEOUT_MS)
      ),
    ]);
    bodyText = await res.text();
  } catch (err) {
    const msg = `AI Router error: ${(err && err.message) || err}`;
    if (attemptsLog) attemptsLog.push({ provider: "ai-router", model: AI_ROUTER_MODEL, ok: false, note: msg });
    throw new Error(msg);
  }

  let data;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { data = { raw: bodyText.slice(0, 500) }; }

  if (!res.ok) {
    const errMsg = data && data.error && (data.error.message || data.error) ? data.error.message || JSON.stringify(data.error) : JSON.stringify(data).slice(0, 300);
    const msg = `AI Router HTTP ${res.status}: ${errMsg}`;
    if (attemptsLog) attemptsLog.push({ provider: "ai-router", model: AI_ROUTER_MODEL, status: res.status, ok: false, note: msg });
    throw new Error(msg);
  }

  return extractRouterText(data);
}

// تحليل محتوى الملفات وفهمها بالـ AI Router
async function synthesizeStoreKnowledge(env, rawFileText, fileName) {
  const prompt = `أنت خبير تحليل بيانات الأنشطة التجارية والمتاجر. قم بقراءة وفهم محتوى هذا الملف (${fileName}) واستخرج منه جميع المعلومات الأساسية للمتجر (المنتجات، الأسعار، العروض، سياسات الشحن والضمان، والأسئلة الشائعة). قم بتلخيصها وصياغتها في شكل قاعدة معرفة واضحة ومباشرة ومنظمة باللغة العربية.

محتوى الملف الخام:
${rawFileText.slice(0, 15000)}

قاعدة المعرفة المستخرجة:`;

  const messages = [
    { role: "system", content: "أنت خبير استخراج وتلخيص المعرفة التجارية للوكلاء الذكيين." },
    { role: "user", content: prompt }
  ];

  const url = `${AI_ROUTER_BASE}/chat/completions`;
  const apiKey = env.AI_ROUTER_API_KEY || env.GEMINI_API_KEY || WORKER_ZERNIO_API_KEY;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_ROUTER_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 1500
      })
    });
    const data = await res.json();
    return extractRouterText(data).trim();
  } catch (err) {
    return rawFileText.slice(0, 5000);
  }
}

function extractJsonObject(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  try { return JSON.parse(cleaned); } catch (_) {}

  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// 6) حلقة تفكير الوكيل (ReAct Agent Loop)
// -----------------------------------------------------------------------------

async function runAgentLoopWithModel(env, rawEventText, eventId) {
  const systemInstruction = await buildAgentSystemInstruction(env);
  const contents = [{ role: "user", parts: [{ text: rawEventText }] }];
  const steps = [];
  const routerAttempts = [];

  for (let i = 0; i < MAX_AGENT_STEPS; i++) {
    let rawText;
    try {
      rawText = await callRouterTurn(env, contents, systemInstruction, routerAttempts);
    } catch (err) {
      return { ok: false, steps, finalText: null, stopReason: "error", error: err.message, routerAttempts };
    }

    const action = extractJsonObject(rawText);

    if (!action || typeof action.action !== "string") {
      steps.push({ step: i + 1, ts: isoNow(), type: "invalid-json", raw: String(rawText).slice(0, 300) });
      contents.push({ role: "model", parts: [{ text: String(rawText).slice(0, 2000) }] });
      contents.push({
        role: "user",
        parts: [{ text: "ردك مش كائن JSON صالح بالشكل المطلوب. رجّع بس واحد من الشكلين: call أو final." }],
      });
      continue;
    }

    if (action.action === "final") {
      const finalText = typeof action.text === "string" ? action.text : "";
      steps.push({ step: i + 1, ts: isoNow(), type: "final", text: finalText });
      return { ok: true, steps, finalText, stopReason: "final", routerAttempts };
    }

    if (action.action === "call") {
      let calls = action.calls;
      if (calls && !Array.isArray(calls)) calls = [calls];
      if (!Array.isArray(calls) || calls.length === 0) {
        steps.push({ step: i + 1, ts: isoNow(), type: "empty-call" });
        contents.push({ role: "model", parts: [{ text: rawText }] });
        contents.push({
          role: "user",
          parts: [{ text: "حقل calls فاضي. لازم يكون فيه عملية واحدة على الأقل." }],
        });
        continue;
      }

      const results = await executeCalls(env, calls, eventId);
      const allOk = results.length > 0 && results.every((r) => r.ok);
      steps.push({
        step: i + 1,
        ts: isoNow(),
        type: "call",
        calls: calls.slice(0, 10).map((c) => ({ name: c && c.name, args: c && c.args })),
        results: results.map((r) => ({
          name: r.name,
          ok: r.ok,
          status: r.status,
          data: JSON.stringify(r.data).slice(0, 400),
        })),
      });

      if (action.done === true && allOk) {
        const summary = `تم بنجاح (done:true): ${calls.map((c) => c && c.name).join(", ")}`;
        return { ok: true, steps, finalText: summary, stopReason: "final", routerAttempts };
      }

      contents.push({ role: "model", parts: [{ text: rawText }] });
      contents.push({ role: "user", parts: [{ text: `نتيجة تنفيذ العمليات:\n${JSON.stringify(results, null, 2).slice(0, 4000)}` }] });
      continue;
    }

    steps.push({ step: i + 1, ts: isoNow(), type: "unknown-action", raw: String(action.action).slice(0, 100) });
    contents.push({ role: "model", parts: [{ text: rawText }] });
    contents.push({
      role: "user",
      parts: [{ text: `"action": "${action.action}" مش معروف. استخدم بس: call أو final.` }],
    });
  }

  return { ok: true, steps, finalText: null, stopReason: "max-steps", routerAttempts };
}

async function runAgentLoop(env, rawEventText, eventId) {
  const apiKey = env.AI_ROUTER_API_KEY || env.GEMINI_API_KEY || WORKER_ZERNIO_API_KEY;
  if (!apiKey) {
    return { steps: [], finalText: null, stopReason: "error", error: "مفيش AI_ROUTER_API_KEY متظبط بالسيرفر", routerAttempts: [] };
  }
  return runAgentLoopWithModel(env, rawEventText, eventId);
}

// -----------------------------------------------------------------------------
// 7) معالجة أحداث الويب هوك (Zernio, Telegram, Gmail)
// -----------------------------------------------------------------------------

function isSelfEcho(payload) {
  const author = payload.comment && payload.comment.author;
  if (author && author.isOwnAccount) return true;
  const direction = payload.message && payload.message.direction;
  if (direction && direction !== "incoming") return true;
  return false;
}

function buildTriggerPreview(payload, rawBody) {
  return {
    platform: (payload.account && payload.account.platform) || null,
    preview: rawBody.length > 220 ? rawBody.slice(0, 220) + "…" : rawBody,
  };
}

function extractAccountId(payload) {
  return (payload.account && (payload.account.id || payload.account.accountId)) || null;
}

function extractMessageContext(payload) {
  const conversationId = payload.message && payload.message.conversationId;
  const accountId = extractAccountId(payload);
  return conversationId && accountId ? { conversationId, accountId } : null;
}

function extractCommentContext(payload) {
  const postId =
    (payload.comment && payload.comment.platformPostId) || (payload.post && payload.post.platformPostId) || null;
  const accountId = extractAccountId(payload);
  return postId && accountId ? { postId, accountId } : null;
}

async function handleUnifiedEvent(env, rawBody, payload, receivedAt) {
  const eventId = payload.id;
  const eventType = payload.event;
  const startedAt = isoNow();
  const trigger = buildTriggerPreview(payload, rawBody);
  const apiKey = (env.ZERNIO_API_KEY || WORKER_ZERNIO_API_KEY || '').trim();

  try {
    if (isSelfEcho(payload)) {
      const finishedAt = isoNow();
      await logActivity(env, {
        eventId,
        event: eventType,
        trigger,
        timing: { receivedAt, startedAt, finishedAt, durationMs: new Date(finishedAt) - new Date(startedAt) },
        outcome: "skipped-self-echo",
      });
      return;
    }

    if (eventType !== "message.received" && eventType !== "comment.received") {
      const finishedAt = isoNow();
      await logActivity(env, {
        eventId,
        event: eventType,
        trigger,
        timing: { receivedAt, startedAt, finishedAt, durationMs: new Date(finishedAt) - new Date(startedAt) },
        outcome: "skipped-unsupported-event",
      });
      return;
    }

    let rawEventText = rawBody;
    let contextFetched = null;

    // فحص الملاحظات الصوتية
    const audioAttachment = (payload.message?.attachments || []).find(a => a.type === 'audio' || a.originalType === 'audio');
    if (audioAttachment && audioAttachment.url) {
      rawEventText += `\n\n[ملاحظة صوتية واردة من العميل]: مرفق ملف صوتي في الرابط: ${audioAttachment.url}`;
    }

    if (eventType === "message.received") {
      const ids = extractMessageContext(payload);
      // جلب السياق فقط لمنصات Zernio
      if (ids && payload.account?.platform !== "telegram" && payload.account?.platform !== "gmail") {
        CALL_HANDLERS.typingIndicator(env, ids).catch(() => {});
        const history = await CALL_HANDLERS.listMessages(env, { ...ids, limit: AUTO_CONTEXT_LIMIT, sortOrder: "desc" });
        contextFetched = { type: "messages", ids, ok: history.ok, status: history.status, data: history.data };
        rawEventText += `\n\nسياق آخر الرسائل:\n${JSON.stringify(history.data).slice(0, 2500)}`;
      }
    } else if (eventType === "comment.received") {
      const ids = extractCommentContext(payload);
      if (ids) {
        const history = await CALL_HANDLERS.listComments(env, { ...ids, limit: AUTO_CONTEXT_LIMIT });
        contextFetched = { type: "comments", ids, ok: history.ok, status: history.status, data: history.data };
        rawEventText += `\n\nسياق تعليقات البوست:\n${JSON.stringify(history.data).slice(0, 2500)}`;
      }
    }

    const trace = await runAgentLoop(env, rawEventText, eventId);

    const finishedAt = isoNow();
    const entry = {
      eventId,
      event: eventType,
      trigger,
      timing: { receivedAt, startedAt, finishedAt, durationMs: new Date(finishedAt) - new Date(startedAt) },
      contextFetched,
      outcome: trace.stopReason,
      finalText: trace.finalText,
      error: trace.error,
      routerAttempts: trace.routerAttempts,
      steps: trace.steps,
    };

    await logActivity(env, entry);

    if (entry.outcome === "error" || entry.outcome === "max-steps") {
      await kvSetJSON(
        env,
        `review:${eventId}`,
        { eventId, event: eventType, outcome: entry.outcome, error: entry.error, finalText: entry.finalText, ts: finishedAt },
        LOG_TTL_SECONDS
      );
      throw new Error(`retry-requested:${entry.outcome}`);
    }
  } catch (err) {
    const finishedAt = isoNow();
    const errMsg = redactSecret(String((err && err.message) || err), apiKey);
    if (!errMsg.startsWith("retry-requested:")) {
      await logActivity(env, {
        eventId,
        event: eventType,
        trigger,
        timing: { receivedAt, startedAt, finishedAt, durationMs: new Date(finishedAt) - new Date(startedAt) },
        outcome: "internal-error",
        error: errMsg,
      });
      await kvSetJSON(
        env,
        `review:${eventId}`,
        { eventId, event: eventType, outcome: "internal-error", error: errMsg, ts: finishedAt },
        LOG_TTL_SECONDS
      );
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// 8) مسارات الـ API الشاملة
// -----------------------------------------------------------------------------

async function handleApiRequests(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const API_KEY = (env.ZERNIO_API_KEY || WORKER_ZERNIO_API_KEY || '').trim();
  const PROFILE_ID = (env.ZERNIO_PROFILE_ID || WORKER_ZERNIO_PROFILE_ID || '').trim();

  // 1. إحصائيات Zernio الرسمية
  if (method === 'GET' && path === '/api/analytics') {
    const today = new Date().toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const fromDate = url.searchParams.get('fromDate') || thirtyDaysAgo;
    const toDate = url.searchParams.get('toDate') || today;
    const platform = url.searchParams.get('platform') || '';

    const qs = new URLSearchParams({ fromDate, toDate, profileId: PROFILE_ID });
    if (platform) qs.set('platform', platform);

    const zernioRes = await zernioFetch(env, `/analytics/inbox/volume?${qs}`);
    return jsonResponse(zernioRes.data, zernioRes.status);
  }

  // 2. الحسابات المتصلة وفصل الحساب
  if (method === 'GET' && path === '/api/accounts') {
    const zernioRes = await zernioFetch(env, `/accounts?profileId=${PROFILE_ID}`);
    return jsonResponse(zernioRes.data, zernioRes.status);
  }

  if (method === 'DELETE' && path.startsWith('/api/accounts/')) {
    const accountId = path.split('/api/accounts/')[1];
    if (!accountId) return jsonResponse({ error: 'accountId مطلوب' }, 400);

    const zernioRes = await zernioFetch(env, `/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    if (zernioRes.ok || zernioRes.status === 404) return jsonResponse({ ok: true, message: 'تم فصل الحساب بنجاح من Zernio' });
    return jsonResponse({ ok: false, error: zernioRes.data?.error || 'فشل فصل الحساب' }, zernioRes.status);
  }

  // 3. الفرمتة الشاملة المحمية بمفتاح الآدمن
  if (method === 'POST' && path === '/api/admin/factory-reset') {
    const body = await request.json().catch(() => ({}));
    const providedKey = request.headers.get("X-Admin-Key") || body.adminKey || url.searchParams.get("key");
    const validKey = env.STATUS_KEY || env.ADMIN_KEY || DEFAULT_ADMIN_KEY;

    if (providedKey !== validKey) {
      return jsonResponse({ error: "غير مصرح: مفتاح الآدمن (Admin Key) غير صحيح أو مفقود." }, 401);
    }

    const disconnectedAccounts = [];
    try {
      const accRes = await zernioFetch(env, `/accounts?profileId=${PROFILE_ID}`);
      const accounts = Array.isArray(accRes.data) ? accRes.data : (accRes.data?.accounts || []);
      for (const acc of accounts) {
        const id = acc.id || acc._id;
        if (id) {
          await zernioFetch(env, `/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
          disconnectedAccounts.push({ id, name: acc.name || acc.username || acc.platform });
        }
      }
    } catch (e) {}

    let deletedKeysCount = 0;
    if (env.ZERNIO_KV) {
      try {
        let cursor = undefined;
        do {
          const listRes = await env.ZERNIO_KV.list({ limit: 1000, cursor });
          for (const k of listRes.keys) {
            await env.ZERNIO_KV.delete(k.name);
            deletedKeysCount++;
          }
          cursor = listRes.cursor;
        } while (cursor);
      } catch (kvErr) {}
    }

    return jsonResponse({
      ok: true,
      message: "تمت فرمتة السيرفر وحذف جميع الحسابات وبيانات الـ KV بالكامل.",
      deletedAccountsCount: disconnectedAccounts.length,
      deletedKvKeysCount: deletedKeysCount,
      resetAt: isoNow()
    });
  }

  // 4. ضبط توكن تليجرام المباشر ورابط سكريبت جيميل
  if (method === 'POST' && path === '/api/telegram/set-token') {
    const body = await request.json().catch(() => ({}));
    if (!body.token) return jsonResponse({ error: "حقل token مفقود" }, 400);
    if (env.ZERNIO_KV) await env.ZERNIO_KV.put("telegram_bot_token", body.token.trim());
    return jsonResponse({ ok: true, message: "تم حفظ رمز بوت تليجرام بنجاح" });
  }

  if (method === 'POST' && path === '/api/gmail/set-script-url') {
    const body = await request.json().catch(() => ({}));
    if (!body.url) return jsonResponse({ error: "حقل url مفقود" }, 400);
    if (env.ZERNIO_KV) await env.ZERNIO_KV.put("gmail_script_url", body.url.trim());
    return jsonResponse({ ok: true, message: "تم حفظ رابط سكريبت جيميل بنجاح" });
  }

  // 5. مسارات OAuth فيسبوك وإنستغرام وتيك توك
  if (method === 'GET' && path === '/api/auth/facebook') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook?profileId=${PROFILE_ID}&headless=true&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'GET' && path === '/api/auth/facebook/pages') {
    const tempToken = url.searchParams.get('tempToken');
    const connectToken = url.searchParams.get('connect_token') || request.headers.get('x-connect-token') || '';
    if (!tempToken) return jsonResponse({ error: 'tempToken مطلوب' }, 400);
    const headers = { Authorization: `Bearer ${API_KEY}` };
    if (connectToken) headers['X-Connect-Token'] = connectToken;
    const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook/select-page?profileId=${PROFILE_ID}&tempToken=${encodeURIComponent(tempToken)}`;
    const res = await fetch(zernioUrl, { headers });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'POST' && path === '/api/auth/facebook/select') {
    const body = await request.json().catch(() => ({}));
    body.profileId = PROFILE_ID;
    const connectToken = body.connect_token || request.headers.get('x-connect-token') || '';
    const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
    if (connectToken) headers['X-Connect-Token'] = connectToken;
    const res = await fetch(`${ZERNIO_API_BASE}/connect/facebook/select-page`, { method: 'POST', headers, body: JSON.stringify(body) });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'GET' && path === '/api/auth/instagram') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'GET' && path === '/api/auth/instagram/accounts') {
    const tempToken = url.searchParams.get('tempToken');
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram/select-account?profileId=${PROFILE_ID}&tempToken=${tempToken}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'POST' && path === '/api/auth/instagram/select') {
    const body = await request.json().catch(() => ({}));
    body.profileId = PROFILE_ID;
    const res = await fetch(`${ZERNIO_API_BASE}/connect/instagram/select-account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'GET' && path === '/api/auth/tiktok') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/tiktok?profileId=${PROFILE_ID}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 6. البرومبت والملفات الذكية
  if (method === 'POST' && path === '/api/set-prompt') {
    const body = await request.json().catch(() => ({}));
    if (!body.prompt) return jsonResponse({ error: 'حقل prompt مفقود' }, 400);
    if (env.ZERNIO_KV) await env.ZERNIO_KV.put('custom_agent_prompt', body.prompt);
    return jsonResponse({ ok: true, message: 'تم حفظ البرومبت بنجاح' });
  }

  if (method === 'GET' && path === '/api/get-prompt') {
    const prompt = env.ZERNIO_KV ? await env.ZERNIO_KV.get('custom_agent_prompt') : null;
    return jsonResponse({ ok: true, prompt: prompt || 'البرومبت الافتراضي نشط' });
  }

  if (method === 'POST' && (path === '/api/upload-file' || path === '/api/upload-rag-doc')) {
    const body = await request.json().catch(() => ({}));
    const { name, size, textContent } = body;
    if (!textContent) return jsonResponse({ error: 'محتوى الملف مفقود' }, 400);

    const structuredKnowledge = await synthesizeStoreKnowledge(env, textContent, name || "مستند المتجر");
    if (env.ZERNIO_KV) {
      await env.ZERNIO_KV.put('store_files_content', structuredKnowledge);
      await env.ZERNIO_KV.put('store_files_meta', JSON.stringify({ name, size, updatedAt: isoNow() }));
    }
    return jsonResponse({
      ok: true,
      message: `تم تحليل وفهم محتوى ملف (${name}) ودمجه بنجاح!`,
      synthesizedPreview: structuredKnowledge.slice(0, 300)
    });
  }

  if (method === 'POST' && (path === '/api/delete-file' || path === '/api/delete-rag-doc')) {
    if (env.ZERNIO_KV) {
      await env.ZERNIO_KV.delete('store_files_content');
      await env.ZERNIO_KV.delete('store_files_meta');
    }
    return jsonResponse({ ok: true, message: 'تم مسح ملفات المتجر وقاعدة المعرفة بنجاح' });
  }

  // 7. الـ CRM
  if (method === 'POST' && path === '/api/set-crm-schema') {
    const body = await request.json().catch(() => ({}));
    const schema = body.schema || '';
    if (env.ZERNIO_KV) await env.ZERNIO_KV.put('crm_custom_schema', schema);
    return jsonResponse({ ok: true, message: 'تم تحديث أعمدة الـ CRM بنجاح' });
  }

  if (method === 'GET' && path === '/api/get-crm-schema') {
    const schema = env.ZERNIO_KV ? await env.ZERNIO_KV.get('crm_custom_schema') : null;
    return jsonResponse({ ok: true, schema: schema || 'الاسم، رقم الهاتف، العنوان، المنتج المطلوب' });
  }

  if (method === 'GET' && path === '/api/crm/leads') {
    if (!env.ZERNIO_KV) return jsonResponse({ ok: true, count: 0, leads: [] });
    try {
      const listRes = await env.ZERNIO_KV.list({ prefix: "crm_lead:", limit: 1000 });
      const leads = (await Promise.all(listRes.keys.map((k) => kvGetJSON(env, k.name)))).filter(Boolean);
      leads.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      return jsonResponse({ ok: true, count: leads.length, leads });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  if (method === 'POST' && path === '/api/crm/clear-leads') {
    if (env.ZERNIO_KV) {
      const listRes = await env.ZERNIO_KV.list({ prefix: "crm_lead:", limit: 1000 });
      for (const k of listRes.keys) await env.ZERNIO_KV.delete(k.name);
    }
    return jsonResponse({ ok: true, message: 'تم تفريغ سجلات الـ CRM بنجاح' });
  }

  // 8. نظرة عامة وسجلات التدفق
  if (method === 'GET' && path === '/api/admin/overview') {
    const prompt = env.ZERNIO_KV ? await env.ZERNIO_KV.get('custom_agent_prompt') : null;
    const filesMeta = env.ZERNIO_KV ? await env.ZERNIO_KV.get('store_files_meta') : null;
    const filesContent = env.ZERNIO_KV ? await env.ZERNIO_KV.get('store_files_content') : null;
    const crmSchema = env.ZERNIO_KV ? await env.ZERNIO_KV.get('crm_custom_schema') : null;

    return jsonResponse({
      ok: true,
      service: "Bedaya Enterprise Agent Engine v25.0",
      model: AI_ROUTER_MODEL,
      prompt: prompt || 'البرومبت الافتراضي نشط',
      crmSchema: crmSchema || 'افتراضي',
      files: {
        active: !!filesContent,
        meta: filesMeta ? JSON.parse(filesMeta) : null,
        preview: filesContent ? filesContent.slice(0, 400) : null
      }
    });
  }

  if (method === 'GET' && path === '/api/audit-logs') {
    const logs = await listRecentLogs(env, { limit: 50 });
    return jsonResponse({ ok: true, count: logs.length, logs });
  }

  // 9. اختبار الشات
  if (method === 'POST' && path === '/api/test-chat') {
    const body = await request.json().catch(() => ({}));
    const userMessage = body.message || 'مرحباً، ما هي الخدمات والأسعار المتاحة؟';
    const fakeEventText = JSON.stringify({
      event: "message.received",
      account: { id: "test_account", platform: "instagram" },
      message: { id: "sim_msg", conversationId: "sim_conv", text: userMessage }
    });

    try {
      const result = await runAgentLoop(env, fakeEventText, `test_${Date.now()}`);
      const lastCall = result.steps?.find(s => s.type === 'call')?.calls?.[0];
      return jsonResponse({
        ok: true,
        generatedReply: lastCall?.args?.message || result.finalText || (lastCall?.name === 'ignoreMessage' ? 'تم تجاهل الرسالة (Spam Detected)' : 'تم تنفيذ الأداة بنجاح'),
        executedTool: lastCall?.name || 'none',
        toolArgs: lastCall?.args || {},
        steps: result.steps
      });
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  return jsonResponse({ error: 'Endpoint not found' }, 404);
}

// -----------------------------------------------------------------------------
// 9) استقبال الـ Webhooks (Zernio, Telegram, Gmail) وإيداعها في الطابور
// -----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApiRequests(request, env, url);
      }

      // أ) ويب هوك Zernio (Meta & TikTok)
      if (request.method === "POST" && url.pathname === "/webhook/zernio") {
        const receivedAt = isoNow();
        const rawBody = await request.text();
        const signature = request.headers.get("X-Zernio-Signature");

        if (signature && env.ZERNIO_WEBHOOK_SECRET) {
          const computed = await hmacSha256Hex(env.ZERNIO_WEBHOOK_SECRET, rawBody);
          if (!safeEqualHex(computed, signature)) return textResponse("Invalid signature", 400);
        }

        let payload;
        try { payload = JSON.parse(rawBody); } catch (_) { return textResponse("Invalid JSON", 400); }

        if (env.EVENTS_QUEUE) await env.EVENTS_QUEUE.send({ rawBody, payload, receivedAt });
        return jsonResponse({ ok: true, queued: true });
      }

      // ب) ويب هوك Telegram المباشر (تليجرام فقط)
      if (request.method === "POST" && url.pathname === "/webhook/telegram") {
        const receivedAt = isoNow();
        const rawBody = await request.text();
        let update;
        try { update = JSON.parse(rawBody); } catch (_) { return textResponse("Invalid JSON", 400); }

        const msg = update.message || update.edited_message;
        if (msg && msg.chat) {
          // تحويل حدث تليجرام لنفس الصيغة الموحدة message.received
          const payload = {
            id: `tg_${msg.message_id}`,
            event: "message.received",
            account: { id: "telegram_bot", platform: "telegram" },
            message: {
              id: String(msg.message_id),
              conversationId: String(msg.chat.id),
              text: msg.text || msg.caption || "",
              sender: { id: String(msg.from?.id), name: msg.from?.first_name || msg.from?.username || "Telegram User" }
            }
          };

          if (env.EVENTS_QUEUE) await env.EVENTS_QUEUE.send({ rawBody: JSON.stringify(payload), payload, receivedAt });
        }
        return jsonResponse({ ok: true, queued: true });
      }

      // ج) ويب هوك Gmail المباشر (من Google Apps Script)
      if (request.method === "POST" && url.pathname === "/webhook/gmail") {
        const receivedAt = isoNow();
        const rawBody = await request.text();
        let data;
        try { data = JSON.parse(rawBody); } catch (_) { return textResponse("Invalid JSON", 400); }

        // تحويل إيميل جيميل لنفس الصيغة الموحدة message.received
        const payload = {
          id: `gmail_${data.messageId || shortId()}`,
          event: "message.received",
          account: { id: "gmail_inbox", platform: "gmail" },
          message: {
            id: data.messageId || shortId(),
            conversationId: data.threadId || data.fromEmail,
            text: `[موضوع الإيميل: ${data.subject || 'بدون عنوان'}]\n\n${data.body || ''}`,
            sender: { id: data.fromEmail, name: data.fromName || data.fromEmail },
            metadata: {
              subject: data.subject,
              fromEmail: data.fromEmail,
              threadId: data.threadId,
              appsScriptCallbackUrl: data.appsScriptCallbackUrl
            }
          }
        };

        if (env.EVENTS_QUEUE) await env.EVENTS_QUEUE.send({ rawBody: JSON.stringify(payload), payload, receivedAt });
        return jsonResponse({ ok: true, queued: true });
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return await handleHealth(request, env);
      }

      if (request.method === "GET" && url.pathname === "/health/review") {
        return await handleReviewQueue(request, env);
      }

      if (request.method === "GET" && url.pathname === "/dashboard") {
        return await handleDashboard(request, env);
      }

      return textResponse("Not found", 404);
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },

  // مستهلك الطوابير
  async queue(batch, env) {
    if (batch.queue && batch.queue.endsWith("-dlq")) {
      for (const message of batch.messages) {
        const { rawBody, payload, receivedAt } = message.body || {};
        try {
          await handleUnifiedEvent(env, rawBody, payload, receivedAt);
          message.ack();
        } catch (dlqErr) {
          if (payload?.id) {
            await kvSetJSON(env, `review:${payload.id}`, {
              eventId: payload.id,
              event: payload.event || "unknown",
              outcome: "dlq-final-review",
              error: dlqErr.message,
              ts: isoNow()
            }, LOG_TTL_SECONDS);
          }
          message.ack();
        }
      }
      return;
    }

    for (const message of batch.messages) {
      const { rawBody, payload, receivedAt } = message.body || {};
      try {
        await handleUnifiedEvent(env, rawBody, payload, receivedAt);
        message.ack();
      } catch (err) {
        const attempt = message.attempts || 1;
        const delaySeconds = Math.min(20 * Math.pow(2, attempt - 1), 1800);
        message.retry({ delaySeconds });
      }
    }
  },
};

// -----------------------------------------------------------------------------
// 10) لوحة المتابعة المسطحة والـ Health
// -----------------------------------------------------------------------------

async function handleHealth(request, env) {
  const url = new URL(request.url);
  if (env.STATUS_KEY && url.searchParams.get("key") !== env.STATUS_KEY) {
    return jsonResponse({ ok: false, error: "Unauthorized." }, 401);
  }

  const apiKey = (env.ZERNIO_API_KEY || WORKER_ZERNIO_API_KEY || '').trim();
  const secrets = {
    ZERNIO_API_KEY: !!apiKey,
    ZERNIO_WEBHOOK_SECRET: !!env.ZERNIO_WEBHOOK_SECRET,
    AI_ROUTER_API_KEY: !!(env.AI_ROUTER_API_KEY || env.GEMINI_API_KEY),
  };

  let zernioRest = { connected: false };
  try {
    const res = await fetch(`${ZERNIO_API_BASE}/accounts?profileId=${env.ZERNIO_PROFILE_ID || WORKER_ZERNIO_PROFILE_ID}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const data = await res.json();
      zernioRest = { connected: true, accountCount: ((data && data.accounts) || (Array.isArray(data) ? data : [])).length };
    }
  } catch (err) {}

  const eventId = url.searchParams.get("eventId");
  const since = computeSinceDate(url);
  const logs = await listRecentLogs(env, { eventId, since });

  return jsonResponse({ ok: true, secrets, zernioRest, tools: buildToolsManifest(), logs });
}

async function handleReviewQueue(request, env) {
  const url = new URL(request.url);
  if (env.STATUS_KEY && url.searchParams.get("key") !== env.STATUS_KEY) {
    return jsonResponse({ ok: false, error: "Unauthorized." }, 401);
  }

  const resolveId = url.searchParams.get("resolve");
  if (resolveId && env.ZERNIO_KV) {
    await env.ZERNIO_KV.delete(`review:${resolveId}`).catch(() => {});
    return jsonResponse({ ok: true, resolved: resolveId });
  }

  try {
    const listRes = await env.ZERNIO_KV.list({ prefix: "review:", limit: 1000 });
    const items = (await Promise.all(listRes.keys.map((k) => kvGetJSON(env, k.name)))).filter(Boolean);
    items.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
    return jsonResponse({ ok: true, pendingCount: items.length, items });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

async function handleDashboard(request, env) {
  const url = new URL(request.url);
  if (env.STATUS_KEY && url.searchParams.get("key") !== env.STATUS_KEY) {
    return textResponse("Unauthorized.", 401);
  }
  const keyQs = env.STATUS_KEY ? `?key=${encodeURIComponent(url.searchParams.get("key"))}` : "";

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>بِـدَايَــةٌ | غرفة المراقبة السحابية (Live Monitor)</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-page: #f5f5f5;
    --bg-card: #ffffff;
    --text-pri: #010101;
    --text-sec: #555555;
    --text-muted: #8e8e93;
    --border-color: #e5e5e5;
    --green-bg: #ebfcd2;
    --green-text: #013330;
    --green-border: #b4f0a0;
    --red-bg: #fef2f2;
    --red-text: #dc2626;
    --radius-workspace: 18px;
    --radius-sm: 6px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Readex Pro', sans-serif !important; box-shadow: none !important; -webkit-box-shadow: none !important; }
  body { background-color: var(--bg-page); color: var(--text-pri); min-height: 100vh; padding: 0 6px 6px 6px; display: flex; flex-direction: column; align-items: center; }
  .top-centered-brand { width: 100%; padding: 24px 0 16px 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; }
  .logo-box-center { width: 50px; height: 50px; display: flex; align-items: center; justify-content: center; }
  .logo-box-center svg { width: 100%; height: 100%; }
  .workspace-container { width: 100%; max-width: 1050px; flex: 1; background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-workspace); padding: 20px 22px; display: flex; flex-direction: column; gap: 16px; margin-bottom: 2px; }
  .status-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding-bottom: 14px; border-bottom: 1px solid var(--border-color); }
  .pills-group { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { background-color: #f5f5f5; border: 1px solid var(--border-color); border-radius: 50px; padding: 5px 12px; font-size: 0.76rem; font-weight: 600; color: var(--text-sec); display: inline-flex; align-items: center; gap: 6px; }
  .pill-ok { background-color: var(--green-bg); color: var(--green-text); border-color: var(--green-border); }
  .stream-section { display: flex; flex-direction: column; gap: 12px; }
  .stream-header { display: flex; align-items: center; justify-content: space-between; font-size: 0.88rem; font-weight: 700; color: var(--text-pri); }
  .logs-list { display: flex; flex-direction: column; gap: 8px; }
  .log-row { background-color: #ffffff; border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
  .log-row-top { display: flex; align-items: center; justify-content: space-between; font-size: 0.78rem; }
  .event-label { font-weight: 700; color: var(--text-pri); }
  .badge-outcome { padding: 2px 8px; border-radius: var(--radius-sm); font-size: 0.7rem; font-weight: 700; }
  .badge-final { background-color: var(--green-bg); color: var(--green-text); }
  .badge-err { background-color: var(--red-bg); color: var(--red-text); }
  .badge-skip { background-color: #f5f5f5; color: var(--text-muted); }
  .log-body-text { font-size: 0.82rem; color: var(--text-sec); line-height: 1.55; background-color: #fafafa; border: 1px solid #f0f0f0; padding: 8px 10px; border-radius: var(--radius-sm); }
</style>
</head>
<body>
  <header class="top-centered-brand">
    <div class="logo-box-center">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 95">
        <path d="m88.7 8.6c-4.5-4.1-9.7-6.6-17.1-7.5h-41.1c-6.5 0-12.5 1.6-17.3 5.5s-11.1 10.3-11.1 21.4v25.3c0 9.7 4.9 18.7 13.4 24.7l-3.1 12.3c-0.5 2.5 2.1 4.4 4.2 3.2l19.7-10.2h32.7c13.9 0 29-11.9 29-29.6v-25.5c-0.2-7.2-3.6-14.7-9.3-19.6zm4.1 44.2c0 13.1-9.8 24.9-24.4 24.9h-32.8c-0.5 0-0.9 0.2-1.3 0.4l-15.1 7.9 2.2-8.1c0.4-1.7-0.4-2.9-1.3-3.4-2.4-1.2-4.3-2.9-6.1-4.8-3.6-4.1-6-9.8-6.8-16.4v-24.7c0-11.7 10.4-22.1 21.4-22.1h42.5c10.6 0 21.7 9 21.7 22.3z" fill="#010101" stroke="#010101" stroke-width="2.7" stroke-linejoin="round" stroke-linecap="round"/>
        <path d="m67.7 51c-1.1 1.1-7.3 5.9-16.7 6.3s-15.9-4.4-17.8-6c-1.3-1.3-3-1.5-4.3-0.3-1.1 1.1-1.3 3.1 0.4 4.2 4.5 3.5 10.5 7.2 20.6 7.2 7.3 0 13.8-2.2 18.2-5.1 3.3-2.3 4-2.8 4-4.4 0-1.9-2.1-3.5-4.2-2.1z" fill="#010101" stroke="#010101" stroke-width="2.0" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
    </div>
  </header>

  <main class="workspace-container">
    <section class="status-bar">
      <div class="pills-group" id="stats-pills"></div>
      <div id="live-clock" style="font-size:0.74rem; color:var(--text-muted); font-weight:600;">جاري التحميل...</div>
    </section>

    <section class="stream-section">
      <div class="stream-header">
        <span>سجل الرسائل والأحداث الواردة (Live Event Stream)</span>
        <span id="events-count" style="font-size:0.75rem; color:var(--text-muted);">سجل 7 أيام</span>
      </div>
      <div class="logs-list" id="logs-container"></div>
    </section>
  </main>

  <script>
  async function refresh() {
    try {
      const res = await fetch('/health${keyQs}');
      const data = await res.json();
      document.getElementById('live-clock').textContent = 'آخر تحديث: ' + new Date().toLocaleTimeString('ar-EG');
      const zc = data.zernioRest && data.zernioRest.connected;
      document.getElementById('stats-pills').innerHTML =
        '<span class="pill ' + (zc ? 'pill-ok' : 'pill-err') + '">Zernio: ' + (zc ? '🟢 متصل' : '🔴 غير متصل') + '</span>' +
        '<span class="pill">الحسابات: ' + ((data.zernioRest && data.zernioRest.accountCount) || 0) + '</span>' +
        '<span class="pill">طابور المعالجة: نشط</span>' +
        '<span class="pill">مدة السجل: 7 أيام</span>';

      const logsEl = document.getElementById('logs-container');
      const items = data.logs || [];
      document.getElementById('events-count').textContent = items.length + ' حدث مسجل';
      logsEl.innerHTML = items.map(function(e) {
        const outcome = e.outcome || '';
        let badgeClass = 'badge-skip';
        if (outcome === 'final') badgeClass = 'badge-final';
        else if (outcome === 'error' || outcome === 'max-steps') badgeClass = 'badge-err';

        return '<div class="log-row">' +
          '<div class="log-row-top">' +
            '<span class="event-label">' + esc(e.event || '') + ' — ' + esc(e.eventId || '') + '</span>' +
            '<span class="badge-outcome ' + badgeClass + '">' + esc(outcome) + '</span>' +
          '</div>' +
          '<div style="font-size:0.74rem; color:var(--text-muted);">' + esc((e.timing && e.timing.receivedAt) || '') + (e.timing && typeof e.timing.durationMs === 'number' ? ' • ' + e.timing.durationMs + 'ms' : '') + '</div>' +
          (e.finalText ? '<div class="log-body-text">' + esc(e.finalText) + '</div>' : '') +
          (e.error ? '<div class="log-body-text" style="color:#dc2626;">' + esc(e.error) + '</div>' : '') +
        '</div>';
      }).join('') || '<div style="text-align:center; padding:16px; color:var(--text-muted);">لا توجد أحداث مسجلة بعد</div>';
    } catch (err) {
      document.getElementById('live-clock').textContent = 'فشل المزامنة: ' + err.message;
    }
  }
  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  refresh();
  setInterval(refresh, 5000);
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
