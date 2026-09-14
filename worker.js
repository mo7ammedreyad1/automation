// =============================================================================
// Bedaya Enterprise Social Inbox Agent (v22.0: TikTok + Spam Tool + Factory Reset)
// =============================================================================

const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const AI_ROUTER_BASE = "https://ai.nckalo018.workers.dev/v1";
const AI_ROUTER_MODEL = "auto";

const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60;
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
const AUDIT_LOG_TTL_SECONDS = 3 * 24 * 60 * 60;
const LOG_LIST_LIMIT = 50;

const MAX_AGENT_STEPS = 10;
const CALL_TIMEOUT_MS = 15000;
const AI_CALL_TIMEOUT_MS = 30000;
const AI_ROUTER_MAX_TOKENS = 1024;
const AUTO_CONTEXT_LIMIT = 20;
const MAX_SAFE_CHARS = 550; // حد أمان لمنع تجاوز 1000 حرف على Meta و TikTok

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zernio-key, x-connect-token, X-Connect-Token',
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

function sanitizeAiResponse(rawText) {
  if (!rawText) return '';
  let cleaned = String(rawText).trim();
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  cleaned = cleaned.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();
  cleaned = cleaned.replace(/===.*?===/gi, '').trim();

  if (cleaned.length > MAX_SAFE_CHARS) {
    cleaned = cleaned.slice(0, MAX_SAFE_CHARS);
    const lastSpace = cleaned.lastIndexOf(' ');
    if (lastSpace > MAX_SAFE_CHARS - 50) cleaned = cleaned.slice(0, lastSpace);
    cleaned += '...';
  }
  return cleaned.trim();
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
// 2) كتالوج أدوات الوكيل (Zernio Handlers + أداة تجاهل السبام)
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
      setTimeout(() => reject(new Error(`انتهت مهلة اتصال Zernio API (${CALL_TIMEOUT_MS / 1000}s): ${path}`)), CALL_TIMEOUT_MS)
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
  sendMessage: "إرسال رسالة DM (نص/صورة/فيديو/صوت)",
  typingIndicator: "مؤشر الكتابة التلقائي",
  addReaction: "إضافة تفاعل Reaction على رسالة DM",
  removeReaction: "إزالة تفاعل Reaction من رسالة DM",
  listComments: "جلب تعليقات البوست (سياق)",
  replyToComment: "الرد على تعليق (فيسبوك، إنستغرام، تيك توك)",
  sendPrivateReply: "إرسال DM خاص لصاحب تعليق",
  deleteComment: "حذف تعليق",
  ignoreMessage: "تجاهل الرسالة تماماً بدون رد (في حالة السبام، الإعلانات المزعجة، الإساءة، أو البوتات)",
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
    
    const cleanMessage = message ? sanitizeAiResponse(message) : undefined;
    const body = { accountId };
    if (cleanMessage) body.message = cleanMessage;
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
    const cleanMessage = sanitizeAiResponse(message);
    const body = { accountId, message: cleanMessage };
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
    const cleanMessage = sanitizeAiResponse(message);
    const body = { accountId, message: cleanMessage };
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

  // 🛡️ أداة تجاهل السبام والمحادثات المزعجة
  async ignoreMessage(env, args) {
    const { reason = "spam", notes = "" } = args || {};
    return {
      ok: true,
      status: 200,
      data: {
        action: "ignored",
        reason,
        notes,
        message: "تم تجاهل المحادثة وإلغاء الرد بنجاح (Spam/Ignored Action)."
      }
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
// 3) بناء الـ System Prompt الديناميكي (دمج البرومبت و RAG وأداة السبام)
// -----------------------------------------------------------------------------

async function buildAgentSystemInstruction(env) {
  let customPrompt = "أنت وكيل ذكي بيرد على رسائل الـ Direct Messages وعلى التعليقات (فيسبوك، انستجرام، وتيك توك) باحترافية وسرعة.";
  let ragSection = "";

  if (env.ZERNIO_KV) {
    const savedPrompt = await env.ZERNIO_KV.get("custom_agent_prompt").catch(() => null);
    if (savedPrompt && savedPrompt.trim()) customPrompt = savedPrompt.trim();

    const ragDoc = await env.ZERNIO_KV.get("rag_doc_content").catch(() => null);
    if (ragDoc && ragDoc.trim()) {
      ragSection = `\n=== مستندات وقاعدة المعرفة (RAG Knowledge Base) ===\nاستند بدقة للتفاصيل والأسعار التالية:\n${ragDoc.trim()}\n`;
    }
  }

  return [
    "=== تعليمات وشخصية المتجر (أولوية قصوى) ===",
    customPrompt,
    ragSection,
    "=== قواعد عمل نظام الوكيل والرد ===",
    "أنت وكيل ذكي بيرد على رسائل الـ Direct Messages والتعليقات الواردة من Zernio (Instagram, Facebook, TikTok).",
    "حدثين بس: event = \"message.received\" (رسالة DM) أو event = \"comment.received\" (تعليق على بوست أو فيديو).",
    "",
    "طريقة الرد الإلزامية: كل رد منك لازم يكون كائن JSON واحد فقط، بدون أي نصوص خارجية أو وسوم تفكير:",
    '1) {"action": "call", "calls": [{"name": "اسم العملية", "args": {...}}], "done": true}',
    '2) {"action": "final", "text": "..."}',
    "",
    "قواعد صارمة جداً:",
    "1. الحد الأقصى لنص message في sendMessage أو replyToComment هو 300 حرف فقط لتفادي قيود Meta و TikTok.",
    "2. في حالة وصول رسالة سبام، إعلانات احتيالية، إساءة، أو بوتات مكررة: استخدم أداة ignoreMessage مع done:true فوراً لعدم إرسال أي رد للعميل.",
    "",
    "── كتالوج أدوات الـ DM (event = message.received) ──",
    '- sendMessage — args: { conversationId, accountId, message (نص عربي < 300 حرف), attachmentUrl? }',
    '- addReaction — args: { conversationId, accountId, messageId, emoji }',
    '- removeReaction — args: { conversationId, accountId, messageId }',
    '- listMessages — args: { conversationId, accountId, limit?, sortOrder? }',
    '- ignoreMessage — args: { reason ("spam"|"offensive"|"no_action_needed"), notes? }',
    "",
    "── كتالوج التعليقات (event = comment.received) ──",
    '- replyToComment — args: { postId (platformPostId!), accountId, message, attachmentUrl?, commentId? }',
    '- sendPrivateReply — args: { postId (platformPostId!), commentId, accountId, message }',
    '- ignoreMessage — args: { reason ("spam"|"offensive"|"no_action_needed"), notes? }',
    "",
    "طريقة عملك:",
    "1. حدد نوع الحدث واستخرج الـ IDs الحقيقية بالظبط من النص الوارد.",
    "2. لو العملية هي آخر حاجة مطلوبة، استخدم done:true لإنهاء المعالجة فوراً."
  ].filter(Boolean).join("\n");
}

// -----------------------------------------------------------------------------
// 4) عميل الموديل (AI Router Client — OpenAI Compatible)
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
  try {
    return JSON.stringify(data);
  } catch (_) {
    return String(data);
  }
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
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch (_) {
    data = { raw: bodyText.slice(0, 500) };
  }

  if (!res.ok) {
    const errMsg = data && data.error && (data.error.message || data.error) ? data.error.message || JSON.stringify(data.error) : JSON.stringify(data).slice(0, 300);
    const msg = `AI Router HTTP ${res.status}: ${errMsg}`;
    if (attemptsLog) attemptsLog.push({ provider: "ai-router", model: AI_ROUTER_MODEL, status: res.status, ok: false, note: msg });
    throw new Error(msg);
  }

  if (attemptsLog) {
    attemptsLog.push({
      provider: "ai-router",
      model: AI_ROUTER_MODEL,
      status: res.status,
      ok: true,
      upstreamProvider: res.headers.get("X-AI-Router-Provider") || null,
      upstreamModel: res.headers.get("X-AI-Router-Model") || null,
    });
  }
  return extractRouterText(data);
}

function extractJsonObject(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// 5) حلقة تفكير الوكيل (ReAct Agent Loop)
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
// 6) معالجة الأحداث الواردة (Webhook Events)
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

async function handleZernioEvent(env, rawBody, payload, receivedAt) {
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

    if (eventType === "message.received") {
      const ids = extractMessageContext(payload);
      if (ids) {
        CALL_HANDLERS.typingIndicator(env, ids).catch(() => {});
        const history = await CALL_HANDLERS.listMessages(env, { ...ids, limit: AUTO_CONTEXT_LIMIT, sortOrder: "desc" });
        contextFetched = { type: "messages", ids, ok: history.ok, status: history.status, data: history.data };
        rawEventText += `\n\nسياق آخر الرسائل (مرفقة تلقائياً):\n${JSON.stringify(history.data).slice(0, 3000)}`;
      } else {
        contextFetched = { type: "messages", error: "extractMessageContext فشل في استخراج المعرفات" };
      }
    } else if (eventType === "comment.received") {
      const ids = extractCommentContext(payload);
      if (ids) {
        const history = await CALL_HANDLERS.listComments(env, { ...ids, limit: AUTO_CONTEXT_LIMIT });
        contextFetched = { type: "comments", ids, ok: history.ok, status: history.status, data: history.data };
        rawEventText += `\n\nسياق تعليقات البوست:\n${JSON.stringify(history.data).slice(0, 3000)}`;
      } else {
        contextFetched = { type: "comments", error: "extractCommentContext فشل في استخراج المعرفات" };
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
// 7) مسارات الـ API (المصادقة، الحسابات، الإحصائيات، الفرمتة الشاملة، والـ RAG)
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

  // 4. 🧹 الفرمتة الشاملة للسيرفر وحذف جميع الحسابات والبيانات (Factory Reset)
  if (method === 'POST' && path === '/api/admin/factory-reset') {
    const disconnectedAccounts = [];

    // أ. جلب وفصل جميع الحسابات من Zernio
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
      console.error("Factory reset accounts disconnect error:", e);
    }

    // ب. مسح جميع مفاتيح الـ KV بالكامل
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
        console.error("Factory reset KV delete error:", kvErr);
      }
    }

    return jsonResponse({
      ok: true,
      message: "تمت فرمتة السيرفر وحذف جميع الحسابات والبيانات بالكامل وإعادته لحالة المصنع.",
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

  // 6. جلب صفحات فيسبوك الرسمية
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

  // 7. تأكيد ربط صفحة فيسبوك
  if (method === 'POST' && path === '/api/auth/facebook/select') {
    const body = await request.json().catch(() => ({}));
    body.profileId = PROFILE_ID;
    const connectToken = body.connect_token || request.headers.get('x-connect-token') || '';
    const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
    if (connectToken) headers['X-Connect-Token'] = connectToken;

    const res = await fetch(`${ZERNIO_API_BASE}/connect/facebook/select-page`, { method: 'POST', headers, body: JSON.stringify(body) });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 8. تفويض إنستغرام
  if (method === 'GET' && path === '/api/auth/instagram') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 9. جلب حسابات إنستغرام
  if (method === 'GET' && path === '/api/auth/instagram/accounts') {
    const tempToken = url.searchParams.get('tempToken');
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram/select-account?profileId=${PROFILE_ID}&tempToken=${tempToken}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 10. تأكيد ربط حساب إنستغرام
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

  // 11. 🎵 تفويض وربط حساب TikTok الرسمي
  if (method === 'GET' && path === '/api/auth/tiktok') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/tiktok?profileId=${PROFILE_ID}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 12. حفظ واسترجاع الـ System Prompt
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

  // 13. رفع وحذف مستند الـ RAG
  if (method === 'POST' && path === '/api/upload-rag-doc') {
    const body = await request.json().catch(() => ({}));
    const { name, size, textContent } = body;
    if (!textContent) return jsonResponse({ error: 'محتوى الملف مفقود' }, 400);

    if (env.ZERNIO_KV) {
      await env.ZERNIO_KV.put('rag_doc_content', textContent);
      await env.ZERNIO_KV.put('rag_doc_meta', JSON.stringify({ name, size, updatedAt: isoNow() }));
    }
    return jsonResponse({ ok: true, message: `تم حفظ وفهرسة مستند (${name}) بنجاح` });
  }

  if (method === 'POST' && path === '/api/delete-rag-doc') {
    if (env.ZERNIO_KV) {
      await env.ZERNIO_KV.delete('rag_doc_content');
      await env.ZERNIO_KV.delete('rag_doc_meta');
    }
    return jsonResponse({ ok: true, message: 'تم مسح قاعدة المعرفة بنجاح' });
  }

  // 14. نظرة عامة للأدمن
  if (method === 'GET' && path === '/api/admin/overview') {
    const prompt = env.ZERNIO_KV ? await env.ZERNIO_KV.get('custom_agent_prompt') : null;
    const ragMeta = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_meta') : null;
    const ragContent = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_content') : null;

    return jsonResponse({
      ok: true,
      service: "Bedaya Enterprise Agent Engine v22.0",
      model: AI_ROUTER_MODEL,
      prompt: prompt || 'البرومبت الافتراضي نشط',
      rag: {
        active: !!ragContent,
        meta: ragMeta ? JSON.parse(ragMeta) : null,
        preview: ragContent ? ragContent.slice(0, 400) : null
      }
    });
  }

  // 15. سجل تتبع الـ 3 أيام للوحة التحكم
  if (method === 'GET' && path === '/api/audit-logs') {
    const logs = await listRecentLogs(env, { limit: 50 });
    return jsonResponse({ ok: true, count: logs.length, logs });
  }

  // 16. محاكاة الشات المباشر مع اختبار أداة تجاهل السبام
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
// 8) استقبال الـ Webhook و /health و /dashboard
// -----------------------------------------------------------------------------

async function handleWebhook(request, env) {
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
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    await logActivity(env, { event: "webhook", outcome: "rejected-invalid-json", error: err.message, timing: { receivedAt } });
    return textResponse("Invalid JSON body", 400);
  }

  const eventId = request.headers.get("X-Zernio-Event-Id") || payload.id;
  if (eventId && env.ZERNIO_KV) {
    const dedupKey = `dedup:${eventId}`;
    const already = await env.ZERNIO_KV.get(dedupKey).catch(() => null);
    if (already) {
      await logActivity(env, { eventId, event: payload.event, outcome: "dedup-skip", timing: { receivedAt } });
      return jsonResponse({ ok: true, dedup: true });
    }
    await env.ZERNIO_KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS }).catch(() => {});
  }

  // إيداع الحدث في طابور Cloudflare Queues
  if (env.EVENTS_QUEUE) {
    await env.EVENTS_QUEUE.send({ rawBody, payload, receivedAt });
  }

  return jsonResponse({ ok: true, queued: true });
}

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
<title>لوحة متابعة Zernio Agent v22</title>
<style>
  body { background:#0b0e14; color:#d8dee9; font-family: -apple-system, Tahoma, sans-serif; margin:0; padding:16px; }
  h1 { font-size:16px; color:#8fd3ff; margin:0 0 8px; }
  .bar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; font-size:13px; }
  .pill { background:#171b26; border-radius:6px; padding:6px 10px; }
  .ok { color:#7ee787; } .bad { color:#ff7b72; }
  .entry { background:#111520; border:1px solid #222736; border-radius:8px; padding:10px 12px; margin-bottom:8px; font-size:13px; }
  .entry .top { display:flex; justify-content:space-between; gap:8px; color:#8b94a8; font-size:12px; margin-bottom:4px; }
  .out-error, .out-internal-error, .out-max-steps { color:#ff7b72; font-weight:bold; }
  .out-final { color:#7ee787; font-weight:bold; }
  .out-skipped-self-echo, .out-skipped-unsupported-event, .out-arrived, .out-dedup-skip { color:#8b94a8; }
  pre { white-space:pre-wrap; word-break:break-word; margin:4px 0 0; color:#c9d1d9; font-size:12px; }
  #status { font-size:12px; color:#8b94a8; margin-bottom:10px; }
</style>
</head>
<body>
<h1>لوحة متابعة Zernio Social Inbox Agent (v22.0)</h1>
<div id="status">بيحمل...</div>
<div class="bar" id="bar"></div>
<div id="logs"></div>
<script>
async function refresh() {
  try {
    const res = await fetch('/health${keyQs}');
    const data = await res.json();
    document.getElementById('status').textContent = 'آخر تحديث: ' + new Date().toLocaleTimeString('ar-EG');
    var bar = document.getElementById('bar');
    var zc = data.zernioRest && data.zernioRest.connected;
    bar.innerHTML =
      '<div class="pill">Zernio: <span class="' + (zc ? 'ok' : 'bad') + '">' + (zc ? 'متصل' : 'غير متصل') + '</span></div>' +
      '<div class="pill">حسابات: ' + ((data.zernioRest && data.zernioRest.accountCount) || 0) + '</div>';
    var logsEl = document.getElementById('logs');
    var items = data.logs || [];
    logsEl.innerHTML = items.map(function(e) {
      var outcome = e.outcome || '';
      return '<div class="entry">' +
        '<div class="top"><span>' + esc(e.event || '') + ' — ' + esc(e.eventId || '') + '</span>' +
        '<span class="out-' + esc(outcome) + '">' + esc(outcome) + '</span></div>' +
        '<div>' + esc((e.timing && e.timing.receivedAt) || '') + (e.timing && typeof e.timing.durationMs === 'number' ? ' — ' + e.timing.durationMs + 'ms' : '') + '</div>' +
        (e.finalText ? '<pre>' + esc(e.finalText) + '</pre>' : '') +
        (e.error ? '<pre style="color:#ff7b72">' + esc(e.error) + '</pre>' : '') +
      '</div>';
    }).join('') || '<div>مفيش أحداث لسه</div>';
  } catch (err) {
    document.getElementById('status').textContent = 'فشل التحديث: ' + err.message;
  }
}
function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// -----------------------------------------------------------------------------
// 9) نقطة الدخول ومستهلك الطوابير (Fetch & Queue Consumers)
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
        return await handleWebhook(request, env);
      }

      if (request.method === "GET" && url.pathname === "/webhook/zernio") {
        return textResponse("Zernio webhook endpoint — جاهز لاستقبال الأحداث.");
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
      console.error("Unhandled fetch error", err);
      await logActivity(env, { event: "webhook", outcome: "fatal-error", error: err.message, timing: { receivedAt: isoNow() } }).catch(() => {});
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },

  async queue(batch, env) {
    if (batch.queue && batch.queue.endsWith("-dlq")) {
      for (const message of batch.messages) {
        const { payload, receivedAt } = message.body || {};
        await logActivity(env, {
          eventId: payload && payload.id,
          event: (payload && payload.event) || "unknown",
          outcome: "dead-lettered",
          timing: { receivedAt },
          note: "استنفدت الرسالة كل محاولات الإعادة في الطابور الرئيسي وانتقلت لـ DLQ.",
        }).catch(() => {});
        message.ack();
      }
      return;
    }

    for (const message of batch.messages) {
      const { rawBody, payload, receivedAt } = message.body || {};
      try {
        await handleZernioEvent(env, rawBody, payload, receivedAt);
        message.ack();
      } catch (err) {
        console.error("queue consumer retry", payload && payload.id, err && err.message);
        const attempt = message.attempts || 1;
        const delaySeconds = Math.min(30 * Math.pow(2, attempt - 1), 1800);
        message.retry({ delaySeconds });
      }
    }
  },
};
