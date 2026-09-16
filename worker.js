// =============================================================================
// Bedaya Enterprise Social Inbox Agent (v25.0: Production Master Engine)
// المعمارية السحابية الموحدة: AI Router + Cloudflare Queues + Warm Grey Dashboard
// =============================================================================

const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";
const DEFAULT_ADMIN_KEY = "bedaya_admin_2026"; // مفتاح الآدمن الافتراضي للفرمتة

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const AI_ROUTER_BASE = "https://ai.nckalo018.workers.dev/v1";
const AI_ROUTER_MODEL = "auto";

// الثوابت التشغيلية المعتمدة
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // حفظ السجلات لمدة 7 أيام كاملة
const AUDIT_LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 أيام
const LOG_LIST_LIMIT = 50;

const MAX_AGENT_STEPS = 10;
const CALL_TIMEOUT_MS = 15000;
const AI_CALL_TIMEOUT_MS = 30000;
const AI_ROUTER_MAX_TOKENS = 1024;
const AUTO_CONTEXT_LIMIT = 10; // 10 رسائل سياق لسرعة الاستجابة

// إعدادات الـ CORS الشاملة
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zernio-key, x-connect-token, X-Connect-Token, X-Admin-Key',
};

// -----------------------------------------------------------------------------
// 1) دوال مساعدة عامة وتشفير
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
    console.error("kvGetJSON failed", key, err);
    return null;
  }
}

async function kvSetJSON(env, key, value, ttlSeconds) {
  try {
    await env.ZERNIO_KV.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  } catch (err) {
    console.error("kvSetJSON failed", key, err);
  }
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
    console.error("listRecentLogs failed", err);
    return [];
  }
}

function redactSecret(text, secret) {
  if (!secret || typeof text !== "string") return text;
  return text.split(secret).join("[REDACTED]");
}

// -----------------------------------------------------------------------------
// 2) قاطع الدائرة الذكي وعدادات التوكنات (Circuit Breaker & Telemetry)
// -----------------------------------------------------------------------------

async function checkCircuitBreaker(env) {
  if (!env.ZERNIO_KV) return false;
  const trippedUntil = await env.ZERNIO_KV.get("circuit_breaker_until");
  if (trippedUntil && Date.now() < parseInt(trippedUntil, 10)) {
    return true; // القاطع مفعل لحماية السيرفر
  }
  return false;
}

async function reportRouterFailure(env) {
  if (!env.ZERNIO_KV) return;
  const currentFailures = parseInt(await env.ZERNIO_KV.get("router_consecutive_failures") || "0", 10) + 1;
  if (currentFailures >= 3) {
    await env.ZERNIO_KV.put("circuit_breaker_until", String(Date.now() + 60000), { expirationTtl: 120 });
    await env.ZERNIO_KV.put("router_consecutive_failures", "0", { expirationTtl: 120 });
  } else {
    await env.ZERNIO_KV.put("router_consecutive_failures", String(currentFailures), { expirationTtl: 120 });
  }
}

async function reportRouterSuccess(env, usage = null) {
  if (!env.ZERNIO_KV) return;
  await env.ZERNIO_KV.delete("router_consecutive_failures").catch(() => {});
  if (usage && usage.total_tokens) {
    const today = new Date().toISOString().split('T')[0];
    const key = `metrics:tokens:${today}`;
    const current = parseInt(await env.ZERNIO_KV.get(key) || "0", 10);
    await env.ZERNIO_KV.put(key, String(current + usage.total_tokens), { expirationTtl: 30 * 86400 });
  }
}

// -----------------------------------------------------------------------------
// 3) كتالوج أدوات الوكيل (Zernio Tools + Custom CRM + Spam Tool)
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
      setTimeout(() => reject(new Error(`انتهت مهلة نداء Zernio API (${CALL_TIMEOUT_MS / 1000}s): ${path}`)), CALL_TIMEOUT_MS)
    ),
  ]);
  const bodyText = await res.text();
  let data;
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch (_) {
    data = { raw: bodyText.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, data };
}

function missingArgsError(names) {
  return { ok: false, status: 0, data: { error: `الحقول المطلوبة مفقودة: ${names.join(", ")}` } };
}

const TOOL_DESCRIPTIONS = {
  listMessages: "جلب آخر رسائل محادثة DM (سياق)",
  sendMessage: "إرسال رسالة DM مباشرة للعميل",
  typingIndicator: "مؤشر الكتابة التلقائي",
  addReaction: "إضافة تفاعل Reaction على رسالة DM",
  removeReaction: "إزالة تفاعل Reaction من رسالة DM",
  listComments: "جلب تعليقات البوست (سياق)",
  replyToComment: "الرد على تعليق (فيسبوك، إنستغرام، تيك توك)",
  sendPrivateReply: "إرسال DM خاص لصاحب تعليق",
  deleteComment: "حذف تعليق",
  ignoreMessage: "تجاهل الرسالة تماماً بدون رد (في حالة السبام أو الإعلانات المزعجة أو الإساءة)",
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

  async sendMessage(env, args, idempotencyKey) {
    const { conversationId, accountId, message, attachmentUrl, attachmentType } = args || {};
    if (!conversationId || !accountId) return missingArgsError(["conversationId", "accountId"]);
    if (!message && !attachmentUrl) return missingArgsError(["message أو attachmentUrl"]);
    
    const body = { accountId };
    if (message) body.message = message; // يمرر النص كما هو بدون تنظيف
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
    const { conversationId, accountId } = args || {};
    if (!conversationId || !accountId) return missingArgsError(["conversationId", "accountId"]);
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
    const { postId, accountId, limit, cursor, subreddit, commentId } = args || {};
    if (!postId || !accountId) return missingArgsError(["postId (platformPostId)", "accountId"]);
    const qs = new URLSearchParams({ accountId });
    if (limit) qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);
    if (subreddit) qs.set("subreddit", subreddit);
    if (commentId) qs.set("commentId", commentId);
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
    const { postId, commentId, accountId, message, quickReplies, buttons } = args || {};
    if (!postId || !commentId || !accountId || !message) {
      return missingArgsError(["postId (platformPostId)", "commentId", "accountId", "message"]);
    }
    const body = { accountId, message };
    if (quickReplies) body.quickReplies = quickReplies;
    if (buttons) body.buttons = buttons;
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

  // أداة تجاهل السبام والمحادثات المزعجة
  async ignoreMessage(env, args) {
    const { reason = "spam", notes = "" } = args || {};
    return {
      ok: true,
      status: 200,
      data: { action: "ignored", reason, notes, message: "تم تجاهل المحادثة بنجاح." }
    };
  },

  // أداة حفظ بيانات الطلب والعميل في الـ CRM
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
  let customPrompt = "أنت وكيل ذكي بيرد على رسائل الـ Direct Messages وعلى التعليقات (فيسبوك، انستجرام، وتيك توك) باحترافية وسرعة.";
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
      crmSection = `\n=== أعمدة تسجيل بيانات العملاء (CRM Schema) ===\nعند اتفاق العميل على الشراء أو حجز موعد، استدعِ أداة saveToCrm بالحقول التالية:\n${crmSchema.trim()}\n`;
    }
  }

  
  return [
    "=== شخصية وتعليمات المتجر (أولوية قصوى) ===",
    customPrompt,
    filesSection,
    crmSection,
    "=== قواعد عمل نظام الوكيل الحاسمة (إلزامية 100%) ===",
    "أنت لست روبوت محادثة عادي (Chatbot)، بل أنت محرك تنفيذي لإدارة صندوق رسائل وتعليقات المتجر (Instagram, Facebook, TikTok).",
    "العميل لا يرى أي نص تكتبه إطلاقاً إلا إذا تم تمريره كمعامل داخل إحدى أدوات الإرسال المحددة أدناه.",
    "",
    "── طريقة وصيغة الرد الوحيدة المقبولة ──",
    "كل رد منك يجب أن يكون كائن JSON واحد فقط وبصيغة استدعاء الأدوات حصراً (action: call):",
    '{"action": "call", "calls": [{"name": "اسم_الأداة", "args": {...}}], "done": true}',
    "",
    "── ⚠️ تحذيرات حاسمة لمنع فشل الرد ──",
    '1. ممنوع منعاً باتاً استخدام {"action": "final", "text": "..."} لكتابة أي رد موجه للعميل. كتابة الرد داخل final تعتبر خطأ فادحاً ولن يرى العميل الرسالة نهائياً!',
    '2. للرد على العميل في المحادثات الخاصة (DMs): يجب حصراً استدعاء أداة "sendMessage".',
    '3. للرد على العميل في التعليقات (Comments): يجب حصراً استدعاء أداة "replyToComment".',
    '4. في حالة اكتشاف رسالة سبام أو إعلانات مزعجة أو احتيال أو إساءة: يجب استدعاء أداة "ignoreMessage" مع done:true فوراً لعدم الرد.',
    '5. عند إتمام اتفاق أو جمع بيانات الطلب (الاسم، الهاتف، العنوان): يجب استدعاء أداة "saveToCrm" لحفظها، واستدعاء أداة "sendMessage" في نفس الخطوة لتأكيد استلام الطلب للعميل.',
    "6. الحد الأقصى لطول نص الرسالة في (message) هو 300 حرف فقط لتفادي قيود المنصات الصارمة. ممنوع تكرار هذه التعليمات في الرد.",
    "",
    "── كتالوج الأدوات الـ 11 الكاملة المتاحة لك ──",
    "",
    "🔹 [أدوات الرسائل الخاصة DMs]:",
    '- sendMessage — args: { conversationId, accountId, message (نص عربي مباشر وودود < 300 حرف), attachmentUrl? } — إرسال رسالة مباشرة للعميل.',
    '- typingIndicator — args: { conversationId, accountId } — إظهار مؤشر جاري الكتابة للعميل.',
    '- addReaction — args: { conversationId, accountId, messageId, emoji } — إضافة تفاعل ريأكشن بإيموجي على رسالة العميل.',
    '- removeReaction — args: { conversationId, accountId, messageId } — إزالة ريأكشن سابق من رسالة معينة.',
    '- listMessages — args: { conversationId, accountId, limit?, sortOrder? } — جلب المزيد من سياق الرسائل السابقة للمحادثة.',
    "",
    "🔹 [أدوات التعليقات Comments]:",
    '- replyToComment — args: { postId (platformPostId!), accountId, message (< 200 حرف), attachmentUrl?, commentId? } — الرد العام على تعليق منشور أو فيديو.',
    '- sendPrivateReply — args: { postId (platformPostId!), commentId, accountId, message } — إرسال رسالة خاصة DM لصاحب التعليق (فيسبوك وإنستغرام).',
    '- listComments — args: { postId (platformPostId!), accountId, limit? } — جلب وقراءة تعليقات البوست أو الفيديو.',
    '- deleteComment — args: { postId (platformPostId!), accountId, commentId } — حذف تعليق مسيء أو غير لائق.',
    "",
    "🔹 [أدوات التحكم والبيانات المشتركة]:",
    '- ignoreMessage — args: { reason ("spam"|"offensive"|"bot"|"no_action_needed"), notes? } — تجاهل المحادثة تماماً بدون إرسال أي رد للعميل.',
    '- saveToCrm — args: { leadData: { ... } } — استخراج وتسجيل بيانات العميل والطلب في الـ CRM عند اتفاق الشراء.',
    "",
    "طريقة عملك:",
    "1. حدد نوع الحدث واستخرج الـ IDs الحقيقية بالظبط من البيانات الواردة.",
    "2. استدعِ الأداة المناسبة فوراً بصيغة action: 'call'، وضع دائماً done:true في استدعاء الرد لإنهاء المعالجة."
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
  const isTripped = await checkCircuitBreaker(env);
  if (isTripped) {
    throw new Error("قاطع الدائرة مفعل مؤقتاً لحماية السيرفر (Circuit Breaker Active - Cooldown 60s)");
  }

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
    await reportRouterFailure(env);
    const msg = `AI Router error: ${(err && err.message) || err}`;
    if (attemptsLog) attemptsLog.push({ provider: "ai-router", model: AI_ROUTER_MODEL, ok: false, note: msg });
    throw new Error(msg);
  }

  let data;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { data = { raw: bodyText.slice(0, 500) }; }

  if (!res.ok) {
    await reportRouterFailure(env);
    const errMsg = data && data.error && (data.error.message || data.error) ? data.error.message || JSON.stringify(data.error) : JSON.stringify(data).slice(0, 300);
    const msg = `AI Router HTTP ${res.status}: ${errMsg}`;
    if (attemptsLog) attemptsLog.push({ provider: "ai-router", model: AI_ROUTER_MODEL, status: res.status, ok: false, note: msg });
    throw new Error(msg);
  }

  await reportRouterSuccess(env, data.usage || null);

  if (attemptsLog) {
    attemptsLog.push({
      provider: "ai-router",
      model: AI_ROUTER_MODEL,
      status: res.status,
      ok: true,
      usage: data.usage || null,
      upstreamProvider: res.headers.get("X-AI-Router-Provider") || null,
      upstreamModel: res.headers.get("X-AI-Router-Model") || null,
    });
  }
  return extractRouterText(data);
}

// تحليل محتوى الملفات بالذكاء الاصطناعي واستخراج معرفة المتجر النظيفة
async function synthesizeStoreKnowledge(env, rawFileText, fileName) {
  const prompt = `أنت خبير استخراج وتلخيص المعرفة التجارية. اقرأ محتوى هذا الملف (${fileName}) واستخرج منه جميع المعلومات الهامة لخدمة العملاء (المنتجات، الأسعار، المواصفات، سياسات الشحن والضمان، والأسئلة الشائعة) في شكل قاعدة معرفة مرتبة وواضحة باللغة العربية.

محتوى الملف:
${rawFileText.slice(0, 15000)}

قاعدة المعرفة الملخصة:`;

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
    console.error("File synthesis fallback:", err);
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
// 7) معالجة الأحداث الواردة (Webhook Handler)
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

async function handleZernioEvent(env, rawBody, payload, receivedAt, isEmergencyRun = false) {
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

    // فحص الملاحظات الصوتية (Voice Notes)
    const audioAttachment = (payload.message?.attachments || []).find(a => a.type === 'audio' || a.originalType === 'audio');
    if (audioAttachment && audioAttachment.url) {
      rawEventText += `\n\n[ملاحظة صوتية واردة من العميل]: مرفق ملف صوتي في الرابط: ${audioAttachment.url}`;
    }

    if (eventType === "message.received") {
      const ids = extractMessageContext(payload);
      if (ids) {
        CALL_HANDLERS.typingIndicator(env, ids).catch(() => {});
        const history = await CALL_HANDLERS.listMessages(env, { ...ids, limit: AUTO_CONTEXT_LIMIT, sortOrder: "desc" });
        contextFetched = { type: "messages", ids, ok: history.ok, status: history.status, data: history.data };
        rawEventText += `\n\nسياق آخر الرسائل:\n${JSON.stringify(history.data).slice(0, 2500)}`;
      } else {
        contextFetched = { type: "messages", error: "extractMessageContext فشل في استخراج المعرفات" };
      }
    } else if (eventType === "comment.received") {
      const ids = extractCommentContext(payload);
      if (ids) {
        const history = await CALL_HANDLERS.listComments(env, { ...ids, limit: AUTO_CONTEXT_LIMIT });
        contextFetched = { type: "comments", ids, ok: history.ok, status: history.status, data: history.data };
        rawEventText += `\n\nسياق تعليقات البوست:\n${JSON.stringify(history.data).slice(0, 2500)}`;
      } else {
        contextFetched = { type: "comments", error: "extractCommentContext فشل في استخراج المعرفات" };
      }
    }

    if (isEmergencyRun) {
      rawEventText = `[معالجة طارئة لرسالة مستنفدة في الـ DLQ — إما أن تجيب العميل أو تستدعي ignoreMessage لإغلاقها]\n\n` + rawEventText;
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
    console.error("handleZernioEvent error", eventId, err);
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
// 8) مسارات الـ API (OAuth, Files, CRM, Analytics, Factory Reset)
// -----------------------------------------------------------------------------

async function handleApiRequests(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const API_KEY = (env.ZERNIO_API_KEY || WORKER_ZERNIO_API_KEY || '').trim();
  const PROFILE_ID = (env.ZERNIO_PROFILE_ID || WORKER_ZERNIO_PROFILE_ID || '').trim();

  // 1. إحصائيات Zernio الرسمية (Volume Analytics)
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

  // 2. جلب الحسابات المتصلة
  if (method === 'GET' && path === '/api/accounts') {
    const zernioRes = await zernioFetch(env, `/accounts?profileId=${PROFILE_ID}`);
    return jsonResponse(zernioRes.data, zernioRes.status);
  }

  // 3. فصل حساب محدد بالـ ID
  if (method === 'DELETE' && path.startsWith('/api/accounts/')) {
    const accountId = path.split('/api/accounts/')[1];
    if (!accountId) return jsonResponse({ error: 'accountId مطلوب' }, 400);

    const zernioRes = await zernioFetch(env, `/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    if (zernioRes.ok || zernioRes.status === 404) return jsonResponse({ ok: true, message: 'تم فصل الحساب بنجاح من Zernio' });
    return jsonResponse({ ok: false, error: zernioRes.data?.error || 'فشل فصل الحساب' }, zernioRes.status);
  }

  // 4. 🧹 الفرمتة الشاملة المحمية بمفتاح الآدمن (Admin Key Protected)
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
    } catch (e) {
      console.error("Factory reset accounts error:", e);
    }

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
      } catch (kvErr) {
        console.error("Factory reset KV error:", kvErr);
      }
    }

    return jsonResponse({
      ok: true,
      message: "تمت فرمتة السيرفر ومسح كافة الحسابات وبيانات الـ KV بالكامل.",
      deletedAccountsCount: disconnectedAccounts.length,
      disconnectedAccounts,
      deletedKvKeysCount: deletedKeysCount,
      resetAt: isoNow()
    });
  }

  // 5. تفويض فيسبوك
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

  // 6. تفويض إنستغرام
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

  // 7. تفويض TikTok
  if (method === 'GET' && path === '/api/auth/tiktok') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/tiktok?profileId=${PROFILE_ID}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 8. حفظ واسترجاع الـ System Prompt
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

  // 9. 📁 رفع وتحليل ملفات المتجر بالذكاء الاصطناعي (Store Files Synthesizer)
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
      message: `تم تحليل وفهم محتوى ملف (${name}) ودمجه في معرفة الوكيل بنجاح!`,
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

  // 10. 📊 إدارة واسترجاع سجلات الـ CRM
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
      for (const k of listRes.keys) {
        await env.ZERNIO_KV.delete(k.name);
      }
    }
    return jsonResponse({ ok: true, message: 'تم تفريغ كافة سجلات الـ CRM بنجاح' });
  }

  // 11. نظرة عامة للأدمن
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

  // 12. سجل تتبع الـ 7 أيام
  if (method === 'GET' && path === '/api/audit-logs') {
    const logs = await listRecentLogs(env, { limit: 50 });
    return jsonResponse({ ok: true, count: logs.length, logs });
  }

  // 13. اختبار الشات والمحاكاة المباشرة
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
// 9) واجهة فحص المسار الفردي /dashboard/trace/:id (BreeAra Warm Grey UI)
// -----------------------------------------------------------------------------

async function handleTraceView(request, env, traceId) {
  const logData = await kvGetJSON(env, `audit_log_${traceId}`) || (await listRecentLogs(env, { eventId: traceId }))[0];

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>سجل ${traceId} | بداية</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css">
<style>
:root {
  --bg-workspace: #f5f5f4;
  --bg-surface: #ffffff;
  --text-primary: #201e1d;
  --text-secondary: #57534e;
  --text-muted: #8c857f;
  --border: #e7e5e4;
  --border-subtle: #f0eeeb;
  --code-bg: #f5f4f2;
  --logo-black: #000000;
  --green-dark: #143823;
  --green-bg: #ebfcd2;
  --error-text: #b91c1c;
  --error-bg: #fef2f2;
  --radius-panel: 26px;
  --radius-md: 8px;
  --radius-sm: 6px;
}
* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Readex Pro', sans-serif; box-shadow: none !important; -webkit-box-shadow: none !important; }
html, body { width: 100vw; height: 100vh; overflow: hidden; background-color: var(--bg-workspace); color: var(--text-primary); display: flex; flex-direction: column; }
*::-webkit-scrollbar { width: 5px; height: 5px; background: transparent; }
*::-webkit-scrollbar-thumb { background-color: rgba(87, 83, 78, 0.2); border-radius: 50px; }
.brand-top-header { width: 100vw; height: clamp(60px, 8.5vh, 76px); display: flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 1vh 2vw; }
.brand-logo-box { width: clamp(38px, 5vh, 46px); height: clamp(36px, 4.8vh, 44px); display: flex; align-items: center; justify-content: center; }
.brand-logo-box svg { width: 100%; height: 100%; display: block; }
.app-sheet { width: 100vw; flex: 1; background: var(--bg-surface); border-top: 1px solid var(--border); border-top-left-radius: var(--radius-panel); border-top-right-radius: var(--radius-panel); border-bottom-left-radius: 0; border-bottom-right-radius: 0; padding: 1.8vh 1.8vw 1.2vh 1.8vw; display: flex; flex-direction: column; overflow: hidden; }
.sheet-nav-bar { display: flex; align-items: center; justify-content: space-between; padding-bottom: 1.4vh; margin-bottom: 1.4vh; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; gap: 12px; }
.back-link { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); background: #fafaf9; border: 1px solid var(--border); padding: 6px 14px; border-radius: var(--radius-md); font-size: 0.82rem; font-weight: 700; text-decoration: none; }
.sheet-scroll-content { flex: 1; overflow-y: auto; overflow-x: hidden; padding-left: 4px; min-width: 0; }
.meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 16px; }
.meta-chip { background: #fafaf9; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 5px 12px; font-size: 0.77rem; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 6px; max-width: 100%; }
.meta-chip code { font-weight: 700; color: var(--text-primary); word-break: break-all; }
.pill { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 100px; font-size: 0.72rem; font-weight: 700; }
.pill-success { background-color: var(--green-bg); color: var(--green-dark); }
.pill-failed { background-color: var(--error-bg); color: var(--error-text); }
.detail-card { background: #ffffff; border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 14px; min-width: 0; }
.detail-card-title { font-size: 0.88rem; font-weight: 800; color: var(--text-primary); margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
.grid-meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.meta-box { background: #fafaf9; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 8px 12px; min-width: 0; overflow: hidden; }
.meta-box-label { font-size: 0.68rem; color: var(--text-muted); margin-bottom: 2px; font-weight: 500; }
.meta-box-val { font-size: 0.82rem; font-weight: 700; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trace-item { display: flex; gap: 12px; margin-bottom: 10px; min-width: 0; }
.trace-bullet { width: 9px; height: 9px; border-radius: 50%; margin-top: 7px; flex-shrink: 0; background: #d6d3d1; }
.trace-bullet-err { background: var(--error-text); }
.trace-box { flex: 1; min-width: 0; background: #ffffff; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; }
.trace-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 6px; font-size: 0.8rem; flex-wrap: wrap; }
.trace-json { margin: 0; font-size: 0.76rem; color: var(--text-secondary); font-family: 'Plus Jakarta Sans', monospace !important; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; background: var(--code-bg); padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); max-height: 240px; overflow-y: auto; }
</style>
</head>
<body>
  <header class="brand-top-header">
    <div class="brand-logo-box">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 95">
        <path d="m88.7 8.6c-4.5-4.1-9.7-6.6-17.1-7.5h-41.1c-6.5 0-12.5 1.6-17.3 5.5s-11.1 10.3-11.1 21.4v25.3c0 9.7 4.9 18.7 13.4 24.7l-3.1 12.3c-0.5 2.5 2.1 4.4 4.2 3.2l19.7-10.2h32.7c13.9 0 29-11.9 29-29.6v-25.5c-0.2-7.2-3.6-14.7-9.3-19.6zm4.1 44.2c0 13.1-9.8 24.9-24.4 24.9h-32.8c-0.5 0-0.9 0.2-1.3 0.4l-15.1 7.9 2.2-8.1c0.4-1.7-0.4-2.9-1.3-3.4-2.4-1.2-4.3-2.9-6.1-4.8-3.6-4.1-6-9.8-6.8-16.4v-24.7c0-11.7 10.4-22.1 21.4-22.1h42.5c10.6 0 21.7 9 21.7 22.3z" fill="var(--logo-black)" stroke="var(--logo-black)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
        <path d="m67.7 51c-1.1 1.1-7.3 5.9-16.7 6.3s-15.9-4.4-17.8-6c-1.3-1.3-3-1.5-4.3-0.3-1.1 1.1-1.3 3.1 0.4 4.2 4.5 3.5 10.5 7.2 20.6 7.2 7.3 0 13.8-2.2 18.2-5.1 3.3-2.3 4-2.8 4-4.4 0-1.9-2.1-3.5-4.2-2.1z" fill="var(--logo-black)" stroke="var(--logo-black)" stroke-width="2.0" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
    </div>
  </header>

  <main class="app-sheet">
    <div class="sheet-nav-bar">
      <div style="display:flex; align-items:center; gap:12px; min-width:0;">
        <a href="/dashboard" class="back-link"><i class="ti ti-arrow-right"></i> رجوع للوحة المتابعة</a>
        <span style="font-size:1.02rem; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">تفاصيل السجل <code style="color:var(--text-muted); font-size:0.92rem;">${traceId}</code></span>
      </div>
      <span class="pill ${logData?.outcome === 'final' || logData?.status === 'completed' ? 'pill-success' : 'pill-failed'}">${logData?.outcome || logData?.status || 'معالجة'}</span>
    </div>

    <div class="sheet-scroll-content">
      <div class="meta-row">
        <span class="meta-chip">المعرف: <code style="font-weight:700;">${traceId}</code></span>
        <span class="meta-chip">${(logData?.timing?.receivedAt || logData?.createdAt || isoNow()).replace('T', ' ').slice(0, 19)}</span>
        <span class="meta-chip">المدة: <b>${logData?.timing?.durationMs ? logData.timing.durationMs + ' ms' : '—'}</b></span>
        <span class="meta-chip">المنصة: <b>${logData?.platform || 'Meta / TikTok'}</b></span>
      </div>

      <div class="detail-card">
        <div class="detail-card-title"><i class="ti ti-message-circle"></i> تفاصيل الرسالة والرد</div>
        <div style="font-size:0.84rem; color:var(--text-secondary); line-height:1.6; word-break:break-word;">
          المرسل: <strong>${logData?.sender?.name || 'عميل'}</strong><br>
          استفسار العميل: "${logData?.incomingText || logData?.trigger?.preview || '---'}"
        </div>
        ${logData?.replyText ? `<div style="margin-top:8px; font-size:0.82rem; background:var(--code-bg); border:1px solid var(--border-subtle); padding:10px 12px; border-radius:6px; word-break:break-word;">الرد المولد: <strong style="color:var(--green-dark);">"${logData.replyText}"</strong></div>` : ''}
      </div>

      <div class="detail-card">
        <div class="detail-card-title"><i class="ti ti-network"></i> تفاصيل الاتصال والشبكة السحابية</div>
        <div class="grid-meta">
          <div class="meta-box"><div class="meta-box-label">بروتوكول HTTP</div><div class="meta-box-val">HTTP/3 (QUIC)</div></div>
          <div class="meta-box"><div class="meta-box-label">تشفير TLS</div><div class="meta-box-val">TLSv1.3</div></div>
          <div class="meta-box"><div class="meta-box-label">حالة الطابور</div><div class="meta-box-val">Cloudflare Queues</div></div>
          <div class="meta-box"><div class="meta-box-label">الحدث المعالج</div><div class="meta-box-val">${logData?.event || 'message'}</div></div>
        </div>
      </div>

      <div class="detail-card" style="margin-bottom:0;">
        <div class="detail-card-title"><i class="ti ti-route"></i> مسار التنفيذ التفصيلي (Trace Timeline)</div>
        <div class="trace-item">
          <div class="trace-bullet"></div>
          <div class="trace-box">
            <div class="trace-header">
              <span class="trace-event">REQUEST_RECEIVED</span>
              <span class="trace-time">${logData?.timing?.receivedAt || isoNow()}</span>
            </div>
            <pre class="trace-json">${JSON.stringify({ event: logData?.event, id: traceId }, null, 2)}</pre>
          </div>
        </div>

        ${(logData?.steps || logData?.workflow || []).map((st, i) => `
          <div class="trace-item">
            <div class="trace-bullet ${st.type === 'invalid-json' || st.ok === false ? 'trace-bullet-err' : ''}"></div>
            <div class="trace-box">
              <div class="trace-header">
                <span class="trace-event">${st.step || st.name || `STEP_${i+1}`} (${st.type || 'ACTION'})</span>
                <span class="trace-time">${st.time || st.ts || ''}</span>
              </div>
              <pre class="trace-json">${JSON.stringify(st, null, 2)}</pre>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  </main>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// -----------------------------------------------------------------------------
// 10) تصميم لوحة المتابعة الرئيسية /dashboard المعتمدة (BreeAra Warm Grey UI)
// -----------------------------------------------------------------------------

async function handleDashboard(request, env) {
  const url = new URL(request.url);
  if (env.STATUS_KEY && url.searchParams.get("key") !== env.STATUS_KEY) {
    return textResponse("Unauthorized.", 401);
  }
  const keyQs = env.STATUS_KEY ? `?key=${encodeURIComponent(url.searchParams.get("key"))}` : "";

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>لوحة المتابعة السحابية | بداية</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css">
<style>
:root {
  --bg-workspace: #f5f5f4;
  --bg-surface: #ffffff;
  --text-primary: #201e1d;
  --text-secondary: #57534e;
  --text-muted: #8c857f;
  --border: #e7e5e4;
  --border-subtle: #f0eeeb;
  --logo-black: #000000;
  --green-dark: #143823;
  --green-bg: #ebfcd2;
  --error-text: #b91c1c;
  --error-bg: #fef2f2;
  --blue-text: #1e3a8a;
  --blue-bg: #edf2f7;
  --tiktok-text: #831843;
  --tiktok-bg: #fce7f3;
  --radius-panel: 26px;
  --radius-lg: 12px;
  --radius-md: 8px;
  --radius-sm: 6px;
  --transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}
* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Readex Pro', sans-serif; box-shadow: none !important; -webkit-box-shadow: none !important; }
html, body { width: 100vw; height: 100vh; overflow: hidden; background-color: var(--bg-workspace); color: var(--text-primary); display: flex; flex-direction: column; }
*::-webkit-scrollbar { width: 5px; height: 5px; background: transparent; }
*::-webkit-scrollbar-thumb { background-color: rgba(87, 83, 78, 0.2); border-radius: 50px; }
.brand-top-header { width: 100vw; height: clamp(60px, 8.5vh, 76px); display: flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 1vh 2vw; }
.brand-logo-box { width: clamp(38px, 5vh, 46px); height: clamp(36px, 4.8vh, 44px); display: flex; align-items: center; justify-content: center; }
.brand-logo-box svg { width: 100%; height: 100%; display: block; }
.app-sheet { width: 100vw; flex: 1; background: var(--bg-surface); border-top: 1px solid var(--border); border-top-left-radius: var(--radius-panel); border-top-right-radius: var(--radius-panel); border-bottom-left-radius: 0; border-bottom-right-radius: 0; padding: 1.8vh 1.8vw 1.2vh 1.8vw; display: flex; flex-direction: column; overflow: hidden; position: relative; }
.font-num { font-family: 'Readex Pro', sans-serif !important; }
.stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1vw; margin-bottom: 1.4vh; flex-shrink: 0; }
.card { background: #fafaf9; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); padding: 1.2vh 1.2vw; transition: var(--transition); }
.card .label { color: var(--text-muted); font-size: clamp(0.68rem, 1.2vh, 0.78rem); font-weight: 600; margin-bottom: 0.3vh; display: flex; align-items: center; justify-content: space-between; }
.card .value { font-size: clamp(1.2rem, 2.3vh, 1.5rem); font-weight: 800; color: var(--text-primary); }
.actions-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 1.2vh; flex-shrink: 0; flex-wrap: wrap; }
.table-wrap { flex: 1; overflow-y: auto; overflow-x: auto; background: #ffffff; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); position: relative; }
table { width: 100%; border-collapse: collapse; min-width: 950px; font-size: clamp(0.74rem, 1.3vh, 0.82rem); }
th { text-align: right; padding: 1.2vh 1vw; color: var(--text-secondary); background: #fafaf9; font-weight: 700; white-space: nowrap; border-bottom: 1px solid var(--border-subtle); position: sticky; top: 0; z-index: 5; }
td { padding: 1.1vh 1vw; border-top: 1px solid var(--border-subtle); white-space: nowrap; color: var(--text-primary); }
tr:hover td { background: #fafaf9; }
.pill { display: inline-flex; align-items: center; padding: 0.35vh 0.7vw; border-radius: 100px; font-size: clamp(0.66rem, 1.1vh, 0.73rem); font-weight: 700; white-space: nowrap; }
.pill-success { background-color: var(--green-bg); color: var(--green-dark); }
.pill-failed { background-color: var(--error-bg); color: var(--error-text); }
.pill-other { background-color: #f5f4f2; color: var(--text-secondary); border: 1px solid var(--border); }
.pill-tiktok { background-color: var(--tiktok-bg); color: var(--tiktok-text); }
.pill-meta { background-color: var(--blue-bg); color: var(--blue-text); }
.btn-view { display: inline-flex; align-items: center; gap: 5px; padding: 0.5vh 0.8vw; border-radius: var(--radius-md); border: 1px solid var(--border); background: #ffffff; color: var(--text-secondary); text-decoration: none; font-size: clamp(0.7rem, 1.15vh, 0.77rem); font-weight: 600; cursor: pointer; transition: var(--transition); }
.btn-view:hover { background-color: #f5f4f2; border-color: #d6d3d1; color: var(--text-primary); }
@media (max-width: 768px) { .app-sheet { padding: 1.4vh 3vw 1vh 3vw; border-top-left-radius: 20px; border-top-right-radius: 20px; } .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
</head>
<body>
  <!-- الهيدر: اللوجو فقط في المنتصف أسمك قليلاً وباللون الأسود الصريح -->
  <header class="brand-top-header">
    <div class="brand-logo-box">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 95">
        <path d="m88.7 8.6c-4.5-4.1-9.7-6.6-17.1-7.5h-41.1c-6.5 0-12.5 1.6-17.3 5.5s-11.1 10.3-11.1 21.4v25.3c0 9.7 4.9 18.7 13.4 24.7l-3.1 12.3c-0.5 2.5 2.1 4.4 4.2 3.2l19.7-10.2h32.7c13.9 0 29-11.9 29-29.6v-25.5c-0.2-7.2-3.6-14.7-9.3-19.6zm4.1 44.2c0 13.1-9.8 24.9-24.4 24.9h-32.8c-0.5 0-0.9 0.2-1.3 0.4l-15.1 7.9 2.2-8.1c0.4-1.7-0.4-2.9-1.3-3.4-2.4-1.2-4.3-2.9-6.1-4.8-3.6-4.1-6-9.8-6.8-16.4v-24.7c0-11.7 10.4-22.1 21.4-22.1h42.5c10.6 0 21.7 9 21.7 22.3z" fill="var(--logo-black)" stroke="var(--logo-black)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
        <path d="m67.7 51c-1.1 1.1-7.3 5.9-16.7 6.3s-15.9-4.4-17.8-6c-1.3-1.3-3-1.5-4.3-0.3-1.1 1.1-1.3 3.1 0.4 4.2 4.5 3.5 10.5 7.2 20.6 7.2 7.3 0 13.8-2.2 18.2-5.1 3.3-2.3 4-2.8 4-4.4 0-1.9-2.1-3.5-4.2-2.1z" fill="var(--logo-black)" stroke="var(--logo-black)" stroke-width="2.0" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
    </div>
  </header>

  <main class="app-sheet">
    <section class="stats-grid">
      <div class="card">
        <div class="label"><span>بوابة Zernio</span><span class="pill pill-success" id="stat-zernio">متصل</span></div>
        <div class="value font-num" id="stat-accounts">--</div>
      </div>
      <div class="card">
        <div class="label"><span>طابور المعالجة</span><span class="pill pill-success">Queues + DLQ</span></div>
        <div class="value font-num">10 محاولات</div>
      </div>
      <div class="card">
        <div class="label"><span>المحادثات المكتملة</span><span class="pill pill-other font-num">سجل 7 أيام</span></div>
        <div class="value font-num" id="stat-completed">--</div>
      </div>
      <div class="card">
        <div class="label"><span>حالة راوتر الـ AI</span><span class="pill pill-other">AI Router</span></div>
        <div class="value font-num" style="font-size: 1.1rem; color: #4338ca;">auto (Failover)</div>
      </div>
    </section>

    <section class="actions-bar">
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:0.84rem; font-weight:700; color:var(--text-primary);">سجل تدفق الأحداث والرسائل المباشرة</span>
        <span class="pill pill-other font-num" id="live-timer">تحديث تلقائي: 5s</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="pill pill-meta">Meta (IG & FB)</span>
        <span class="pill pill-tiktok">TikTok Business</span>
        <a href="/health${keyQs}" class="btn-view"><i class="ti ti-activity"></i> فحص السيرفر</a>
      </div>
    </section>

    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Request ID</th>
            <th>الوقت</th>
            <th>المنصة</th>
            <th>الحدث</th>
            <th>المرسل / الحساب</th>
            <th>الإجراء والرد الصافي</th>
            <th>الموديل</th>
            <th>المدة</th>
            <th>الحالة</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="logs-tbody">
          <tr><td colspan="11" style="text-align:center; padding:20px; color:var(--text-muted);">جاري استدعاء البيانات الحية...</td></tr>
        </tbody>
      </table>
    </section>
  </main>

  <script>
    const tbody = document.getElementById('logs-tbody');

    async function loadDashboardData() {
      try {
        const res = await fetch('/api/audit-logs');
        const data = await res.json();
        const logs = data.logs || [];

        if (logs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="11" style="text-align:center; padding:20px; color:var(--text-muted);">لا توجد أحداث مسجلة في السيرفر حالياً.</td></tr>';
          return;
        }

        let html = '';
        let completedCount = 0;

        logs.forEach((logItem, idx) => {
          const outcome = logItem.outcome || 'final';
          if (outcome === 'final' || outcome === 'completed') completedCount++;

          let pillClass = 'pill-other';
          let pillLabel = outcome;
          if (outcome === 'final' || outcome === 'completed') {
            pillClass = 'pill-success';
            pillLabel = 'تم الرد';
          } else if (outcome === 'error' || outcome === 'internal-error' || outcome === 'max-steps') {
            pillClass = 'pill-failed';
            pillLabel = 'تعثر';
          } else if (outcome === 'dead-lettered') {
            pillClass = 'pill-failed';
            pillLabel = 'DLQ';
          }

          const platform = logItem.platform || (logItem.trigger && logItem.trigger.platform) || 'meta';
          const platformPill = platform === 'tiktok' ? 'pill-tiktok' : 'pill-meta';
          const timeStr = logItem.timing?.receivedAt || logItem.createdAt || '---';
          const durationStr = logItem.timing?.durationMs ? logItem.timing.durationMs + ' ms' : '—';
          const actionSnippet = logItem.replyText || logItem.finalText || logItem.error || 'معالجة';

          html += \`
            <tr>
              <td class="font-num" style="color:var(--text-muted); font-size:0.72rem;">\${idx + 1}</td>
              <td><code class="font-num" style="font-weight:700; color:var(--text-primary);">\${logItem.eventId || logItem.id || '---'}</code></td>
              <td class="font-num">\${timeStr.slice(0, 19).replace('T', ' ')}</td>
              <td><span class="pill \${platformPill}">\${platform}</span></td>
              <td><span class="pill pill-other font-num">\${logItem.event || 'message'}</span></td>
              <td style="font-weight:600;">\${logItem.sender?.name || logItem.accountId || 'عميل'}</td>
              <td style="max-width:260px; overflow:hidden; text-overflow:ellipsis; color:var(--text-secondary);" title="\${actionSnippet}">\${actionSnippet}</td>
              <td class="font-num" style="color:#4338ca;">\${logItem.modelUsed || 'auto'}</td>
              <td class="font-num">\${durationStr}</td>
              <td><span class="pill \${pillClass}">\${pillLabel}</span></td>
              <td>
                <a class="btn-view" href="/dashboard/trace/\${logItem.eventId || logItem.id}">
                  <i class="ti ti-route"></i> المسار
                </a>
              </td>
            </tr>
          \`;
        });

        tbody.innerHTML = html;
        document.getElementById('stat-completed').textContent = completedCount;

        // جلب عدد الحسابات
        fetch('/api/accounts').then(r => r.json()).then(accData => {
          const count = ((accData && accData.accounts) || (Array.isArray(accData) ? accData : [])).length;
          document.getElementById('stat-accounts').textContent = count + ' حسابات';
        }).catch(() => {});

      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center; padding:20px; color:var(--error-text);">خطأ في استدعاء السجلات السحابية.</td></tr>';
      }
    }

    loadDashboardData();
    setInterval(loadDashboardData, 5000);
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// -----------------------------------------------------------------------------
// 11) مسارات الـ Health والـ Review
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
    } else {
      const errText = await res.text().catch(() => "");
      zernioRest = { connected: false, status: res.status, error: errText.slice(0, 300) };
    }
  } catch (err) {
    zernioRest = { connected: false, error: err.message };
  }

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

// -----------------------------------------------------------------------------
// 12) نقطة الدخول ومستهلك الطوابير (Fetch & Queue Consumers)
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

      if (request.method === "POST" && url.pathname === "/webhook/zernio") {
        const receivedAt = isoNow();
        const rawBody = await request.text();

        await logActivity(env, {
          event: "webhook-received",
          outcome: "arrived",
          timing: { receivedAt },
          hasSignatureHeader: !!request.headers.get("X-Zernio-Signature"),
          bodyPreview: rawBody.length > 200 ? rawBody.slice(0, 200) + "…" : rawBody,
        });

        const signature = request.headers.get("X-Zernio-Signature");
        if (signature && env.ZERNIO_WEBHOOK_SECRET) {
          const computed = await hmacSha256Hex(env.ZERNIO_WEBHOOK_SECRET, rawBody);
          if (!safeEqualHex(computed, signature)) {
            await logActivity(env, { event: "webhook", outcome: "rejected-bad-signature", timing: { receivedAt } });
            return textResponse("Invalid signature", 400);
          }
        }

        let payload;
        try { payload = JSON.parse(rawBody); } 
        catch (err) { return textResponse("Invalid JSON body", 400); }

        // إيداع مباشر في طابور Cloudflare Queues بدون فحص Dedup نهائياً
        if (env.EVENTS_QUEUE) {
          await env.EVENTS_QUEUE.send({ rawBody, payload, receivedAt });
        }

        return jsonResponse({ ok: true, queued: true });
      }

      if (request.method === "GET" && url.pathname.startsWith("/dashboard/trace/")) {
        const traceId = url.pathname.split("/dashboard/trace/")[1];
        return await handleTraceView(request, env, traceId);
      }

      if (request.method === "GET" && url.pathname === "/dashboard") {
        return await handleDashboard(request, env);
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return await handleHealth(request, env);
      }

      if (request.method === "GET" && url.pathname === "/health/review") {
        return await handleReviewQueue(request, env);
      }

      return textResponse("Not found", 404);
    } catch (err) {
      console.error("Unhandled fetch error", err);
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },

  // مستهلك الطوابير (10 محاولات كحد أقصى مع معالجة إلزامية لـ DLQ)
  async queue(batch, env) {
    // 1. طابور الـ Dead Letter Queue (معالجة طارئة للرسائل المتعثرة لضمان عدم سقوط أي رسالة)
    if (batch.queue && batch.queue.endsWith("-dlq")) {
      for (const message of batch.messages) {
        const { rawBody, payload, receivedAt } = message.body || {};
        try {
          await handleZernioEvent(env, rawBody, payload, receivedAt, true);
          message.ack();
        } catch (dlqErr) {
          console.error("DLQ Emergency handled event:", payload?.id, dlqErr.message);
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

    // 2. الطابور الرئيسي (مع تأخير تصاعدي حتى 10 محاولات كاملة)
    for (const message of batch.messages) {
      const { rawBody, payload, receivedAt } = message.body || {};
      try {
        await handleZernioEvent(env, rawBody, payload, receivedAt, false);
        message.ack();
      } catch (err) {
        console.error("queue consumer retry", payload && payload.id, err && err.message);
        const attempt = message.attempts || 1;
        const delaySeconds = Math.min(20 * Math.pow(2, attempt - 1), 1800); // 20s, 40s, 80s... حتى 10 محاولات
        message.retry({ delaySeconds });
      }
    }
  },
};
