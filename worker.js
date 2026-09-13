// =============================================================================
// Zernio Social Inbox Agent — AI Router Edition
// =============================================================================
//
// هذا الملف يحافظ على منطق Zernio الأساسي:
// - Webhook verification + dedup
// - Zernio REST tools
// - Cloudflare KV logs/context
// - Cloudflare Queues + DLQ
// - Dashboard + review queue
// - Admin business context
//
// طبقة الذكاء تم استبدالها بالكامل بسيرفر AI Router خارجي:
//   AI_ROUTER_URL
//   AI_ROUTER_API_KEY
//   AI_ROUTER_MODEL (اختياري)
//
// الـ AI Router هو المسؤول عن:
// - Gemini/Groq KeyPool + ModelPool
// - Failover
// - اختيار الموديل والمفتاح
// - إرجاع OpenAI-compatible response
//
// ملاحظة:
// هذا الملف نفسه لا يحتوي أي اتصال مباشر إلى Gemini أو Workers AI.
//
// الأسرار المطلوبة:
//   ZERNIO_API_KEY
//   ZERNIO_WEBHOOK_SECRET
//   AI_ROUTER_API_KEY
//   ADMIN_KEY (اختياري)
//   STATUS_KEY (اختياري)
//
// Variables المطلوبة:
//   AI_ROUTER_URL
//   AI_ROUTER_MODEL (اختياري، الافتراضي auto)
//
// Bindings:
//   ZERNIO_KV
//   EVENTS_QUEUE
// =============================================================================

// -----------------------------------------------------------------------------
// 1) ثوابت عامة
// -----------------------------------------------------------------------------

const ZERNIO_API_BASE = "https://zernio.com/api/v1";

const AI_ROUTER_DEFAULT_MODEL = "auto";

const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60;
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOG_LIST_LIMIT = 30;

const MAX_AGENT_STEPS = 10;

const CALL_TIMEOUT_MS = 15000;
const AI_ROUTER_TIMEOUT_MS = 30000;

const AUTO_CONTEXT_LIMIT = 20;

// -----------------------------------------------------------------------------
// 2) أدوات مساعدة عامة
// -----------------------------------------------------------------------------

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
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

function isoNow() {
  return new Date().toISOString();
}

function shortId() {
  return crypto.randomUUID().slice(0, 8);
}

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
// 3) كتالوج العمليات المسموحة (call handlers) — DM + Comments
// -----------------------------------------------------------------------------

async function zernioFetch(env, path, options = {}) {
  const url = `${ZERNIO_API_BASE}${path}`;
  const headers = Object.assign(
    { Authorization: `Bearer ${env.ZERNIO_API_KEY}` },
    options.body ? { "Content-Type": "application/json" } : {},
    options.headers || {}
  );
  const res = await Promise.race([
    fetch(url, { ...options, headers }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`انتهت مهلة نداء REST (${CALL_TIMEOUT_MS / 1000}s): ${path}`)), CALL_TIMEOUT_MS)
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
  return { ok: false, status: 0, data: { error: `محتاج الحقول دي: ${names.join(", ")}` } };
}

const TOOL_DESCRIPTIONS = {
  listMessages: "جلب آخر رسائل محادثة DM (سياق)",
  sendMessage: "إرسال رسالة DM (نص/صورة/فيديو/صوت)",
  typingIndicator: "مؤشر الكتابة — تلقائي، مش من قرار الموديل",
  addReaction: "إضافة reaction على رسالة DM",
  removeReaction: "إزالة reaction من رسالة DM",
  listComments: "جلب تعليقات بوست (سياق)",
  replyToComment: "الرد على تعليق (نص، وصورة على فيسبوك بس)",
  sendPrivateReply: "إرسال DM خاص لصاحب تعليق (فيسبوك/انستجرام)",
  deleteComment: "حذف تعليق",
};

const CALL_HANDLERS = {
  // ---------------- Direct Messages ----------------

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
    if (!message && !attachmentUrl) return missingArgsError(["message أو attachmentUrl (واحد منهم على الأقل)"]);
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

  // ---------------- Comments ----------------

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
    if (attachmentUrl) body.attachmentUrl = attachmentUrl; // فيسبوك بس
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
      results.push({ name, ok: false, data: { error: redactSecret(String((err && err.message) || err), env.ZERNIO_API_KEY) } });
    }
  }
  return results;
}

// -----------------------------------------------------------------------------
// 4) عميل الـ AI Router الجديد
// -----------------------------------------------------------------------------
//
// هذا هو الاتصال الوحيد بطبقة الذكاء الاصطناعي.
// لا يوجد هنا Gemini API مباشر ولا Workers AI.
//
// المتغيرات:
//   AI_ROUTER_URL
//   AI_ROUTER_API_KEY
//   AI_ROUTER_MODEL (اختياري)
// -----------------------------------------------------------------------------

function normalizeRouterURL(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

function getRouterChatURL(env) {
  const base = normalizeRouterURL(env.AI_ROUTER_URL);
  if (!base) {
    throw new Error("AI_ROUTER_URL مش متظبط.");
  }

  if (base.endsWith("/v1/chat/completions")) {
    return base;
  }

  if (base.endsWith("/v1")) {
    return `${base}/chat/completions`;
  }

  return `${base}/v1/chat/completions`;
}

function getRouterModelsURL(env) {
  const base = normalizeRouterURL(env.AI_ROUTER_URL);
  if (!base) {
    throw new Error("AI_ROUTER_URL مش متظبط.");
  }

  if (base.endsWith("/v1/models")) {
    return base;
  }

  if (base.endsWith("/v1")) {
    return `${base}/models`;
  }

  return `${base}/v1/models`;
}

function getRouterModel(env) {
  const model =
    typeof env.AI_ROUTER_MODEL === "string"
      ? env.AI_ROUTER_MODEL.trim()
      : "";

  return model || AI_ROUTER_DEFAULT_MODEL;
}

function normalizeMessagesForRouter(systemInstruction, contents) {
  const messages = [];

  if (systemInstruction && String(systemInstruction).trim()) {
    messages.push({
      role: "system",
      content: String(systemInstruction),
    });
  }

  for (const c of contents || []) {
    const text = Array.isArray(c?.parts)
      ? c.parts
          .map((part) => {
            if (!part) return "";
            if (typeof part.text === "string") return part.text;
            return "";
          })
          .filter(Boolean)
          .join("\n")
      : "";

    if (!text) continue;

    messages.push({
      role: c.role === "model" ? "assistant" : "user",
      content: text,
    });
  }

  return messages;
}

function extractRouterAssistantText(data) {
  if (!data || typeof data !== "object") {
    return "";
  }

  // OpenAI-compatible:
  if (Array.isArray(data.choices) && data.choices[0]) {
    const choice = data.choices[0];

    if (
      choice.message &&
      typeof choice.message.content === "string"
    ) {
      return choice.message.content;
    }

    if (typeof choice.text === "string") {
      return choice.text;
    }
  }

  // Defensive fallbacks:
  if (typeof data.response === "string") {
    return data.response;
  }

  if (
    data.result &&
    typeof data.result.response === "string"
  ) {
    return data.result.response;
  }

  if (typeof data.content === "string") {
    return data.content;
  }

  return "";
}

function sanitizeAssistantText(text) {
  if (typeof text !== "string") return "";

  let result = text;

  // إزالة reasoning blocks الشائعة لو ظهرت كنص.
  result = result.replace(
    /<think>[\s\S]*?<\/think>/gi,
    ""
  );

  result = result.replace(
    /<thinking>[\s\S]*?<\/thinking>/gi,
    ""
  );

  // لو بدأ بلوك think ولم يُغلق، لا نسمح له بالخروج للعميل.
  result = result.replace(
    /^\s*<think>[\s\S]*$/i,
    ""
  );

  result = result.replace(
    /^\s*<thinking>[\s\S]*$/i,
    ""
  );

  return result.trim();
}

function extractRouterDiagnostics(data) {
  return {
    requestId:
      data?.id ||
      data?.request_id ||
      data?.requestId ||
      null,

    usage:
      data?.usage ||
      null,
  };
}

async function callAIRouterTurn(
  env,
  contents,
  systemInstruction,
  attemptsLog
) {
  const url = getRouterChatURL(env);

  const apiKey =
    String(env.AI_ROUTER_API_KEY || "").trim();

  if (!apiKey) {
    throw new Error(
      "AI_ROUTER_API_KEY مش متظبط."
    );
  }

  const messages =
    normalizeMessagesForRouter(
      systemInstruction,
      contents
    );

  if (!messages.length) {
    throw new Error(
      "مفيش messages صالحة لإرسالها للـAI Router."
    );
  }

  const model = getRouterModel(env);

  const body = {
    model,
    messages,

    temperature: 0.3,

    stream: false,
  };

  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    getNumberEnv(
      env.AI_ROUTER_TIMEOUT_MS,
      AI_ROUTER_TIMEOUT_MS
    )
  );

  try {
    const res = await fetch(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",

          Authorization:
            `Bearer ${apiKey}`,
        },

        body:
          JSON.stringify(body),

        signal:
          controller.signal,
      }
    );

    clearTimeout(timer);

    const contentType =
      res.headers.get("content-type") ||
      "";

    let data;

    if (
      contentType.includes(
        "application/json"
      )
    ) {
      data =
        await res.json().catch(() => ({}));
    } else {
      const text =
        await res.text().catch(() => "");

      try {
        data = text
          ? JSON.parse(text)
          : {};
      } catch {
        data = {
          raw: text.slice(0, 1000),
        };
      }
    }

    if (!res.ok) {
      const message =
        extractRouterErrorMessage(data);

      const error =
        new Error(
          `AI Router HTTP ${res.status}: ${message}`
        );

      error.routerStatus =
        res.status;

      error.routerBody =
        data;

      if (attemptsLog) {
        attemptsLog.push({
          provider:
            "ai-router",

          model,

          status:
            res.status,

          ok:
            false,

          note:
            message,
        });
      }

      throw error;
    }

    const rawText =
      extractRouterAssistantText(
        data
      );

    const cleanedText =
      sanitizeAssistantText(
        rawText
      );

    if (!cleanedText) {
      const error =
        new Error(
          "AI Router رجّع رد فاضي."
        );

      error.routerStatus =
        res.status;

      error.routerBody =
        data;

      if (attemptsLog) {
        attemptsLog.push({
          provider:
            "ai-router",

          model,

          status:
            res.status,

          ok:
            false,

          note:
            "Empty assistant response",
        });
      }

      throw error;
    }

    if (attemptsLog) {
      const diagnostics =
        extractRouterDiagnostics(
          data
        );

      attemptsLog.push({
        provider:
          "ai-router",

        model,

        status:
          res.status,

        ok:
          true,

        requestId:
          diagnostics.requestId,

        usage:
          diagnostics.usage,

        note:
          "Router response received",
      });
    }

    return {
      text:
        cleanedText,

      rawText:

        rawText,

      data:
        data,

      model:
        data?.model ||
        model,

      headers: res.headers,
    };
  } catch (error) {
    clearTimeout(timer);

    if (attemptsLog &&
        !attemptsLog.some(
          (x) =>
            x.provider === "ai-router" &&
            x.ok === false &&
            x.note &&
            error?.message?.includes(x.note)
        )) {
      attemptsLog.push({
        provider:
          "ai-router",

        model,

        status:
          error?.routerStatus ||
          0,

        ok:
          false,

        note:
          error?.message ||
          "AI Router request failed",
      });
    }

    throw error;
  }
}

function extractRouterErrorMessage(data) {
  if (!data) {
    return "Unknown AI Router error";
  }

  if (typeof data === "string") {
    return data.slice(0, 500);
  }

  if (
    data.error &&
    typeof data.error === "string"
  ) {
    return data.error.slice(0, 500);
  }

  if (
    data.error &&
    typeof data.error.message === "string"
  ) {
    return data.error.message.slice(0, 500);
  }

  if (
    Array.isArray(data.errors) &&
    data.errors.length
  ) {
    return data.errors
      .map(
        (e) =>
          e?.message ||
          e?.code ||
          String(e)
      )
      .join("; ")
      .slice(0, 500);
  }

  if (
    typeof data.message === "string"
  ) {
    return data.message.slice(0, 500);
  }

  try {
    return JSON.stringify(data)
      .slice(0, 500);
  } catch {
    return "Unknown AI Router error";
  }
}

// نداء منفصل لتلخيص نصوص السياق باستخدام نفس الـAI Router.
// لا يوجد هنا أي مزود AI مباشر.
async function callAIRouterForSummary(
  env,
  promptText
) {
  const messages = [
    {
      role: "user",
      content: String(promptText || ""),
    },
  ];

  const controller =
    new AbortController();

  const timeoutMs =
    getNumberEnv(
      env.AI_ROUTER_TIMEOUT_MS,
      AI_ROUTER_TIMEOUT_MS
    );

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    const url =
      getRouterChatURL(env);

    const apiKey =
      String(
        env.AI_ROUTER_API_KEY || ""
      ).trim();

    if (!apiKey) {
      throw new Error(
        "AI_ROUTER_API_KEY مش متظبط."
      );
    }

    const response =
      await fetch(
        url,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${apiKey}`,
          },

          body:
            JSON.stringify({
              model:
                getRouterModel(env),

              messages,

              temperature:
                0.2,

              stream:
                false,
            }),

          signal:
            controller.signal,
        }
      );

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    let data;

    if (
      contentType.includes(
        "application/json"
      )
    ) {
      data =
        await response
          .json()
          .catch(() => ({}));
    } else {
      const text =
        await response
          .text()
          .catch(() => "");

      try {
        data =
          text
            ? JSON.parse(text)
            : {};
      } catch {
        data = {
          raw: text,
        };
      }
    }

    if (!response.ok) {
      throw new Error(
        `AI Router summary HTTP ${response.status}: ${extractRouterErrorMessage(data)}`
      );
    }

    const text =
      sanitizeAssistantText(
        extractRouterAssistantText(
          data
        )
      );

    if (!text) {
      throw new Error(
        "AI Router رجّع ملخص فاضي."
      );
    }

    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

// تحويل الملفات النصية فقط إلى نص يمكن إرساله للـAI Router.
// PDF/DOCX والباقي binary يحتاج طبقة parsing مستقلة لو عايز دعمها.
async function extractTextFromUploadedFile(file) {
  const name =
    String(
      file?.name || ""
    );

  const type =
    String(
      file?.type || ""
    ).toLowerCase();

  const textLike =
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("csv") ||
    type.includes("xml") ||
    type.includes("javascript") ||
    type.includes("html") ||
    /\.(txt|md|csv|json|xml|html|htm|js|css)$/i.test(
      name
    );

  if (!textLike) {
    throw new Error(
      `الملف "${name || "بدون اسم"}" نوعه ${type || "غير معروف"} وليس ملفًا نصيًا مدعومًا في هذه النسخة.`
    );
  }

  const text =
    await file.text();

  return {
    name:
      name || "file",

    type:
      type || "text/plain",

    text:
      text,
  };
}

// -----------------------------------------------------------------------------
// 5) حلقة الوكيل: Plan → Act → Reflect
// -----------------------------------------------------------------------------

const AGENT_SYSTEM_INSTRUCTION = [
  "أنت وكيل ذكي بيرد على رسائل الـ Direct Messages وعلى التعليقات (فيسبوك وانستجرام) اللي بتوصلك خام كأحداث webhook من منصة Zernio. حدثين بس: event = \"message.received\" (رسالة DM) أو event = \"comment.received\" (تعليق على بوست). كل نوع له كتالوج أدوات مختلف — ماتخلطش بينهم.",
  "",
  "سياق جاهز: في آخر نص الحدث اللي بيوصلك، هتلاقي فقرة إضافية باسم \"سياق آخر الرسائل\" أو \"سياق تعليقات البوست\" — دي بيانات اتجابت تلقائيًا بكود ثابت *قبل* ما توصلك، مفيش داعي تطلبها تاني إلا لو محتاج أكتر من العدد الظاهر أو صفحة تانية (cursor).",
  "",
  "طريقة الرد (مهم جدًا تلتزم بيها بالحرف): كل رد منك لازم يكون كائن JSON واحد بس، من غير أي نص تاني قبله أو بعده أو أي markdown، بواحد من الشكلين دول بالظبط:",
  '1) {"action": "call", "calls": [{"name": "اسم العملية", "args": {...}}, ...], "done": true} — عملية واحدة أو أكتر من الكتالوج تحت. حقل "done" اختياري: لو حاططه true وكل العمليات في الخطوة دي نجحت، بتوقف المعالجة على طول من غير ما تستنى دور تاني. لو حصل فشل في أي عملية، هتكمل الحلقة عادي حتى لو حاطط done:true.',
  '2) {"action": "final", "text": "..."} — بس لو محتاج توقف من غير أي فعل، أو بعد أكتر من خطوة call من غير done.',
  "",
  "تحذير حاسم: صياغة نص الرد لوحدها متكفيش. الرد النهائي (final.text أو الملخص التلقائي بعد done:true) مش بيوصل للعميل خالص — ده بس ملاحظة داخلية للّوج. اللي بيوصل فعليًا للعميل هو نص sendMessage (للـ DM) أو replyToComment/sendPrivateReply (للتعليق). لو قررت إن فيه رد لازم يوصل، لازم يكون اتنفذ فعل الإرسال المناسب فعليًا (ورجع ok:true) قبل أي إنهاء.",
  "",
  "قاعدة تجميع العمليات: اجمع عمليات مستقلة عن بعض بس في نفس الـ calls. ماتحاولش تجمع listMessages/listComments مع فعل إرسال في نفس الخطوة — أصلاً مش هتحتاجهم غالبًا لأن السياق وصلك جاهز زي ما شرحنا فوق.",
  "",
  "قاعدة حرجة للتعليقات: أي postId تستخدمه في أدوات التعليقات لازم يكون platformPostId (من comment.platformPostId أو post.platformPostId في الحدث الخام) — الحقول comment.postId و post.id ممكن توصل فاضية واستخدامها هيفشل النداء.",
  "",
  "── كتالوج الـ DM (event = message.received) ──",
  '- sendMessage — args: { conversationId, accountId, message? (نص), attachmentUrl? (رابط عام), attachmentType? ("image"|"video"|"audio"|"file") } — لازم message أو attachmentUrl على الأقل.',
  '- addReaction — args: { conversationId, accountId, messageId, emoji } (اختياري)',
  '- removeReaction — args: { conversationId, accountId, messageId } (اختياري)',
  '- listMessages — args: { conversationId, accountId, limit?, sortOrder?, cursor? } — استخدمها بس لو محتاج أكتر من السياق الجاهز اللي وصلك.',
  "",
  "── كتالوج التعليقات (event = comment.received) ──",
  '- replyToComment — args: { postId (platformPostId!), accountId, message, attachmentUrl? (صورة — فيسبوك بس), commentId? }',
  '- sendPrivateReply — args: { postId (platformPostId!), commentId, accountId, message, quickReplies?, buttons? } — DM خاص لصاحب التعليق، مرة واحدة بس لكل تعليق وخلال 7 أيام.',
  "",
  "طريقة عملك:",
  "1. حدد نوع الحدث وابدأ تقرا الحقول الخاصة بيه بعناية — استخرج الـ IDs الحقيقية بالظبط زي ما ظهروا في النص، مع مراعاة قاعدة platformPostId للتعليقات.",
  "2. لو أي عملية رجعت ok:false، اقرا data.error/data.status وصحح الـ args قبل ما تعيد المحاولة.",
  "3. اكتب رد العميل بنفس لغته (عربي فصحى أو عامية أو إنجليزي)، ودود ومختصر ومحترف.",
  "4. لما تكون متأكد إن العملية اللي هتنفذها هي آخر حاجة مطلوبة، استخدم done:true بدل ما تاخد دور إضافي بس عشان تقول final.",
].join("\n");

const BUSINESS_CONTEXT_KV_KEY = "config:business-context";
const BUSINESS_CONTEXT_MAX_WORDS = 500;

// بيدمج سياق النشاط التجاري الديناميكي (من KV، بيتغير من غير deploy) مع
// التعليمات الثابتة (بروتوكول/كتالوج الأدوات، بيتغير بس لما نحسّن الوكيل
// نفسه). لو مفيش سياق متظبط لسه، بيرجع التعليمات الثابتة لوحدها — يعني
// النظام شغال حتى قبل أول إعداد لنشاط تجاري.
function buildFinalSystemInstruction(businessContextText) {
  const text = (businessContextText || "").trim();
  if (!text) return AGENT_SYSTEM_INSTRUCTION;
  return ["── معلومات النشاط التجاري اللي بترد نيابة عنه ──", text, "", AGENT_SYSTEM_INSTRUCTION].join("\n");
}



function extractJsonObject(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // نحاول نلقط أول { ... } متكامل بعدّ الأقواس
  }
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

async function runAgentLoopWithModel(
  env,
  rawEventText,
  eventId,
  modelOverride,
  systemInstruction
) {
  const contents = [
    {
      role: "user",
      parts: [
        {
          text:
            rawEventText,
        },
      ],
    },
  ];

  const steps = [];
  const aiRouterAttempts = [];

  /*
   * الـAI Router نفسه يملك ModelPool + KeyPool.
   *
   * لذلك لا نُنشئ combos هنا ولا نُدير مفاتيح AI داخل هذا الـWorker.
   *
   * لو AI_ROUTER_MODEL موجود:
   *   نمرره للـRouter.
   *
   * لو غير موجود:
   *   نستخدم auto.
   */

  const originalModel =
    env.AI_ROUTER_MODEL;

  if (
    modelOverride &&
    String(modelOverride).trim()
  ) {
    env.AI_ROUTER_MODEL =
      String(modelOverride).trim();
  }

  try {
    for (
      let i = 0;
      i < MAX_AGENT_STEPS;
      i++
    ) {
      let rawText;

      try {
        const result =
          await callAIRouterTurn(
            env,
            contents,
            systemInstruction,
            aiRouterAttempts
          );

        rawText =
          result.text;
      } catch (err) {
        return {
          ok:
            false,

          steps,

          finalText:
            null,

          stopReason:
            "error",

          error:
            err?.message ||
            "AI Router error",

          aiRouterAttempts,
        };
      }

      const action =
        extractJsonObject(
          rawText
        );


      /*
       * لو الـRouter رجّع JSON داخل markdown
       * أو مع نص زائد، extractJsonObject يحاول
       * استخراج الكائن.
       */

      if (
        !action ||
        typeof action.action !==
          "string"
      ) {
        steps.push(
          {
            step:
              i + 1,

            ts:
              isoNow(),

            type:
              "invalid-json",

            raw:
              String(
                rawText
              ).slice(
                0,
                600
              ),
          }
        );

        contents.push(
          {
            role:
              "model",

            parts:
              [
                {
                  text:
                    String(
                      rawText
                    ).slice(
                      0,
                      4000
                    ),
                },
              ],
          }
        );

        contents.push(
          {
            role:
              "user",

            parts:
              [
                {
                  text:
                    "ردك مش كائن JSON صالح بالشكل المطلوب. رجّع بس واحد من الشكلين المتفق عليهم: call أو final، من غير أي نص إضافي.",
                },
              ],
          }
        );

        continue;
      }


      /* ------------------------------------------------------
         FINAL
         ------------------------------------------------------ */

      if (
        action.action ===
        "final"
      ) {
        const finalText =
          typeof action.text ===
          "string"
            ? sanitizeAssistantText(
                action.text
              )
            : "";

        steps.push(
          {
            step:
              i + 1,

            ts:
              isoNow(),

            type:
              "final",

            text:
              finalText,
          }
        );

        return {
          ok:
            true,

          steps,

          finalText,

          stopReason:
            "final",

          aiRouterAttempts,
        };
      }


      /* ------------------------------------------------------
         TOOL CALL
         ------------------------------------------------------ */

      if (
        action.action ===
        "call"
      ) {
        let calls =
          action.calls;


        if (
          calls &&
          !Array.isArray(
            calls
          )
        ) {
          calls =
            [
              calls,
            ];
        }


        if (
          !Array.isArray(
            calls
          ) ||
          calls.length === 0
        ) {
          steps.push(
            {
              step:
                i + 1,

              ts:
                isoNow(),

              type:
                "empty-call",
            }
          );

          contents.push(
            {
              role:
                "model",

              parts:
                [
                  {
                    text:
                      String(
                        rawText
                      ),
                  },
                ],
            }
          );

          contents.push(
            {
              role:
                "user",

              parts:
                [
                  {
                    text:
                      "حقل calls فاضي أو مش array. لازم يكون فيه عملية واحدة على الأقل، وكل عملية فيها name و args.",
                  },
                ],
            }
          );

          continue;
        }


        /*
         * تنفيذ الأدوات الفعلي يظل هنا بالكامل.
         * الـAI Router فقط هو الذي يقرر أي أداة
         * يجب استدعاؤها.
         */

        const results =
          await executeCalls(
            env,
            calls,
            eventId
          );


        const allOk =
          results.length > 0 &&
          results.every(
            (r) =>
              r.ok
          );


        steps.push(
          {
            step:
              i + 1,

            ts:
              isoNow(),

            type:
              "call",

            calls:
              calls
                .slice(
                  0,
                  10
                )
                .map(
                  (c) => ({
                    name:
                      c &&
                      c.name,

                    args:
                      c &&
                      c.args,
                  })
                ),

            results:
              results.map(
                (r) => ({
                  name:
                    r.name,

                  ok:
                    r.ok,

                  status:
                    r.status,

                  data:
                    JSON.stringify(
                      r.data
                    ).slice(
                      0,
                      400
                    ),
                })
              ),
          }
        );


        if (
          action.done ===
            true &&
          allOk
        ) {
          const summary =
            `تم تلقائيًا (done:true): ${calls
              .map(
                (c) =>
                  c &&
                  c.name
              )
              .join(", ")}`;


          return {
            ok:
              true,

            steps,

            finalText:
              summary,

            stopReason:
              "final",

            aiRouterAttempts,
          };
        }


        contents.push(
          {
            role:
              "model",

            parts:
              [
                {
                  text:
                    String(
                      rawText
                    ).slice(
                      0,
                      5000
                    ),
                },
              ],
          }
        );


        contents.push(
          {
            role:
              "user",

            parts:
              [
                {
                  text:
                    `نتيجة تنفيذ العمليات:\n${JSON.stringify(
                      results,
                      null,
                      2
                    ).slice(
                      0,
                      6000
                    )}`,
                },
              ],
          }
        );


        continue;
      }


      /* ------------------------------------------------------
         UNKNOWN ACTION
         ------------------------------------------------------ */

      steps.push(
        {
          step:
            i + 1,

          ts:
            isoNow(),

          type:
            "unknown-action",

          raw:
            String(
              action.action
            ).slice(
              0,
              100
            ),
        }
      );


      contents.push(
        {
          role:
            "model",

          parts:
            [
              {
                text:
                  String(
                    rawText
                  ).slice(
                    0,
                    4000
                  ),
              },
            ],
        }
      );


      contents.push(
        {
          role:
            "user",

          parts:
            [
              {
                text:
                  `"action": "${action.action}" مش معروف. استخدم بس: call أو final.`,
              },
            ],
        }
      );
    }


    return {
      ok:
        true,

      steps,

      finalText:
        null,

      stopReason:
        "max-steps",

      aiRouterAttempts,
    };
  } finally {
    /*
     * لا نريد أن نغيّر قيمة الـenv بشكل دائم
     * داخل نفس invocation.
     */
    env.AI_ROUTER_MODEL =
      originalModel;
  }
}

async function runAgentLoop(
  env,
  rawEventText,
  eventId,
  systemInstruction
) {
  const model =
    (typeof env.AI_ROUTER_MODEL === "string" ? env.AI_ROUTER_MODEL.trim() : "") ||
    AI_ROUTER_DEFAULT_MODEL;

  return runAgentLoopWithModel(
    env,
    rawEventText,
    eventId,
    model,
    systemInstruction
  );
}


// -----------------------------------------------------------------------------
// 6) معالجة الحدث الوارد
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

  // شبكة أمان شاملة: أي استثناء غير متوقع في أي نقطة تحت (خصوصًا الجلب
  // التلقائي للسياق، اللي كان مكشوف من غير حماية) لازم ينتج عنه سطر لوج
  // واحد على الأقل — الحدث ميختفيش بصمت تاني خالص.
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

    // جلب سياق تلقائي (بكود ثابت) + مؤشر كتابة للـ DM. contextFetched بيتسجل
    // في اللوج بالكامل عشان تشخيص أي مشكلة في وصول السياق للموديل.
    let rawEventText = rawBody;
    let contextFetched = null;

    if (eventType === "message.received") {
      const ids = extractMessageContext(payload);
      if (ids) {
        CALL_HANDLERS.typingIndicator(env, ids).catch(() => {}); // fire-and-forget
        const history = await CALL_HANDLERS.listMessages(env, { ...ids, limit: AUTO_CONTEXT_LIMIT, sortOrder: "desc" });
        contextFetched = { type: "messages", ids, ok: history.ok, status: history.status, data: history.data };
        rawEventText += `\n\nسياق آخر الرسائل (اتجابت تلقائيًا، مفيش داعي تطلبها تاني إلا لو محتاج أكتر من ${AUTO_CONTEXT_LIMIT} أو صفحة تانية):\n${JSON.stringify(history.data).slice(0, 3000)}`;
      } else {
        contextFetched = { type: "messages", error: "extractMessageContext فشل يلاقي conversationId/accountId — السياق ماتجابش خالص" };
      }
    } else if (eventType === "comment.received") {
      const ids = extractCommentContext(payload);
      if (ids) {
        const history = await CALL_HANDLERS.listComments(env, { ...ids, limit: AUTO_CONTEXT_LIMIT });
        contextFetched = { type: "comments", ids, ok: history.ok, status: history.status, data: history.data };
        rawEventText += `\n\nسياق تعليقات البوست ده (اتجابت تلقائيًا، مفيش داعي تطلبها تاني إلا لو محتاج أكتر):\n${JSON.stringify(history.data).slice(0, 3000)}`;
      } else {
        contextFetched = { type: "comments", error: "extractCommentContext فشل يلاقي postId/accountId — السياق ماتجابش خالص" };
      }
    }

    const bizStored = await kvGetJSON(env, BUSINESS_CONTEXT_KV_KEY);
    const systemInstruction = buildFinalSystemInstruction(bizStored && bizStored.text);

    const trace = await runAgentLoop(env, rawEventText, eventId, systemInstruction);

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
      aiRouterAttempts: trace.aiRouterAttempts,
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
      // نرمي استثناء (بعد ما سجّلنا كل حاجة فوق) عشان الطابور (Cloudflare
      // Queues) يمسك الفشل ده ويعيد المحاولة تلقائيًا — بعد استنفاد
      // max_retries، الرسالة بتروح لـ Dead Letter Queue بدل ما تضيع.
      throw new Error(`retry-requested:${entry.outcome}`);
    }
  } catch (err) {
    const finishedAt = isoNow();
    const errMsg = redactSecret(String((err && err.message) || err), env.ZERNIO_API_KEY);
    console.error("handleZernioEvent error", eventId, err);
    // لو الاستثناء ده هو الـ "retry-requested" اللي رميناه إحنا فوق بعد ما
    // سجّلنا كل حاجة خلاص، متسجلش تاني. أي استثناء تاني (غير متوقع، زي فشل
    // الجلب التلقائي للسياق) بيتسجل هنا كـ شبكة أمان أخيرة.
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
    // نعيد رمي الاستثناء لغاية استهلاك الطابور (queue consumer) — هو اللي
    // بيقرر يعيد المحاولة (message.retry()) اعتمادًا على وجود استثناء هنا.
    throw err;
  }
}

// -----------------------------------------------------------------------------
// 7) استقبال الـ webhook (تحقق توقيع + dedup + رد سريع + معالجة خلفية)
// -----------------------------------------------------------------------------

async function handleWebhook(request, env) {
  const receivedAt = isoNow();
  const rawBody = await request.text();

  // سجل غير مشروط: أي طلب POST يوصل هنا بيتسجل فورًا، قبل أي تحقق أو رفض —
  // عشان نضمن إن مفيش webhook بيوصل ويختفي من غير أثر خالص، حتى لو فشل في
  // أي خطوة بعد كده (توقيع غلط، JSON غير صالح...).
  await logActivity(env, {
    event: "webhook-received",
    outcome: "arrived",
    timing: { receivedAt },
    hasSignatureHeader: !!request.headers.get("X-Zernio-Signature"),
    bodyPreview: rawBody.length > 200 ? rawBody.slice(0, 200) + "…" : rawBody,
  });

  const signature = request.headers.get("X-Zernio-Signature");
  if (!signature) {
    await logActivity(env, { event: "webhook", outcome: "rejected-no-signature", timing: { receivedAt } });
    return textResponse("No signature provided.", 401);
  }
  if (!env.ZERNIO_WEBHOOK_SECRET) {
    await logActivity(env, { event: "webhook", outcome: "misconfigured", error: "ZERNIO_WEBHOOK_SECRET غير موجود", timing: { receivedAt } });
    return textResponse("Server not configured (ZERNIO_WEBHOOK_SECRET).", 500);
  }

  const computed = await hmacSha256Hex(env.ZERNIO_WEBHOOK_SECRET, rawBody);
  if (!safeEqualHex(computed, signature)) {
    await logActivity(env, { event: "webhook", outcome: "rejected-bad-signature", timing: { receivedAt } });
    return textResponse("Invalid signature", 400);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    await logActivity(env, { event: "webhook", outcome: "rejected-invalid-json", error: err.message, timing: { receivedAt } });
    return textResponse("Invalid JSON body", 400);
  }

  const eventId = request.headers.get("X-Zernio-Event-Id") || payload.id;
  if (eventId) {
    const dedupKey = `dedup:${eventId}`;
    const already = await env.ZERNIO_KV.get(dedupKey).catch(() => null);
    if (already) {
      await logActivity(env, { eventId, event: payload.event, outcome: "dedup-skip", timing: { receivedAt } });
      return jsonResponse({ ok: true, dedup: true });
    }
    await env.ZERNIO_KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS }).catch(() => {});
  }

  // بدل المعالجة الفورية في الخلفية، بنحط الحدث في طابور مضمون التسليم —
  // Cloudflare نفسها بتضمن وصول الرسالة وتعيد المحاولة تلقائيًا لو
  // المعالجة فشلت، وبعد استنفاد المحاولات بتحطها في Dead Letter Queue بدل
  // ما تضيع خالص.
  await env.EVENTS_QUEUE.send({ rawBody, payload, receivedAt });

  return jsonResponse({ ok: true });
}

// -----------------------------------------------------------------------------
// 8) /health
// -----------------------------------------------------------------------------

async function handleHealth(request, env) {
  const url = new URL(request.url);
  if (env.STATUS_KEY && url.searchParams.get("key") !== env.STATUS_KEY) {
    return jsonResponse({ ok: false, error: "Unauthorized. ضيف ?key=... في الرابط." }, 401);
  }

  const secrets = {
    ZERNIO_API_KEY: !!env.ZERNIO_API_KEY,
    ZERNIO_WEBHOOK_SECRET: !!env.ZERNIO_WEBHOOK_SECRET,
    AI_ROUTER_API_KEY: !!env.AI_ROUTER_API_KEY,
    AI_ROUTER_URL: !!env.AI_ROUTER_URL,
    ADMIN_KEY: !!env.ADMIN_KEY,
  };

  let zernioRest = { connected: false };
  try {
    const res = await fetch(`${ZERNIO_API_BASE}/accounts`, {
      headers: { Authorization: `Bearer ${env.ZERNIO_API_KEY || ""}` },
    });
    if (res.ok) {
      const data = await res.json();
      zernioRest = { connected: true, accountCount: ((data && data.accounts) || []).length };
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

// -----------------------------------------------------------------------------
// 9) /health/review
// -----------------------------------------------------------------------------

async function handleReviewQueue(request, env) {
  const url = new URL(request.url);
  if (env.STATUS_KEY && url.searchParams.get("key") !== env.STATUS_KEY) {
    return jsonResponse({ ok: false, error: "Unauthorized. ضيف ?key=... في الرابط." }, 401);
  }

  const resolveId = url.searchParams.get("resolve");
  if (resolveId) {
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
// 10) /dashboard — صفحة متابعة بشرية بتحدّث نفسها لوحدها كل 5 ثواني
// -----------------------------------------------------------------------------

async function handleDashboard(request, env) {
  const url = new URL(request.url);
  if (env.STATUS_KEY && url.searchParams.get("key") !== env.STATUS_KEY) {
    return textResponse("Unauthorized. ضيف ?key=... في الرابط.", 401);
  }
  const keyQs = env.STATUS_KEY ? `?key=${encodeURIComponent(url.searchParams.get("key"))}` : "";

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>لوحة متابعة Zernio Agent</title>
<style>
  body { background:#0b0e14; color:#d8dee9; font-family: -apple-system, "Segoe UI", Tahoma, sans-serif; margin:0; padding:16px; }
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
<h1>لوحة متابعة Zernio Social Inbox Agent — بتحدّث نفسها كل 5 ثواني</h1>
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
// 11) /admin — إدارة سياق النشاط التجاري (الجزء الديناميكي من الـ system prompt)
// -----------------------------------------------------------------------------
//
// كلهم محميين بـ ADMIN_KEY (منفصل عن STATUS_KEY بتاع الداشبورد للقراءة فقط
// — القدرة على تغيير رد النشاط التجاري أخطر من مجرد متابعته).

function checkAdminKey(request, env) {
  const url = new URL(request.url);
  return Boolean(env.ADMIN_KEY) && url.searchParams.get("key") === env.ADMIN_KEY;
}

// GET /admin/business-context — عرض السياق الديناميكي المحفوظ حاليًا، وشكل
// الـ system prompt الكامل بعد الدمج (للمراجعة والتأكد).
async function handleGetBusinessContext(request, env) {
  if (!checkAdminKey(request, env)) {
    return jsonResponse({ ok: false, error: "Unauthorized. ضيف ?key=... بمفتاح ADMIN_KEY الصحيح." }, 401);
  }
  const stored = await kvGetJSON(env, BUSINESS_CONTEXT_KV_KEY);
  const text = (stored && stored.text) || "";
  return jsonResponse({
    ok: true,
    businessContext: text,
    updatedAt: (stored && stored.updatedAt) || null,
    fullSystemPrompt: buildFinalSystemInstruction(text),
  });
}

// POST /admin/business-context — استبدال يدوي مباشر (body: {"text": "..."}) —
// من غير أي استدعاء AI، لتحرير نصي سريع.
async function handlePostBusinessContext(request, env) {
  if (!checkAdminKey(request, env)) {
    return jsonResponse({ ok: false, error: "Unauthorized. ضيف ?key=... بمفتاح ADMIN_KEY الصحيح." }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: "الجسم لازم يكون JSON صالح." }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return jsonResponse({ ok: false, error: 'محتاج حقل "text" نصي غير فاضي.' }, 400);

  await kvSetJSON(env, BUSINESS_CONTEXT_KV_KEY, { text, updatedAt: isoNow() });
  return jsonResponse({ ok: true, businessContext: text });
}

// POST /admin/upload-context — رفع ملف أو اتنين (multipart/form-data، حقل
// "file" مكرر لو اتنين)، بيتبعتوا لـ Gemini مع السياق الحالي (لو موجود)
// عشان يرجّع ملخص واحد متجانس محدّث، وده اللي بيتحفظ كسياق جديد.
async function handleUploadContext(request, env) {
  if (!checkAdminKey(request, env)) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unauthorized. ضيف ?key=... بمفتاح ADMIN_KEY الصحيح.",
      },
      401
    );
  }

  let form;

  try {
    form =
      await request.formData();
  } catch (err) {
    return jsonResponse(
      {
        ok: false,

        error:
          "الطلب لازم يكون multipart/form-data بحقل file.",
      },
      400
    );
  }

  const files =
    form
      .getAll("file")
      .filter(
        (f) =>
          f &&
          typeof f.text ===
            "function"
      );


  if (!files.length) {
    return jsonResponse(
      {
        ok:
          false,

        error:
          'محتاج ملف واحد على الأقل في حقل "file".',
      },
      400
    );
  }


  if (files.length > 2) {
    return jsonResponse(
      {
        ok:
          false,

        error:
          "حد أقصى ملفين في المرة الواحدة.",
      },
      400
    );
  }


  const existing =
    await kvGetJSON(
      env,
      BUSINESS_CONTEXT_KV_KEY
    );


  const existingText =
    (
      existing &&
      existing.text
    ) ||
    "";


  const extractedFiles =
    [];


  try {
    for (
      const file of
        files
    ) {
      const extracted =
        await extractTextFromUploadedFile(
          file
        );

      extractedFiles.push(
        extracted
      );
    }
  } catch (err) {
    return jsonResponse(
      {
        ok:
          false,

        error:
          err?.message ||
          String(err),
      },
      415
    );
  }


  let combined =
    "";


  for (
    const file of
      extractedFiles
  ) {
    combined +=
      `\n\n===== FILE: ${file.name} =====\n` +
      file.text;
  }


  /*
   * حماية من إدخال ملف ضخم جدًا في رسالة واحدة.
   * الحد هنا لكل ملف بعد الاستخراج النصي.
   */
  const MAX_FILE_CHARS =
    50000;


  const safeCombined =
    combined.slice(
      0,
      MAX_FILE_CHARS
    );


  const instruction =
    [
      "إنت مساعد بتلخّص مستندات نشاط تجاري عشان تتحط كسياق لوكيل رد آلي على العملاء عبر الرسائل والتعليقات.",

      existingText
        ? `السياق الحالي المحفوظ فعلاً:\n${existingText}\n`
        : "",

      "ادمج السياق الحالي (لو موجود) مع محتوى الملفات في ملخص واحد متجانس بالعربي، مركّز وعملي.",

      "ركّز على الخدمات، الأسعار، السياسات، الشروط، أوقات العمل، طرق التواصل، والأسئلة الشائعة.",

      `الحد الأقصى للملخص تقريبًا ${BUSINESS_CONTEXT_MAX_WORDS} كلمة.`,

      "رجّع النص النهائي فقط، من غير مقدمة أو markdown أو تفسير لطريقة عملك.",

      `محتوى الملفات:\n${safeCombined}`,
    ]
      .filter(Boolean)
      .join(
        "\n\n"
      );


  let summary;


  try {
    summary =
      await callAIRouterForSummary(
        env,
        instruction
      );
  } catch (err) {
    return jsonResponse(
      {
        ok:
          false,

        error:
          String(
            err?.message ||
            err
          ),
      },
      502
    );
  }


  if (!summary) {
    return jsonResponse(
      {
        ok:
          false,

        error:
          "AI Router رجّع رد فاضي.",
      },
      502
    );
  }


  await kvSetJSON(
    env,
    BUSINESS_CONTEXT_KV_KEY,
    {
      text:
        summary,

      updatedAt:
        isoNow(),
    }
  );


  return jsonResponse(
    {
      ok:
        true,

      businessContext:
        summary,

      filesProcessed:
        files.length,

      aiProvider:
        "ai-router",
    }
  );
}

// -----------------------------------------------------------------------------
// 12) نقطة الدخول الرئيسية
// -----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/webhook/zernio") {
        return await handleWebhook(request, env);
      }

      if (request.method === "GET" && url.pathname === "/webhook/zernio") {
        return textResponse("Zernio webhook endpoint — استخدم POST هنا لتسجيل الأحداث.");
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

      if (request.method === "GET" && url.pathname === "/admin/business-context") {
        return await handleGetBusinessContext(request, env);
      }

      if (request.method === "POST" && url.pathname === "/admin/business-context") {
        return await handlePostBusinessContext(request, env);
      }

      if (request.method === "POST" && url.pathname === "/admin/upload-context") {
        return await handleUploadContext(request, env);
      }

      return textResponse("Not found", 404);
    } catch (err) {
      console.error("Unhandled fetch error", err);
      await logActivity(env, { event: "webhook", outcome: "fatal-error", error: err.message, timing: { receivedAt: isoNow() } }).catch(() => {});
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },

  // مستهلك الطابور (Cloudflare Queues) — بيستقبل الأحداث اللي handleWebhook
  // حطها في الطابور، ويعالج كل واحدة فعليًا. لو نجحت، بنأكدها (ack) وتتشال
  // من الطابور. لو فشلت (handleZernioEvent رمى استثناء)، بنطلب إعادة
  // المحاولة (retry) — Cloudflare بتعيد المحاولة تلقائيًا حسب max_retries
  // المتظبطة في wrangler.jsonc، وبعد استنفادها بتحط الرسالة في Dead Letter
  // Queue بدل ما تضيع خالص.
  async queue(batch, env) {
    // طابور الـ Dead Letter — رسائل استنفدت كل محاولات الطابور الرئيسي.
    // بنسجلها بس عشان تبقى ظاهرة في /health و/dashboard، من غير أي إعادة
    // معالجة تلقائية تانية (لتفادي حلقة فاشلة لانهائية على حدث عالق).
    if (batch.queue && batch.queue.endsWith("-dlq")) {
      for (const message of batch.messages) {
        const { rawBody, payload, receivedAt } = message.body || {};
        await logActivity(env, {
          eventId: payload && payload.id,
          event: (payload && payload.event) || "unknown",
          outcome: "dead-lettered",
          timing: { receivedAt },
          note: "استنفدت كل محاولات إعادة المعالجة في الطابور الرئيسي — محتاجة مراجعة يدوية.",
        }).catch(() => {});
        message.ack();
      }
      return;
    }
function getNumberEnv(val, defaultValue) {
  if (val === undefined || val === null || val === "") return defaultValue;
  const num = Number(val);
  return isNaN(num) ? defaultValue : num;
}
    // الطابور الرئيسي — تأخير متصاعد بين كل محاولة وإعادة المحاولة اللي
    // بعدها (30 ثانية، 60، 120، 240...) عشان لو المشكلة مؤقتة (ازدحام عند
    // موديل معين مثلاً) تاخد وقت تتعافى بدل ما نضرب في نفس الحيط فورًا.
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
