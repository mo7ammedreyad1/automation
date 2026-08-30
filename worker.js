// =============================================================================
// Zernio Social Inbox Agent — Cloudflare Worker (v3: code-execution agent, DM only)
// =============================================================================
//
// المعمارية: أي حدث webhook من Zernio بيوصل خام (نص JSON كامل) لموديل Gemini.
// مفيش MCP خالص في النسخة دي. الموديل بيرد بواحد من شكلين بس:
//
//   {"action": "code", "code": "..."}   — كود JS يتنفذ فورًا جوه الـ worker
//   {"action": "final", "text": "..."}  — انتهى، ده اللي بيوقف المعالجة
//
// الكود اللي الموديل بيكتبه بيتنفذ جوه new Function (مش eval) في الـ global
// scope — يعني مفيش أي متغير من الملف ده (env, rawBody, secrets...) قابل
// للوصول من جوه الكود ده غير اللي بنمرره احنا صراحة كـ arguments تلاتة بس:
//   - fetch          : نسخة مقيدة بتقبل بس دومين zernio.com (حماية من إن
//                       injection من تعليق/DM يخلي الكود يبعت بيانات لسيرفر
//                       تاني)
//   - ZERNIO_API_KEY  : قيمة السر الحقيقية — الموديل بيستخدم اسم المتغير ده
//                       في الكود، من غير ما يكتب القيمة الحرفية أبدًا (متتحطش
//                       في أي نص بيتبعت للموديل نفسه ولا في اللوج — انظر
//                       redactSecret)
//   - ZERNIO_BASE_URL : https://zernio.com/api/v1
//
// النسخة دي (v3) شغالة على رسائل الـ DM بس (message.received). أي حدث تاني
// (comment.received, referral.received, account.disconnected) بيتسجل باللوج
// من غير ما يتبعت لـ Gemini خالص — هيتفعّل لما نضيف كتالوج أدوات التعليقات.
//
// الاستثناء الأمني الوحيد المكتوب في الكود (مش قرار للموديل): تجاهل أي حدث
// صادر من الحساب نفسه (تعليق فيه isOwnAccount، أو رسالة direction !=
// incoming) — منعًا لحلقة رد-على-النفس اللانهائية. المنطق ده منقول زي ما هو
// من النسخة اللي قبل كده (v2)، لأنه اتبنى على شكل payload حقيقي مُختبر.
//
// الأسرار المطلوبة (تتحط يدوي في Cloudflare Dashboard أو wrangler secret put):
//   ZERNIO_API_KEY         — نفس المفتاح شغال REST (Bearer) على
//                             https://zernio.com/api/v1
//   ZERNIO_WEBHOOK_SECRET   — نفس السر المسجّل عند إنشاء الـ webhook في Zernio
//   GEMINI_API_KEY          — مفتاح واحد أو أكتر مفصولين بفاصلة
//   GEMINI_MODELS            — اختياري، قائمة موديلات مفصولة بفاصلة (fallback)
//   STATUS_KEY                — اختياري، لحماية /health بمفتاح في الرابط
//
// KV binding المطلوب في wrangler.jsonc: باسم ZERNIO_KV
//
// ملاحظة مفتوحة: لسه معندناش عينة payload حقيقية موثّقة لشكل الـ account id
// جوه حدث message.received (id ولا _id). ده مش مشكلة لمنطق الملف ده نفسه —
// الموديل بيقرا الـ JSON الخام بنفسه ويستخرج الـ IDs الصح منه مباشرة — لكن
// يستاهل تتأكد منه من أول تشغيل حقيقي (شوف اللوج).
//
// ملاحظة تانية: المرفقات (صور/صوت) الجاية في رسائل الدخول بتوصل للموديل كـ
// نص (رابط جوه الـ JSON الخام) مش كمحتوى وسائط فعلي — يعني الموديل عارف إن
// فيه مرفق ومعاه رابطه، لكنه لسه مش "شايف" الصورة ولا "سامع" الصوت فعليًا.
// لو محتاج فهم فعلي لمحتوى الوسائط، ده خطوة تالية منفصلة (تحويل الـ Gemini
// call لـ multimodal وتنزيل المرفق وتمريره كـ inline data).
// =============================================================================

// -----------------------------------------------------------------------------
// 1) ثوابت عامة
// -----------------------------------------------------------------------------

const ZERNIO_API_BASE = "https://zernio.com/api/v1";
const ZERNIO_ALLOWED_HOST = "zernio.com";

const DEFAULT_GEMINI_MODELS = ["gemini-3.1-flash-lite"];
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 أيام (أكبر من أطول إعادة إرسال موثقة عند Zernio ~51 ساعة)
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 أيام
const LOG_LIST_LIMIT = 30;

// حد أقصى لعدد دورات Plan→Act→Reflect لكل حدث — حماية من التكلفة/التكرار
// اللانهائي، مش قرار على مضمون الرد.
const MAX_AGENT_STEPS = 10;

// حد أقصى لوقت تنفيذ أي كود يكتبه الموديل — حماية من كود بيعلق (حلقة
// لانهائية، fetch بيستنى للأبد...) ياكل من ميزانية ctx.waitUntil كلها.
const CODE_EXEC_TIMEOUT_MS = 20000;

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

// range=1h (آخر ساعة) أو range=today (من أول اليوم UTC) أو since=<ISO> مخصص.
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
// 3) بيئة تنفيذ كود الموديل (sandboxed code execution)
// -----------------------------------------------------------------------------
//
// new Function (مش eval) بينفذ الكود في الـ global scope، مش في closure
// الملف ده — يعني حتى لو الكود المولّد حاول يقرا أي متغير تاني غير التلاتة
// اللي بنمررهم صراحة، مش هيلاقيه أصلاً (undefined / ReferenceError).

function makeRestrictedFetch(allowedHost) {
  return async function fetch(url, options) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (err) {
      throw new Error(`رابط غير صالح: ${url}`);
    }
    if (parsed.hostname !== allowedHost) {
      throw new Error(`fetch مسموح بس لدومين ${allowedHost} — الرابط اللي اتحاول توصله: ${parsed.hostname}`);
    }
    return globalThis.fetch(parsed.toString(), options);
  };
}

// دفاع إضافي: لو الكود المولّد رجّع أو رمى نص فيه القيمة الحرفية للسر
// بالغلط، نمسحها قبل ما تتسجل باللوج أو ترجع لسياق الموديل نفسه.
function redactSecret(text, secret) {
  if (!secret || typeof text !== "string") return text;
  return text.split(secret).join("[REDACTED]");
}

async function executeGeneratedCode(env, code) {
  const restrictedFetch = makeRestrictedFetch(ZERNIO_ALLOWED_HOST);

  let fn;
  try {
    fn = new Function(
      "fetch",
      "ZERNIO_API_KEY",
      "ZERNIO_BASE_URL",
      `"use strict";\nreturn (async () => {\n${code}\n})();`
    );
  } catch (err) {
    return { ok: false, text: `خطأ في صياغة الكود (syntax error): ${err.message}` };
  }

  try {
    const raw = await Promise.race([
      fn(restrictedFetch, env.ZERNIO_API_KEY, ZERNIO_API_BASE),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`انتهت مهلة تنفيذ الكود (${CODE_EXEC_TIMEOUT_MS / 1000} ثانية)`)), CODE_EXEC_TIMEOUT_MS)
      ),
    ]);
    let text;
    if (typeof raw === "string") text = raw;
    else {
      try {
        text = JSON.stringify(raw, null, 2);
      } catch (_) {
        text = String(raw);
      }
      if (text === undefined) text = "(الكود اتنفذ من غير return، مفيش نتيجة)";
    }
    text = redactSecret(text, env.ZERNIO_API_KEY);
    return { ok: true, text: text.slice(0, 4000) };
  } catch (err) {
    const msg = redactSecret(String((err && err.message) || err), env.ZERNIO_API_KEY);
    return { ok: false, text: `خطأ أثناء تنفيذ الكود: ${msg}` };
  }
}

// -----------------------------------------------------------------------------
// 4) عميل Gemini (تدوير مفاتيح/موديلات)
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
// 5) حلقة الوكيل: Plan → Act → Reflect
// -----------------------------------------------------------------------------
//
// الموديل بيرد بنص عادي (role: user/model بس)، والنص ده لازم يكون كائن JSON
// واحد بواحد من شكلين ثابتين، وإحنا اللي بنحلله:
//   {"action": "code", "code": "..."}   — كود JS يتنفذ فورًا
//   {"action": "final", "text": "..."}  — رد نهائي، بيوقف المعالجة

const AGENT_SYSTEM_INSTRUCTION = [
  "أنت وكيل ذكي بيرد على رسائل الـ Direct Messages (فيسبوك وانستجرام) اللي بتوصلك خام كأحداث webhook من منصة Zernio. النسخة دي شغالة على الـ DMs بس دلوقتي — لو استقبلت أي حاجة تانية غير رسالة DM، اعتبرها غلط ورد بـ final فيه نص قصير يوضح كده من غير أي فعل.",
  "",
  "طريقة الرد (مهم جدًا تلتزم بيها بالحرف): كل رد منك لازم يكون كائن JSON واحد بس، من غير أي نص تاني قبله أو بعده أو أي markdown، بواحد من الشكلين دول بالظبط:",
  '1) {"action": "code", "code": "..."} — كود JavaScript (async) بينفذ فورًا جوه الـ Cloudflare Worker.',
  '2) {"action": "final", "text": "..."} — لما تنتهي من كل الأفعال المطلوبة، أو تقرر عدم الحاجة لأي فعل من الأساس.',
  "",
  "بيئة تنفيذ الكود (مهم تفهمها كويس):",
  "- الكود اللي تكتبه بيتنفذ كـ جسم دالة async — يعني تقدر تستخدم await عادي وتكتب return في الآخر يرجّع نتيجة (نص أو كائن) هتشوفها في الخطوة اللي بعدها.",
  "- عندك 3 متغيرات جاهزة بس، تقدر تستخدمهم بالاسم من غير ما تعرّفهم: fetch, ZERNIO_API_KEY, ZERNIO_BASE_URL.",
  "- ZERNIO_BASE_URL = \"https://zernio.com/api/v1\".",
  "- تحذير أمني حاسم: متكتبش قيمة ZERNIO_API_KEY الحرفية في الكود أبدًا تحت أي ظرف — استخدم اسم المتغير ZERNIO_API_KEY بس، وإحنا بنحقن القيمة الحقيقية وقت التنفيذ. لو رجّعت أو طبعت القيمة دي بأي شكل هتتشال من النتيجة تلقائيًا.",
  "- الـ fetch المتاحة ليك مقيدة تبعت بس لدومين zernio.com — أي محاولة توصل دومين تاني هترجع خطأ فورًا.",
  "- لو الكود رمى استثناء (throw / fetch فشل / JSON غير صالح...) هيترجم لنص خطأ بيوصلك في الخطوة اللي بعدها، اقراه واصلحه.",
  "",
  "كتالوج الـ REST endpoints المتاحة ليك (كلها REST حقيقي على Zernio، الـ Authorization header دايمًا `Bearer ${ZERNIO_API_KEY}`):",
  "",
  "1) جلب آخر رسائل محادثة (سياق) — استخدمها إلزاميًا قبل أي رد فعلي على DM، حتى لو الرسالة الحالية واضحة لوحدها:",
  "GET /inbox/conversations/{conversationId}/messages?accountId={accountId}&limit=20&sortOrder=desc",
  "مثال:",
  '```js',
  'const res = await fetch(`${ZERNIO_BASE_URL}/inbox/conversations/${conversationId}/messages?accountId=${accountId}&limit=20&sortOrder=desc`, {',
  '  headers: { Authorization: `Bearer ${ZERNIO_API_KEY}` },',
  '});',
  'const data = await res.json();',
  'return JSON.stringify(data.messages);',
  '```',
  "ملاحظة: كل مرفق (attachments[]) على انستجرام/فيسبوك ليه url بينتهي صلاحيته و refreshUrl ثابت — لو محتاج تستخدم مرفق قديم مش الرسالة الحالية، استخدم الـ refreshUrl مش الـ url.",
  "",
  "2) إرسال رسالة نصية:",
  "POST /inbox/conversations/{conversationId}/messages",
  '```js',
  'const res = await fetch(`${ZERNIO_BASE_URL}/inbox/conversations/${conversationId}/messages`, {',
  '  method: "POST",',
  '  headers: { Authorization: `Bearer ${ZERNIO_API_KEY}`, "Content-Type": "application/json" },',
  '  body: JSON.stringify({ accountId, message: "نص الرد هنا" }),',
  '});',
  'const data = await res.json();',
  'return JSON.stringify(data);',
  '```',
  "",
  "3) إرسال صورة أو فيديو أو صوت (attachmentType: image | video | audio | file)، مع نص اختياري:",
  '```js',
  'const res = await fetch(`${ZERNIO_BASE_URL}/inbox/conversations/${conversationId}/messages`, {',
  '  method: "POST",',
  '  headers: { Authorization: `Bearer ${ZERNIO_API_KEY}`, "Content-Type": "application/json" },',
  '  body: JSON.stringify({ accountId, message: "نص اختياري", attachmentUrl: "https://...", attachmentType: "image" }),',
  '});',
  'const data = await res.json();',
  'return JSON.stringify(data);',
  '```',
  "لازم attachmentUrl يكون رابط عام (publicly accessible). لو الملف اللي عايز تبعته مش على رابط عام أصلاً، ارفعه الأول:",
  "POST /media/upload-direct (multipart/form-data، فيه file) — بيرجّع { url } تستخدمه كـ attachmentUrl.",
  "",
  "4) مؤشر إنه بيكتب رد (اختياري، لمسة واقعية بس مش إلزامية):",
  "POST /inbox/conversations/{conversationId}/typing — body: { accountId }",
  "",
  "5) إضافة/إزالة reaction على رسالة (اختياري):",
  "POST /inbox/conversations/{conversationId}/messages/{messageId}/reactions — body: { accountId, emoji }",
  "DELETE بنفس الرابط + ?accountId=... لإزالتها.",
  "",
  "طريقة عملك:",
  "1. اقرا حدث الـ DM الخام اللي وصلك بعناية، واستخرج منه conversationId و accountId الحقيقيين بالظبط زي ما ظهروا في النص — ما تخترعش أي قيمة غير موجودة.",
  "2. نفّذ كود يجيب آخر الرسائل (أداة 1) الأول عشان تفهم سياق المحادثة كامل.",
  "3. لو محتاج ترد فعليًا، اكتب كود ينفذ الإرسال المناسب (نص/صورة/فيديو/صوت) بأداة 2 أو 3.",
  "4. لو نداء REST رجع خطأ (status مش 2xx)، اقرا رسالة الخطأ (error/code/platformError في رد الـ JSON) وصحح الكود (اسم الحقل، القيمة، الرابط) قبل ما تعيد المحاولة — بلاش تكرر نفس الكود بالظبط.",
  "5. اكتب رد العميل بنفس لغته (عربي فصحى أو عامية أو إنجليزي)، ودود ومختصر ومحترف.",
  "6. تحذير حاسم: صياغة نص الرد لوحدها متكفيش. لو قررت إن فيه رد لازم يوصل للعميل، لازم تكون نفّذت كود الإرسال فعليًا (أداة 2 أو 3) قبل ما تختم بـ final — رد نهائي فيه محتوى موجّه للعميل من غير تنفيذ إرسال فعلي = العميل مايستقبلش أي حاجة خالص.",
  "7. لما تنتهي فعلاً (نفذت كل الأفعال المطلوبة بنجاح، أو قررت من البداية عدم الحاجة لأي رد)، ردّ بـ final — هذا هو اللي بيوقف المعالجة.",
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

// دورة كاملة بموديل واحد ثابت — بترجع نتيجة دايمًا (مفيهاش throw خالص، حتى
// لو فشلت)، عشان الخطوات اللي حصلت قبل أي فشل متتسجلش أبدًا وتضيع.
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

    // رد مش JSON صالح أو مفيهوش "action" — نديله فرصة تانية بدل ما نوقف
    // فورًا (بيستهلك خطوة من MAX_AGENT_STEPS، فمحمي من لوب لانهائي).
    if (!action || typeof action.action !== "string") {
      steps.push({ step: i + 1, ts: isoNow(), type: "invalid-json", raw: String(rawText).slice(0, 300) });
      contents.push({ role: "model", parts: [{ text: String(rawText).slice(0, 2000) }] });
      contents.push({
        role: "user",
        parts: [{ text: "ردك مش كائن JSON صالح بالشكل المطلوب. رجّع بس واحد من الشكلين المتفق عليهم: code أو final، من غير أي نص إضافي." }],
      });
      continue;
    }

    if (action.action === "final") {
      const finalText = typeof action.text === "string" ? action.text : "";
      steps.push({ step: i + 1, ts: isoNow(), type: "final", text: finalText });
      return { ok: true, steps, finalText, stopReason: "final", geminiAttempts };
    }

    if (action.action === "code") {
      const code = typeof action.code === "string" ? action.code : "";
      if (!code.trim()) {
        steps.push({ step: i + 1, ts: isoNow(), type: "empty-code" });
        contents.push({ role: "model", parts: [{ text: rawText }] });
        contents.push({ role: "user", parts: [{ text: "حقل code فاضي. لازم تحط كود JS فعلي فيه." }] });
        continue;
      }

      const result = await executeGeneratedCode(env, code);
      steps.push({
        step: i + 1,
        ts: isoNow(),
        type: "code",
        code: code.slice(0, 800),
        result: String(result.text).slice(0, 500),
        ok: result.ok,
      });
      contents.push({ role: "model", parts: [{ text: rawText }] });
      contents.push({ role: "user", parts: [{ text: `نتيجة تنفيذ الكود:\n${result.text}` }] });
      continue;
    }

    // action.action قيمة مش من الشكلين المعروفين
    steps.push({ step: i + 1, ts: isoNow(), type: "unknown-action", raw: String(action.action).slice(0, 100) });
    contents.push({ role: "model", parts: [{ text: rawText }] });
    contents.push({
      role: "user",
      parts: [{ text: `"action": "${action.action}" مش معروف. استخدم بس: code أو final.` }],
    });
  }

  return { ok: true, steps, finalText: null, stopReason: "max-steps", geminiAttempts };
}

// الغلاف الخارجي: بيجرب موديل واحد ثابت للحدث كله. لو فشل *قبل أي فعل حقيقي*
// (مفيش خطوة type:"code" في الأثر لسه)، آمن نجرب موديل تاني من الصفر. لو
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
    const hadRealAction = result.steps.some((s) => s.type === "code");
    if (hadRealAction) return result; // فعل حقيقي حصل بالفعل — منكررش بموديل تاني
  }
  return lastResult || { steps: [], finalText: null, stopReason: "error", error: "كل الموديلات فشلت", geminiAttempts: [] };
}

// -----------------------------------------------------------------------------
// 6) معالجة الحدث الوارد
// -----------------------------------------------------------------------------

// الاستثناء الأمني الوحيد المكتوب في الكود: منع حلقة رد-على-النفس اللانهائية.
// منقول زي ما هو من النسخة اللي قبل كده — مبني على شكل payload حقيقي مختبر.
function isSelfEcho(payload) {
  const author = payload.comment && payload.comment.author;
  if (author && author.isOwnAccount) return true;
  const direction = payload.message && payload.message.direction;
  if (direction && direction !== "incoming") return true;
  return false;
}

// معاينة عامة بحتة (لغرض القراءة البشرية في اللوج فقط).
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

  // النسخة دي شغالة على الـ DMs بس دلوقتي — أي حدث تاني (تعليق، referral،
  // account.disconnected...) بيتسجل باللوج من غير ما يتكلف Gemini بيه خالص،
  // لحد ما نضيف كتالوج أدوات التعليقات.
  if (eventType !== "message.received") {
    const finishedAt = isoNow();
    await logActivity(env, {
      eventId,
      event: eventType,
      trigger,
      timing: { receivedAt, startedAt, finishedAt, durationMs: new Date(finishedAt) - new Date(startedAt) },
      outcome: "skipped-not-dm-yet",
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
// 7) استقبال الـ webhook (تحقق توقيع + dedup + رد سريع + معالجة خلفية)
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
// 8) /health — endpoint متابعة الحالة (JSON خالص، بدون أي HTML)
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

  let zernioRest = { connected: false };
  try {
    const res = await fetch(`${ZERNIO_API_BASE}/accounts`, {
      headers: { Authorization: `Bearer ${env.ZERNIO_API_KEY || ""}` },
    });
    if (res.ok) {
      const data = await res.json();
      zernioRest = { connected: true, accountCount: ((data && data.accounts) || []).length };
    } else {
      const errText = await res.text().catch(() => "");
      zernioRest = { connected: false, status: res.status, error: errText.slice(0, 300) };
    }
  } catch (err) {
    zernioRest = { connected: false, error: err.message };
  }

  const eventId = url.searchParams.get("eventId");
  const since = computeSinceDate(url);
  const logs = await listRecentLogs(env, { eventId, since });

  return jsonResponse({ ok: true, secrets, zernioRest, logs });
}

// -----------------------------------------------------------------------------
// 9) /health/review — طابور الأحداث اللي محتاجة مراجعة بشرية
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
// 10) نقطة الدخول الرئيسية
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
