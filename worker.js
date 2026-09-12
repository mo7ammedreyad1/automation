// Bedaya Meta Direct Engine (v19.0: Gemma-4-26b + Auto-Fallback + Zero-Leak)
// Worker URL: https://automation.nckalo018.workers.dev
// =============================================================================

const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const PRIMARY_MODEL = "gemma-4-26b-a4b-it";
const FALLBACK_MODEL = "gemini-3.5-flash-lite";

const CALL_TIMEOUT_MS = 15000;
const AI_TIMEOUT_MS = 25000;
const AUDIT_LOG_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 أيام
const DEDUP_TTL_SECONDS = 86400; // 24 ساعة
const MAX_SAFE_CHARS = 450; // حد أمان قاطع ضد خطأ الـ 1000 حرف

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zernio-key, x-connect-token, X-Connect-Token',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function isoNow() { return new Date().toISOString(); }

// -----------------------------------------------------------------------------
// تنظيف الرد: إزالة التفكير وتسريب البرومبت والـ RAG
// -----------------------------------------------------------------------------
function sanitizeAiResponse(rawText) {
  if (!rawText) return '';
  let cleaned = String(rawText).trim();

  // 1. حذف وسوم التفكير
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  cleaned = cleaned.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();

  // 2. حذف أي تكرار لعناوين البرومبت والـ RAG
  cleaned = cleaned.replace(/===[\s\S]*?===/gi, '').trim();
  cleaned = cleaned.replace(/\[تعليمات[\s\S]*?\]/gi, '').trim();
  cleaned = cleaned.replace(/\[قاعدة المعرفة[\s\S]*?\]/gi, '').trim();
  cleaned = cleaned.replace(/^.*?(?:التعليمات|معلومات المتجر|قاعدة المعرفة|الرد المطلوب|رسالة العميل)\s*:.*$/gim, '').trim();

  // 3. تنظيف الفراغات المتكررة
  cleaned = cleaned.replace(/\n{2,}/g, '\n').trim();

  // 4. القص الصارم عند 450 حرفاً كحد أقصى آمن
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
    { 'Authorization': `Bearer ${apiKey}` },
    options.body ? { 'Content-Type': 'application/json' } : {},
    options.headers || {}
  );

  const res = await Promise.race([
    fetch(url, { ...options, headers }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('انتهت مهلة اتصال Zernio')), CALL_TIMEOUT_MS))
  ]);

  const bodyText = await res.text();
  let data;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { data = { raw: bodyText }; }
  return { ok: res.ok, status: res.status, data };
}

// -----------------------------------------------------------------------------
// 2) سجل تتبع تدفق الرسائل لـ 3 أيام
// -----------------------------------------------------------------------------
async function createAuditLog(env, logEntry) {
  if (!env.ZERNIO_KV) return;
  try {
    const logId = logEntry.id || `log_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    logEntry.id = logId;
    logEntry.createdAt = logEntry.createdAt || isoNow();

    await env.ZERNIO_KV.put(`audit_log_${logId}`, JSON.stringify(logEntry), {
      expirationTtl: AUDIT_LOG_TTL_SECONDS
    });

    let index = [];
    try {
      const rawIndex = await env.ZERNIO_KV.get('audit_logs_index');
      index = rawIndex ? JSON.parse(rawIndex) : [];
    } catch (_) {}

    index.unshift({ id: logId, time: logEntry.createdAt, platform: logEntry.platform, event: logEntry.event, status: logEntry.status });
    if (index.length > 200) index = index.slice(0, 200);

    await env.ZERNIO_KV.put('audit_logs_index', JSON.stringify(index), {
      expirationTtl: AUDIT_LOG_TTL_SECONDS
    });
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

      await env.ZERNIO_KV.put(`audit_log_${logId}`, JSON.stringify(log), {
        expirationTtl: AUDIT_LOG_TTL_SECONDS
      });
    }
  } catch (err) {
    console.error('Update Log Error:', err);
  }
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
  } catch (_) {
    return [];
  }
}

// -----------------------------------------------------------------------------
// 3) طابور الرسائل الفاشلة
// -----------------------------------------------------------------------------
async function getFailedQueue(env) {
  if (!env.ZERNIO_KV) return [];
  try {
    const raw = await env.ZERNIO_KV.get('failed_messages_queue');
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}

async function saveFailedQueue(env, queue) {
  if (!env.ZERNIO_KV) return;
  await env.ZERNIO_KV.put('failed_messages_queue', JSON.stringify(queue.slice(0, 100)));
}

async function pushToFailedQueue(env, item) {
  const queue = await getFailedQueue(env);
  const idx = queue.findIndex(q => q.id === item.id);
  const entry = {
    id: item.id,
    type: item.type,
    platform: item.platform || 'meta',
    payload: item.payload,
    generatedReply: item.generatedReply || null,
    errorReason: item.errorReason || 'Unknown Error',
    retries: (item.retries || 0),
    lastAttempt: isoNow(),
    createdAt: item.createdAt || isoNow()
  };

  if (idx >= 0) queue[idx] = entry;
  else queue.push(entry);
  await saveFailedQueue(env, queue);
}

// -----------------------------------------------------------------------------
// 4) توليد الرد الصارم مع تعطيل التفكير والـ Fallback التلقائي
// -----------------------------------------------------------------------------
async function callGeminiModel(modelName, geminiKey, fullPrompt) {
  const url = `${GEMINI_API_BASE}/${modelName}:generateContent?key=${geminiKey}`;
  const res = await Promise.race([
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: fullPrompt }]
          }
        ],
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 250,
          thinkingConfig: {
            thinkingLevel: "OFF",
            thinkingBudget: 0
          }
        }
      })
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI Request Timeout')), AI_TIMEOUT_MS))
  ]);

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`API ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const textParts = parts.filter(p => !p.thought && p.text);

  let raw = '';
  if (textParts.length > 0) {
    raw = textParts.map(p => p.text).join('\n');
  } else if (parts.length > 0) {
    raw = parts[parts.length - 1].text || '';
  }

  return raw;
}

async function generateStrictReply(env, incomingText, contextHistory = '', isComment = false, auditLogId = null) {
  let customPrompt = 'أنت مساعد خدمة عملاء ومبيعات محترف وودود، ترد باختصار ولباقة ودقة على استفسارات العملاء.';
  let ragContent = '';

  if (env.ZERNIO_KV) {
    customPrompt = await env.ZERNIO_KV.get('custom_agent_prompt') || customPrompt;
    ragContent = await env.ZERNIO_KV.get('rag_doc_content') || '';
  }

  // بناء المدخلات بدون استخدام حقل systemInstruction لتفادي تكراره في Gemma
  const fullPrompt = [
    `[تعليمات المتجر]`,
    customPrompt,
    ragContent ? `\n[قاعدة المعرفة والمنتجات RAG]\n${ragContent}` : '',
    contextHistory ? `\n[سياق المحادثة السابقة]\n${contextHistory}` : '',
    `\n[رسالة العميل الحالية]`,
    incomingText,
    `\n[قواعد الرد الإلزامية]`,
    `1. اكتب نص الرد النهائي المباشر للعميل فقط باللغة العربية.`,
    `2. ممنوع منعاً باتاً تكرار أي سطر من التعليمات أو قاعدة المعرفة أو كتابة أي تفكير داخلي.`,
    `3. أقصى حد لطول الرد هو 250 حرف فقط.`,
    `الرد المباشر الصافي:`
  ].join('\n');

  const geminiKey = (env.GEMINI_API_KEY || '').split(',')[0].trim();
  if (!geminiKey) {
    console.error('GEMINI_API_KEY مفقود');
    return null;
  }

  const modelsToTry = [PRIMARY_MODEL, FALLBACK_MODEL];
  let lastError = '';

  for (const model of modelsToTry) {
    try {
      const rawText = await callGeminiModel(model, geminiKey, fullPrompt);
      if (rawText && rawText.trim()) {
        const cleanReply = sanitizeAiResponse(rawText);
        if (cleanReply) {
          if (auditLogId) {
            await updateAuditLog(env, auditLogId, {
              workflowStep: { step: 'ai_generated', model, chars: cleanReply.length, status: 'ok' }
            });
          }
          return { reply: cleanReply, model };
        }
      }
    } catch (err) {
      lastError = err.message;
      console.warn(`Model ${model} failed, trying next...`, err.message);
    }
  }

  console.error('All AI models failed:', lastError);
  return null;
}

// -----------------------------------------------------------------------------
// 5) معالجات الرسائل والتعليقات
// -----------------------------------------------------------------------------
async function handleDirectMessage(env, payload, preGeneratedReply = null) {
  const accountId = payload.account?.id || payload.account?.accountId;
  const conversationId = payload.message?.conversationId;
  const messageId = payload.message?.id || payload.id || `msg_${Date.now()}`;
  const incomingText = payload.message?.text || payload.message?.message || '';
  const sender = payload.message?.sender || { name: 'عميل' };
  const platform = payload.account?.platform || 'instagram';

  if (!accountId || !conversationId || !incomingText) return;

  if (env.ZERNIO_KV && !preGeneratedReply) {
    const dedupKey = `dedup_msg_${messageId}`;
    if (await env.ZERNIO_KV.get(dedupKey)) return;
    await env.ZERNIO_KV.put(dedupKey, '1', { expirationTtl: DEDUP_TTL_SECONDS });
  }

  const logEntry = {
    id: messageId,
    event: 'message.received',
    platform,
    accountId,
    conversationId,
    sender,
    incomingText,
    workflow: [{ step: 'received', status: 'ok', text: incomingText }],
    status: 'processing',
    replyText: null,
    error: null
  };

  await createAuditLog(env, logEntry);

  zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, {
    method: 'POST',
    body: JSON.stringify({ accountId })
  }).catch(() => {});

  let aiResult = preGeneratedReply ? { reply: preGeneratedReply, model: 'manual_retry' } : null;
  if (!aiResult) {
    let contextHistory = '';
    try {
      const history = await zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages?accountId=${accountId}&limit=5&sortOrder=desc`);
      if (history.ok && Array.isArray(history.data?.data)) {
        contextHistory = history.data.data.reverse().map(m => `${m.sender?.name || 'طرف'}: ${m.message || m.text}`).join('\n');
        await updateAuditLog(env, messageId, { workflowStep: { step: 'context_fetched', messagesCount: history.data.data.length } });
      }
    } catch (_) {}

    aiResult = await generateStrictReply(env, incomingText, contextHistory, false, messageId);
  }

  if (!aiResult || !aiResult.reply) {
    const errorMsg = `فشل توليد الرد من الذكاء الاصطناعي`;
    await updateAuditLog(env, messageId, { status: 'failed', error: errorMsg });
    await pushToFailedQueue(env, { id: messageId, type: 'message', platform, payload, errorReason: errorMsg });
    return;
  }

  const finalReply = sanitizeAiResponse(aiResult.reply);

  const sendRes = await zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ accountId, message: finalReply })
  });

  if (sendRes.ok) {
    await updateAuditLog(env, messageId, {
      status: 'completed',
      replyText: finalReply,
      workflowStep: { step: 'delivered_to_platform', status: 'success', model: aiResult.model, zernioStatus: sendRes.status }
    });
    const queue = (await getFailedQueue(env)).filter(q => q.id !== messageId);
    await saveFailedQueue(env, queue);
  } else {
    const errorMsg = `فشل الإرسال لـ Zernio (${sendRes.status}): ${JSON.stringify(sendRes.data)}`;
    await updateAuditLog(env, messageId, { status: 'queued_for_retry', error: errorMsg, replyText: finalReply });
    await pushToFailedQueue(env, { id: messageId, type: 'message', platform, payload, generatedReply: finalReply, errorReason: errorMsg });
  }
}

async function handleDirectComment(env, payload, preGeneratedReply = null) {
  const accountId = payload.account?.id || payload.account?.accountId;
  const postId = payload.comment?.platformPostId || payload.post?.platformPostId;
  const commentId = payload.comment?.id || payload.comment?.platformCommentId || `comm_${Date.now()}`;
  const commentText = payload.comment?.text || payload.comment?.message || '';
  const sender = payload.comment?.sender || { name: 'معلق' };
  const platform = payload.account?.platform || 'facebook';

  if (!accountId || !postId || !commentText) return;

  const logEntry = {
    id: commentId,
    event: 'comment.received',
    platform,
    accountId,
    postId,
    sender,
    incomingText: commentText,
    workflow: [{ step: 'comment_received', status: 'ok', text: commentText }],
    status: 'processing',
    replyText: null,
    error: null
  };

  await createAuditLog(env, logEntry);

  let aiResult = preGeneratedReply ? { reply: preGeneratedReply, model: 'manual_retry' } : null;
  if (!aiResult) {
    aiResult = await generateStrictReply(env, commentText, '', true, commentId);
  }

  if (!aiResult || !aiResult.reply) {
    const errorMsg = `فشل توليد رد التعليق من الذكاء الاصطناعي`;
    await updateAuditLog(env, commentId, { status: 'failed', error: errorMsg });
    await pushToFailedQueue(env, { id: commentId, type: 'comment', platform, payload, errorReason: errorMsg });
    return;
  }

  const finalReply = sanitizeAiResponse(aiResult.reply);

  const replyRes = await zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}`, {
    method: 'POST',
    body: JSON.stringify({ accountId, commentId, message: finalReply })
  });

  if (replyRes.ok) {
    await updateAuditLog(env, commentId, {
      status: 'completed',
      replyText: finalReply,
      workflowStep: { step: 'comment_replied', status: 'success', model: aiResult.model, zernioStatus: replyRes.status }
    });
    const queue = (await getFailedQueue(env)).filter(q => q.id !== commentId);
    await saveFailedQueue(env, queue);
  } else {
    const errorMsg = `فشل إرسال التعليق لـ Zernio (${replyRes.status}): ${JSON.stringify(replyRes.data)}`;
    await updateAuditLog(env, commentId, { status: 'queued_for_retry', error: errorMsg, replyText: finalReply });
    await pushToFailedQueue(env, { id: commentId, type: 'comment', platform, payload, generatedReply: finalReply, errorReason: errorMsg });
  }
}

async function retryAllFailedMessages(env) {
  const queue = await getFailedQueue(env);
  if (queue.length === 0) return { ok: true, processed: 0, remaining: 0 };

  const remainingQueue = [];
  let successful = 0;

  for (const item of queue) {
    try {
      if (item.type === 'message') {
        await handleDirectMessage(env, item.payload, item.generatedReply);
      } else if (item.type === 'comment') {
        await handleDirectComment(env, item.payload, item.generatedReply);
      }
      successful++;
    } catch (err) {
      item.retries = (item.retries || 0) + 1;
      item.errorReason = err.message;
      if (item.retries < 5) remainingQueue.push(item);
    }
  }

  await saveFailedQueue(env, remainingQueue);
  return { ok: true, processed: successful, remaining: remainingQueue.length };
}

// -----------------------------------------------------------------------------
// 6) مسارات الـ API
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

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

  // 2. الحسابات المتصلة
  if (method === 'GET' && path === '/api/accounts') {
    const zernioRes = await zernioFetch(env, `/accounts?profileId=${PROFILE_ID}`);
    return jsonResponse(zernioRes.data, zernioRes.status);
  }

  // 3. فصل الحساب
  if (method === 'DELETE' && path.startsWith('/api/accounts/')) {
    const accountId = path.split('/api/accounts/')[1];
    if (!accountId) return jsonResponse({ error: 'accountId مطلوب' }, 400);

    const zernioRes = await zernioFetch(env, `/accounts/${encodeURIComponent(accountId)}`, {
      method: 'DELETE'
    });

    if (zernioRes.ok || zernioRes.status === 404) {
      return jsonResponse({ ok: true, message: 'تم فصل الحساب بنجاح من Zernio' });
    }
    return jsonResponse({ ok: false, error: zernioRes.data?.error || 'فشل فصل الحساب' }, zernioRes.status);
  }

  // 4. سجل الـ 3 أيام
  if (method === 'GET' && path === '/api/audit-logs') {
    const logs = await getRecentAuditLogs(env);
    return jsonResponse({ ok: true, count: logs.length, logs });
  }

  // 5. نظرة عامة للأدمن
  if (method === 'GET' && path === '/api/admin/overview') {
    const prompt = env.ZERNIO_KV ? await env.ZERNIO_KV.get('custom_agent_prompt') : null;
    const ragMeta = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_meta') : null;
    const ragContent = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_content') : null;
    const failedQueue = await getFailedQueue(env);

    return jsonResponse({
      ok: true,
      activeModel: PRIMARY_MODEL,
      fallbackModel: FALLBACK_MODEL,
      maxSafeChars: MAX_SAFE_CHARS,
      prompt: prompt || 'البرومبت الافتراضي نشط',
      rag: {
        active: !!ragContent,
        meta: ragMeta ? JSON.parse(ragMeta) : null,
        preview: ragContent ? ragContent.slice(0, 500) : null
      },
      failedQueueCount: failedQueue.length
    });
  }

  // 6. طابور الفشل
  if (method === 'GET' && path === '/api/failed-messages') {
    const queue = await getFailedQueue(env);
    return jsonResponse({ ok: true, count: queue.length, queue });
  }

  if (method === 'POST' && path === '/api/retry-failed') {
    const res = await retryAllFailedMessages(env);
    return jsonResponse(res);
  }

  if (method === 'POST' && path === '/api/clear-failed') {
    await saveFailedQueue(env, []);
    return jsonResponse({ ok: true, message: 'تم تفريغ طابور الفشل بنجاح' });
  }

  // 7. البرومبت والـ RAG
  if (method === 'POST' && path === '/api/set-prompt') {
    const body = await request.json().catch(() => ({}));
    if (!body.prompt) return jsonResponse({ error: 'حقل prompt مفقود' }, 400);
    if (env.ZERNIO_KV) await env.ZERNIO_KV.put('custom_agent_prompt', body.prompt);
    return jsonResponse({ ok: true, message: 'تم حفظ التعليمات بالسيرفر بنجاح' });
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

  // 8. مسارات OAuth فيسبوك الرسمية
  if (method === 'GET' && path === '/api/auth/facebook') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook?profileId=${PROFILE_ID}&headless=true&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'GET' && path === '/api/auth/facebook/pages') {
    const tempToken = url.searchParams.get('tempToken');
    const connectToken = url.searchParams.get('connect_token') || request.headers.get('x-connect-token') || '';
    if (!tempToken) return jsonResponse({ error: 'tempToken مطلوب' }, 400);

    const headers = { 'Authorization': `Bearer ${API_KEY}` };
    if (connectToken) headers['X-Connect-Token'] = connectToken;

    const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook/select-page?profileId=${PROFILE_ID}&tempToken=${encodeURIComponent(tempToken)}`;
    const res = await fetch(zernioUrl, { headers });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'POST' && path === '/api/auth/facebook/select') {
    const body = await request.json().catch(() => ({}));
    body.profileId = PROFILE_ID;
    const connectToken = body.connect_token || request.headers.get('x-connect-token') || '';
    const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
    if (connectToken) headers['X-Connect-Token'] = connectToken;

    const res = await fetch(`${ZERNIO_API_BASE}/connect/facebook/select-page`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 9. مسارات OAuth إنستغرام الرسمية
  if (method === 'GET' && path === '/api/auth/instagram') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'GET' && path === '/api/auth/instagram/accounts') {
    const tempToken = url.searchParams.get('tempToken');
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram/select-account?profileId=${PROFILE_ID}&tempToken=${tempToken}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'POST' && path === '/api/auth/instagram/select') {
    const body = await request.json().catch(() => ({}));
    body.profileId = PROFILE_ID;
    const res = await fetch(`${ZERNIO_API_BASE}/connect/instagram/select-account`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 10. اختبار الشات الصارم
  if (method === 'POST' && path === '/api/test-chat') {
    const body = await request.json().catch(() => ({}));
    const userMessage = body.message || 'مرحباً، ما هي الخدمات والأسعار؟';
    const result = await generateStrictReply(env, userMessage, '', false, `test_${Date.now()}`);
    if (!result || !result.reply) {
      return jsonResponse({ ok: false, error: 'تعذر توليد الرد من الذكاء الاصطناعي' }, 500);
    }
    return jsonResponse({
      ok: true,
      modelUsed: result.model,
      charsCount: result.reply.length,
      userMessage,
      reply: result.reply,
      timestamp: isoNow()
    });
  }

  return jsonResponse({ error: 'Endpoint not found' }, 404);
}

// -----------------------------------------------------------------------------
// 7) نقطة الدخول
// -----------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    if (url.pathname.startsWith('/api/')) {
      return await handleApiRequests(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/webhook/zernio') {
      const rawBody = await request.text();
      let payload;
      try { payload = JSON.parse(rawBody); } catch (_) { return new Response('Invalid JSON', { status: 400 }); }

      if (payload.event === 'message.received') {
        ctx.waitUntil(handleDirectMessage(env, payload));
      } else if (payload.event === 'comment.received') {
        ctx.waitUntil(handleDirectComment(env, payload));
      }

      return jsonResponse({ ok: true, queued: true });
    }

    return new Response('Bedaya Production Engine v19.0 Running (Clean Prompt Injection & Fallback).', { headers: corsHeaders });
  }
};
