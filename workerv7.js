// =============================================================================
// Zernio Social Inbox Agent — Cloudflare Worker (v4: fixed documented tools)
// =============================================================================
//
// المعمارية: أي حدث webhook من Zernio بيوصل خام (نص JSON كامل) لموديل Gemini.
// الموديل بيختار من قائمة أفعال ثابتة موثّقة (TOOLS)، كل واحد فيهم بينفّذ
// نداء REST حقيقي واحد على zernio.com/api/v1. مفيش MCP، ومفيش كود يتولّد
// ديناميكيًا (Cloudflare Workers بيمنع eval()/new Function() في الإنتاج على
// الخطة المجانية — جرّبنا ده فعليًا واتأكدنا إنه مرفوض). كل التنفيذ الفعلي
// كوده إحنا كاتبينه إحنا، ثابت، والموديل بيحدد بس اسم الأداة والـ arguments.
//
// الحلقة (Plan → Act → Reflect) بتتكرر لحد ما الموديل يرجع action: "final".
//
// الاستثناء الأمني الوحيد المكتوب في الكود (مش قرار للموديل): تجاهل أي حدث
// صادر من الحساب نفسه (تعليق فيه isOwnAccount، أو رسالة direction != incoming)
// — منعًا لحلقة رد-على-النفس اللانهائية.
//
// الأسرار المطلوبة:
//   ZERNIO_API_KEY         — Bearer token لـ Zernio REST API
//   ZERNIO_WEBHOOK_SECRET   — نفس السر المسجّل عند إنشاء الـ webhook في Zernio
//   GEMINI_API_KEY          — مفتاح واحد أو أكتر مفصولين بفاصلة
//   GEMINI_MODELS            — اختياري، قائمة موديلات مفصولة بفاصلة (fallback)
//   STATUS_KEY                — اختياري، لحماية /health بمفتاح في الرابط
//
// KV binding المطلوب في wrangler.jsonc: باسم ZERNIO_KV
// =============================================================================

// -----------------------------------------------------------------------------
// 1) ثوابت عامة
// -----------------------------------------------------------------------------

const ZERNIO_REST_BASE = "https://zernio.com/api/v1";

const DEFAULT_GEMINI_MODELS = ["gemini-3.1-flash-lite"];
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 أيام (أكبر من أطول إعادة إرسال موثقة عند Zernio ~51 ساعة)
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 أيام
const LOG_LIST_LIMIT = 30;

// حد أقصى لعدد دورات Plan→Act→Reflect لكل حدث. الأفعال الثابتة قليلة
// ومباشرة، فسيناريو نموذجي (جلب تاريخ + رد) بياخد 3-4 خطوات بس.
const MAX_AGENT_STEPS = 8;

// -----------------------------------------------------------------------------
// 2) أدوات مساعدة عامة (JSON responses, hex, HMAC, KV wrappers)
// -----------------------------------------------------------------------------

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
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

async function kvGetJSON(env, key) {
  try {
    const raw = await env.ZERNIO_KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("kvGetJSON failed", key, err);
    return null;
  }
}

async function kvSetJSON(env, key, value, ttlSeconds) {
  try {
    await env.ZERNIO_KV.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  } catch (err) {
    console.error("kvSetJSON failed", key, err);
  }
}

function isoNow() {
  return new Date().toISOString();
}

function shortId() {
  return crypto.randomUUID().slice(0, 8);
}

async function logActivity(env, entry) {
  await kvSetJSON(env, `log:${isoNow()}:${shortId()}`, entry, LOG_TTL_SECONDS);
}

function computeSinceDate(url) {
  const since = url.searchParams.get("since");
  if (since) {
    const d = new Date(since);
    if (!isNaN(d)) return d;
  }
  const range = url.searchParams.get("range");
  if (range === "1h") return new Date(Date.now() - 60 * 60 * 1000);
  if (range === "today") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  return null;
}

async function listRecentLogs(env, { limit = LOG_LIST_LIMIT, eventId = null, since = null } = {}) {
  try {
    const needsWideScan = Boolean(eventId || since);
    const listRes = await env.ZERNIO_KV.list({ prefix: "log:", limit: 1000 });
    let keys = listRes.keys.map((k) => k.name).sort().reverse();
    keys = keys.slice(0, needsWideScan ? 1000 : limit);

    let entries = (await Promise.all(keys.map((k) => kvGetJSON(env, k)))).filter(Boolean);
    if (eventId) entries = entries.filter((e) => e.eventId === eventId);
    if (since) {
      entries = entries.filter((e) => {
        const t = new Date((e.timing && e.timing.receivedAt) || e.ts || 0);
        return t >= since;
      });
    }
    return needsWideScan ? entries : entries.slice(0, limit);
  } catch (err) {
    console.error("listRecentLogs failed", err);
    return [];
  }
}

// -----------------------------------------------------------------------------
// 3) zernioApi — عميل REST بسيط (fetch عادي، بدون أي كود ديناميكي)
// -----------------------------------------------------------------------------

function buildZernioApiClient(env) {
  async function request(method, path, bodyOrQuery) {
    let url = ZERNIO_REST_BASE + path;
    const headers = {
      Authorization: "Bearer " + env.ZERNIO_API_KEY,
      "Content-Type": "application/json",
    };
    const init = { method, headers };

    if (method === "GET" || method === "DELETE") {
      if (bodyOrQuery && typeof bodyOrQuery === "object") {
        const qs = new URLSearchParams(
          Object.entries(bodyOrQuery)
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => [k, String(v)])
        ).toString();
        if (qs) url += (url.includes("?") ? "&" : "?") + qs;
      }
    } else if (bodyOrQuery !== undefined) {
      // نشيل أي حقل undefined عشان الـ body يبقى نضيف
      const cleanBody = Object.fromEntries(Object.entries(bodyOrQuery).filter(([, v]) => v !== undefined));
      init.body = JSON.stringify(cleanBody);
    }

    const res = await fetch(url, init);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  }

  return {
    get: (path, query) => request("GET", path, query),
    post: (path, body) => request("POST", path, body),
    delete: (path, query) => request("DELETE", path, query),
  };
}

// -----------------------------------------------------------------------------
// 4) الأفعال الثابتة (TOOLS) — كل واحد بيمثّل نداء REST حقيقي واحد، موثّق من
//    توثيق Zernio الرسمي. الموديل بيختار اسم الأداة والـ arguments بس؛
//    التنفيذ الفعلي (المسار، الطريقة، بناء الـ body) كوده ثابت إحنا كاتبينه.
// -----------------------------------------------------------------------------

const TOOLS = {
  get_post_comments: {
    description:
      "قراءة تعليقات منشور. args: {postId (لازم), accountId (لازم), limit?, cursor?}. postId ممكن يكون كمان commentId فترجع ردوده بدل تعليقات المنشور.",
    execute: (api, a) => api.get(`/inbox/comments/${encodeURIComponent(a.postId)}`, { accountId: a.accountId, limit: a.limit, cursor: a.cursor }),
  },
  reply_to_comment: {
    description:
      "الرد على تعليق (عام، يظهر تحته). args: {postId (لازم), accountId (لازم), message (لازم), commentId?, attachmentUrl?}. attachmentUrl (صورة): فيسبوك بس — ممنوع خالص لو platform === instagram.",
    execute: (api, a) =>
      api.post(`/inbox/comments/${encodeURIComponent(a.postId)}`, {
        accountId: a.accountId,
        message: a.message,
        commentId: a.commentId,
        attachmentUrl: a.attachmentUrl,
      }),
  },
  send_private_reply: {
    description:
      "رد خاص (DM) لصاحب تعليق. args: {postId (لازم), commentId (لازم), accountId (لازم), message (لازم)}. نص بس، مفيش صور. رد واحد بس لكل تعليق طول الوقت، ولازم يتبعت خلال 7 أيام من وقت التعليق — محاولة تانية على نفس التعليق هترفض. فيسبوك وانستجرام بس.",
    execute: (api, a) =>
      api.post(`/inbox/comments/${encodeURIComponent(a.postId)}/${encodeURIComponent(a.commentId)}/private-reply`, {
        accountId: a.accountId,
        message: a.message,
      }),
  },
  hide_comment: {
    description: "إخفاء تعليق عن العرض العام (يفضل يظهر لصاحبه ولإدارة الصفحة بس). args: {postId (لازم), commentId (لازم), accountId (لازم)}.",
    execute: (api, a) => api.post(`/inbox/comments/${encodeURIComponent(a.postId)}/${encodeURIComponent(a.commentId)}/hide`, { accountId: a.accountId }),
  },
  unhide_comment: {
    description: "إظهار تعليق كان مخفي. args: {postId (لازم), commentId (لازم), accountId (لازم)}.",
    execute: (api, a) => api.delete(`/inbox/comments/${encodeURIComponent(a.postId)}/${encodeURIComponent(a.commentId)}/hide`, { accountId: a.accountId }),
  },
  get_dm_history: {
    description:
      "جلب آخر رسائل محادثة (استخدمها دايمًا قبل أي رد على DM عشان تفهم السياق). args: {conversationId (لازم), accountId (لازم), limit? (افتراضي 20), sortOrder? ('asc' أو 'desc', افتراضي 'desc')}. ملحوظة: لفيسبوك sortOrder مش بيتحترم دايمًا، بترجع الأحدث الأول.",
    execute: (api, a) =>
      api.get(`/inbox/conversations/${encodeURIComponent(a.conversationId)}/messages`, {
        accountId: a.accountId,
        limit: a.limit || 20,
        sortOrder: a.sortOrder || "desc",
      }),
  },
  send_dm: {
    description:
      "إرسال رسالة خاصة. args: {conversationId (لازم), accountId (لازم), message (لازم), attachmentUrl?, attachmentType? ('image'|'video'|'audio'|'file')}. تحذير: voice note حقيقي (waveform) موثق لواتساب بس؛ لفيسبوك/انستجرام استخدم attachmentType:'audio' عادي لو محتاج، مش مضمون قبوله من ميتا. تحذير حاسم: لو صورة+نص مع بعض، الرد ممكن يرجع 200 حتى لو جزء فشل — راجع نتيجة الأداة بعناية.",
    execute: (api, a) =>
      api.post(`/inbox/conversations/${encodeURIComponent(a.conversationId)}/messages`, {
        accountId: a.accountId,
        message: a.message,
        attachmentUrl: a.attachmentUrl,
        attachmentType: a.attachmentType,
      }),
  },
  send_typing_indicator: {
    description: "إظهار مؤشر 'بيكتب...' فى محادثة (اختياري، best-effort). args: {conversationId (لازم), accountId (لازم)}.",
    execute: (api, a) => api.post(`/inbox/conversations/${encodeURIComponent(a.conversationId)}/typing`, { accountId: a.accountId }),
  },
};

function buildToolsReferenceText() {
  return Object.entries(TOOLS)
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join("\n");
}

async function executeAction(env, action) {
  const tool = TOOLS[action.name];
  if (!tool) {
    return `أداة غير معروفة: "${action.name}". الأدوات المتاحة: ${Object.keys(TOOLS).join(", ")}`;
  }
  const args = action.arguments && typeof action.arguments === "object" ? action.arguments : {};
  try {
    const api = buildZernioApiClient(env);
    const result = await tool.execute(api, args);
    return JSON.stringify(result);
  } catch (err) {
    return `خطأ فى التنفيذ: ${err.message}`;
  }
}

// -----------------------------------------------------------------------------
// 5) عميل Gemini (تدوير مفاتيح/موديلات)
// -----------------------------------------------------------------------------

function parseCommaList(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function buildGeminiCombos(env) {
  const keys = parseCommaList(env.GEMINI_API_KEY);
  const models = parseCommaList(env.GEMINI_MODELS);
  const finalModels = models.length ? models : DEFAULT_GEMINI_MODELS;
  const combos = [];
  for (const model of finalModels) for (const key of keys) combos.push({ key, model });
  return combos;
}

// نداء Gemini واحد بموديل/مفتاح ثابتين — بدون أي تبديل داخلي، وبدون آلية
// function calling الخاصة بأي provider. البروتوكول نص عادي + JSON نحلله
// إحنا، مستقل عن أي provider. responseMimeType تحسين موثوقية خاص بـ Gemini.
async function callGeminiTurnFixed(env, contents, systemInstruction, combo, attemptsLog) {
  const { key, model } = combo;
  const res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const msg = `Gemini HTTP ${res.status} (${model}): ${errText.slice(0, 300)}`;
    if (attemptsLog) attemptsLog.push({ model, status: res.status, ok: false, note: msg });
    throw new Error(msg);
  }

  if (attemptsLog) attemptsLog.push({ model, status: res.status, ok: true });
  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  return parts.map((p) => p.text || "").join("\n");
}

// -----------------------------------------------------------------------------
// 6) حلقة الوكيل: Plan → Act → Reflect
// -----------------------------------------------------------------------------
//
// بروتوكول فعلين بس، مستقل عن أي provider (نص عادي، role: user/model بس):
//   {"action": "call_tool", "name": "...", "arguments": {...}}
//   {"action": "final", "text": "..."}

const AGENT_SYSTEM_INSTRUCTION = [
  "أنت وكيل ذكي بيستقبل أحداث webhook خام من منصة Zernio (إدارة حسابات سوشيال ميديا: فيسبوك وانستجرام).",
  "",
  "طريقة الرد (مهم جدًا تلتزم بيها بالحرف): كل رد منك لازم يكون كائن JSON واحد بس، من غير أي نص تاني قبله أو بعده أو أي markdown، بواحد من الشكلين دول بالظبط:",
  '1) {"action": "call_tool", "name": "اسم الأداة", "arguments": {...}} — لتنفيذ فعل حقيقي.',
  '2) {"action": "final", "text": "..."} — لما تنتهي من كل الأفعال المطلوبة، أو تقرر عدم الحاجة لأي فعل من الأساس.',
  "",
  "=== الأدوات المتاحة ===",
  buildToolsReferenceText(),
  "",
  "=== قواعد عامة صارمة ===",
  "- استخدم الـ IDs الحقيقية الموجودة في نص الحدث الخام بالظبط (accountId, conversationId, commentId, postId/platformPostId) — لا تخترع أي قيمة غير موجودة في النص.",
  "- لو الحدث فيه conversationId (رسالة/DM)، لازم قبل أي رد تستخدم get_dm_history عشان تفهم السياق الكامل — حتى لو الرسالة الحالية شكلها واضحة لوحدها.",
  "- لو الحدث فيه postId/platformPostId من غير conversationId (يعني تعليق)، استخدم أدوات التعليقات مش الرسايل.",
  "",
  "طريقة عملك:",
  "1. اقرا الحدث الخام اللي وصلك بعناية وافهم نوعه (تعليق، رسالة، أو أي حدث تاني) والمطلوب فعله، لو فيه حاجة أصلاً.",
  "2. لو الحدث لا يحتاج أي فعل (إشعار نشر منشور، تفاعل بسيط، حدث غير متعلق بالتفاعل مع عميل)، ردّ بـ action: final ونص قصير يشرح السبب من غير ما تستخدم أي أداة.",
  "3. لو نداء أداة رجع خطأ، اقرا الرسالة بعناية وصحّح الـ arguments أو جرّب أداة بديلة قبل ما تستسلم.",
  "4. لو بتصيغ ردًا فعليًا لعميل، اكتبه بنفس لغته (عربي فصحى أو عامية أو إنجليزي) وخليه ودود ومختصر ومحترف.",
  "5. تحذير حاسم: صياغة نص الرد لوحدها متكفيش. لو قررت إن فيه رد لازم يوصل للعميل، لازم تكون نفّذت أداة الإرسال المناسبة فعليًا قبل ما تختم بـ action: final — رد نهائي فيه محتوى موجّه للعميل من غير تنفيذ فعلي = العميل مايستقبلش أي حاجة خالص.",
  "6. لما تنتهي فعلاً (نفذت كل الأفعال المطلوبة بنجاح، أو قررت من البداية عدم الحاجة لأي فعل)، ردّ بـ action: final — هذا هو اللي بيوقف المعالجة.",
].join("\n");

// يحاول يلاقط أول كائن JSON صالح من نص الموديل، حتى لو كان ملفوف بـ markdown
// code fence أو معاه نص زيادة قبله/بعده — دفاعي، مش معتمدين عليه كضمان
// وحيد (بنطلب أصلاً من الـ API نفسه إجبار الرد يكون JSON صالح لما ده مدعوم).
function extractJsonObject(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // نحاول نلقط أول { ... } متكامل بعدّ الأقواس
  }
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

async function runAgentLoopWithModel(env, rawEventText, combo) {
  const contents = [{ role: "user", parts: [{ text: rawEventText }] }];
  const steps = [];
  const geminiAttempts = [];

  for (let i = 0; i < MAX_AGENT_STEPS; i++) {
    let rawText;
    try {
      rawText = await callGeminiTurnFixed(env, contents, AGENT_SYSTEM_INSTRUCTION, combo, geminiAttempts);
    } catch (err) {
      return { ok: false, steps, finalText: null, stopReason: "error", error: err.message, geminiAttempts };
    }

    const action = extractJsonObject(rawText);

    if (!action || typeof action.action !== "string") {
      steps.push({ step: i + 1, ts: isoNow(), type: "invalid-json", raw: String(rawText).slice(0, 300) });
      contents.push({ role: "model", parts: [{ text: String(rawText).slice(0, 2000) }] });
      contents.push({
        role: "user",
        parts: [{ text: "ردك مش كائن JSON صالح بالشكل المطلوب. رجّع بس واحد من الشكلين المتفق عليهم." }],
      });
      continue;
    }

    if (action.action === "final") {
      const finalText = typeof action.text === "string" ? action.text : "";
      steps.push({ step: i + 1, ts: isoNow(), type: "final", text: finalText });
      return { ok: true, steps, finalText, stopReason: "final", geminiAttempts };
    }

    if (action.action === "call_tool") {
      const resultText = await executeAction(env, action);
      steps.push({
        step: i + 1,
        ts: isoNow(),
        type: "call",
        name: action.name,
        args: action.arguments,
        result: String(resultText).slice(0, 500),
      });
      contents.push({ role: "model", parts: [{ text: rawText }] });
      contents.push({ role: "user", parts: [{ text: `نتيجة التنفيذ:\n${resultText}` }] });
      continue;
    }

    steps.push({ step: i + 1, ts: isoNow(), type: "unknown-action", raw: String(action.action).slice(0, 100) });
    contents.push({ role: "model", parts: [{ text: rawText }] });
    contents.push({
      role: "user",
      parts: [{ text: `"action": "${action.action}" مش معروف. استخدم بس: call_tool أو final.` }],
    });
  }

  return { ok: true, steps, finalText: null, stopReason: "max-steps", geminiAttempts };
}

// الغلاف الخارجي: بيجرب موديل واحد ثابت للحدث كله. لو فشل *قبل أي فعل حقيقي*
// (مفيش خطوة type:"call" في الأثر لسه)، آمن نجرب موديل تاني من الصفر. لو
// فشل *بعد* ما فعل حقيقي حصل، بنوقف فورًا ونسجل بدل ما نعيد المحاولة —
// عشان منعملش فعل مكرر (زي إرسال رسالة مرتين) بموديل مختلف مش عارف إن
// الأول خلص جزء من الشغل خلاص.
async function runAgentLoop(env, rawEventText) {
  const combos = buildGeminiCombos(env);
  if (!combos.length) {
    return { steps: [], finalText: null, stopReason: "error", error: "مفيش GEMINI_API_KEY متظبط", geminiAttempts: [] };
  }

  let lastResult = null;
  for (const combo of combos) {
    const result = await runAgentLoopWithModel(env, rawEventText, combo);
    if (result.ok) return result;
    lastResult = result;
    const hadRealAction = result.steps.some((s) => s.type === "call");
    if (hadRealAction) return result; // فعل حقيقي حصل بالفعل — منكررش بموديل تاني
  }
  return lastResult || { steps: [], finalText: null, stopReason: "error", error: "كل الموديلات فشلت", geminiAttempts: [] };
}

// -----------------------------------------------------------------------------
// 7) معالجة الحدث الوارد
// -----------------------------------------------------------------------------

// الاستثناء الأمني الوحيد المكتوب في الكود: منع حلقة رد-على-النفس اللانهائية.
// كل حاجة تانية (نوع الحدث، هل يحتاج رد، بأي أداة) قرار الموديل بالكامل.
function isSelfEcho(payload) {
  const author = payload.comment && payload.comment.author;
  if (author && author.isOwnAccount) return true;
  const direction = payload.message && payload.message.direction;
  if (direction && direction !== "incoming") return true;
  return false;
}

// معاينة عامة بحتة (لغرض القراءة البشرية في اللوج فقط) — بتاخد حقول موجودة
// في كل أنواع الأحداث (account.platform) + مقتطف من النص الخام، من غير أي
// تصنيف أو استخراج حقول خاصة بنوع حدث معين (ده قرار الموديل، مش الكود).
function buildTriggerPreview(payload, rawBody) {
  return {
    platform: (payload.account && payload.account.platform) || null,
    preview: rawBody.length > 220 ? rawBody.slice(0, 220) + "…" : rawBody,
  };
}

async function handleZernioEvent(env, rawBody, payload, receivedAt) {
  const eventId = payload.id;
  const eventType = payload.event;
  const startedAt = isoNow();
  const trigger = buildTriggerPreview(payload, rawBody);

  if (isSelfEcho(payload)) {
    const finishedAt = isoNow();
    await logActivity(env, {
      eventId,
      event: eventType,
      trigger,
      timing: { receivedAt, startedAt, finishedAt, durationMs: new Date(finishedAt) - new Date(startedAt) },
      outcome: "skipped-self-echo",
    });
    return;
  }

  const trace = await runAgentLoop(env, rawBody);
  const finishedAt = isoNow();
  const entry = {
    eventId,
    event: eventType,
    trigger,
    timing: { receivedAt, startedAt, finishedAt, durationMs: new Date(finishedAt) - new Date(startedAt) },
    outcome: trace.stopReason,
    finalText: trace.finalText,
    error: trace.error,
    geminiAttempts: trace.geminiAttempts,
    steps: trace.steps,
  };

  await logActivity(env, entry);

  // أي حدث ماخلصش برد نهائي واضح (خطأ، أو وصل لحد الخطوات) بيتسجل في طابور
  // مراجعة منفصل — يظهر لوحده في /health/review لحد ما حد يراجعه ويعلّمه.
  if (entry.outcome === "error" || entry.outcome === "max-steps") {
    await kvSetJSON(
      env,
      `review:${eventId}`,
      { eventId, event: eventType, outcome: entry.outcome, error: entry.error, finalText: entry.finalText, ts: finishedAt },
      LOG_TTL_SECONDS
    );
  }
}

// -----------------------------------------------------------------------------
// 8) استقبال الـ webhook (تحقق توقيع + dedup + رد سريع + معالجة خلفية)
// -----------------------------------------------------------------------------

async function handleWebhook(request, env, ctx) {
  const receivedAt = isoNow();
  const rawBody = await request.text();

  const signature = request.headers.get("X-Zernio-Signature");
  if (!signature) {
    await logActivity(env, { event: "webhook", outcome: "rejected-no-signature", timing: { receivedAt } });
    return textResponse("No signature provided.", 401);
  }
  if (!env.ZERNIO_WEBHOOK_SECRET) {
    await logActivity(env, { event: "webhook", outcome: "misconfigured", error: "ZERNIO_WEBHOOK_SECRET غير موجود", timing: { receivedAt } });
    return textResponse("Server not configured (ZERNIO_WEBHOOK_SECRET).", 500);
  }

  const computed = await hmacSha256Hex(env.ZERNIO_WEBHOOK_SECRET, rawBody);
  if (!safeEqualHex(computed, signature)) {
    await logActivity(env, { event: "webhook", outcome: "rejected-bad-signature", timing: { receivedAt } });
    return textResponse("Invalid signature", 400);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    await logActivity(env, { event: "webhook", outcome: "rejected-invalid-json", error: err.message, timing: { receivedAt } });
    return textResponse("Invalid JSON body", 400);
  }

  const eventId = request.headers.get("X-Zernio-Event-Id") || payload.id;
  if (eventId) {
    const dedupKey = `dedup:${eventId}`;
    const already = await env.ZERNIO_KV.get(dedupKey).catch(() => null);
    if (already) {
      await logActivity(env, { eventId, event: payload.event, outcome: "dedup-skip", timing: { receivedAt } });
      return jsonResponse({ ok: true, dedup: true });
    }
    await env.ZERNIO_KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS }).catch(() => {});
  }

  // لازم رد 2xx خلال 5 ثواني (وإلا Zernio تعيد المحاولة لغاية ~51 ساعة) —
  // فبنرجّع الرد فورًا، والمعالجة الفعلية (حلقة الوكيل) بتكمل في الخلفية.
  ctx.waitUntil(handleZernioEvent(env, rawBody, payload, receivedAt));

  return jsonResponse({ ok: true });
}

// -----------------------------------------------------------------------------
// 9) /health — endpoint متابعة الحالة (JSON خالص، بدون أي HTML)
// -----------------------------------------------------------------------------

async function handleHealth(request, env) {
  const url = new URL(request.url);
  if (env.STATUS_KEY && url.searchParams.get("key") !== env.STATUS_KEY) {
    return jsonResponse({ ok: false, error: "Unauthorized. ضيف ?key=... في الرابط." }, 401);
  }

  const secrets = {
    ZERNIO_API_KEY: !!env.ZERNIO_API_KEY,
    ZERNIO_WEBHOOK_SECRET: !!env.ZERNIO_WEBHOOK_SECRET,
    GEMINI_API_KEY: !!env.GEMINI_API_KEY,
  };

  let zernio = { connected: false };
  try {
    const api = buildZernioApiClient(env);
    const res = await api.get("/accounts");
    zernio = { connected: res.ok, status: res.status };
  } catch (err) {
    zernio = { connected: false, error: err.message };
  }

  const eventId = url.searchParams.get("eventId");
  const since = computeSinceDate(url);
  const logs = await listRecentLogs(env, { eventId, since });

  return jsonResponse({ ok: true, secrets, zernio, tools: Object.keys(TOOLS), logs });
}

// -----------------------------------------------------------------------------
// 10) /health/review — طابور الأحداث اللي محتاجة مراجعة بشرية
// -----------------------------------------------------------------------------

async function handleReviewQueue(request, env) {
  const url = new URL(request.url);
  if (env.STATUS_KEY && url.searchParams.get("key") !== env.STATUS_KEY) {
    return jsonResponse({ ok: false, error: "Unauthorized. ضيف ?key=... في الرابط." }, 401);
  }

  const resolveId = url.searchParams.get("resolve");
  if (resolveId) {
    await env.ZERNIO_KV.delete(`review:${resolveId}`).catch(() => {});
    return jsonResponse({ ok: true, resolved: resolveId });
  }

  try {
    const listRes = await env.ZERNIO_KV.list({ prefix: "review:", limit: 1000 });
    const items = (await Promise.all(listRes.keys.map((k) => kvGetJSON(env, k.name)))).filter(Boolean);
    items.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
    return jsonResponse({ ok: true, pendingCount: items.length, items });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

// -----------------------------------------------------------------------------
// 11) نقطة الدخول الرئيسية
// -----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/webhook/zernio") {
        return await handleWebhook(request, env, ctx);
      }

      if (request.method === "GET" && url.pathname === "/webhook/zernio") {
        return textResponse("Zernio webhook endpoint — استخدم POST هنا لتسجيل الأحداث.");
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return await handleHealth(request, env);
      }

      if (request.method === "GET" && url.pathname === "/health/review") {
        return await handleReviewQueue(request, env);
      }

      return textResponse("Not found", 404);
    } catch (err) {
      console.error("Unhandled fetch error", err);
      await logActivity(env, { event: "webhook", outcome: "fatal-error", error: err.message, timing: { receivedAt: isoNow() } }).catch(() => {});
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },
};
