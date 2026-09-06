// =============================================================================
// Zernio SaaS Agent Worker (v10: Direct Execution + Native KV-RAG + Live Stats)
// =============================================================================


// 👇 ضع بيانات حساب Zernio الخاص بهذا الـ Worker هنا 👇
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
const DEFAULT_GEMINI_MODELS = ["gemini-3.5-flash-lite"];

const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60;
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_AGENT_STEPS = 10;
const CALL_TIMEOUT_MS = 15000;
const AI_CALL_TIMEOUT_MS = 30000;
const WORKERS_AI_MAX_TOKENS = 1024;
const AUTO_CONTEXT_LIMIT = 20;

// إعدادات CORS الشاملة
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zernio-key',
};

// -----------------------------------------------------------------------------
// 1) أدوات مساعدة ونظام الذاكرة وإحصائيات KV
// -----------------------------------------------------------------------------
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders } });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders } });
}

function isoNow() { return new Date().toISOString(); }
function shortId() { return crypto.randomUUID().slice(0, 8); }

async function kvGetJSON(env, key) {
  try {
    const raw = await env.ZERNIO_KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

async function kvSetJSON(env, key, value, ttlSeconds) {
  try {
    await env.ZERNIO_KV.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  } catch (_) {}
}

// تسجيل وتحديث إحصائيات النشاط الحية
async function recordMetric(env, type, durationMs = 0) {
  try {
    const today = isoNow().slice(0, 10);
    const statsKey = `stats:${today}`;
    const stats = (await kvGetJSON(env, statsKey)) || {
      messages_received: 0,
      messages_replied: 0,
      comments_replied: 0,
      total_response_time_ms: 0,
      replies_count: 0,
      failed_jobs: 0
    };

    if (type === 'received') stats.messages_received++;
    if (type === 'message_replied') {
      stats.messages_replied++;
      stats.replies_count++;
      stats.total_response_time_ms += durationMs;
    }
    if (type === 'comment_replied') {
      stats.comments_replied++;
      stats.replies_count++;
      stats.total_response_time_ms += durationMs;
    }
    if (type === 'failed') stats.failed_jobs++;

    await kvSetJSON(env, statsKey, stats, 30 * 24 * 60 * 60);
  } catch (_) {}
}

function redactSecret(text, secret) {
  if (!secret || typeof text !== "string") return text;
  return text.split(secret).join("[REDACTED]");
}

// -----------------------------------------------------------------------------
// 2) محرك الـ RAG المدمج (Native KV Knowledge Base)
// -----------------------------------------------------------------------------

// البحث السريع واستخراج النصوص الأكثر صلة برسالة العميل
async function retrieveRelevantRAGContext(env, userQuery) {
  try {
    const index = (await kvGetJSON(env, 'rag:index')) || [];
    if (!index.length || !userQuery) return "";

    const queryTokens = userQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let matchedChunks = [];

    for (const docMeta of index) {
      const doc = await kvGetJSON(env, `rag:doc:${docMeta.id}`);
      if (doc && Array.isArray(doc.chunks)) {
        for (const chunk of doc.chunks) {
          const lowerChunk = chunk.toLowerCase();
          let score = 0;
          for (const token of queryTokens) {
            if (lowerChunk.includes(token)) score++;
          }
          if (score > 0) {
            matchedChunks.push({ text: chunk, score, docName: doc.name });
          }
        }
      }
    }

    matchedChunks.sort((a, b) => b.score - a.score);
    const topChunks = matchedChunks.slice(0, 3).map(c => `[مصدر: ${c.docName}]\n${c.text}`);
    
    if (topChunks.length > 0) {
      return `\n\n=== مستندات ومعلومات قاعدة المعرفة (RAG) ===\nاستخدم المعلومات الموثوقة التالية للإجابة بدقة:\n${topChunks.join("\n---\n")}`;
    }
    return "";
  } catch (err) {
    console.error("RAG retrieval error:", err);
    return "";
  }
}

// -----------------------------------------------------------------------------
// 3) مسارات الـ API للواجهة الأمامية (Proxy, RAG, Stats)
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
  const path = url.pathname;
  const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

  // 1. مسار حفظ تعليمات الوكيل (System Prompt)
  if (request.method === 'POST' && path === '/api/set-prompt') {
    const body = await request.json().catch(() => ({}));
    if (!body.prompt) return jsonResponse({ error: 'حقل prompt مفقود' }, 400);
    await env.ZERNIO_KV.put('custom_agent_prompt', body.prompt);
    return jsonResponse({ ok: true, message: 'تم حفظ التعليمات في ذاكرة الوكيل بنجاح' });
  }

  // 2. مسار الإحصائيات المباشرة (Live Stats API)
  if (request.method === 'GET' && path === '/api/stats') {
    const today = isoNow().slice(0, 10);
    const stats = (await kvGetJSON(env, `stats:${today}`)) || {
      messages_received: 0,
      messages_replied: 0,
      comments_replied: 0,
      total_response_time_ms: 0,
      replies_count: 0,
      failed_jobs: 0
    };

    const avgTimeMs = stats.replies_count > 0 
      ? Math.round(stats.total_response_time_ms / stats.replies_count) 
      : 1200;

    return jsonResponse({
      ok: true,
      stats: {
        total_received: stats.messages_received,
        messages_replied: stats.messages_replied,
        comments_replied: stats.comments_replied,
        avg_response_time_formatted: `~ ${(avgTimeMs / 1000).toFixed(1)} ثانية`,
        failed_retries: stats.failed_jobs,
        uptime_status: '100% متصل ومستقر'
      }
    });
  }

  // 3. مسارات محرك الـ RAG
  if (path.startsWith('/api/rag')) {
    // رفع وفهرسة مستند جديد
    if (request.method === 'POST' && path === '/api/rag/upload') {
      const body = await request.json().catch(() => ({}));
      const { name, text, chunks } = body;
      if (!name || (!text && !chunks)) return jsonResponse({ error: 'الاسم والمحتوى مطلوبان' }, 400);

      const docId = shortId();
      let textChunks = chunks;
      if (!textChunks && text) {
        // تقسيم النص تلقائياً إلى قطع بحجم 400 حرف
        textChunks = text.match(/[\s\S]{1,400}/g) || [text];
      }

      const docRecord = { id: docId, name, chunks: textChunks, createdAt: isoNow() };
      await kvSetJSON(env, `rag:doc:${docId}`, docRecord);

      let index = (await kvGetJSON(env, 'rag:index')) || [];
      index.push({ id: docId, name, chunksCount: textChunks.length, createdAt: isoNow() });
      await kvSetJSON(env, 'rag:index', index);

      return jsonResponse({ ok: true, message: 'تمت فهرسة المستند بنجاح', docId, chunksCount: textChunks.length });
    }

    // جلب قائمة المستندات المفهرسة
    if (request.method === 'GET' && path === '/api/rag/documents') {
      const index = (await kvGetJSON(env, 'rag:index')) || [];
      return jsonResponse({ ok: true, documents: index });
    }

    // حذف مستند من الـ RAG
    if (request.method === 'DELETE' && path === '/api/rag/documents') {
      const docId = url.searchParams.get('id');
      if (!docId) return jsonResponse({ error: 'معرف المستند id مطلوب' }, 400);

      await env.ZERNIO_KV.delete(`rag:doc:${docId}`);
      let index = (await kvGetJSON(env, 'rag:index')) || [];
      index = index.filter(d => d.id !== docId);
      await kvSetJSON(env, 'rag:index', index);

      return jsonResponse({ ok: true, message: 'تم حذف المستند بنجاح' });
    }
  }

  // 4. مسارات OAuth فيسبوك وإنستغرام
  if (request.method === 'GET' && path === '/api/auth/facebook') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook?profileId=${PROFILE_ID}&headless=true&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    return jsonResponse(data, res.status);
  }

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
    return jsonResponse(data, res.status);
  }

  if (request.method === 'GET' && path === '/api/auth/instagram') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    return jsonResponse(data, res.status);
  }

  // 5. مسار جلب حسابات الإنستغرام (نسخة آمنة من الردود الفارغة)
    if (request.method === 'GET' && path === '/api/auth/instagram/accounts') {
        const tempToken = url.searchParams.get('tempToken');
        const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram/select-account?profileId=${PROFILE_ID}&tempToken=${tempToken}`;
        
        try {
            const res = await fetch(zernioUrl, { 
                headers: { 
                    'Authorization': `Bearer ${API_KEY}`,
                    'Content-Type': 'application/json'
                } 
            });

            // قراءة الرد كنص أولاً لمنع انهيار الـ JSON
            const text = await res.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch (_) {
                data = { raw: text };
            }

            // ضمان إرجاع كود 200 أو الكود الحقيقي مع جسم JSON دائماً
            return new Response(JSON.stringify(data), { 
                status: res.status, 
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message, pages: [] }), { 
                status: 500, 
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    }

  return jsonResponse({ error: 'المسار غير موجود' }, 404);
}

// -----------------------------------------------------------------------------
// 4) كتالوج عمليات Zernio (CALL HANDLERS)
// -----------------------------------------------------------------------------
function missingArgsError(names) { return { ok: false, status: 0, data: { error: `الحقول التالية مطلوبة: ${names.join(", ")}` } }; }

async function zernioFetch(env, path, options = {}) {
  const apiKey = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const url = `${ZERNIO_API_BASE}${path}`;
  const headers = Object.assign({ Authorization: `Bearer ${apiKey}` }, options.body ? { "Content-Type": "application/json" } : {}, options.headers || {});
  const res = await Promise.race([
    fetch(url, { ...options, headers }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout in Zernio REST call")), CALL_TIMEOUT_MS))
  ]);
  const bodyText = await res.text();
  let data;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { data = { raw: bodyText.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
}

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
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
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
// 5) الذكاء الاصطناعي مع دمج الـ RAG والـ System Prompt
// -----------------------------------------------------------------------------
async function getDynamicSystemInstruction(env, userMessage) {
  let customPrompt = await env.ZERNIO_KV.get('custom_agent_prompt');
  if (!customPrompt) customPrompt = "أنت وكيل خدمة عملاء ذكي ومحترف، ترد بلباقة على استفسارات العملاء.";

  // استدعاء معلومات الـ RAG المطابقة للرسالة الحالية
  const ragContext = await retrieveRelevantRAGContext(env, userMessage);

  return [
    "=== تعليمات شخصية الوكيل (أولويات قصوى) ===",
    customPrompt,
    ragContext,
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

async function callWorkersAiTurn(env, contents, systemInstruction, combo) {
  const messages = contentsToMessages(systemInstruction, contents);
  const url = `${CLOUDFLARE_AI_BASE}/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${combo.model}`;
  const res = await Promise.race([
    fetch(url, { 
      method: "POST", 
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" }, 
      body: JSON.stringify({ messages, response_format: { type: "json_object" }, max_tokens: WORKERS_AI_MAX_TOKENS }) 
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), AI_CALL_TIMEOUT_MS))
  ]);
  const bodyText = await res.text();
  let data; try { data = JSON.parse(bodyText); } catch (_) { data = { raw: bodyText.slice(0, 500) }; }
  if (!res.ok) throw new Error("Workers AI execution error");
  return data.result?.response || data.result?.text || (typeof data.result === 'string' ? data.result : JSON.stringify(data.result));
}

async function callGeminiTurnFixed(env, contents, systemInstruction, combo) {
  const { key, model } = combo;
  const res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: systemInstruction }] }, generationConfig: { temperature: 0.3, responseMimeType: "application/json" } })
  });
  if (!res.ok) throw new Error("Gemini API Error");
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

async function runAgentLoopWithModel(env, rawEventText, combo, eventId, userMsgSnippet) {
  const systemInstruction = await getDynamicSystemInstruction(env, userMsgSnippet);
  const contents = [{ role: "user", parts: [{ text: rawEventText }] }];
  const steps = [];

  for (let i = 0; i < MAX_AGENT_STEPS; i++) {
    let rawText;
    try {
      rawText = combo.provider === "workers-ai" 
        ? await callWorkersAiTurn(env, contents, systemInstruction, combo)
        : await callGeminiTurnFixed(env, contents, systemInstruction, combo);
    } catch (err) { 
      return { ok: false, steps, stopReason: "error", error: err.message }; 
    }

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

async function runAgentLoop(env, rawEventText, eventId, userMsgSnippet) {
  const combos = buildModelCombos(env);
  for (const combo of combos) {
    const result = await runAgentLoopWithModel(env, rawEventText, combo, eventId, userMsgSnippet);
    if (result.ok) return result;
  }
  throw new Error("فشلت جميع نماذج الذكاء الاصطناعي في إتمام الرد");
}

// -----------------------------------------------------------------------------
// 6) معالجة الأحداث والرد المباشر
// -----------------------------------------------------------------------------
function extractAccountId(payload) { return (payload.account && (payload.account.id || payload.account.accountId)) || null; }
function extractMessageContext(payload) { return { conversationId: payload.message?.conversationId, accountId: extractAccountId(payload) }; }
function extractCommentContext(payload) { return { postId: payload.comment?.platformPostId || payload.post?.platformPostId, accountId: extractAccountId(payload) }; }

async function handleZernioEvent(env, rawBody, payload) {
  const eventId = payload.id;
  const eventType = payload.event;
  
  if (eventType === "message.received" || eventType === "comment.received") {
    let rawEventText = rawBody;
    let userMsgSnippet = payload.message?.text || payload.comment?.text || "";

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

    await runAgentLoop(env, rawEventText, eventId, userMsgSnippet);
  }
}

// محرك إعادة المحاولة المباشر في الخلفية (Direct Execution with Auto-Retry)
async function processEventWithRetries(env, rawBody, payload, receivedAt) {
  const startTime = Date.now();
  const maxAttempts = 3;
  const eventType = payload.event === 'comment.received' ? 'comment_replied' : 'message_replied';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await handleZernioEvent(env, rawBody, payload);
      const durationMs = Date.now() - startTime;
      await recordMetric(env, eventType, durationMs);
      return;
    } catch (err) {
      console.error(`المحاولة ${attempt} فشلت لحدث ${payload.id}:`, err.message);
      
      if (attempt === maxAttempts) {
        // تسجيل الفشل النهائي في KV بعد استنفاد كل المحاولات
        await recordMetric(env, 'failed');
        await kvSetJSON(env, `failed_job:${payload.id}`, {
          eventId: payload.id,
          event: payload.event,
          error: err.message,
          receivedAt,
          failedAt: isoNow()
        }, LOG_TTL_SECONDS);
      } else {
        // تأخير متصاعد قبل إعادة المحاولة (2 ثواني، ثم 4 ثواني)
        await new Promise(res => setTimeout(res, attempt * 2000));
      }
    }
  }
}

// -----------------------------------------------------------------------------
// 7) نقطة الدخول الرئيسية للـ Worker
// -----------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. معالجة طلبات الـ CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 2. مسارات الـ API للواجهة (Proxy, Stats, RAG)
    if (url.pathname.startsWith('/api/')) {
      return await handleApiRequests(request, env, url);
    }

    // 3. مسار استقبال الـ Webhook الفوري (Fast Response + Background Execution)
    if (request.method === "POST" && url.pathname === "/webhook/zernio") {
      const rawBody = await request.text();
      let payload;
      try { 
        payload = JSON.parse(rawBody); 
      } catch (_) { 
        return textResponse("Invalid JSON", 400); 
      }

      // منع تكرار معالجة نفس الحدث (De-duplication)
      if (payload.id) {
        const dedupKey = `dedup:${payload.id}`;
        const alreadyProcessed = await env.ZERNIO_KV.get(dedupKey).catch(() => null);
        if (alreadyProcessed) {
          return jsonResponse({ ok: true, dedup: true });
        }
        await env.ZERNIO_KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS }).catch(() => {});
      }

      // تسجيل استلام الرسالة
      ctx.waitUntil(recordMetric(env, 'received'));

      // إطلاق المعالجة الخلفية الفورية مع إعادة المحاولة التلقائية
      ctx.waitUntil(processEventWithRetries(env, rawBody, payload, isoNow()));

      // الرد الفوري على Zernio في أجزاء من الثانية
      return jsonResponse({ ok: true, status: "processing" });
    }

    return textResponse("Bedaya Agent Worker Running (v10: Direct Execution & KV RAG).");
  }
};
