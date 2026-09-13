// =============================================================================
// Bedaya Gateway, Auth & Billing Controller (v2.0 - Pure Gateway)
// المسؤول فقط عن: المصادقة، إدارة الحسابات، الفوترة والحصص، الـ RAG والبرومبت
// =============================================================================

const WORKER_ZERNIO_API_KEY = "sk_df7ff944e449abea14a5ea0999ea0e13afe58b5eb8e10242a3a16fbc6b37debd";
const WORKER_ZERNIO_PROFILE_ID = "6a8caec32b562566622cf28d";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const CALL_TIMEOUT_MS = 15000;

// حدود الباقات الستة الرسمية (عدد المحادثات/الرسائل شهرياً)
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
// محرك الفوترة ومراقبة الحصص (Billing & Quota Engine)
// -----------------------------------------------------------------------------
async function getBillingUsageAndStatus(env) {
  const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();
  
  // 1. قراءة الباقة الحالية للمستخدم من الـ KV
  const userPlan = env.ZERNIO_KV ? (await env.ZERNIO_KV.get('user_active_plan') || 'free').toLowerCase() : 'free';
  const planLimit = PLAN_LIMITS[userPlan] !== undefined ? PLAN_LIMITS[userPlan] : 100;

  // 2. جلب حجم الاستهلاك الفعلي للشهر الحالي من Zernio API
  const now = new Date();
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];

  const qs = new URLSearchParams({ fromDate: firstDayOfMonth, toDate: today, profileId: PROFILE_ID });
  const zernioRes = await zernioFetch(env, `/analytics/inbox/volume?${qs}`);

  let consumedMessages = 0;
  if (zernioRes.ok && zernioRes.data?.summary) {
    consumedMessages = (zernioRes.data.summary.sent || 0) + (zernioRes.data.summary.received || 0);
  }

  const isUnlimited = planLimit === Infinity;
  const isExceeded = !isUnlimited && consumedMessages >= planLimit;
  const remaining = isUnlimited ? 'غير محدود' : Math.max(0, planLimit - consumedMessages);
  const usagePercentage = isUnlimited ? 0 : Math.min(100, Math.round((consumedMessages / planLimit) * 100));

  return {
    userPlan,
    planLimit: isUnlimited ? 'غير محدود' : planLimit,
    consumedMessages,
    remaining,
    usagePercentage,
    isExceeded,
    billingPeriod: { from: firstDayOfMonth, to: today }
  };
}

// -----------------------------------------------------------------------------
// توجيه ومعالجة مسارات الـ API (المصادقة، الفوترة، الحسابات، والـ RAG)
// -----------------------------------------------------------------------------
async function handleApiRequests(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const API_KEY = (WORKER_ZERNIO_API_KEY || env.ZERNIO_API_KEY || '').trim();
  const PROFILE_ID = (WORKER_ZERNIO_PROFILE_ID || env.ZERNIO_PROFILE_ID || '').trim();

  // ---------------------------------------------------------------------------
  // 1. مسارات الفوترة والحصص (Billing & Quota Management)
  // ---------------------------------------------------------------------------
  
  // فحص حالة الباقة والاستهلاك
  if (method === 'GET' && path === '/api/billing/status') {
    const billingInfo = await getBillingUsageAndStatus(env);
    return jsonResponse({ ok: true, billing: billingInfo });
  }

  // تحديث باقة المستخدم (من قِبل الأدمن أو عند الدفع)
  if (method === 'POST' && path === '/api/billing/set-plan') {
    const body = await request.json().catch(() => ({}));
    const newPlan = (body.plan || 'free').toLowerCase();
    if (!PLAN_LIMITS[newPlan] && PLAN_LIMITS[newPlan] !== 0) {
      return jsonResponse({ error: 'اسم الباقة غير صالح (متاح: free, basic, advance, pro, biz, enterprise)' }, 400);
    }

    if (env.ZERNIO_KV) {
      await env.ZERNIO_KV.put('user_active_plan', newPlan);
      await env.ZERNIO_KV.put('plan_updated_at', isoNow());
    }
    return jsonResponse({ ok: true, message: `تم تحديث باقة الحساب إلى (${newPlan}) بنجاح` });
  }

  // تطبيق فحص الحصة وفصل الحسابات تلقائياً إذا انتهت الباقة (Enforce Limits)
  if (method === 'POST' && path === '/api/billing/enforce') {
    const billingInfo = await getBillingUsageAndStatus(env);

    if (billingInfo.isExceeded) {
      // جلب الحسابات المتصلة وفصلها من Zernio
      const accsRes = await zernioFetch(env, `/accounts?profileId=${PROFILE_ID}`);
      const accounts = Array.isArray(accsRes.data) ? accsRes.data : (accsRes.data?.accounts || []);

      const disconnected = [];
      for (const acc of accounts) {
        const id = acc.id || acc._id;
        if (id) {
          await zernioFetch(env, `/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
          disconnected.push({ id, name: acc.name || acc.username });
        }
      }

      if (env.ZERNIO_KV) await env.ZERNIO_KV.put('account_lock_status', 'locked_quota_exceeded');

      return jsonResponse({
        ok: true,
        action: 'accounts_disconnected',
        reason: 'انتهت حصة الباقة المخصصة',
        disconnectedAccounts: disconnected,
        billing: billingInfo
      });
    }

    return jsonResponse({ ok: true, action: 'none', message: 'الاستهلاك ضمن حدود الباقة', billing: billingInfo });
  }

  // ---------------------------------------------------------------------------
  // 2. إحصائيات Zernio الرسمية (Volume Analytics)
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 3. الحسابات المتصلة وفصل الحسابات يدوياً
  // ---------------------------------------------------------------------------
  if (method === 'GET' && path === '/api/accounts') {
    const zernioRes = await zernioFetch(env, `/accounts?profileId=${PROFILE_ID}`);
    return jsonResponse(zernioRes.data, zernioRes.status);
  }

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

  // ---------------------------------------------------------------------------
  // 4. مسارات OAuth فيسبوك (Facebook Official Connect)
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 5. مسارات OAuth إنستغرام (Instagram Official Connect)
  // ---------------------------------------------------------------------------
  if (method === 'GET' && path === '/api/auth/instagram') {
    const redirectUrl = url.searchParams.get('redirect_url') || '';
    const loginMethod = url.searchParams.get('loginMethod') || 'facebook_login';
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram?profileId=${PROFILE_ID}&headless=true&loginMethod=${loginMethod}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(zernioUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
    return jsonResponse(await res.json().catch(() => ({})), res.status);
  }

  if (method === 'GET' && path === '/api/auth/instagram/accounts') {
    const tempToken = url.searchParams.get('tempToken');
    const zernioUrl = `${ZERNIO_API_BASE}/connect/instagram/select-account?profileId=${PROFILE_ID}&tempToken=${encodeURIComponent(tempToken)}`;
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

  // ---------------------------------------------------------------------------
  // 6. إدارة الـ System Prompt ومستندات الـ RAG في الـ KV
  // ---------------------------------------------------------------------------
  if (method === 'POST' && path === '/api/set-prompt') {
    const body = await request.json().catch(() => ({}));
    if (!body.prompt) return jsonResponse({ error: 'حقل prompt مفقود' }, 400);
    if (env.ZERNIO_KV) await env.ZERNIO_KV.put('custom_agent_prompt', body.prompt);
    return jsonResponse({ ok: true, message: 'تم حفظ البرومبت بنجاح' });
  }

  if (method === 'GET' && path === '/api/get-prompt') {
    const prompt = env.ZERNIO_KV ? await env.ZERNIO_KV.get('custom_agent_prompt') : null;
    return jsonResponse({ ok: true, prompt: prompt || 'البرومبت الافتراضي نشط' });
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

  // ---------------------------------------------------------------------------
  // 7. نظرة عامة للأدمن (Admin Overview)
  // ---------------------------------------------------------------------------
  if (method === 'GET' && path === '/api/admin/overview') {
    const prompt = env.ZERNIO_KV ? await env.ZERNIO_KV.get('custom_agent_prompt') : null;
    const ragMeta = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_meta') : null;
    const ragContent = env.ZERNIO_KV ? await env.ZERNIO_KV.get('rag_doc_content') : null;
    const billing = await getBillingUsageAndStatus(env);

    return jsonResponse({
      ok: true,
      service: "Bedaya Pure Gateway & Billing Controller",
      billing,
      prompt: prompt || 'البرومبت الافتراضي نشط',
      rag: {
        active: !!ragContent,
        meta: ragMeta ? JSON.parse(ragMeta) : null,
        preview: ragContent ? ragContent.slice(0, 400) : null
      }
    });
  }

  return jsonResponse({ error: 'المسار غير موجود في Gateway Worker' }, 404);
}

// -----------------------------------------------------------------------------
// نقطة الدخول (Fetch Event Handler)
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

    return textResponse("Bedaya Gateway, Auth & Billing Controller Running (v2.0)");
  }
};
