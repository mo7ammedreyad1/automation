// =============================================================================
// Zernio Social Inbox Agent — Cloudflare Worker (v6: Workers AI via REST + تشخيص)
// =============================================================================
//
// جديد في v6:
//
// 1) Workers AI بقى عن طريق REST API (مش env.AI binding) — نداء fetch عادي
//    على https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/{model}
//    بـ Bearer token. محتاج secretين جدد:
//      CLOUDFLARE_API_TOKEN   — من Dashboard → My Profile → API Tokens
//                                (صلاحية Workers AI)
//      CLOUDFLARE_ACCOUNT_ID  — رقم حسابك في Cloudflare
//    الـ "ai" binding اللي ضفناه في wrangler.jsonc قبل كده بقى غير مستخدم —
//    مش لازم تشيله (مبيضرش)، بس مش شرط تبقيه.
//
// 2) ضفنا @cf/google/gemma-3-12b-it لقائمة الموديلات (بدل فكرة gemma-7b-it-lora
//    القديمة اللي كانت base model لـ LoRA مش موديل محادثة عادي). الترتيب
//    الحالي (افتراض مني، قابل للتغيير): deepseek-r1-distill-qwen-32b ثم
//    llama-3.2-11b-vision-instruct ثم gemma-3-12b-it ثم Gemini أخيرًا.
//
// 3) كل log entry دلوقتي فيه حقل "contextFetched" بيوضح بالظبط السياق اللي
//    اتجاب تلقائيًا (listMessages/listComments) قبل أول دور للموديل — أو
//    سبب الفشل لو الاستخراج (conversationId/accountId أو postId/accountId)
//    فشل من الأساس. ده عشان تشخيص مشكلة "الموديل مش عارف يجيب السياق"
//    بالدليل مش بالتخمين.
//
// 4) /health بقى فيه حقل "tools" (تحت "zernioRest" مباشرة) بقائمة مرجعية
//    لكل الـ operations المتاحة للموديل، للتذكرة بس.
//
// ⚠️ postId في حدث comment.received لازم يكون platformPostId (مش postId/id
// اللي ممكن يوصلوا فاضيين لو البوست مش منشور من خلال Zernio نفسها).
//
// الاستثناء الأمني الوحيد المكتوب في الكود: تجاهل أي حدث صادر من الحساب
// نفسه (comment.author.isOwnAccount، أو message.direction != incoming).
//
// الأسرار المطلوبة (Cloudflare Dashboard أو wrangler secret put):
//   ZERNIO_API_KEY, ZERNIO_WEBHOOK_SECRET, GEMINI_API_KEY,
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
//   GEMINI_MODELS (اختياري), STATUS_KEY (اختياري)
//
// Binding المطلوب في wrangler.jsonc: ZERNIO_KV (KV) بس. الـ "ai" binding
// اختياري دلوقتي (مش مستخدم).
// =============================================================================

// -----------------------------------------------------------------------------
// 1) ثوابت عامة
// -----------------------------------------------------------------------------

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const CLOUDFLARE_AI_BASE = "https://api.cloudflare.com/client/v4/accounts";

// الترتيب = ترتيب المحاولة الفعلي.
const WORKERS_AI_MODELS = [
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/google/gemma-3-12b-it",
];

const DEFAULT_GEMINI_MODELS = ["gemini-3.1-flash-lite"];
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60;
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOG_LIST_LIMIT = 30;

const MAX_AGENT_STEPS = 10;

// حد أقصى لوقت أي نداء REST واحد على Zernio.
const CALL_TIMEOUT_MS = 15000;
// حد أقصى لوقت نداء موديل واحد (Workers AI عن طريق REST) — أسخى شوية لأن
// موديلات التفكير (reasoning) ممكن تاخد وقت أطول.
const AI_CALL_TIMEOUT_MS = 30000;

// كام رسالة/تعليق نجيبهم تلقائيًا كسياق قبل أول دور للموديل.
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
// 4) عملاء الموديلات (Workers AI عن طريق REST أولاً، Gemini fallback)
// -----------------------------------------------------------------------------

function parseCommaList(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function buildModelCombos(env) {
  const combos = [];
  for (const model of WORKERS_AI_MODELS) combos.push({ provider: "workers-ai", model });

  const geminiKeys = parseCommaList(env.GEMINI_API_KEY);
  const geminiModels = parseCommaList(env.GEMINI_MODELS);
  const finalGeminiModels = geminiModels.length ? geminiModels : DEFAULT_GEMINI_MODELS;
  for (const model of finalGeminiModels) for (const key of geminiKeys) combos.push({ provider: "gemini", model, key });

  return combos;
}

async function callGeminiTurnFixed(env, contents, systemInstruction, combo, attemptsLog) {
  const { key, model } = combo;
  const res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const msg = `Gemini HTTP ${res.status} (${model}): ${errText.slice(0, 300)}`;
    if (attemptsLog) attemptsLog.push({ provider: "gemini", model, status: res.status, ok: false, note: msg });
    throw new Error(msg);
  }

  if (attemptsLog) attemptsLog.push({ provider: "gemini", model, status: res.status, ok: true });
  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  return parts.map((p) => p.text || "").join("\n");
}

function contentsToMessages(systemInstruction, contents) {
  const messages = [{ role: "system", content: systemInstruction }];
  for (const c of contents) {
    const text = (c.parts || []).map((p) => p.text || "").join("\n");
    messages.push({ role: c.role === "model" ? "assistant" : "user", content: text });
  }
  return messages;
}

// دفاعي: أشكال رد مختلفة ممكنة — REST بيلف النتيجة في {result:{...}}.
function extractWorkersAiText(data) {
  const inner = data && typeof data === "object" && "result" in data ? data.result : data;
  if (typeof inner === "string") return inner;
  if (inner && typeof inner.response === "string") return inner.response;
  if (inner && inner.result && typeof inner.result.response === "string") return inner.result.response;
  if (inner && Array.isArray(inner.choices) && inner.choices[0] && inner.choices[0].message) {
    return inner.choices[0].message.content || "";
  }
  try {
    return JSON.stringify(inner);
  } catch (_) {
    return String(inner);
  }
}

async function callWorkersAiTurn(env, contents, systemInstruction, combo, attemptsLog) {
  const messages = contentsToMessages(systemInstruction, contents);
  const url = `${CLOUDFLARE_AI_BASE}/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${combo.model}`;

  let res, bodyText;
  try {
    res = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages, response_format: { type: "json_object" } }),
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`انتهت مهلة نداء Workers AI (${AI_CALL_TIMEOUT_MS / 1000}s)`)), AI_CALL_TIMEOUT_MS)
      ),
    ]);
    bodyText = await res.text();
  } catch (err) {
    const msg = `Workers AI REST error (${combo.model}): ${(err && err.message) || err}`;
    if (attemptsLog) attemptsLog.push({ provider: "workers-ai", model: combo.model, ok: false, note: msg });
    throw new Error(msg);
  }

  let data;
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch (_) {
    data = { raw: bodyText.slice(0, 500) };
  }

  if (!res.ok) {
    const errMsg =
      data && Array.isArray(data.errors) && data.errors.length
        ? data.errors.map((e) => e.message || e.code).join("; ")
        : JSON.stringify(data).slice(0, 300);
    const msg = `Workers AI REST HTTP ${res.status} (${combo.model}): ${errMsg}`;
    if (attemptsLog) attemptsLog.push({ provider: "workers-ai", model: combo.model, status: res.status, ok: false, note: msg });
    throw new Error(msg);
  }

  if (attemptsLog) attemptsLog.push({ provider: "workers-ai", model: combo.model, status: res.status, ok: true });
  return extractWorkersAiText(data);
}

async function callModelTurn(env, contents, systemInstruction, combo, attemptsLog) {
  if (combo.provider === "workers-ai") return callWorkersAiTurn(env, contents, systemInstruction, combo, attemptsLog);
  return callGeminiTurnFixed(env, contents, systemInstruction, combo, attemptsLog);
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
  '- deleteComment — args: { postId (platformPostId!), accountId, commentId } (اختياري)',
  '- listComments — args: { postId (platformPostId!), accountId, limit?, cursor? } — استخدمها بس لو محتاج أكتر من السياق الجاهز اللي وصلك.',
  "",
  "طريقة عملك:",
  "1. حدد نوع الحدث وابدأ تقرا الحقول الخاصة بيه بعناية — استخرج الـ IDs الحقيقية بالظبط زي ما ظهروا في النص، مع مراعاة قاعدة platformPostId للتعليقات.",
  "2. لو أي عملية رجعت ok:false، اقرا data.error/data.status وصحح الـ args قبل ما تعيد المحاولة.",
  "3. اكتب رد العميل بنفس لغته (عربي فصحى أو عامية أو إنجليزي)، ودود ومختصر ومحترف.",
  "4. لما تكون متأكد إن العملية اللي هتنفذها هي آخر حاجة مطلوبة، استخدم done:true بدل ما تاخد دور إضافي بس عشان تقول final.",
].join("\n");

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

async function runAgentLoopWithModel(env, rawEventText, combo, eventId) {
  const contents = [{ role: "user", parts: [{ text: rawEventText }] }];
  const steps = [];
  const geminiAttempts = [];

  for (let i = 0; i < MAX_AGENT_STEPS; i++) {
    let rawText;
    try {
      rawText = await callModelTurn(env, contents, AGENT_SYSTEM_INSTRUCTION, combo, geminiAttempts);
    } catch (err) {
      return { ok: false, steps, finalText: null, stopReason: "error", error: err.message, geminiAttempts };
    }

    const action = extractJsonObject(rawText);

    if (!action || typeof action.action !== "string") {
      steps.push({ step: i + 1, ts: isoNow(), type: "invalid-json", raw: String(rawText).slice(0, 300) });
      contents.push({ role: "model", parts: [{ text: String(rawText).slice(0, 2000) }] });
      contents.push({
        role: "user",
        parts: [{ text: "ردك مش كائن JSON صالح بالشكل المطلوب. رجّع بس واحد من الشكلين المتفق عليهم: call أو final، من غير أي نص إضافي." }],
      });
      continue;
    }

    if (action.action === "final") {
      const finalText = typeof action.text === "string" ? action.text : "";
      steps.push({ step: i + 1, ts: isoNow(), type: "final", text: finalText });
      return { ok: true, steps, finalText, stopReason: "final", geminiAttempts };
    }

    if (action.action === "call") {
      let calls = action.calls;
      if (calls && !Array.isArray(calls)) calls = [calls];
      if (!Array.isArray(calls) || calls.length === 0) {
        steps.push({ step: i + 1, ts: isoNow(), type: "empty-call" });
        contents.push({ role: "model", parts: [{ text: rawText }] });
        contents.push({
          role: "user",
          parts: [{ text: "حقل calls فاضي أو مش array. لازم يكون فيه عملية واحدة على الأقل، كل واحدة فيها name و args." }],
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
        const summary = `تم تلقائيًا (done:true): ${calls.map((c) => c && c.name).join(", ")}`;
        return { ok: true, steps, finalText: summary, stopReason: "final", geminiAttempts };
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

  return { ok: true, steps, finalText: null, stopReason: "max-steps", geminiAttempts };
}

async function runAgentLoop(env, rawEventText, eventId) {
  const combos = buildModelCombos(env);
  if (!combos.length) {
    return { steps: [], finalText: null, stopReason: "error", error: "مفيش أي provider متظبط", geminiAttempts: [] };
  }

  let lastResult = null;
  for (const combo of combos) {
    const result = await runAgentLoopWithModel(env, rawEventText, combo, eventId);
    if (result.ok) return result;
    lastResult = result;
    const hadRealAction = result.steps.some((s) => s.type === "call");
    if (hadRealAction) return result;
  }
  return lastResult || { steps: [], finalText: null, stopReason: "error", error: "كل الموديلات فشلت", geminiAttempts: [] };
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
      geminiAttempts: trace.geminiAttempts,
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
    }
  } catch (err) {
    // آخر خط دفاع: استثناء مايتوقعش (زي فشل نداء الجلب التلقائي بره try/catch
    // خاصة بيه) — لسه بيتسجل هنا بدل ما يضيع بصمت.
    const finishedAt = isoNow();
    const errMsg = redactSecret(String((err && err.message) || err), env.ZERNIO_API_KEY);
    console.error("handleZernioEvent fatal error", eventId, err);
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
}

// -----------------------------------------------------------------------------
// 7) استقبال الـ webhook (تحقق توقيع + dedup + رد سريع + معالجة خلفية)
// -----------------------------------------------------------------------------

async function handleWebhook(request, env, ctx) {
  const receivedAt = isoNow();
  const rawBody = await request.text();

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

  ctx.waitUntil(handleZernioEvent(env, rawBody, payload, receivedAt));

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
    GEMINI_API_KEY: !!env.GEMINI_API_KEY,
    CLOUDFLARE_API_TOKEN: !!env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: !!env.CLOUDFLARE_ACCOUNT_ID,
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
// 10) نقطة الدخول الرئيسية
// -----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/webhook/zernio") {
        return await handleWebhook(request, env, ctx);
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

      return textResponse("Not found", 404);
    } catch (err) {
      console.error("Unhandled fetch error", err);
      await logActivity(env, { event: "webhook", outcome: "fatal-error", error: err.message, timing: { receivedAt: isoNow() } }).catch(() => {});
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },
};
