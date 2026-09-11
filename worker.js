// =============================================================================
// Bedaya Direct Responder Worker (v11.0: Fast Direct Responders & Zernio Engine)
// خادم فوري لمعالجة رسائل وتعليقات إنستغرام وفيسبوك مع نظام RAG والإحصائيات الحية
// =============================================================================

// 👇 ضع بيانات حساب Zernio الخاص بهذا العميل/السيرفر هنا 👇
const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const CLOUDFLARE_AI_BASE = "https://api.cloudflare.com/client/v4/accounts";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const WORKERS_AI_MODELS = [
  "@cf/google/gemma-3-12b-it",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/meta/llama-3.1-8b-instruct"
];
const DEFAULT_GEMINI_MODELS = ["gemma-4-26b-a4b-it", "gemma-4-26b-a4b-it"];

const CALL_TIMEOUT_MS = 15000;
const AI_CALL_TIMEOUT_MS = 25000;
const AUTO_CONTEXT_LIMIT = 8;

// إعدادات CORS للسماح لتطبيق الواجهة بالاتصال بالسيرفر
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zernio-key, x-connect-token, X-Connect-Token',
};

// -----------------------------------------------------------------------------
// 1) API ROUTER: مسارات المصادقة، حفظ البرومبت، مستندات الـ RAG، والـ Disconnect
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
    const path = url.pathname;
    const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
    const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

    // 1. مسار حفظ سيناريو وتعليمات الردود
    if (request.method === 'POST' && path === '/api/set-prompt') {
        const body = await request.json().catch(() => ({}));
        if (!body.prompt) {
            return jsonResponse({ error: 'حقل prompt مفقود في الطلب' }, 400);
        }
        await env.ZERNIO_KV.put('custom_agent_prompt', body.prompt);
        return jsonResponse({ ok: true, message: 'تم حفظ سيناريو الردود بنجاح' });
    }

    // 2. مسار رفع واستخراج نصوص مستند الـ RAG وتخزينه بالـ KV
    if (request.method === 'POST' && path === '/api/upload-rag-doc') {
        const body = await request.json().catch(() => ({}));
        const { name, size, textContent } = body;

        if (!textContent) {
            return jsonResponse({ error: 'محتوى الملف مفقود' }, 400);
        }

        await env.ZERNIO_KV.put('rag_doc_content', textContent);
        await env.ZERNIO_KV.put('rag_doc_meta', JSON.stringify({ name, size, updatedAt: new Date().toISOString() }));

        return jsonResponse({ 
            ok: true, 
            message: `تم حفظ وفهرسة نصوص مستند (${name}) بنجاح` 
        });
    }

    // 3. مسار حذف مستند الـ RAG من الـ KV
    if (request.method === 'POST' && path === '/api/delete-rag-doc') {
        await env.ZERNIO_KV.delete('rag_doc_content');
        await env.ZERNIO_KV.delete('rag_doc_meta');
        return jsonResponse({ ok: true, message: 'تم مسح المستند من قاعدة المعرفة بنجاح' });
    }

    // 4. مسار جلب الإحصائيات الحقيقية المحفوظة
    if (request.method === 'GET' && path === '/api/stats') {
        const statsRaw = await env.ZERNIO_KV.get('stats_summary');
        const stats = statsRaw ? JSON.parse(statsRaw) : {
            ig_dms: 0,
            ig_comments: 0,
            ig_last_active: 'جاهز للرد',
            fb_dms: 0,
            fb_comments: 0,
            fb_last_active: 'جاهز للرد'
        };
        return jsonResponse(stats);
    }

    // 5. مسار فصل وإلغاء ربط الحساب الفعلي (DELETE Account from Zernio API)
    if (request.method === 'DELETE' && path.startsWith('/api/accounts/')) {
        const accountId = path.split('/')[3];
        if (!accountId) {
            return jsonResponse({ error: 'معرّف الحساب accountId مفقود' }, 400);
        }

        const zernioUrl = `${ZERNIO_API_BASE}/accounts/${encodeURIComponent(accountId)}`;
        const res = await fetch(zernioUrl, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await res.json().catch(() => ({}));
        return jsonResponse({
            ok: res.ok,
            status: res.status,
            message: res.ok ? 'تم فصل الحساب بنجاح من Zernio' : (data.error || 'فشل فصل الحساب'),
            data
        }, res.ok ? 200 : res.status);
    }

    // 6. مسار جلب رابط تفويض الفيسبوك
    if (request.method === 'GET' && path === '/api/auth/facebook') {
        const redirectUrl = url.searchParams.get('redirect_url') || '';
        const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook?profileId=${PROFILE_ID}&headless=true&redirect_url=${encodeURIComponent(redirectUrl)}`;

        const res = await fetch(zernioUrl, { 
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } 
        });
        const data = await res.json().catch(() => ({}));
        return jsonResponse(data, res.status);
    }

    // 7. مسار تأكيد ربط صفحة الفيسبوك
    if (request.method === 'POST' && path === '/api/auth/facebook/select') {
        const body = await request.json().catch(() => ({}));
        body.profileId = PROFILE_ID; 

        const connectToken = body.connect_token || body.connectToken || request.headers.get('x-connect-token') || '';
        const zernioHeaders = { 
            'Authorization': `Bearer ${API_KEY}`, 
            'Content-Type': 'application/json' 
        };
        if (connectToken) {
            zernioHeaders['X-Connect-Token'] = connectToken;
        }

        if (typeof body.userProfile === 'string') {
            try {
                let dec = decodeURIComponent(body.userProfile);
                if (dec.startsWith('%')) dec = decodeURIComponent(dec);
                body.userProfile = JSON.parse(dec);
            } catch (_) {}
        }

        if (!body.userProfile || typeof body.userProfile !== 'object') {
            body.userProfile = { id: String(body.pageId || "122132545395248368"), name: "Facebook User" };
        }

        const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook/select-page`;
        const res = await fetch(zernioUrl, { 
            method: 'POST', 
            headers: zernioHeaders,
            body: JSON.stringify(body)
        });

        const data = await res.json().catch(() => ({}));
        // إرجاع معرّف الحساب بوضوح للواجهة لحفظه لعمليات الـ Disconnect اللاحقة
        if (res.ok && !data.accountId) {
            data.accountId = data.id || body.pageId;
        }
        return jsonResponse(data, res.status);
    }

    // 8. مسار جلب رابط تفويض الإنستغرام
    if (request.method === 'GET' && path === '/api/auth/instagram') {
        const redirectUrl = url.searchParams.get('redirect_url') || '';
        const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
        const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;

        const res = await fetch(zernioUrl, { 
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } 
        });
        const data = await res.json().catch(() => ({}));
        return jsonResponse(data, res.status);
    }

    // 9. مسار جلب حسابات الإنستغرام
    if (request.method === 'GET' && path === '/api/auth/instagram/accounts') {
        const tempToken = url.searchParams.get('tempToken');
        const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram/select-account?profileId=${PROFILE_ID}&tempToken=${tempToken}`;
        const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
        const data = await res.json().catch(() => ({}));
        return jsonResponse(data, res.status);
    }

    // 10. مسار تأكيد ربط حساب الإنستغرام
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
        if (res.ok && !data.accountId) {
            data.accountId = data.id || body.pageId;
        }
        return jsonResponse(data, res.status);
    }

    return jsonResponse({ error: 'المسار غير موجود (Endpoint not found)' }, 404);
}

// -----------------------------------------------------------------------------
// 2) دوال وأدوات الاتصال بـ Zernio API (إرسال الرسائل والتعليقات المباشرة)
// -----------------------------------------------------------------------------
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { 
      status, 
      headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders } 
  });
}

function textResponse(text, status = 200) {
  return new Response(text, { 
      status, 
      headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders } 
  });
}

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
    new Promise((_, reject) => setTimeout(() => reject(new Error("انتهت مهلة استدعاء Zernio")), CALL_TIMEOUT_MS))
  ]);
  
  const bodyText = await res.text();
  let data;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { data = { raw: bodyText.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
}

const DIRECT_ACTIONS = {
  // 1. إظهار مؤشر جاري الكتابة
  async sendTyping(env, conversationId, accountId) {
    if (!conversationId || !accountId) return;
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, {
      method: "POST",
      body: JSON.stringify({ accountId })
    }).catch(() => {});
  },

  // 2. إرسال رد مباشر في المحادثة الخاصة (DM)
  async sendDM(env, conversationId, accountId, messageText) {
    if (!conversationId || !accountId || !messageText) return null;
    return zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ accountId, message: messageText })
    });
  },

  // 3. الرد على تعليق منشور أو ريلز
  async replyComment(env, postId, accountId, commentId, messageText) {
    if (!postId || !accountId || !messageText) return null;
    const body = { accountId, message: messageText };
    if (commentId) body.commentId = commentId;
    return zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  },

  // 4. جلب سياق الرسائل السابقة
  async getMessagesHistory(env, conversationId, accountId) {
    if (!conversationId || !accountId) return [];
    const qs = new URLSearchParams({ accountId, limit: String(AUTO_CONTEXT_LIMIT), sortOrder: "desc" });
    const res = await zernioFetch(env, `/inbox/conversations/${encodeURIComponent(conversationId)}/messages?${qs}`, { method: "GET" });
    if (res.ok && res.data && Array.isArray(res.data.data)) {
        return res.data.data.map(m => `${m.direction === 'inbound' ? 'العميل' : 'المتجر'}: ${m.message || m.text || ''}`).reverse();
    }
    return [];
  },

  // 5. جلب سياق التعليقات السابقة
  async getCommentsHistory(env, postId, accountId) {
    if (!postId || !accountId) return [];
    const qs = new URLSearchParams({ accountId, limit: "5" });
    const res = await zernioFetch(env, `/inbox/comments/${encodeURIComponent(postId)}?${qs}`, { method: "GET" });
    if (res.ok && res.data && Array.isArray(res.data.data)) {
        return res.data.data.map(c => `تعليق (${c.from?.name || 'متابع'}): ${c.message || c.text || ''}`);
    }
    return [];
  }
};

// -----------------------------------------------------------------------------
// 3) تجميع الـ System Prompt المباشر + نصوص الـ RAG
// -----------------------------------------------------------------------------
async function getDirectSystemPrompt(env) {
  let customPrompt = await env.ZERNIO_KV.get('custom_agent_prompt');
  if (!customPrompt) {
    customPrompt = "أنت مساعد خدمة عملاء ومبيعات ذكي ومحترف لمتجرنا، ترد بلباقة وسرعة واحترافية على العملاء وتشرح المنتجات والأسعار وتساعدهم في الشراء.";
  }

  let ragContent = await env.ZERNIO_KV.get('rag_doc_content');
  let ragSection = "";
  if (ragContent && ragContent.trim()) {
    ragSection = `
=== مستندات ومعلومات الكتالوج وقاعدة المعرفة (RAG Knowledge) ===
استند بدقة إلى تفاصيل المنتجات، الأسعار، والمواصفات المذكورة هنا للإجابة على العميل:
${ragContent}
`;
  }

  return `
${customPrompt}

${ragSection}

=== إرشادات الرد الصارمة ===
1. قم بالرد فوراً بالنص العربي النهائي الموجه للعميل فقط.
2. لا تضع أي مقدمات برمجية، كود JSON، أو عبارات مثل "بالتأكيد سأرد عليه".
3. اجعل الأسلوب جذاباً، واضحاً، ومختصراً يلائم محادثات إنستغرام وفيسبوك.
`.trim();
}

// -----------------------------------------------------------------------------
// 4) محرك توليد النصوص المباشر السريع (Workers AI + Gemini Fallback)
// -----------------------------------------------------------------------------
function parseCommaList(value) { return (value || "").split(",").map((s) => s.trim()).filter(Boolean); }

async function callDirectWorkersAI(env, systemInstruction, userQuery, model) {
  const url = `${CLOUDFLARE_AI_BASE}/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`;
  const messages = [
    { role: "system", content: systemInstruction },
    { role: "user", content: userQuery }
  ];

  const res = await Promise.race([
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ messages, max_tokens: 600, temperature: 0.3 })
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout Workers AI")), AI_CALL_TIMEOUT_MS))
  ]);

  if (!res.ok) throw new Error(`Workers AI Status ${res.status}`);
  const data = await res.json();
  const inner = data && data.result ? data.result : data;
  if (typeof inner === "string") return inner;
  if (inner && inner.response) return inner.response;
  if (inner && Array.isArray(inner.choices) && inner.choices[0]?.message) return inner.choices[0].message.content;
  return String(inner || '');
}

async function callDirectGemini(env, systemInstruction, userQuery, model, apiKey) {
  const res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: userQuery }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
    })
  });

  if (!res.ok) throw new Error(`Gemini API Error ${res.status}`);
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

async function generateDirectText(env, promptText) {
  const systemInstruction = await getDirectSystemPrompt(env);

  // 1. تجربة نماذج Cloudflare Workers AI أولاً
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    for (const model of WORKERS_AI_MODELS) {
      try {
        const text = await callDirectWorkersAI(env, systemInstruction, promptText, model);
        if (text && text.trim()) return text.trim();
      } catch (err) {
        console.warn(`Workers AI (${model}) failed:`, err.message);
      }
    }
  }

  // 2. تجربة Google Gemini كـ Fallback فوري
  const geminiKeys = parseCommaList(env.GEMINI_API_KEY);
  const geminiModels = parseCommaList(env.GEMINI_MODELS).length ? parseCommaList(env.GEMINI_MODELS) : DEFAULT_GEMINI_MODELS;

  for (const model of geminiModels) {
    for (const key of geminiKeys) {
      try {
        const text = await callDirectGemini(env, systemInstruction, promptText, model, key);
        if (text && text.trim()) return text.trim();
      } catch (err) {
        console.warn(`Gemini (${model}) failed:`, err.message);
      }
    }
  }

  return "أهلاً بك! نسعد بخدمتك، وسنقوم بالرد على استفسارك ومساعدتك في أقرب وقت.";
}

// -----------------------------------------------------------------------------
// 5) تحديث ومزامنة الإحصائيات الحقيقية المباشرة (Live Real Stats)
// -----------------------------------------------------------------------------
async function recordStatsEvent(env, platform, eventType) {
  try {
    const statsRaw = await env.ZERNIO_KV.get('stats_summary');
    const stats = statsRaw ? JSON.parse(statsRaw) : {
      ig_dms: 0,
      ig_comments: 0,
      ig_last_active: 'جاهز للرد',
      fb_dms: 0,
      fb_comments: 0,
      fb_last_active: 'جاهز للرد'
    };

    const timeString = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    if (platform === 'instagram') {
      if (eventType === 'dm') stats.ig_dms = (stats.ig_dms || 0) + 1;
      if (eventType === 'comment') stats.ig_comments = (stats.ig_comments || 0) + 1;
      stats.ig_last_active = `اليوم ${timeString}`;
    } else {
      if (eventType === 'dm') stats.fb_dms = (stats.fb_dms || 0) + 1;
      if (eventType === 'comment') stats.fb_comments = (stats.fb_comments || 0) + 1;
      stats.fb_last_active = `اليوم ${timeString}`;
    }

    await env.ZERNIO_KV.put('stats_summary', JSON.stringify(stats));
  } catch (err) {
    console.error("Stats update error:", err);
  }
}

// -----------------------------------------------------------------------------
// 6) المعالجات المباشرة السريعة (Direct Responders)
// -----------------------------------------------------------------------------
function extractAccountId(payload) { 
  return (payload.account && (payload.account.id || payload.account.accountId)) || null; 
}

function detectPlatform(payload) {
  const provider = (payload.account?.provider || payload.platform || '').toLowerCase();
  if (provider.includes('instagram')) return 'instagram';
  return 'facebook';
}

// أ. دالة الرد المباشر على رسائل الـ DMs
async function handleDirectMessage(env, payload) {
  const conversationId = payload.message?.conversationId;
  const accountId = extractAccountId(payload);
  const incomingMsg = payload.message?.text || payload.message?.message || '';
  const platform = detectPlatform(payload);

  if (!conversationId || !accountId || !incomingMsg) return;

  // 1. إرسال إشارة جاري الكتابة فوراً
  DIRECT_ACTIONS.sendTyping(env, conversationId, accountId);

  // 2. جلب سياق المحادثة السابقة
  const history = await DIRECT_ACTIONS.getMessagesHistory(env, conversationId, accountId);

  // 3. بناء نص الطلب للذكاء الاصطناعي
  const promptQuery = `
سياق المحادثة السابقة:
${history.join("\n")}

رسالة العميل الجديدة الآن:
"${incomingMsg}"

قم بصياغة الرد المناسب والمباشر للعميل:
`.trim();

  // 4. توليد نص الرد
  const replyText = await generateDirectText(env, promptQuery);

  // 5. إرسال الرد للعميل عبر Zernio
  const result = await DIRECT_ACTIONS.sendDM(env, conversationId, accountId, replyText);

  // 6. تسجيل الإحصائيات الحقيقية
  if (result && result.ok) {
    await recordStatsEvent(env, platform, 'dm');
  }
}

// ب. دالة الرد المباشر على تعليقات المنشورات والريلز
async function handleDirectComment(env, payload) {
  const postId = payload.comment?.platformPostId || payload.post?.platformPostId;
  const commentId = payload.comment?.id || payload.comment?.commentId;
  const accountId = extractAccountId(payload);
  const commentText = payload.comment?.text || payload.comment?.message || '';
  const platform = detectPlatform(payload);

  if (!postId || !accountId || !commentText) return;

  // 1. جلب سياق التعليقات السابقة
  const history = await DIRECT_ACTIONS.getCommentsHistory(env, postId, accountId);

  // 2. بناء نص الطلب للذكاء الاصطناعي
  const promptQuery = `
سياق تعليقات البوست السابقة:
${history.join("\n")}

تعليق العميل الجديد:
"${commentText}"

قم بصياغة رد مباشر، جذاب، ومناسب للتعليق:
`.trim();

  // 3. توليد نص الرد
  const replyText = await generateDirectText(env, promptQuery);

  // 4. إرسال الرد على التعليق
  const result = await DIRECT_ACTIONS.replyComment(env, postId, accountId, commentId, replyText);

  // 5. تسجيل الإحصائيات الحقيقية
  if (result && result.ok) {
    await recordStatsEvent(env, platform, 'comment');
  }
}

// -----------------------------------------------------------------------------
// 7) نقطة الدخول (Fetch Event) واستقبال الـ Webhook
// -----------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // الرد على طلبات الـ CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // مسارات واجهة التطبيق (API Endpoints)
    if (url.pathname.startsWith('/api/')) {
      return await handleApiRequests(request, env, url);
    }

    // مسار استقبال أحداث الـ Webhook من Zernio
    if (request.method === "POST" && url.pathname === "/webhook/zernio") {
      const rawBody = await request.text();
      let payload;
      try { 
        payload = JSON.parse(rawBody); 
      } catch (_) { 
        return textResponse("Invalid JSON", 400); 
      }

      const eventType = payload.event;
      const eventId = payload.id;

      // منع تكرار معالجة نفس الحدث (Deduplication عبر الـ KV)
      if (eventId) {
        const isProcessed = await env.ZERNIO_KV.get(`evt_${eventId}`);
        if (isProcessed) {
          return jsonResponse({ ok: true, note: "Event already processed" });
        }
        await env.ZERNIO_KV.put(`evt_${eventId}`, "1", { expirationTtl: 1800 }); // نصف ساعة
      }

      // توجيه الحدث إلى الدالة المباشرة المناسبة في الخلفية
      if (eventType === "message.received") {
        ctx.waitUntil(handleDirectMessage(env, payload));
      } else if (eventType === "comment.received") {
        ctx.waitUntil(handleDirectComment(env, payload));
      }

      // الرد الفوري على Zernio بنجاح الاستلام لتفادي الـ Timeouts
      return jsonResponse({ ok: true, received: true });
    }

    return textResponse("Bedaya Direct Responder Server is Running Smoothly.");
  }
};
