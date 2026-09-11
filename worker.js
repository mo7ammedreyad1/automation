// =============================================================================
// Bedaya Meta Agent Worker (v11.0: Bulletproof Architecture)
// النموذج الأساسي: Gemini | الاحتياطي: Cloudflare Workers AI | إعادة محاولة + إحصائيات حقيقية
// =============================================================================

// 👇 ضع مفاتيحك هنا مباشرة (أو في Environment Variables بـ Cloudflare) 👇
const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";
const WORKER_GEMINI_API_KEY = ""; // ضع مفتاح Gemini API هنا (يبدأ بـ AIzaSy...)

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const CLOUDFLARE_AI_BASE = "https://api.cloudflare.com/client/v4/accounts";

// إعدادات CORS للسماح لتطبيقك بالاتصال
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zernio-key, x-connect-token, X-Connect-Token',
};

// -----------------------------------------------------------------------------
// 1. مسارات الـ API (المصادقة، البرومبت، الـ RAG، والإحصائيات)
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
    const path = url.pathname.replace(/\/+/g, '/');
    const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
    const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

    // 1. حفظ البرومبت في KV
    if (request.method === 'POST' && path === '/api/set-prompt') {
        const body = await request.json().catch(() => ({}));
        if (!body.prompt) {
            return new Response(JSON.stringify({ error: 'حقل prompt مفقود' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        await env.ZERNIO_KV.put('custom_agent_prompt', body.prompt);
        return new Response(JSON.stringify({ ok: true, message: 'تم حفظ التعليمات في السيرفر بنجاح' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 2. رفع مستند RAG وحفظ نصوصه الصافية في KV
    if (request.method === 'POST' && path === '/api/upload-rag-doc') {
        const body = await request.json().catch(() => ({}));
        const { name, size, textContent } = body;
        if (!textContent) {
            return new Response(JSON.stringify({ error: 'محتوى النص مفقود' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        await env.ZERNIO_KV.put('rag_doc_content', textContent);
        await env.ZERNIO_KV.put('rag_doc_meta', JSON.stringify({ name, size, updatedAt: new Date().toISOString() }));
        return new Response(JSON.stringify({ ok: true, message: 'تمت فهرسة نصوص المستند بالكامل' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 3. حذف مستند RAG
    if (request.method === 'POST' && path === '/api/delete-rag-doc') {
        await env.ZERNIO_KV.delete('rag_doc_content');
        await env.ZERNIO_KV.delete('rag_doc_meta');
        return new Response(JSON.stringify({ ok: true, message: 'تم مسح المستند من السيرفر' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 4. جلب الإحصائيات الحية الفعلية للتطبيق
    if (request.method === 'GET' && path === '/api/stats') {
        const stats = await getLiveStats(env);
        return new Response(JSON.stringify(stats), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 5. مصادقة فيسبوك
    if (request.method === 'GET' && path === '/api/auth/facebook') {
        const redirectUrl = url.searchParams.get('redirect_url') || '';
        const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook?profileId=${PROFILE_ID}&headless=true&redirect_url=${encodeURIComponent(redirectUrl)}`;
        const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } });
        const data = await res.json().catch(() => ({}));
        return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 6. تأكيد صفحة فيسبوك
    if (request.method === 'POST' && path === '/api/auth/facebook/select') {
        const body = await request.json().catch(() => ({}));
        body.profileId = PROFILE_ID;
        const connectToken = body.connect_token || body.connectToken || request.headers.get('x-connect-token') || '';
        
        const zHeaders = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
        if (connectToken) zHeaders['X-Connect-Token'] = connectToken;

        if (!body.userProfile || typeof body.userProfile !== 'object') {
            body.userProfile = { id: String(body.pageId || "122132545395248368"), name: "Facebook User" };
        }

        const res = await fetch(`${ZERNIO_API_BASE}/connect/facebook/select-page`, {
            method: 'POST',
            headers: zHeaders,
            body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 7. مصادقة إنستغرام
    if (request.method === 'GET' && path === '/api/auth/instagram') {
        const redirectUrl = url.searchParams.get('redirect_url') || '';
        const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
        const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;
        const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } });
        const data = await res.json().catch(() => ({}));
        return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 8. جلب وتأكيد حساب إنستغرام
    if (request.method === 'GET' && path === '/api/auth/instagram/accounts') {
        const tempToken = url.searchParams.get('tempToken');
        const res = await fetch(`${ZERNIO_API_BASE}/connect/instagram/select-account?profileId=${PROFILE_ID}&tempToken=${tempToken}`, {
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        });
        const data = await res.json().catch(() => ({}));
        return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST' && path === '/api/auth/instagram/select') {
        const body = await request.json().catch(() => ({}));
        body.profileId = PROFILE_ID;
        const res = await fetch(`${ZERNIO_API_BASE}/connect/instagram/select-account`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'المسار غير موجود' }), { status: 404, headers: corsHeaders });
}

// -----------------------------------------------------------------------------
// 2. نظام الإحصائيات الحية
// -----------------------------------------------------------------------------
async function getLiveStats(env) {
    try {
        const raw = await env.ZERNIO_KV.get('agent_live_stats');
        return raw ? JSON.parse(raw) : { dmsProcessed: 0, commentReplies: 0, avgResponseTime: 1.5, lastActive: "الآن" };
    } catch (_) {
        return { dmsProcessed: 0, commentReplies: 0, avgResponseTime: 1.5, lastActive: "الآن" };
    }
}

async function incrementStat(env, type, durationSec) {
    try {
        const stats = await getLiveStats(env);
        if (type === 'dm') stats.dmsProcessed = (stats.dmsProcessed || 0) + 1;
        if (type === 'comment') stats.commentReplies = (stats.commentReplies || 0) + 1;
        
        if (durationSec) {
            stats.avgResponseTime = Number(((stats.avgResponseTime * 0.7) + (durationSec * 0.3)).toFixed(1));
        }
        stats.lastActive = "منذ لحظات";
        await env.ZERNIO_KV.put('agent_live_stats', JSON.stringify(stats));
    } catch (_) {}
}

// -----------------------------------------------------------------------------
// 3. محرك استدعاء الذكاء الاصطناعي مع الـ Auto-Retry
// -----------------------------------------------------------------------------
async function getSystemInstruction(env) {
    const prompt = (await env.ZERNIO_KV.get('custom_agent_prompt')) || "أنت وكيل خدمة عملاء ومبيعات ذكي ومحترف، ترد بلباقة وسرعة على استفسارات العملاء.";
    const rag = (await env.ZERNIO_KV.get('rag_doc_content')) || "";

    let instruction = `=== تعليمات شخصية وسيناريو الوكيل ===\n${prompt}\n\n`;
    if (rag && rag.trim()) {
        instruction += `=== كتالوج وقاعدة معرفة النشاط التجاري (استند للمعلومات والأسعار التالية حصراً للإجابة بدقة) ===\n${rag}\n\n`;
    }
    instruction += `=== قواعد الرد الإلزامية ===\n1. تحدث باللغة العربية بأسلوب ودود وواضح ومحترف.\n2. أجب مباشرة على سؤال العميل دون مقدمات مصطنعة أو حشو.\n3. قدم نص الرد فقط دون أي نصوص برمجية أو علامات JSON.`;
    return instruction;
}

// استدعاء Google Gemini مع محاولة 3 مرات
async function callGeminiDirect(geminiKey, promptText, systemInstruction) {
    const models = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"];
    
    for (const model of models) {
        try {
            const res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent?key=${geminiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: promptText }] }],
                    systemInstruction: { parts: [{ text: systemInstruction }] },
                    generationConfig: { temperature: 0.4, maxOutputTokens: 800 }
                })
            });

            if (res.ok) {
                const data = await res.json();
                const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (reply && reply.trim()) return reply.trim();
            }
        } catch (err) {
            console.error(`Gemini (${model}) attempt failed:`, err);
        }
    }
    throw new Error("All Gemini attempts failed");
}

// النموذج الاحتياطي: Cloudflare Workers AI
async function callCloudflareAiFallback(env, promptText, systemInstruction) {
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
        throw new Error("No Cloudflare AI credentials");
    }
    const model = "@cf/meta/llama-3.2-3b-instruct";
    const url = `${CLOUDFLARE_AI_BASE}/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`;
    
    const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: promptText }
            ],
            max_tokens: 600
        })
    });

    if (res.ok) {
        const data = await res.json();
        const reply = data.result?.response || data.result?.choices?.[0]?.message?.content;
        if (reply && reply.trim()) return reply.trim();
    }
    throw new Error("Workers AI Fallback failed");
}

// المولد الشامل مع إعادة المحاولة
async function generateSmartReply(env, promptText) {
    const systemInstruction = await getSystemInstruction(env);
    const geminiKey = (WORKER_GEMINI_API_KEY || env.GEMINI_API_KEY || "").trim();

    // 1. تجربة Gemini الأساسي (حتى 3 محاولات)
    if (geminiKey) {
        try {
            return await callGeminiDirect(geminiKey, promptText, systemInstruction);
        } catch (e) {
            console.error("Primary Gemini failed, switching to fallback...");
        }
    }

    // 2. التحويل التلقائي للنموذج الاحتياطي (Cloudflare AI)
    try {
        return await callCloudflareAiFallback(env, promptText, systemInstruction);
    } catch (e) {
        console.error("Secondary AI failed.");
    }

    // 3. رد طوارئ ذكي في حال انقطاع كل الخوادم الدولية
    return "أهلاً بك! تم استلام رسالتك بنجاح، وسيقوم فريق العمل بالتواصل معك والرد على استفسارك في أقرب وقت.";
}

// -----------------------------------------------------------------------------
// 4. إرسال الرسائل لـ Zernio مع إعادة المحاولة (Auto-Retry)
// -----------------------------------------------------------------------------
async function sendZernioMessageWithRetry(env, conversationId, accountId, messageText) {
    const apiKey = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
    const url = `${ZERNIO_API_BASE}/inbox/conversations/${encodeURIComponent(conversationId)}/messages`;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ accountId, message: messageText })
            });
            if (res.ok) return true;
        } catch (e) {
            console.error(`Zernio send attempt ${attempt} error:`, e);
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    return false;
}

async function sendZernioCommentReplyWithRetry(env, postId, commentId, accountId, messageText) {
    const apiKey = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
    const url = `${ZERNIO_API_BASE}/inbox/comments/${encodeURIComponent(postId)}`;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ accountId, commentId, message: messageText })
            });
            if (res.ok) return true;
        } catch (e) {
            console.error(`Zernio comment reply attempt ${attempt} error:`, e);
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    return false;
}

// -----------------------------------------------------------------------------
// 5. معالجة أحداث الـ Webhook الصادرة من إنستغرام وفيسبوك
// -----------------------------------------------------------------------------
async function handleZernioWebhookEvent(env, payload) {
    const startTime = Date.now();
    const eventType = payload.event;
    const accountId = payload.account?.id || payload.account?.accountId;

    if (!accountId) return;

    // أ) معالجة الرسائل المباشرة (Direct Messages على إنستغرام أو ماسنجر)
    if (eventType === "message.received" && payload.message) {
        const conversationId = payload.message.conversationId;
        const userText = payload.message.text || payload.message.message || payload.message.content || "";

        if (!conversationId || !userText.trim()) return;

        // 1. إظهار إشارة الكتابة فوراً
        const apiKey = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
        fetch(`${ZERNIO_API_BASE}/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ accountId })
        }).catch(() => {});

        // 2. توليد الرد الذكي المباشر من Gemini
        const aiReply = await generateSmartReply(env, userText);

        // 3. إرسال الرسالة للعميل فوراً مع إعادة المحاولة إن تعثرت
        const sent = await sendZernioMessageWithRetry(env, conversationId, accountId, aiReply);

        // 4. تسجيل الإحصائيات الحية
        if (sent) {
            const durationSec = (Date.now() - startTime) / 1000;
            await incrementStat(env, 'dm', durationSec);
        }
    }

    // ب) معالجة التعليقات على المنشورات والريلز
    if (eventType === "comment.received" && payload.comment) {
        const postId = payload.comment.platformPostId || payload.post?.platformPostId || payload.comment.postId;
        const commentId = payload.comment.platformCommentId || payload.comment.id;
        const commentText = payload.comment.text || payload.comment.message || payload.comment.content || "";

        if (!postId || !commentId || !commentText.trim()) return;

        const aiReply = await generateSmartReply(env, `تعليق من عميل على المنشور: "${commentText}". اكتب رداً مختصراً ولطيفاً.`);
        const sent = await sendZernioCommentReplyWithRetry(env, postId, commentId, accountId, aiReply);

        if (sent) {
            const durationSec = (Date.now() - startTime) / 1000;
            await incrementStat(env, 'comment', durationSec);
        }
    }
}

// -----------------------------------------------------------------------------
// 6. نقطة الدخول الأساسية (Fetch)
// -----------------------------------------------------------------------------
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // مسارات الـ API (المصادقة، البرومبت، RAG، والإحصائيات)
        if (url.pathname.startsWith('/api/')) {
            return await handleApiRequests(request, env, url);
        }

        // استقبال Webhook من Zernio
        if (request.method === "POST" && (url.pathname === "/webhook/zernio" || url.pathname.endsWith("/webhook/zernio"))) {
            const rawBody = await request.text();
            let payload;
            try { payload = JSON.parse(rawBody); } catch (_) { return new Response("Invalid JSON", { status: 400 }); }

            // تنفيذ معالجة الرد وإرساله في الخلفية لضمان سرعة رد الـ Webhook لفيسبوك
            ctx.waitUntil(handleZernioWebhookEvent(env, payload));
            
            return new Response(JSON.stringify({ ok: true, status: "processing" }), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            });
        }

        return new Response("Bedaya Meta Agent Worker Running with Gemini Engine & Live Stats.", { headers: corsHeaders });
    }
};
