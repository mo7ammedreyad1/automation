// =============================================================================
// Zernio SaaS Agent Worker (v9.2: Hardcoded Account Credentials Enabled)
// =============================================================================

// 👇 ضع بيانات حساب Zernio الخاص بهذا الـ Worker هنا مباشرة 👇
const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const CLOUDFLARE_AI_BASE = "https://api.cloudflare.com/client/v4/accounts";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const WORKERS_AI_MODELS = [
  "@cf/google/gemma-3-12b-it",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/google/gemma-3-12b-it",
];
const DEFAULT_GEMINI_MODELS = ["gemini-3.1-flash-lite"];

const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60;
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOG_LIST_LIMIT = 30;
const MAX_AGENT_STEPS = 10;
const CALL_TIMEOUT_MS = 15000;
const AI_CALL_TIMEOUT_MS = 30000;
const WORKERS_AI_MAX_TOKENS = 1024;
const AUTO_CONTEXT_LIMIT = 20;

// إعدادات CORS للسماح لتطبيقك وصفحة الاختبار بالاتصال بالـ Worker
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zernio-key',
};

// -----------------------------------------------------------------------------
// 1) API PROXY: Endpoints الخاصة بالتطبيق
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
    const path = url.pathname;
    
    // الأولوية للمفتاح المكتوب في أول الكود، أو المسجل بـ Cloudflare
    const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
    const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

    // 1. مسار حفظ تعليمات العميل (System Prompt) في الـ KV
    if (request.method === 'POST' && path === '/api/set-prompt') {
        const body = await request.json().catch(() => ({}));
        if (!body.prompt) {
            return new Response(JSON.stringify({ error: 'حقل prompt مفقود في الطلب' }), { 
                status: 400, 
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
        await env.ZERNIO_KV.put('custom_agent_prompt', body.prompt);
        return new Response(JSON.stringify({ ok: true, message: 'تم حفظ التعليمات في البوت بنجاح' }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // 2. مسار جلب رابط تفويض الفيسبوك
    if (request.method === 'GET' && path === '/api/auth/facebook') {
        const redirectUrl = url.searchParams.get('redirect_url') || '';
        const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook?profileId=${PROFILE_ID}&headless=true&redirect_url=${encodeURIComponent(redirectUrl)}`;

        const res = await fetch(zernioUrl, { 
            headers: { 
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            } 
        });

        const data = await res.json().catch(() => ({}));
        return new Response(JSON.stringify(data), { 
            status: res.status, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // 3. مسار تأكيد ربط صفحة الفيسبوك
    if (request.method === 'POST' && path === '/api/auth/facebook/select') {
        const body = await request.json().catch(() => ({}));
        body.profileId = PROFILE_ID; 

        const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook/select-page`;
        const res = await fetch(zernioUrl, { 
            method: 'POST', 
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

    // 4. مسار جلب رابط تفويض الإنستغرام
    if (request.method === 'GET' && path === '/api/auth/instagram') {
        const redirectUrl = url.searchParams.get('redirect_url') || '';
        const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
        const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;

        const res = await fetch(zernioUrl, { 
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } 
        });
        const data = await res.json().catch(() => ({}));
        return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

    // 5. مسار جلب حسابات الإنستغرام
    if (request.method === 'GET' && path === '/api/auth/instagram/accounts') {
        const tempToken = url.searchParams.get('tempToken');
        const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram/select-account?profileId=${PROFILE_ID}&tempToken=${tempToken}`;
        const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
        const data = await res.json().catch(() => ({}));
        return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

    // 6. مسار تأكيد ربط حساب الإنستغرام
    if (request.method === 'POST' && path === '/api/auth/instagram/select') {
        const body = await request.json().catch(() => ({}));
        body.profileId = PROFILE_ID;

        const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram/select-account`;
        const res = await fetch(zernioUrl, { 
            method: 'POST', 
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

    return new Response(JSON.stringify({ error: 'المسار غير موجود (Endpoint not found)' }), { status: 404, headers: corsHeaders });
}

// -----------------------------------------------------------------------------
// 2) أدوات مساعدة عامة
// -----------------------------------------------------------------------------
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders } });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders } });
}

function bufferToHex(buffer) { return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

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

function isoNow() { return new Date().toISOString(); }
function shortId() { return crypto.randomUUID().slice(0, 8); }

async function kvGetJSON(env, key) {
  try {
    const raw = await env.ZERNIO_KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) { return null; }
}

async function kvSetJSON(env, key, value, ttlSeconds) {
  try {
    await env.ZERNIO_KV.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  } catch (err) {}
}

async function logActivity(env, entry) {
  await kvSetJSON(env, `log:${isoNow()}:${shortId()}`, entry, LOG_TTL_SECONDS);
}

function redactSecret(text, secret) {
  if (!secret || typeof text !== "string") return text;
  return text.split(secret).join("[REDACTED]");
}

// -----------------------------------------------------------------------------
// 3) كتالوج العمليات المسموحة (CALL HANDLERS)
// -----------------------------------------------------------------------------
async function zernioFetch(env, path, options = {}) {
  const apiKey = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const url = `${ZERNIO_API_BASE}${path}`;
  const headers = Object.assign({ Authorization: `Bearer ${apiKey}` }, options.body ? { "Content-Type": "application/json" } : {}, options.headers || {});
  const res = await Promise.race([
    fetch(url, { ...options, headers }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`انتهت مهلة نداء REST`)), CALL_TIMEOUT_MS))
  ]);
  const bodyText = await res.text();
  let data;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { data = { raw: bodyText.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
}

function missingArgsError(names) { return { ok: false, status: 0, data: { error: `محتاج الحقول دي: ${names.join(", ")}` } }; }

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
    if (!message && !attachmentUrl) return missingArgsError(["message أو attachmentUrl (واحد منهم على الأقل)"]);
    const body = { accountId };
    if (message) body.message = message;
    if (attachmentUrl) { body.attachmentUrl = attachmentUrl; body.attachmentType = attachmentType || "file"; }
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", body: JSON.stringify(body), headers });
  },

  async typingIndicator(env, args) {
    const { conversationId, accountId } = args || {};
    if (!conversationId || !accountId) return missingArgsError(["conversationId", "accountId"]);
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, { method: "POST", body: JSON.stringify({ accountId }) });
  },

  async addReaction(env, args) {
    const { conversationId, accountId, messageId, emoji } = args || {};
    if (!conversationId || !accountId || !messageId || !emoji) return missingArgsError(["conversationId", "accountId", "messageId", "emoji"]);
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions`, { method: "POST", body: JSON.stringify({ accountId, emoji }) });
  },

  async listComments(env, args) {
    const { postId, accountId, limit, cursor, subreddit, commentId } = args || {};
    if (!postId || !accountId) return missingArgsError(["postId", "accountId"]);
    const qs = new URLSearchParams({ accountId });
    if (limit) qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}?${qs}`, { method: "GET" });
  },

  async replyToComment(env, args, idempotencyKey) {
    const { postId, accountId, message, attachmentUrl, commentId } = args || {};
    if (!postId || !accountId || !message) return missingArgsError(["postId", "accountId", "message"]);
    const body = { accountId, message };
    if (attachmentUrl) body.attachmentUrl = attachmentUrl;
    if (commentId) body.commentId = commentId;
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}`, { method: "POST", body: JSON.stringify(body), headers });
  },

  async sendPrivateReply(env, args, idempotencyKey) {
    const { postId, commentId, accountId, message } = args || {};
    if (!postId || !commentId || !accountId || !message) return missingArgsError(["postId", "commentId", "accountId", "message"]);
    const body = { accountId, message };
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/private-reply`, { method: "POST", body: JSON.stringify(body), headers });
  }
};

const IDEMPOTENT_WRITE_OPS = new Set(["sendMessage", "replyToComment", "sendPrivateReply"]);

async function buildIdempotencyKey(eventId, name, args) {
  const raw = `${eventId || "noevent"}:${name}:${JSON.stringify(args || {})}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return bufferToHex(buf).slice(0, 40);
}

async function executeCalls(env, calls, eventId) {
  const apiKey = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const results = [];
  for (const c of calls) {
    const name = c && c.name;
    const handler = CALL_HANDLERS[name];
    if (!handler) {
      results.push({ name, ok: false, data: { error: `عملية غير معروفة: "${name}"` } });
      continue;
    }
    try {
      const idempotencyKey = IDEMPOTENT_WRITE_OPS.has(name) ? await buildIdempotencyKey(eventId, name, c.args) : undefined;
      const r = await handler(env, c.args || {}, idempotencyKey);
      results.push({ name, ok: r.ok, status: r.status, data: r.data });
    } catch (err) {
      results.push({ name, ok: false, data: { error: redactSecret(String(err.message), apiKey) } });
    }
  }
  return results;
}

// -----------------------------------------------------------------------------
// 4) محرك الذكاء الاصطناعي مع دمج الـ System Prompt من KV
// -----------------------------------------------------------------------------
async function getDynamicSystemInstruction(env) {
  let customPrompt = await env.ZERNIO_KV.get('custom_agent_prompt');
  if (!customPrompt) customPrompt = "أنت وكيل خدمة عملاء ذكي ومحترف، ترد بلباقة على استفسارات العملاء.";

  return [
    "=== تعليمات شخصية الوكيل (أولويات قصوى) ===",
    customPrompt,
    "",
    "=== قواعد عمل النظام (يجب الالتزام بها حرفياً) ===",
    "أنت وكيل ذكي بيرد على رسائل الـ Direct Messages والتعليقات.",
    "حدثين بس: event = \"message.received\" أو event = \"comment.received\".",
    "طريقة الرد (مهم جدًا): كل رد منك لازم يكون كائن JSON واحد بس، بواحد من الشكلين دول بالظبط:",
    '1) {"action": "call", "calls": [{"name": "اسم العملية", "args": {...}}, ...], "done": true}',
    '2) {"action": "final", "text": "..."}',
    "",
    "── كتالوج الـ DM (event = message.received) ──",
    '- sendMessage — args: { conversationId, accountId, message? (نص), attachmentUrl? }',
    '- addReaction — args: { conversationId, accountId, messageId, emoji }',
    "",
    "── كتالوج التعليقات (event = comment.received) ──",
    '- replyToComment — args: { postId, accountId, message, attachmentUrl?, commentId? }',
    '- sendPrivateReply — args: { postId, commentId, accountId, message }'
  ].join("\n");
}

function parseCommaList(value) { return (value || "").split(",").map((s) => s.trim()).filter(Boolean); }

function buildModelCombos(env) {
  const combos = [];
  for (const model of WORKERS_AI_MODELS) combos.push({ provider: "workers-ai", model });
  const geminiKeys = parseCommaList(env.GEMINI_API_KEY);
  const geminiModels = parseCommaList(env.GEMINI_MODELS).length ? parseCommaList(env.GEMINI_MODELS) : DEFAULT_GEMINI_MODELS;
  for (const model of geminiModels) for (const key of geminiKeys) combos.push({ provider: "gemini", model, key });
  return combos;
}

function extractJsonObject(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
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

function contentsToMessages(systemInstruction, contents) {
  const messages = [{ role: "system", content: systemInstruction }];
  for (const c of contents) {
    const text = (c.parts || []).map((p) => p.text || "").join("\n");
    messages.push({ role: c.role === "model" ? "assistant" : "user", content: text });
  }
  return messages;
}

function extractWorkersAiText(data) {
  const inner = data && typeof data === "object" && "result" in data ? data.result : data;
  if (typeof inner === "string") return inner;
  if (inner && typeof inner.response === "string") return inner.response;
  if (inner && inner.result && typeof inner.result.response === "string") return inner.result.response;
  if (inner && Array.isArray(inner.choices) && inner.choices[0] && inner.choices[0].message) return inner.choices[0].message.content || "";
  try { return JSON.stringify(inner); } catch (_) { return String(inner); }
}

async function callWorkersAiTurn(env, contents, systemInstruction, combo, attemptsLog) {
  const messages = contentsToMessages(systemInstruction, contents);
  const url = `${CLOUDFLARE_AI_BASE}/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${combo.model}`;
  let res, bodyText;
  try {
    res = await Promise.race([
      fetch(url, { method: "POST", headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ messages, response_format: { type: "json_object" }, max_tokens: WORKERS_AI_MAX_TOKENS }) }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), AI_CALL_TIMEOUT_MS))
    ]);
    bodyText = await res.text();
  } catch (err) { throw new Error(err.message); }

  let data; try { data = JSON.parse(bodyText); } catch (_) { data = { raw: bodyText.slice(0, 500) }; }
  if (!res.ok) throw new Error("API Error");
  return extractWorkersAiText(data);
}

async function callGeminiTurnFixed(env, contents, systemInstruction, combo, attemptsLog) {
  const { key, model } = combo;
  const res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: systemInstruction }] }, generationConfig: { temperature: 0.3, responseMimeType: "application/json" } })
  });
  if (!res.ok) throw new Error("Gemini API Error");
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

async function callModelTurn(env, contents, systemInstruction, combo, attemptsLog) {
  if (combo.provider === "workers-ai") return callWorkersAiTurn(env, contents, systemInstruction, combo, attemptsLog);
  return callGeminiTurnFixed(env, contents, systemInstruction, combo, attemptsLog);
}

async function runAgentLoopWithModel(env, rawEventText, combo, eventId) {
  const systemInstruction = await getDynamicSystemInstruction(env);
  const contents = [{ role: "user", parts: [{ text: rawEventText }] }];
  const steps = [];

  for (let i = 0; i < MAX_AGENT_STEPS; i++) {
    let rawText;
    try { rawText = await callModelTurn(env, contents, systemInstruction, combo, []); } 
    catch (err) { return { ok: false, steps, stopReason: "error", error: err.message }; }

    const action = extractJsonObject(rawText);
    if (!action) continue;

    if (action.action === "final") return { ok: true, steps, stopReason: "final" };

    if (action.action === "call") {
      const results = await executeCalls(env, action.calls, eventId);
      const allOk = results.length > 0 && results.every((r) => r.ok);
      steps.push({ type: "call", results });

      if (action.done === true && allOk) return { ok: true, steps, stopReason: "final" };

      contents.push({ role: "model", parts: [{ text: rawText }] });
      contents.push({ role: "user", parts: [{ text: `النتائج:\n${JSON.stringify(results)}` }] });
    }
  }
  return { ok: true, steps, stopReason: "max-steps" };
}

async function runAgentLoop(env, rawEventText, eventId) {
  const combos = buildModelCombos(env);
  for (const combo of combos) {
    const result = await runAgentLoopWithModel(env, rawEventText, combo, eventId);
    if (result.ok) return result;
  }
  return { stopReason: "error", error: "كل الموديلات فشلت" };
}

// -----------------------------------------------------------------------------
// 5) معالجة الأحداث الواردة من Zernio
// -----------------------------------------------------------------------------
function extractAccountId(payload) { return (payload.account && (payload.account.id || payload.account.accountId)) || null; }
function extractMessageContext(payload) { return { conversationId: payload.message?.conversationId, accountId: extractAccountId(payload) }; }
function extractCommentContext(payload) { return { postId: payload.comment?.platformPostId || payload.post?.platformPostId, accountId: extractAccountId(payload) }; }

async function handleZernioEvent(env, rawBody, payload, receivedAt) {
  const eventId = payload.id;
  const eventType = payload.event;
  
  if (eventType === "message.received" || eventType === "comment.received") {
    let rawEventText = rawBody;
    
    if (eventType === "message.received") {
      const ids = extractMessageContext(payload);
      if (ids.conversationId) {
        CALL_HANDLERS.typingIndicator(env, ids).catch(() => {}); 
        const history = await CALL_HANDLERS.listMessages(env, { ...ids, limit: AUTO_CONTEXT_LIMIT });
        rawEventText += `\n\nسياق الرسائل السابقة:\n${JSON.stringify(history.data).slice(0, 3000)}`;
      }
    } else if (eventType === "comment.received") {
      const ids = extractCommentContext(payload);
      if (ids.postId) {
        const history = await CALL_HANDLERS.listComments(env, { ...ids, limit: AUTO_CONTEXT_LIMIT });
        rawEventText += `\n\nسياق تعليقات البوست:\n${JSON.stringify(history.data).slice(0, 3000)}`;
      }
    }

    await runAgentLoop(env, rawEventText, eventId);
  }
}

// -----------------------------------------------------------------------------
// 6) نقطة الدخول (Fetch & Queue)
// -----------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    
    // توجيه مسارات الـ API التشخيصية
    if (url.pathname.startsWith('/api/')) {
        return await handleApiRequests(request, env, url);
    }

    // استقبال الـ Webhook
    if (request.method === "POST" && url.pathname === "/webhook/zernio") {
      const rawBody = await request.text();
      let payload;
      try { payload = JSON.parse(rawBody); } catch (_) { return textResponse("Invalid JSON", 400); }

      if (env.EVENTS_QUEUE) {
        await env.EVENTS_QUEUE.send({ rawBody, payload, receivedAt: isoNow() });
      } else {
        ctx.waitUntil(handleZernioEvent(env, rawBody, payload, isoNow()));
      }
      return jsonResponse({ ok: true });
    }

    return textResponse("Bedaya Agent Worker Running.");
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const { rawBody, payload, receivedAt } = message.body || {};
      try {
        await handleZernioEvent(env, rawBody, payload, receivedAt);
        message.ack();
      } catch (err) {
        message.retry({ delaySeconds: 30 });
      }
    }
  }
};
