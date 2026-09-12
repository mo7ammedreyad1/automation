// =============================================================================
// Bedaya Enterprise Agent (v20.0: Cloudflare Queues + DLQ + ReAct Agent + RAG)
// =============================================================================

// إعدادات وبيانات Zernio
const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const CLOUDFLARE_AI_BASE = "https://api.cloudflare.com/client/v4/accounts";

const WORKERS_AI_MODELS = [
  "@cf/google/gemma-3-12b-it",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/google/gemma-3-12b-it"
];

const GEMINI_MODELS = ["gemma-4-26b-a4b-it", "gemini-1.5-flash"];

const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60;
const AUDIT_LOG_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 أيام
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60;

const MAX_AGENT_STEPS = 8;
const CALL_TIMEOUT_MS = 15000;
const AI_CALL_TIMEOUT_MS = 25000;
const WORKERS_AI_MAX_TOKENS = 1024;
const AUTO_CONTEXT_LIMIT = 15;
const MAX_SAFE_CHARS = 550; // حد أمان ضد خطأ الـ 1000 حرف من Meta

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zernio-key, x-connect-token, X-Connect-Token',
};

// -----------------------------------------------------------------------------
// 1) دوال مساعدة عامة
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

function isoNow() { return new Date().toISOString(); }

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
// 2) نظام تتبع الرسائل لـ 3 أيام (Audit Log)
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

async function getRecentAuditLogs(env) {
  if (!env.ZERNIO_KV) return [];
  try {
    const rawIndex = await env.ZERNIO_KV.get('audit_logs_index');
    if (!rawIndex) return [];
    const index = JSON.parse(rawIndex);
    const logs = await Promise.all(
      index.slice(0, 50).map(async item => {
        const raw = await env.ZERNIO_KV.get(`audit_log_${item.id}`);
        return raw ? JSON.parse(raw) : null;
      })
    );
    return logs.filter(Boolean);
  } catch (_) { return []; }
}

// -----------------------------------------------------------------------------
// 3) كتالوج العمليات وأدوات الوكيل (Zernio Tool Handlers)
// -----------------------------------------------------------------------------
async function zernioFetch(env, path, options = {}) {
  const apiKey = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const url = `${ZERNIO_API_BASE}${path}`;
  const headers = Object.assign(
    { Authorization: `Bearer ${apiKey}` },
    options.body ? { "Content-Type": "application/json" } : {},
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

function missingArgsError(names) {
  return { ok: false, status: 0, data: { error: `محتاج الحقول دي: ${names.join(", ")}` } };
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
    
    const cleanMessage = message ? sanitizeAiResponse(message) : undefined;
    const body = { accountId };
    if (cleanMessage) body.message = cleanMessage;
    if (attachmentUrl) { body.attachmentUrl = attachmentUrl; body.attachmentType = attachmentType || "file"; }
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
    if (!conversationId || !accountId || !messageId || !emoji) return missingArgsError(["conversationId", "accountId", "messageId", "emoji"]);
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: "POST",
      body: JSON.stringify({ accountId, emoji })
    });
  },

  async listComments(env, args) {
    const { postId, accountId, limit = AUTO_CONTEXT_LIMIT, cursor } = args || {};
    if (!postId || !accountId) return missingArgsError(["postId", "accountId"]);
    const qs = new URLSearchParams({ accountId, limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}?${qs}`, { method: "GET" });
  },

  async replyToComment(env, args, idempotencyKey) {
    const { postId, accountId, message, attachmentUrl, commentId } = args || {};
    if (!postId || !accountId || !message) return missingArgsError(["postId", "accountId", "message"]);
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
    const { postId, commentId, accountId, message } = args || {};
    if (!postId || !commentId || !accountId || !message) return missingArgsError(["postId", "commentId", "accountId", "message"]);
    const cleanMessage = sanitizeAiResponse(message);
    const body = { accountId, message: cleanMessage };
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;

    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/private-reply`, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
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
// 4) محرك الذكاء الاصطناعي والـ System Prompt الديناميكي (مع الـ RAG)
// -----------------------------------------------------------------------------
async function getDynamicAgentInstruction(env) {
  let customPrompt = 'أنت وكيل خدمة عملاء ومبيعات ذكي ومحترف، ترد بلباقة على استفسارات العملاء.';
  let ragContent = '';

  if (env.ZERNIO_KV) {
    customPrompt = await env.ZERNIO_KV.get('custom_agent_prompt') || customPrompt;
    ragContent = await env.ZERNIO_KV.get('rag_doc_content') || '';
  }

  return [
    "=== تعليمات وشخصية المتجر (أولوية قصوى) ===",
    customPrompt,
    "",
    ragContent ? `=== مستندات وقاعدة المعرفة (RAG Knowledge Base) ===\nاستند بدقة للتفاصيل والأسعار التالية:\n${ragContent}\n` : '',
    "=== قواعد عمل نظام الوكيل والرد ===",
    "أنت وكيل ذكي للرد على رسائل الـ DMs والتعليقات الواردة من Zernio.",
    "نوعان فقط من الأحداث: event = \"message.received\" (DM) أو event = \"comment.received\" (تعليق).",
    "طريقة الرد الإلزامية: كل رد منك يجب أن يكون كائن JSON واحد فقط بالشكل التالي:",
    '{"action": "call", "calls": [{"name": "sendMessage", "args": {"conversationId": "...", "accountId": "...", "message": "نص الرد العربي"}}], "done": true}',
    "",
    "قواعد صارمة لطول النص:",
    "1. الحد الأقصى لنص message في sendMessage أو replyToComment هو 300 حرف فقط لتفادي قيود المنصات.",
    "2. اكتب الرد المباشر بدون تكرار هذه التعليمات وبدون وسوم تفكير.",
    "",
    "── كتالوج أدوات الـ DM (event = message.received) ──",
    '- sendMessage — args: { conversationId, accountId, message (نص عربي < 300 حرف), attachmentUrl? }',
    '- addReaction — args: { conversationId, accountId, messageId, emoji }',
    "",
    "── كتالوج أدوات التعليقات (event = comment.received) ──",
    '- replyToComment — args: { postId (استخدم platformPostId), accountId, message, commentId? }',
    '- sendPrivateReply — args: { postId, commentId, accountId, message }'
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

// استدعاء الموديلات (Gemini + Workers AI Fallback)
async function callModelTurn(env, contents, systemInstruction, combo) {
  if (combo.provider === "gemini") {
    const url = `${GEMINI_API_BASE}/${combo.model}:generateContent?key=${combo.key}`;
    const res = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: `${systemInstruction}\n\nبيانات المحادثة والحدث:\n${contents[0].parts[0].text}` }] }
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 500,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: "OFF", thinkingBudget: 0 }
          }
        })
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini Timeout")), AI_CALL_TIMEOUT_MS))
    ]);

    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textParts = parts.filter(p => !p.thought && p.text);
    return textParts.map(p => p.text).join('\n') || (parts[0] ? parts[0].text : '');
  }

  // Cloudflare Workers AI
  const url = `${CLOUDFLARE_AI_BASE}/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${combo.model}`;
  const res = await Promise.race([
    fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: contents[0].parts[0].text }
        ],
        response_format: { type: "json_object" },
        max_tokens: WORKERS_AI_MAX_TOKENS
      })
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Workers AI Timeout")), AI_CALL_TIMEOUT_MS))
  ]);

  if (!res.ok) throw new Error(`Workers AI HTTP ${res.status}`);
  const data = await res.json();
  return (data.result && typeof data.result === 'string') ? data.result : (data.result?.response || JSON.stringify(data.result));
}

function buildModelCombos(env) {
  const combos = [];
  const geminiKey = (env.GEMINI_API_KEY || '').split(',')[0].trim();
  if (geminiKey) {
    for (const model of GEMINI_MODELS) combos.push({ provider: "gemini", model, key: geminiKey });
  }
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    for (const model of WORKERS_AI_MODELS) combos.push({ provider: "workers-ai", model });
  }
  return combos;
}

// -----------------------------------------------------------------------------
// 5) حلقة تفكير الوكيل (ReAct Agent Execution Loop)
// -----------------------------------------------------------------------------
async function runAgentLoop(env, rawEventText, eventId, auditLogId = null) {
  const systemInstruction = await getDynamicAgentInstruction(env);
  const contents = [{ role: "user", parts: [{ text: rawEventText }] }];
  const steps = [];
  const combos = buildModelCombos(env);

  if (!combos.length) throw new Error("لم يتم إعداد أي مزود ذكاء اصطناعي (Gemini / Workers AI)");

  for (const combo of combos) {
    try {
      for (let i = 0; i < MAX_AGENT_STEPS; i++) {
        const rawText = await callModelTurn(env, contents, systemInstruction, combo);
        const action = extractJsonObject(rawText);

        if (!action) continue;

        if (action.action === "final") {
          steps.push({ step: i + 1, type: "final", text: action.text });
          if (auditLogId) await updateAuditLog(env, auditLogId, { status: "completed", replyText: action.text });
          return { ok: true, steps, modelUsed: combo.model };
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
                workflowStep: { step: "tool_executed", tool: sentMsg.name, ok: allOk, model: combo.model }
              });
            }
          }

          if (action.done === true && allOk) {
            return { ok: true, steps, modelUsed: combo.model };
          }

          contents.push({ role: "model", parts: [{ text: rawText }] });
          contents.push({ role: "user", parts: [{ text: `نتائج تنفيذ الأدوات:\n${JSON.stringify(results)}` }] });
        }
      }
      return { ok: true, steps, modelUsed: combo.model };
    } catch (err) {
      console.warn(`Model ${combo.model} failed, trying next...`, err.message);
    }
  }

  throw new Error("فشلت جميع نماذج الذكاء الاصطناعي في الاستجابة");
}

// -----------------------------------------------------------------------------
// 6) معالجة الأحداث الواردة من Zernio
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
        rawEventText += `\n\nسياق آخر الرسائل:\n${JSON.stringify(history.data).slice(0, 2500)}`;
        await updateAuditLog(env, eventId, { workflowStep: { step: "context_fetched", count: history.data?.data?.length || 0 } });
      }
    }
  } else if (eventType === "comment.received") {
    const ids = extractCommentContext(payload);
    if (ids.postId) {
      const history = await CALL_HANDLERS.listComments(env, { ...ids, limit: AUTO_CONTEXT_LIMIT });
      if (history.ok) {
        rawEventText += `\n\nسياق تعليقات البوست:\n${JSON.stringify(history.data).slice(0, 2500)}`;
        await updateAuditLog(env, eventId, { workflowStep: { step: "comments_context_fetched" } });
      }
    }
  }

  await runAgentLoop(env, rawEventText, eventId, eventId);
}

// -----------------------------------------------------------------------------
// 7) مسارات الـ API (OAuth, Analytics, Prompt, RAG, Disconnect)
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

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

  // 3. سجل تتبع الـ 3 أيام
  if (method === 'GET' && path === '/api/audit-logs') {
    const logs = await getRecentAuditLogs(env);
    return jsonResponse({ ok: true, count: logs.length, logs });
  }

  // 4. لوحة نظرة عامة للأدمن
  if (method === 'GET' && path === '/api/admin/overview') {
    const prompt = env.ZERNIO_KV ? await env.ZERNIO_KV.get('custom_agent_prompt') : null;
    const ragMeta = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_meta') : null;
    const ragContent = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_content') : null;

    return jsonResponse({
      ok: true,
      prompt: prompt || 'البرومبت الافتراضي نشط',
      rag: { active: !!ragContent, meta: ragMeta ? JSON.parse(ragMeta) : null, preview: ragContent ? ragContent.slice(0, 400) : null }
    });
  }

  // 5. إدارة البرومبت والـ RAG
  if (method === 'POST' && path === '/api/set-prompt') {
    const body = await request.json().catch(() => ({}));
    if (!body.prompt) return jsonResponse({ error: 'حقل prompt مفقود' }, 400);
    if (env.ZERNIO_KV) await env.ZERNIO_KV.put('custom_agent_prompt', body.prompt);
    return jsonResponse({ ok: true, message: 'تم حفظ البرومبت بالسيرفر بنجاح' });
  }

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

  // 6. مسارات OAuth فيسبوك الرسمية
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

  // 7. مسارات OAuth إنستغرام الرسمية
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

  // 8. محاكاة الشات المباشر
  if (method === 'POST' && path === '/api/test-chat') {
    const body = await request.json().catch(() => ({}));
    const userMessage = body.message || 'مرحباً، ما هي المنتجات والأسعار المتاحة؟';
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
        modelUsed: result.modelUsed,
        generatedReply: lastCall?.args?.message || "تم تنفيذ الأداة بنجاح",
        steps: result.steps
      });
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  return jsonResponse({ error: 'Endpoint not found' }, 404);
}

// -----------------------------------------------------------------------------
// 8) نقطة الدخول واستقبال الطوابير (Fetch & Queue Handlers)
// -----------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    if (url.pathname.startsWith('/api/')) {
      return await handleApiRequests(request, env, url);
    }

    // استقبال الويب هوك وتمريره للطابور
    if (request.method === 'POST' && url.pathname === '/webhook/zernio') {
      const receivedAt = isoNow();
      const rawBody = await request.text();

      // فحص توقيع HMAC إن وجد
      const signature = request.headers.get("X-Zernio-Signature");
      if (signature && env.ZERNIO_WEBHOOK_SECRET) {
        const computed = await hmacSha256Hex(env.ZERNIO_WEBHOOK_SECRET, rawBody);
        if (!safeEqualHex(computed, signature)) return textResponse("Invalid signature", 400);
      }

      let payload;
      try { payload = JSON.parse(rawBody); } catch (_) { return textResponse("Invalid JSON", 400); }

      // فحص التكرار (Deduplication)
      const eventId = request.headers.get("X-Zernio-Event-Id") || payload.id;
      if (eventId && env.ZERNIO_KV) {
        const dedupKey = `dedup:${eventId}`;
        const already = await env.ZERNIO_KV.get(dedupKey).catch(() => null);
        if (already) return jsonResponse({ ok: true, dedup: true });
        await env.ZERNIO_KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS }).catch(() => {});
      }

      // إيداع الحدث في طابور Cloudflare Queues
      if (env.EVENTS_QUEUE) {
        await env.EVENTS_QUEUE.send({ rawBody, payload, receivedAt });
      } else {
        // Fallback في حالة عدم تفعيل الـ Queue
        ctx.waitUntil(handleZernioEvent(env, rawBody, payload, receivedAt));
      }

      return jsonResponse({ ok: true, queued: true });
    }

    return new Response('Bedaya Enterprise Agent Engine v20.0 Running with Cloudflare Queues.', { headers: corsHeaders });
  },

  // مستهلك الطابور (Cloudflare Queue Consumer with Backoff)
  async queue(batch, env) {
    // 1. طابور الـ Dead Letter Queue (DLQ)
    if (batch.queue && batch.queue.endsWith("-dlq")) {
      for (const message of batch.messages) {
        const { payload } = message.body || {};
        if (payload?.id) {
          await updateAuditLog(env, payload.id, {
            status: "dead_lettered",
            error: "استنفدت الرسالة جميع محاولات الإعادة في الطابور الرئيسي (انتقلت لـ DLQ)"
          }).catch(() => {});
        }
        message.ack();
      }
      return;
    }

    // 2. الطابور الرئيسي مع تأخير تصاعدي (Exponential Backoff)
    for (const message of batch.messages) {
      const { rawBody, payload, receivedAt } = message.body || {};
      try {
        await handleZernioEvent(env, rawBody, payload, receivedAt);
        message.ack();
      } catch (err) {
        console.error("Queue retry for event:", payload?.id, err.message);
        const attempt = message.attempts || 1;
        const delaySeconds = Math.min(30 * Math.pow(2, attempt - 1), 1800); // 30s, 60s, 120s...
        message.retry({ delaySeconds });
      }
    }
  }
};
