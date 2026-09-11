// =============================================================================
// Bedaya Meta Engine (v12.0: Zero-Dummy Responders & Failed Queue Retry Engine)
// خادم بداية المحكم - طابور الرسائل الفاشلة، عدم التكرار، والردود الحقيقية فقط
// =============================================================================

const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const CLOUDFLARE_AI_BASE = "https://api.cloudflare.com/client/v4/accounts";

const CALL_TIMEOUT_MS = 15000;
const AI_TIMEOUT_MS = 25000;
const DEDUP_TTL_SECONDS = 86400; // 24 ساعة لمنع تكرار الرد على نفس الرسالة

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
// 1) دوال Zernio API الأساسية
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
// 2) إدارة طابور الرسائل الفاشلة والإحصائيات (Queue & Stats Engine)
// -----------------------------------------------------------------------------
async function incrementStat(env, keyName) {
  try {
    if (!env.ZERNIO_KV) return;
    const current = parseInt(await env.ZERNIO_KV.get(keyName) || '0', 10);
    await env.ZERNIO_KV.put(keyName, String(current + 1));
    await env.ZERNIO_KV.put('stat_last_active', isoNow());
  } catch (err) {
    console.error('Stats error:', err);
  }
}

async function getLiveStats(env) {
  try {
    if (!env.ZERNIO_KV) return { dms: 0, comments: 0, failedCount: 0, lastActive: null };
    const dms = parseInt(await env.ZERNIO_KV.get('stat_dms_count') || '0', 10);
    const comments = parseInt(await env.ZERNIO_KV.get('stat_comments_count') || '0', 10);
    const lastActive = await env.ZERNIO_KV.get('stat_last_active') || null;
    const queue = await getFailedQueue(env);
    return { dms, comments, failedCount: queue.length, lastActive };
  } catch (_) {
    return { dms: 0, comments: 0, failedCount: 0, lastActive: null };
  }
}

async function getFailedQueue(env) {
  if (!env.ZERNIO_KV) return [];
  try {
    const raw = await env.ZERNIO_KV.get('failed_messages_queue');
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

async function saveFailedQueue(env, queue) {
  if (!env.ZERNIO_KV) return;
  await env.ZERNIO_KV.put('failed_messages_queue', JSON.stringify(queue.slice(0, 100))); // حفظ آخر 100 رسالة فاشلة
}

async function pushToFailedQueue(env, item) {
  const queue = await getFailedQueue(env);
  // منع تكرار نفس الرسالة في الطابور
  const exists = queue.some(q => q.id === item.id);
  if (!exists) {
    queue.push({
      id: item.id || crypto.randomUUID().slice(0, 8),
      type: item.type, // 'message' | 'comment'
      payload: item.payload,
      generatedReply: item.generatedReply || null,
      errorReason: item.errorReason || 'Unknown error',
      retries: item.retries || 0,
      createdAt: isoNow()
    });
    await saveFailedQueue(env, queue);
  }
}

// -----------------------------------------------------------------------------
// 3) توليد الرد الصارم من الذكاء الاصطناعي (Strict Generator - No Dummy)
// -----------------------------------------------------------------------------
async function generateStrictReply(env, incomingText, contextHistory = '', isComment = false) {
  let customPrompt = 'أنت مساعد خدمة عملاء ومبيعات محترف وودود، ترد بدقة ولباقة على استفسارات العملاء.';
  let ragContent = '';

  if (env.ZERNIO_KV) {
    customPrompt = await env.ZERNIO_KV.get('custom_agent_prompt') || customPrompt;
    ragContent = await env.ZERNIO_KV.get('rag_doc_content') || '';
  }

  const systemInstruction = [
    '=== تعليمات وسيناريو المتجر ===',
    customPrompt,
    ragContent ? `\n=== كتالوج ومعلومات المنتجات وقاعدة المعرفة (RAG) ===\n${ragContent}` : '',
    '\n=== القواعد الصارمة للرد ===',
    isComment ? '- رد على تعليق المنشور باختصار واحترافية.' : '- رد على محادثة الـ DM بدقة وقدم التفاصيل للعميل.',
    '- اكتب نص الرد باللغة العربية مباشرة بدون JSON وبدون وسوم برمجية.'
  ].join('\n');

  // المحاولة الأولى: Gemini API
  const geminiKey = (env.GEMINI_API_KEY || '').split(',')[0].trim();
  if (geminiKey) {
    try {
      const res = await Promise.race([
        fetch(`${GEMINI_API_BASE}/gemini-1.5-flash:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({
            contents: [
              ...(contextHistory ? [{ role: 'user', parts: [{ text: `سياق المحادثة السابقة:\n${contextHistory}` }] }] : []),
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
        if (text && text.trim()) return text.trim();
      }
    } catch (err) {
      console.error('Gemini failed, trying Cloudflare AI...', err);
    }
  }

  // المحاولة الثانية: Cloudflare Workers AI
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
      if (reply && reply.trim()) return reply.trim();
    } catch (cfErr) {
      console.error('Workers AI failed:', cfErr);
    }
  }

  // تم إلغاء الرد الافتراضي نهائياً: إذا فشل الذكاء الاصطناعي نرجع null لتسجيلها في طابور الفشل
  return null;
}

// -----------------------------------------------------------------------------
// 4) معالجات الـ Direct Pipelines (مع حماية طابور الفشل)
// -----------------------------------------------------------------------------
async function handleDirectMessage(env, payload, preGeneratedReply = null) {
  const accountId = payload.account?.id || payload.account?.accountId;
  const conversationId = payload.message?.conversationId;
  const messageId = payload.message?.id || payload.id;
  const incomingText = payload.message?.text || payload.message?.message || '';

  if (!accountId || !conversationId || !incomingText) return;

  // فحص عدم التكرار (Deduplication)
  if (env.ZERNIO_KV && messageId && !preGeneratedReply) {
    const dedupKey = `dedup_msg_${messageId}`;
    const alreadyProcessed = await env.ZERNIO_KV.get(dedupKey);
    if (alreadyProcessed) return;
    await env.ZERNIO_KV.put(dedupKey, '1', { expirationTtl: DEDUP_TTL_SECONDS });
  }

  // إرسال مؤشر الكتابة
  zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, {
    method: 'POST',
    body: JSON.stringify({ accountId })
  }).catch(() => {});

  let aiReplyText = preGeneratedReply;

  if (!aiReplyText) {
    // جلب سياق الرسائل السابقة
    let contextHistory = '';
    try {
      const history = await zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages?accountId=${accountId}&limit=6&sortOrder=desc`);
      if (history.ok && Array.isArray(history.data?.data)) {
        contextHistory = history.data.data.reverse().map(m => `${m.sender?.name || 'طرف'}: ${m.message || m.text}`).join('\n');
      }
    } catch (_) {}

    // توليد الرد الصارم
    aiReplyText = await generateStrictReply(env, incomingText, contextHistory, false);
  }

  // إذا تعطل الذكاء الاصطناعي، يتم الحفظ في طابور الفشل فوراً ولا نرسل رداً تافهاً
  if (!aiReplyText) {
    await pushToFailedQueue(env, {
      id: messageId,
      type: 'message',
      payload,
      errorReason: 'فشل استجابة نماذج الذكاء الاصطناعي (AI Timeout/Error)'
    });
    return;
  }

  // إرسال الرد
  const sendRes = await zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ accountId, message: aiReplyText })
  });

  if (sendRes.ok) {
    await incrementStat(env, 'stat_dms_count');
  } else {
    // فشل الإرسال لسبب شبكي أو توكن: نحفظ الرسالة والرد الجاهز في الـ Queue
    await pushToFailedQueue(env, {
      id: messageId,
      type: 'message',
      payload,
      generatedReply: aiReplyText,
      errorReason: `فشل الإرسال لـ Zernio (${sendRes.status}): ${JSON.stringify(sendRes.data)}`
    });
  }
}

async function handleDirectComment(env, payload, preGeneratedReply = null) {
  const accountId = payload.account?.id || payload.account?.accountId;
  const postId = payload.comment?.platformPostId || payload.post?.platformPostId;
  const commentId = payload.comment?.id || payload.comment?.platformCommentId;
  const commentText = payload.comment?.text || payload.comment?.message || '';

  if (!accountId || !postId || !commentText) return;

  let aiReplyText = preGeneratedReply;
  if (!aiReplyText) {
    aiReplyText = await generateStrictReply(env, commentText, '', true);
  }

  if (!aiReplyText) {
    await pushToFailedQueue(env, {
      id: commentId || postId,
      type: 'comment',
      payload,
      errorReason: 'فشل استجابة نماذج الذكاء الاصطناعي أثناء معالجة التعليق'
    });
    return;
  }

  const replyRes = await zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}`, {
    method: 'POST',
    body: JSON.stringify({ accountId, commentId, message: aiReplyText })
  });

  if (replyRes.ok) {
    await incrementStat(env, 'stat_comments_count');
  } else {
    await pushToFailedQueue(env, {
      id: commentId || postId,
      type: 'comment',
      payload,
      generatedReply: aiReplyText,
      errorReason: `فشل إرسال التعليق لـ Zernio (${replyRes.status})`
    });
  }
}

// -----------------------------------------------------------------------------
// 5) محرك إعادة محاولة الرسائل الفاشلة (Retry Engine)
// -----------------------------------------------------------------------------
async function retryAllFailedMessages(env) {
  const queue = await getFailedQueue(env);
  if (queue.length === 0) return { ok: true, processed: 0, remaining: 0 };

  const remainingQueue = [];
  let successfulRetries = 0;

  for (const item of queue) {
    try {
      if (item.type === 'message') {
        await handleDirectMessage(env, item.payload, item.generatedReply);
      } else if (item.type === 'comment') {
        await handleDirectComment(env, item.payload, item.generatedReply);
      }
      successfulRetries++;
    } catch (err) {
      item.retries = (item.retries || 0) + 1;
      item.lastRetryError = err.message;
      if (item.retries < 5) {
        remainingQueue.push(item);
      }
    }
  }

  await saveFailedQueue(env, remainingQueue);
  return { ok: true, processed: successfulRetries, remaining: remainingQueue.length };
}

// -----------------------------------------------------------------------------
// 6) مسارات الـ API الشاملة
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

  // 1. فحص الحالة والإحصائيات
  if (method === 'GET' && path === '/api/stats') {
    const stats = await getLiveStats(env);
    return jsonResponse({ ok: true, stats });
  }

  // 2. فحص طابور الرسائل الفاشلة
  if (method === 'GET' && path === '/api/failed-messages') {
    const queue = await getFailedQueue(env);
    return jsonResponse({ ok: true, count: queue.length, queue });
  }

  // 3. إعادة محاولة إرسال الرسائل الفاشلة
  if (method === 'POST' && path === '/api/retry-failed') {
    const result = await retryAllFailedMessages(env);
    return jsonResponse(result);
  }

  // 4. تفريغ طابور الرسائل الفاشلة
  if (method === 'POST' && path === '/api/clear-failed') {
    await saveFailedQueue(env, []);
    return jsonResponse({ ok: true, message: 'تم مسح طابور الفشل بنجاح' });
  }

  // 5. تجربة المحاكاة المباشرة
  if (method === 'POST' && path === '/api/test-chat') {
    const body = await request.json().catch(() => ({}));
    const userMessage = body.message || 'مرحباً، ما هي الخدمات والأسعار لديكم؟';
    const reply = await generateStrictReply(env, userMessage, '', false);
    if (!reply) {
      return jsonResponse({ ok: false, error: 'تعذر توليد الرد من الذكاء الاصطناعي (تم تفادي الرد الافتراضي)' }, 500);
    }
    return jsonResponse({ ok: true, userMessage, reply, timestamp: isoNow() });
  }

  // 6. البرومبت
  if (method === 'POST' && path === '/api/set-prompt') {
    const body = await request.json().catch(() => ({}));
    if (!body.prompt) return jsonResponse({ error: 'حقل prompt مفقود' }, 400);
    if (env.ZERNIO_KV) await env.ZERNIO_KV.put('custom_agent_prompt', body.prompt);
    return jsonResponse({ ok: true, message: 'تم حفظ التعليمات بالسيرفر بنجاح' });
  }

  if (method === 'GET' && path === '/api/get-prompt') {
    const prompt = env.ZERNIO_KV ? await env.ZERNIO_KV.get('custom_agent_prompt') : null;
    return jsonResponse({ ok: true, prompt: prompt || 'البرومبت الافتراضي نشط' });
  }

  // 7. الـ RAG
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

  // 8. زر الفصل الحقيقي من Zernio (Disconnect API)
  if (method === 'DELETE' && path.startsWith('/api/accounts/')) {
    const accountId = path.split('/api/accounts/')[1];
    if (!accountId) return jsonResponse({ error: 'accountId مطلوب' }, 400);

    const zernioRes = await zernioFetch(env, `/accounts/${encodeURIComponent(accountId)}`, {
      method: 'DELETE'
    });

    if (zernioRes.ok || zernioRes.status === 404) {
      return jsonResponse({ ok: true, message: 'تم فصل الحساب بنجاح من Zernio' });
    }
    return jsonResponse({ ok: false, error: zernioRes.data?.error || 'فشل فصل الحساب', status: zernioRes.status }, zernioRes.status);
  }

  // 9. تفويض الفيسبوك
  if (method === 'GET' && path === '/api/auth/facebook') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook?profileId=${PROFILE_ID}&headless=true&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
    const data = await res.json().catch(() => ({}));
    return jsonResponse(data, res.status);
  }

  // 10. تفويض الإنستغرام
  if (method === 'GET' && path === '/api/auth/instagram') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
    const data = await res.json().catch(() => ({}));
    return jsonResponse(data, res.status);
  }

  return jsonResponse({ error: 'Endpoint not found' }, 404);
}

// -----------------------------------------------------------------------------
// 7) نقطة الدخول وجدولة الإعادة
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

    return new Response('Bedaya Robust Engine v12.0 Running.', { headers: corsHeaders });
  },

  // إعادة المحاولة التلقائية كل فترة (Cron Trigger) إن وجدت
  async scheduled(event, env, ctx) {
    ctx.waitUntil(retryAllFailedMessages(env));
  }
};
