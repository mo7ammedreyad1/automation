// =============================================================================
// Bedaya Gateway & Auth Worker (v1.0 - Decoupled Microservice)
// خادم البوابة، المصادقة الرسمية، الإحصائيات، وإدارة الحسابات والـ RAG
// =============================================================================

const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const CALL_TIMEOUT_MS = 15000;
const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 أيام

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

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
  });
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

// -----------------------------------------------------------------------------
// الاتصال بمنصة Zernio API
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
    new Promise((_, reject) => setTimeout(() => reject(new Error('انتهت مهلة اتصال Zernio API')), CALL_TIMEOUT_MS))
  ]);

  const bodyText = await res.text();
  let data;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { data = { raw: bodyText }; }
  return { ok: res.ok, status: res.status, data };
}

// -----------------------------------------------------------------------------
// مسارات واجهة الـ API (المصادقة، الحسابات، الإحصائيات، البرومبت، والـ RAG)
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

  // 1. إحصائيات الرسائل الرسمية من Zernio (Inbox Volume Analytics)
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

  // 2. جلب الحسابات المتصلة حالياً في Zernio
  if (method === 'GET' && path === '/api/accounts') {
    const zernioRes = await zernioFetch(env, `/accounts?profileId=${PROFILE_ID}`);
    return jsonResponse(zernioRes.data, zernioRes.status);
  }

  // 3. فصل الحساب من Zernio بالـ ID
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

  // 4. مسار تفويض فيسبوك (Get Auth URL)
  if (method === 'GET' && path === '/api/auth/facebook') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/facebook?profileId=${PROFILE_ID}&headless=true&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 5. مسار جلب صفحات فيسبوك المتاحة بعد الـ OAuth
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

  // 6. مسار تأكيد اختيار وربط صفحة فيسبوك
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

  // 7. مسار تفويض إنستغرام (Get Auth URL)
  if (method === 'GET' && path === '/api/auth/instagram') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 8. مسار جلب حسابات إنستغرام المرتبطة بصفحات فيسبوك
  if (method === 'GET' && path === '/api/auth/instagram/accounts') {
    const tempToken = url.searchParams.get('tempToken');
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram/select-account?profileId=${PROFILE_ID}&tempToken=${encodeURIComponent(tempToken)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  // 9. مسار تأكيد اختيار وربط حساب إنستغرام
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

  // 10. إدارة الـ System Prompt في الـ KV المشترك
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

  // 11. إدارة نصوص مستندات الـ RAG في الـ KV المشترك
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

  // 12. لوحة نظرة عامة للأدمن (Admin Overview)
  if (method === 'GET' && path === '/api/admin/overview') {
    const prompt = env.ZERNIO_KV ? await env.ZERNIO_KV.get('custom_agent_prompt') : null;
    const ragMeta = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_meta') : null;
    const ragContent = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_content') : null;

    return jsonResponse({
      ok: true,
      service: "Bedaya Gateway Worker",
      prompt: prompt || 'البرومبت الافتراضي نشط',
      rag: {
        active: !!ragContent,
        meta: ragMeta ? JSON.parse(ragMeta) : null,
        preview: ragContent ? ragContent.slice(0, 400) : null
      }
    });
  }

  // 13. قراءة سجل الـ 3 أيام للوحة التحكم (Audit Logs)
  if (method === 'GET' && path === '/api/audit-logs') {
    if (!env.ZERNIO_KV) return jsonResponse({ ok: true, logs: [] });
    try {
      const rawIndex = await env.ZERNIO_KV.get('audit_logs_index');
      if (!rawIndex) return jsonResponse({ ok: true, logs: [] });
      const index = JSON.parse(rawIndex);
      const logs = await Promise.all(
        index.slice(0, 50).map(async item => {
          const raw = await env.ZERNIO_KV.get(`audit_log_${item.id}`);
          return raw ? JSON.parse(raw) : null;
        })
      );
      return jsonResponse({ ok: true, count: logs.filter(Boolean).length, logs: logs.filter(Boolean) });
    } catch (_) {
      return jsonResponse({ ok: true, logs: [] });
    }
  }

  return jsonResponse({ error: 'Endpoint not found on Gateway Worker' }, 404);
}

// -----------------------------------------------------------------------------
// نقطة الدخول (Fetch Event) واستقبال الـ Webhook
// -----------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname.startsWith('/api/')) {
      return await handleApiRequests(request, env, url);
    }

    // استقبال رسائل الويب هوك من Zernio ووضعها فوراً في الطابور
    if (request.method === 'POST' && url.pathname === '/webhook/zernio') {
      const receivedAt = isoNow();
      const rawBody = await request.text();

      // 1. التحقق من توقيع HMAC إن وجد
      const signature = request.headers.get("X-Zernio-Signature");
      if (signature && env.ZERNIO_WEBHOOK_SECRET) {
        const computed = await hmacSha256Hex(env.ZERNIO_WEBHOOK_SECRET, rawBody);
        if (!safeEqualHex(computed, signature)) {
          return textResponse("Invalid HMAC signature", 400);
        }
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (_) {
        return textResponse("Invalid JSON payload", 400);
      }

      // 2. منع التكرار الفوري عبر الـ KV
      const eventId = request.headers.get("X-Zernio-Event-Id") || payload.id;
      if (eventId && env.ZERNIO_KV) {
        const dedupKey = `dedup:${eventId}`;
        const alreadySeen = await env.ZERNIO_KV.get(dedupKey).catch(() => null);
        if (alreadySeen) {
          return jsonResponse({ ok: true, dedup: true, message: "Duplicate event dropped" });
        }
        await env.ZERNIO_KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS }).catch(() => {});
      }

      // 3. إيداع الحدث في طابور Cloudflare Queues
      if (env.EVENTS_QUEUE) {
        await env.EVENTS_QUEUE.send({ rawBody, payload, receivedAt });
      }

      // رد فوري فائق السرعة (< 20ms) لمنع timeout من Meta/Zernio
      return jsonResponse({ ok: true, queued: true, eventId });
    }

    return textResponse("Bedaya Gateway & Auth Worker Running (v1.0)");
  }
};
