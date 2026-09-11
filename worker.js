// =============================================================================
// Bedaya Meta Engine (v13.0: 3-Day Workflow Audit Logger & Live Account Tracker)
// =============================================================================

const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const CLOUDFLARE_AI_BASE = "https://api.cloudflare.com/client/v4/accounts";

const CALL_TIMEOUT_MS = 15000;
const AI_TIMEOUT_MS = 25000;
const AUDIT_LOG_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 أيام (259200 ثانية)
const DEDUP_TTL_SECONDS = 86400; // 24 ساعة

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
// 1) دوال الاتصال بـ Zernio API
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
// 2) نظام تتبع الرسائل وسجل الـ 3 أيام (3-Day Audit Logging Engine)
// -----------------------------------------------------------------------------
async function createAuditLog(env, logEntry) {
  if (!env.ZERNIO_KV) return;
  try {
    const logId = logEntry.id || `log_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    logEntry.id = logId;
    logEntry.createdAt = logEntry.createdAt || isoNow();

    // حفظ السجل الفردي مع مدة صلاحية 3 أيام
    await env.ZERNIO_KV.put(`audit_log_${logId}`, JSON.stringify(logEntry), {
      expirationTtl: AUDIT_LOG_TTL_SECONDS
    });

    // تحديث فهرس السجلات الحديثة
    let index = [];
    try {
      const rawIndex = await env.ZERNIO_KV.get('audit_logs_index');
      index = rawIndex ? JSON.parse(rawIndex) : [];
    } catch (_) {}

    index.unshift({ id: logId, time: logEntry.createdAt, platform: logEntry.platform, event: logEntry.event, status: logEntry.status });
    if (index.length > 200) index = index.slice(0, 200); // الاحتفاظ بآخر 200 معرّف

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
    console.error('Update Audit Log Error:', err);
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
// 3) طابور الرسائل الفاشلة والإحصائيات
// -----------------------------------------------------------------------------
async function incrementStat(env, keyName) {
  if (!env.ZERNIO_KV) return;
  try {
    const current = parseInt(await env.ZERNIO_KV.get(keyName) || '0', 10);
    await env.ZERNIO_KV.put(keyName, String(current + 1));
    await env.ZERNIO_KV.put('stat_last_active', isoNow());
  } catch (_) {}
}

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
  const exists = queue.some(q => q.id === item.id);
  if (!exists) {
    queue.push({
      id: item.id,
      type: item.type,
      payload: item.payload,
      generatedReply: item.generatedReply || null,
      errorReason: item.errorReason || 'Unknown Error',
      retries: item.retries || 0,
      createdAt: isoNow()
    });
    await saveFailedQueue(env, queue);
  }
}

// -----------------------------------------------------------------------------
// 4) توليد الرد الصارم (Strict AI Generator - No Dummy Responses)
// -----------------------------------------------------------------------------
async function generateStrictReply(env, incomingText, contextHistory = '', isComment = false, auditLogId = null) {
  let customPrompt = 'أنت مساعد خدمة عملاء ومبيعات محترف وودود، ترد بدقة على استفسارات العملاء.';
  let ragContent = '';

  if (env.ZERNIO_KV) {
    customPrompt = await env.ZERNIO_KV.get('custom_agent_prompt') || customPrompt;
    ragContent = await env.ZERNIO_KV.get('rag_doc_content') || '';
  }

  const systemInstruction = [
    '=== تعليمات وسيناريو المتجر ===',
    customPrompt,
    ragContent ? `\n=== قاعدة المعرفة والمنتجات (RAG) ===\n${ragContent}` : '',
    '\n=== القواعد الصارمة ===',
    isComment ? '- رد على التعليق باختصار واحترافية.' : '- رد على رسالة الـ DM بدقة وقدم التفاصيل المطلوبة.',
    '- اكتب نص الرد باللغة العربية مباشرة دون أي مقدمات أو وسوم برمجية.'
  ].join('\n');

  // 1. تجربة Gemini 1.5 Flash
  const geminiKey = (env.GEMINI_API_KEY || '').split(',')[0].trim();
  if (geminiKey) {
    try {
      const res = await Promise.race([
        fetch(`${GEMINI_API_BASE}/gemini-1.5-flash:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({
            contents: [
              ...(contextHistory ? [{ role: 'user', parts: [{ text: `سياق المحادثة:\n${contextHistory}` }] }] : []),
              { role: 'user', parts: [{ text: incomingText }] }
            ],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig: { temperature: 0.35, maxOutputTokens: 800 }
          })
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini Timeout')), AI_TIMEOUT_MS))
      ]);

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim()) {
          if (auditLogId) await updateAuditLog(env, auditLogId, { workflowStep: { step: 'ai_generated', model: 'Google Gemini 1.5 Flash', status: 'ok' } });
          return text.trim();
        }
      }
    } catch (err) {
      console.error('Gemini error, trying Workers AI...', err);
    }
  }

  // 2. تجربة Cloudflare Workers AI كـ Fallback
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    try {
      const cfUrl = `${CLOUDFLARE_AI_BASE}/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/google/gemma-3-12b-it`;
      const res = await fetch(cfUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemInstruction },
            ...(contextHistory ? [{ role: 'user', content: `سياق المحادثة:\n${contextHistory}` }] : []),
            { role: 'user', content: incomingText }
          ],
          max_tokens: 800
        })
      });
      const data = await res.json();
      const reply = data.result?.response || (data.result && typeof data.result === 'string' ? data.result : '');
      if (reply && reply.trim()) {
        if (auditLogId) await updateAuditLog(env, auditLogId, { workflowStep: { step: 'ai_generated', model: 'Cloudflare Gemma-3-12B', status: 'ok' } });
        return reply.trim();
      }
    } catch (cfErr) {
      console.error('Workers AI error:', cfErr);
    }
  }

  return null; // لا يتم إرجاع أي رد وهمي إطلاقاً
}

// -----------------------------------------------------------------------------
// 5) معالجة الرسائل والتعليقات مع التسجيل الكامل في الـ Audit Log
// -----------------------------------------------------------------------------
async function handleDirectMessage(env, payload, preGeneratedReply = null) {
  const accountId = payload.account?.id || payload.account?.accountId;
  const conversationId = payload.message?.conversationId;
  const messageId = payload.message?.id || payload.id || `msg_${Date.now()}`;
  const incomingText = payload.message?.text || payload.message?.message || '';
  const sender = payload.message?.sender || { name: 'عميل' };
  const platform = payload.account?.platform || 'instagram';

  if (!accountId || !conversationId || !incomingText) return;

  // فحص منع التكرار
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
    workflow: [
      { step: 'received', status: 'ok', text: incomingText }
    ],
    status: 'processing',
    replyText: null,
    error: null
  };

  await createAuditLog(env, logEntry);

  // إرسال مؤشر الكتابة
  zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, {
    method: 'POST',
    body: JSON.stringify({ accountId })
  }).catch(() => {});

  let aiReplyText = preGeneratedReply;
  if (!aiReplyText) {
    let contextHistory = '';
    try {
      const history = await zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages?accountId=${accountId}&limit=6&sortOrder=desc`);
      if (history.ok && Array.isArray(history.data?.data)) {
        contextHistory = history.data.data.reverse().map(m => `${m.sender?.name || 'طرف'}: ${m.message || m.text}`).join('\n');
        await updateAuditLog(env, messageId, { workflowStep: { step: 'context_fetched', messagesCount: history.data.data.length } });
      }
    } catch (_) {}

    aiReplyText = await generateStrictReply(env, incomingText, contextHistory, false, messageId);
  }

  // إذا تعطل الذكاء الاصطناعي، يضاف إلى طابور الفشل
  if (!aiReplyText) {
    const errorMsg = 'تعذر توليد الرد من نماذج الذكاء الاصطناعي (AI Generation Failed)';
    await updateAuditLog(env, messageId, { status: 'failed', error: errorMsg });
    await pushToFailedQueue(env, { id: messageId, type: 'message', payload, errorReason: errorMsg });
    return;
  }

  // إرسال الرد عبر Zernio
  const sendRes = await zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ accountId, message: aiReplyText })
  });

  if (sendRes.ok) {
    await incrementStat(env, 'stat_dms_count');
    await updateAuditLog(env, messageId, {
      status: 'completed',
      replyText: aiReplyText,
      workflowStep: { step: 'delivered_to_platform', status: 'success', zernioStatus: sendRes.status }
    });
  } else {
    const errorMsg = `فشل إرسال الرد لـ Zernio (${sendRes.status}): ${JSON.stringify(sendRes.data)}`;
    await updateAuditLog(env, messageId, { status: 'queued_for_retry', error: errorMsg, replyText: aiReplyText });
    await pushToFailedQueue(env, { id: messageId, type: 'message', payload, generatedReply: aiReplyText, errorReason: errorMsg });
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
    workflow: [
      { step: 'comment_received', status: 'ok', text: commentText }
    ],
    status: 'processing',
    replyText: null,
    error: null
  };

  await createAuditLog(env, logEntry);

  let aiReplyText = preGeneratedReply;
  if (!aiReplyText) {
    aiReplyText = await generateStrictReply(env, commentText, '', true, commentId);
  }

  if (!aiReplyText) {
    const errorMsg = 'تعذر توليد رد التعليق من الذكاء الاصطناعي';
    await updateAuditLog(env, commentId, { status: 'failed', error: errorMsg });
    await pushToFailedQueue(env, { id: commentId, type: 'comment', payload, errorReason: errorMsg });
    return;
  }

  const replyRes = await zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}`, {
    method: 'POST',
    body: JSON.stringify({ accountId, commentId, message: aiReplyText })
  });

  if (replyRes.ok) {
    await incrementStat(env, 'stat_comments_count');
    await updateAuditLog(env, commentId, {
      status: 'completed',
      replyText: aiReplyText,
      workflowStep: { step: 'comment_replied', status: 'success', zernioStatus: replyRes.status }
    });
  } else {
    const errorMsg = `فشل إرسال التعليق لـ Zernio (${replyRes.status})`;
    await updateAuditLog(env, commentId, { status: 'queued_for_retry', error: errorMsg, replyText: aiReplyText });
    await pushToFailedQueue(env, { id: commentId, type: 'comment', payload, generatedReply: aiReplyText, errorReason: errorMsg });
  }
}

// -----------------------------------------------------------------------------
// 6) محرك إعادة المحاولة لجميع الرسائل الفاشلة
// -----------------------------------------------------------------------------
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
      item.lastRetryError = err.message;
      if (item.retries < 5) remainingQueue.push(item);
    }
  }

  await saveFailedQueue(env, remainingQueue);
  return { ok: true, processed: successful, remaining: remainingQueue.length };
}

// -----------------------------------------------------------------------------
// 7) مسارات الـ API للإنتاج
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

  // 1. مسار جلب سجل تتبع الـ 3 أيام
  if (method === 'GET' && path === '/api/audit-logs') {
    const logs = await getRecentAuditLogs(env);
    return jsonResponse({ ok: true, count: logs.length, logs });
  }

  // 2. مسار فحص لوحة الأدمن للبرومبت والـ RAG والإحصائيات
  if (method === 'GET' && path === '/api/admin/overview') {
    const prompt = env.ZERNIO_KV ? await env.ZERNIO_KV.get('custom_agent_prompt') : null;
    const ragMeta = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_meta') : null;
    const ragContent = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_content') : null;
    const dms = parseInt(await env.ZERNIO_KV.get('stat_dms_count') || '0', 10);
    const comments = parseInt(await env.ZERNIO_KV.get('stat_comments_count') || '0', 10);
    const failedQueue = await getFailedQueue(env);

    return jsonResponse({
      ok: true,
      prompt: prompt || 'البرومبت الافتراضي نشط',
      rag: {
        active: !!ragContent,
        meta: ragMeta ? JSON.parse(ragMeta) : null,
        preview: ragContent ? ragContent.slice(0, 500) : null
      },
      stats: { dms, comments, failedCount: failedQueue.length }
    });
  }

  // 3. مسار جلب الحسابات المتصلة من Zernio مباشرة
  if (method === 'GET' && path === '/api/accounts') {
    const zernioRes = await zernioFetch(env, `/accounts?profileId=${PROFILE_ID}`);
    return jsonResponse(zernioRes.data, zernioRes.status);
  }

  // 4. مسار فصل الحساب الفعلي
  if (method === 'DELETE' && path.startsWith('/api/accounts/')) {
    const accountId = path.split('/api/accounts/')[1];
    if (!accountId) return jsonResponse({ error: 'accountId مطلوب' }, 400);

    const zernioRes = await zernioFetch(env, `/accounts/${encodeURIComponent(accountId)}`, {
      method: 'DELETE'
    });

    if (zernioRes.ok || zernioRes.status === 404) {
      return jsonResponse({ ok: true, message: 'تم فصل الحساب بنجاح من منصة Zernio' });
    }
    return jsonResponse({ ok: false, error: zernioRes.data?.error || 'فشل فصل الحساب' }, zernioRes.status);
  }

  // 5. طابور الرسائل الفاشلة
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

  // 6. حفظ البرومبت
  if (method === 'POST' && path === '/api/set-prompt') {
    const body = await request.json().catch(() => ({}));
    if (!body.prompt) return jsonResponse({ error: 'حقل prompt مفقود' }, 400);
    if (env.ZERNIO_KV) await env.ZERNIO_KV.put('custom_agent_prompt', body.prompt);
    return jsonResponse({ ok: true, message: 'تم حفظ التعليمات في السيرفر بنجاح' });
  }

  // 7. رفع وحذف الـ RAG
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

  // 8. مسارات OAuth فيسبوك وإنستغرام
  if (method === 'GET' && path === '/api/auth/facebook') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook?profileId=${PROFILE_ID}&headless=true&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
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

  // 9. تجربة الشات المباشر الصارم
  if (method === 'POST' && path === '/api/test-chat') {
    const body = await request.json().catch(() => ({}));
    const userMessage = body.message || 'مرحباً، ما هي الأسعار والخدمات؟';
    const reply = await generateStrictReply(env, userMessage, '', false, `test_${Date.now()}`);
    if (!reply) return jsonResponse({ ok: false, error: 'فشل الذكاء الاصطناعي في الاستجابة (تم حجب أي رد وهمي)' }, 500);
    return jsonResponse({ ok: true, userMessage, reply, timestamp: isoNow() });
  }

  return jsonResponse({ error: 'المسار غير موجود (Endpoint not found)' }, 404);
}

// -----------------------------------------------------------------------------
// 8) نقطة الدخول
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

    return new Response('Bedaya Production Engine v13.0 Running with 3-Day Audit Log.', { headers: corsHeaders });
  }
};
