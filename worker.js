// =============================================================================
// Bedaya Master Unified Worker (v21.0 - Full Agent + OAuth + Queues + Billing)
// =============================================================================

const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const CLOUDFLARE_AI_BASE = "https://api.cloudflare.com/client/v4/accounts";

const PRIMARY_GEMINI_MODEL = "gemma-4-26b-a4b-it";
const FALLBACK_GEMINI_MODEL = "gemini-1.5-flash";

const WORKERS_AI_MODELS = [
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/google/gemma-3-12b-it"
];

const CALL_TIMEOUT_MS = 15000;
const AI_CALL_TIMEOUT_MS = 25000;
const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60;
const AUDIT_LOG_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 أيام
const MAX_AGENT_STEPS = 8;
const AUTO_CONTEXT_LIMIT = 15;
const MAX_SAFE_CHARS = 550; // حد أمان قاطع ضد خطأ الـ 1000 حرف

const PLAN_LIMITS = {
  free: 100,
  basic: 1500,
  advance: 5000,
  pro: Infinity,
  biz: Infinity,
  enterprise: Infinity
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zernio-key, x-connect-token, X-Connect-Token',
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders } });
}

function isoNow() { return new Date().toISOString(); }

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

// -----------------------------------------------------------------------------
// 1) الاتصال بـ Zernio API
// -----------------------------------------------------------------------------
async function zernioFetch(env, path, options = {}) {
  const apiKey = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const url = `${ZERNIO_API_BASE}${path}`;
  const headers = Object.assign(
    { Authorization: `Bearer ${apiKey}` },
    options.body ? { 'Content-Type': 'application/json' } : {},
    options.headers || {}
  );
  const res = await Promise.race([
    fetch(url, { ...options, headers }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`انتهت مهلة اتصال Zernio`)), CALL_TIMEOUT_MS))
  ]);
  const bodyText = await res.text();
  let data;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { data = { raw: bodyText.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
}

// -----------------------------------------------------------------------------
// 2) سجل تتبع الـ 3 أيام
// -----------------------------------------------------------------------------
async function createAuditLog(env, logEntry) {
  if (!env.ZERNIO_KV) return;
  try {
    const logId = logEntry.id || `log_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    logEntry.id = logId;
    logEntry.createdAt = logEntry.createdAt || isoNow();

    await env.ZERNIO_KV.put(`audit_log_${logId}`, JSON.stringify(logEntry), { expirationTtl: AUDIT_LOG_TTL_SECONDS });

    let index = [];
    try {
      const rawIndex = await env.ZERNIO_KV.get('audit_logs_index');
      index = rawIndex ? JSON.parse(rawIndex) : [];
    } catch (_) {}

    index.unshift({ id: logId, time: logEntry.createdAt, platform: logEntry.platform, event: logEntry.event, status: logEntry.status });
    if (index.length > 200) index = index.slice(0, 200);

    await env.ZERNIO_KV.put('audit_logs_index', JSON.stringify(index), { expirationTtl: AUDIT_LOG_TTL_SECONDS });
  } catch (err) {
    console.error('Audit Log Error:', err);
  }
}

async function updateAuditLog(env, logId, updateData) {
  if (!env.ZERNIO_KV || !logId) return;
  try {
    const raw = await env.ZERNIO_KV.get(`audit_log_${logId}`);
    if (raw) {
      const log = JSON.parse(raw);
      if (updateData.workflowStep) {
        log.workflow = log.workflow || [];
        log.workflow.push({ ...updateData.workflowStep, time: isoNow() });
      }
      if (updateData.status) log.status = updateData.status;
      if (updateData.replyText) log.replyText = updateData.replyText;
      if (updateData.error) log.error = updateData.error;

      await env.ZERNIO_KV.put(`audit_log_${logId}`, JSON.stringify(log), { expirationTtl: AUDIT_LOG_TTL_SECONDS });
    }
  } catch (_) {}
}

// -----------------------------------------------------------------------------
// 3) كتالوج أدوات الوكيل (Tools)
// -----------------------------------------------------------------------------
const CALL_HANDLERS = {
  async listMessages(env, args) {
    const { conversationId, accountId, limit = AUTO_CONTEXT_LIMIT, sortOrder = "desc", cursor } = args || {};
    if (!conversationId || !accountId) return { ok: false, data: { error: "missing args" } };
    const qs = new URLSearchParams({ accountId, limit: String(limit), sortOrder });
    if (cursor) qs.set("cursor", cursor);
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages?${qs}`, { method: "GET" });
  },

  async sendMessage(env, args, idempotencyKey) {
    const { conversationId, accountId, message, attachmentUrl, attachmentType } = args || {};
    if (!conversationId || !accountId) return { ok: false, data: { error: "missing args" } };
    const cleanMessage = message ? sanitizeAiResponse(message) : undefined;
    const body = { accountId };
    if (cleanMessage) body.message = cleanMessage;
    if (attachmentUrl) { body.attachmentUrl = attachmentUrl; body.attachmentType = attachmentType || "file"; }
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST", body: JSON.stringify(body), headers
    });
  },

  async typingIndicator(env, args) {
    const { conversationId, accountId } = args || {};
    if (!conversationId || !accountId) return { ok: false, data: { error: "missing args" } };
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, {
      method: "POST", body: JSON.stringify({ accountId })
    });
  },

  async addReaction(env, args) {
    const { conversationId, accountId, messageId, emoji } = args || {};
    if (!conversationId || !accountId || !messageId || !emoji) return { ok: false, data: { error: "missing args" } };
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: "POST", body: JSON.stringify({ accountId, emoji })
    });
  },

  async listComments(env, args) {
    const { postId, accountId, limit = AUTO_CONTEXT_LIMIT, cursor } = args || {};
    if (!postId || !accountId) return { ok: false, data: { error: "missing args" } };
    const qs = new URLSearchParams({ accountId, limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}?${qs}`, { method: "GET" });
  },

  async replyToComment(env, args, idempotencyKey) {
    const { postId, accountId, message, attachmentUrl, commentId } = args || {};
    if (!postId || !accountId || !message) return { ok: false, data: { error: "missing args" } };
    const cleanMessage = sanitizeAiResponse(message);
    const body = { accountId, message: cleanMessage };
    if (attachmentUrl) body.attachmentUrl = attachmentUrl;
    if (commentId) body.commentId = commentId;
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}`, {
      method: "POST", body: JSON.stringify(body), headers
    });
  },

  async sendPrivateReply(env, args, idempotencyKey) {
    const { postId, commentId, accountId, message } = args || {};
    if (!postId || !commentId || !accountId || !message) return { ok: false, data: { error: "missing args" } };
    const cleanMessage = sanitizeAiResponse(message);
    const body = { accountId, message: cleanMessage };
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/private-reply`, {
      method: "POST", body: JSON.stringify(body), headers
    });
  }
};

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
      results.push({ name, ok: false, data: { error: `عملية غير معروفة: "${name}"` } });
      continue;
    }
    try {
      const idempotencyKey = IDEMPOTENT_WRITE_OPS.has(name) ? await buildIdempotencyKey(eventId, name, c.args) : undefined;
      const r = await handler(env, c.args || {}, idempotencyKey);
      results.push({ name, ok: r.ok, status: r.status, data: r.data });
    } catch (err) {
      results.push({ name, ok: false, data: { error: String(err.message) } });
    }
  }
  return results;
}

// -----------------------------------------------------------------------------
// 4) محرك الذكاء الاصطناعي وحلقة التفكير (Agent Loop)
// -----------------------------------------------------------------------------
async function getDynamicAgentInstruction(env) {
  let customPrompt = 'أنت وكيل خدمة عملاء ومبيعات ذكي ومحترف، ترد بلباقة على استفسارات العملاء.';
  let ragContent = '';

  if (env.ZERNIO_KV) {
    customPrompt = await env.ZERNIO_KV.get('custom_agent_prompt') || customPrompt;
    ragContent = await env.ZERNIO_KV.get('rag_doc_content') || '';
  }

  return [
    "=== تعليمات وشخصية المتجر ===",
    customPrompt,
    ragContent ? `\n=== قاعدة المعرفة والمنتجات (RAG) ===\n${ragContent}` : '',
    "\n=== القواعد الصارمة ===",
    "أنت وكيل للرد على رسائل DMs والتعليقات.",
    "ردك الإلزامي هو كائن JSON واحد فقط:",
    '{"action": "call", "calls": [{"name": "sendMessage", "args": {"conversationId": "...", "accountId": "...", "message": "نص الرد العربي"}}], "done": true}',
    "أقصى طول لنص message هو 300 حرف فقط."
  ].join("\n");
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

async function callModelTurn(env, fullPrompt, modelName, geminiKey) {
  const url = `${GEMINI_API_BASE}/${modelName}:generateContent?key=${geminiKey}`;
  const res = await Promise.race([
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 450,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: "OFF", thinkingBudget: 0 }
        }
      })
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("AI Timeout")), AI_CALL_TIMEOUT_MS))
  ]);

  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const textParts = parts.filter(p => !p.thought && p.text);
  return textParts.map(p => p.text).join('\n') || (parts[0] ? parts[0].text : '');
}

async function runAgentLoop(env, rawEventText, eventId, auditLogId = null) {
  const systemInstruction = await getDynamicAgentInstruction(env);
  const geminiKey = (env.GEMINI_API_KEY || '').split(',')[0].trim();
  const fullPrompt = `${systemInstruction}\n\nبيانات الحدث:\n${rawEventText}`;
  const steps = [];

  const models = [PRIMARY_GEMINI_MODEL, FALLBACK_GEMINI_MODEL];

  for (const model of models) {
    try {
      for (let i = 0; i < MAX_AGENT_STEPS; i++) {
        const rawText = await callModelTurn(env, fullPrompt, model, geminiKey);
        const action = extractJsonObject(rawText);

        if (!action) continue;

        if (action.action === "final") {
          steps.push({ step: i + 1, type: "final", text: action.text });
          if (auditLogId) await updateAuditLog(env, auditLogId, { status: "completed", replyText: action.text });
          return { ok: true, steps, modelUsed: model };
        }

        if (action.action === "call") {
          let calls = Array.isArray(action.calls) ? action.calls : [action.calls];
          const results = await executeCalls(env, calls, eventId);
          const allOk = results.length > 0 && results.every((r) => r.ok);

          steps.push({ step: i + 1, type: "call", calls, results });

          if (auditLogId) {
            const sentMsg = calls.find(c => c.name === 'sendMessage' || c.name === 'replyToComment');
            if (sentMsg) {
              await updateAuditLog(env, auditLogId, {
                status: allOk ? "completed" : "failed",
                replyText: sentMsg.args?.message,
                workflowStep: { step: "tool_executed", tool: sentMsg.name, ok: allOk, model }
              });
            }
          }

          if (action.done === true && allOk) return { ok: true, steps, modelUsed: model };
        }
      }
      return { ok: true, steps, modelUsed: model };
    } catch (err) {
      console.warn(`Model ${model} failed, trying fallback...`, err.message);
    }
  }

  throw new Error("فشلت جميع نماذج الذكاء الاصطناعي");
}

// -----------------------------------------------------------------------------
// 5) معالجة أحداث الويب هوك
// -----------------------------------------------------------------------------
function extractAccountId(payload) { return (payload.account && (payload.account.id || payload.account.accountId)) || null; }
function extractMessageContext(payload) { return { conversationId: payload.message?.conversationId, accountId: extractAccountId(payload) }; }
function extractCommentContext(payload) { return { postId: payload.comment?.platformPostId || payload.post?.platformPostId, accountId: extractAccountId(payload) }; }

async function handleZernioEvent(env, rawBody, payload, receivedAt) {
  const eventId = payload.id;
  const eventType = payload.event;
  const platform = payload.account?.platform || 'meta';

  if (eventType !== "message.received" && eventType !== "comment.received") return;

  const logEntry = {
    id: eventId,
    event: eventType,
    platform,
    accountId: extractAccountId(payload),
    incomingText: payload.message?.text || payload.comment?.text || '',
    sender: payload.message?.sender || payload.comment?.author || { name: 'عميل' },
    workflow: [{ step: "received_in_queue", time: isoNow() }],
    status: "processing",
    replyText: null,
    error: null
  };
  await createAuditLog(env, logEntry);

  let rawEventText = rawBody;

  if (eventType === "message.received") {
    const ids = extractMessageContext(payload);
    if (ids.conversationId) {
      CALL_HANDLERS.typingIndicator(env, ids).catch(() => {});
      const history = await CALL_HANDLERS.listMessages(env, { ...ids, limit: AUTO_CONTEXT_LIMIT });
      if (history.ok) {
        rawEventText += `\n\nسياق آخر الرسائل:\n${JSON.stringify(history.data).slice(0, 2000)}`;
        await updateAuditLog(env, eventId, { workflowStep: { step: "context_fetched" } });
      }
    }
  } else if (eventType === "comment.received") {
    const ids = extractCommentContext(payload);
    if (ids.postId) {
      const history = await CALL_HANDLERS.listComments(env, { ...ids, limit: AUTO_CONTEXT_LIMIT });
      if (history.ok) {
        rawEventText += `\n\nسياق تعليقات البوست:\n${JSON.stringify(history.data).slice(0, 2000)}`;
        await updateAuditLog(env, eventId, { workflowStep: { step: "comments_context_fetched" } });
      }
    }
  }

  await runAgentLoop(env, rawEventText, eventId, eventId);
}

// -----------------------------------------------------------------------------
// 6) مسارات الـ API (OAuth, Billing, Accounts, Disconnect, RAG)
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

  // 1. مسار جلب الحسابات المتصلة من Zernio (GET /accounts) ⭐
  if (method === 'GET' && (path === '/accounts' || path === '/api/accounts')) {
    const zernioRes = await zernioFetch(env, `/accounts?profileId=${PROFILE_ID}`);
    return jsonResponse(zernioRes.data, zernioRes.status);
  }

  // 2. مسار فصل الحساب الحقيقي من Zernio (DELETE /accounts/:id) ⭐
  if (method === 'DELETE' && (path.startsWith('/accounts/') || path.startsWith('/api/accounts/'))) {
    const accountId = path.split('/accounts/')[1] || path.split('/api/accounts/')[1];
    if (!accountId) return jsonResponse({ error: 'accountId مطلوب' }, 400);

    const zernioRes = await zernioFetch(env, `/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    if (zernioRes.ok || zernioRes.status === 404) return jsonResponse({ ok: true, message: 'تم فصل الحساب بنجاح من Zernio' });
    return jsonResponse({ ok: false, error: zernioRes.data?.error || 'فشل فصل الحساب' }, zernioRes.status);
  }

  // 3. إحصائيات Zernio الرسمية (Volume Analytics)
  if (method === 'GET' && (path === '/api/analytics' || path === '/admin/analytics')) {
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

  // 4. الفوترة ومراقبة الحصص (Billing Engine)
  if (method === 'GET' && path === '/api/billing/status') {
    const userPlan = env.ZERNIO_KV ? (await env.ZERNIO_KV.get('user_active_plan') || 'free') : 'free';
    const planLimit = PLAN_LIMITS[userPlan] !== undefined ? PLAN_LIMITS[userPlan] : 100;
    const today = new Date().toISOString().split('T')[0];
    const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

    const qs = new URLSearchParams({ fromDate: firstDay, toDate: today, profileId: PROFILE_ID });
    const zernioRes = await zernioFetch(env, `/analytics/inbox/volume?${qs}`);
    const consumed = (zernioRes.data?.summary?.sent || 0) + (zernioRes.data?.summary?.received || 0);

    return jsonResponse({
      ok: true,
      billing: {
        userPlan,
        planLimit: planLimit === Infinity ? 'غير محدود' : planLimit,
        consumedMessages: consumed,
        remaining: planLimit === Infinity ? 'غير محدود' : Math.max(0, planLimit - consumed),
        usagePercentage: planLimit === Infinity ? 0 : Math.min(100, Math.round((consumed / planLimit) * 100))
      }
    });
  }

  if (method === 'POST' && path === '/api/billing/set-plan') {
    const body = await request.json().catch(() => ({}));
    if (env.ZERNIO_KV && body.plan) await env.ZERNIO_KV.put('user_active_plan', body.plan.toLowerCase());
    return jsonResponse({ ok: true, message: `تم تحديث الباقة إلى (${body.plan})` });
  }

  // 5. مسارات OAuth فيسبوك
  if (method === 'GET' && (path === '/connect/facebook/start' || path === '/api/auth/facebook')) {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook?profileId=${PROFILE_ID}&headless=true&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'GET' && (path === '/connect/facebook/pages' || path === '/api/auth/facebook/pages')) {
    const tempToken = url.searchParams.get('tempToken');
    const connectToken = url.searchParams.get('connect_token') || request.headers.get('x-connect-token') || '';
    const headers = { Authorization: `Bearer ${API_KEY}` };
    if (connectToken) headers['X-Connect-Token'] = connectToken;

    const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook/select-page?profileId=${PROFILE_ID}&tempToken=${encodeURIComponent(tempToken || '')}`;
    const res = await fetch(zernioUrl, { headers });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'POST' && (path === '/connect/facebook/select' || path === '/api/auth/facebook/select')) {
    const body = await request.json().catch(() => ({}));
    body.profileId = PROFILE_ID;
    const connectToken = body.connect_token || request.headers.get('x-connect-token') || '';
    const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
    if (connectToken) headers['X-Connect-Token'] = connectToken;

    const res = await fetch(`${ZERNIO_API_BASE}/connect/facebook/select-page`, { method: 'POST', headers, body: JSON.stringify(body) });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 6. مسارات OAuth إنستغرام
  if (method === 'GET' && (path === '/connect/instagram/start' || path === '/api/auth/instagram')) {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'GET' && (path === '/connect/instagram/accounts' || path === '/api/auth/instagram/accounts')) {
    const tempToken = url.searchParams.get('tempToken');
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram/select-account?profileId=${PROFILE_ID}&tempToken=${encodeURIComponent(tempToken || '')}`;
    const res = await fetch(zernioUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'POST' && (path === '/connect/instagram/select' || path === '/api/auth/instagram/select')) {
    const body = await request.json().catch(() => ({}));
    body.profileId = PROFILE_ID;
    const res = await fetch(`${ZERNIO_API_BASE}/connect/instagram/select-account`, {
      method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 7. البرومبت والـ RAG
  if (method === 'POST' && (path === '/api/set-prompt' || path === '/admin/business-context')) {
    const body = await request.json().catch(() => ({}));
    const promptText = body.prompt || body.text;
    if (env.ZERNIO_KV && promptText) await env.ZERNIO_KV.put('custom_agent_prompt', promptText);
    return jsonResponse({ ok: true, message: 'تم حفظ البرومبت بنجاح' });
  }

  if (method === 'POST' && path === '/api/upload-rag-doc') {
    const body = await request.json().catch(() => ({}));
    if (env.ZERNIO_KV && body.textContent) {
      await env.ZERNIO_KV.put('rag_doc_content', body.textContent);
      await env.ZERNIO_KV.put('rag_doc_meta', JSON.stringify({ name: body.name, size: body.size, updatedAt: isoNow() }));
    }
    return jsonResponse({ ok: true, message: 'تم رفع وفهرسة الـ RAG بنجاح' });
  }

  if (method === 'POST' && path === '/api/delete-rag-doc') {
    if (env.ZERNIO_KV) {
      await env.ZERNIO_KV.delete('rag_doc_content');
      await env.ZERNIO_KV.delete('rag_doc_meta');
    }
    return jsonResponse({ ok: true, message: 'تم مسح الـ RAG' });
  }

  // 8. سجل الـ 3 أيام
  if (method === 'GET' && path === '/api/audit-logs') {
    if (!env.ZERNIO_KV) return jsonResponse({ ok: true, logs: [] });
    const rawIndex = await env.ZERNIO_KV.get('audit_logs_index');
    const index = rawIndex ? JSON.parse(rawIndex) : [];
    const logs = await Promise.all(
      index.slice(0, 50).map(async item => {
        const raw = await env.ZERNIO_KV.get(`audit_log_${item.id}`);
        return raw ? JSON.parse(raw) : null;
      })
    );
    return jsonResponse({ ok: true, logs: logs.filter(Boolean) });
  }

  return jsonResponse({ error: 'Endpoint not found' }, 404);
}

// -----------------------------------------------------------------------------
// 7) نقطة الدخول واستقبال الطوابير
// -----------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/connect/') || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/accounts')) {
      return await handleApiRequests(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/webhook/zernio') {
      const receivedAt = isoNow();
      const rawBody = await request.text();

      const signature = request.headers.get("X-Zernio-Signature");
      if (signature && env.ZERNIO_WEBHOOK_SECRET) {
        const computed = await hmacSha256Hex(env.ZERNIO_WEBHOOK_SECRET, rawBody);
        if (!safeEqualHex(computed, signature)) return textResponse("Invalid signature", 400);
      }

      let payload;
      try { payload = JSON.parse(rawBody); } catch (_) { return textResponse("Invalid JSON", 400); }

      const eventId = request.headers.get("X-Zernio-Event-Id") || payload.id;
      if (eventId && env.ZERNIO_KV) {
        const dedupKey = `dedup:${eventId}`;
        const already = await env.ZERNIO_KV.get(dedupKey).catch(() => null);
        if (already) return jsonResponse({ ok: true, dedup: true });
        await env.ZERNIO_KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS }).catch(() => {});
      }

      if (env.EVENTS_QUEUE) {
        await env.EVENTS_QUEUE.send({ rawBody, payload, receivedAt });
      } else {
        ctx.waitUntil(handleZernioEvent(env, rawBody, payload, receivedAt));
      }

      return jsonResponse({ ok: true, queued: true });
    }

    return textResponse("Bedaya Master Worker v21.0 Running.");
  },

  async queue(batch, env) {
    if (batch.queue && batch.queue.endsWith("-dlq")) {
      for (const message of batch.messages) {
        const { payload } = message.body || {};
        if (payload?.id) {
          await updateAuditLog(env, payload.id, { status: "dead_lettered", error: "استنفدت الرسالة محاولات الإعادة" }).catch(() => {});
        }
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
        console.error("Queue retry:", payload?.id, err.message);
        const attempt = message.attempts || 1;
        const delaySeconds = Math.min(30 * Math.pow(2, attempt - 1), 1800);
        message.retry({ delaySeconds });
      }
    }
  }
};
