// =============================================================================
// Zernio Social Inbox Agent — Cloudflare Worker (v2: agentic loop)
// =============================================================================
//
// المعمارية: أي حدث webhook من Zernio بيوصل خام (نص JSON كامل) لموديل Gemini.
// الموديل عنده أداتين عامتين بس، بيمرروا 1:1 لبروتوكول MCP نفسه من غير أي
// منطق خاص بـ Zernio مكتوب في هذا الملف:
//
//   - list_tools  → tools/list (مع pagination)
//   - call_tool   → tools/call (بأي اسم/arguments يحددهم الموديل)
//
// الموديل هو اللي بيقرر: هل الحدث ده تعليق ولا رسالة ولا حاجة تانية، هل
// محتاج رد، وبأي أداة. الحلقة (Plan → Act → Reflect) بتتكرر لحد ما الموديل
// يرجع رد نصي من غير أي نداء أداة — وده اللي بيوقف المعالجة.
//
// الاستثناء الأمني الوحيد المكتوب في الكود (مش قرار للموديل): تجاهل أي حدث
// صادر من الحساب نفسه (تعليق فيه isOwnAccount، أو رسالة direction !=
// incoming) — منعًا لحلقة رد-على-النفس اللانهائية.
//
// الأسرار المطلوبة (تتحط يدوي في Cloudflare Dashboard أو wrangler secret put):
//   ZERNIO_API_KEY         — Bearer token لـ Zernio MCP
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

const MCP_URL = "https://mcp.zernio.com/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_GEMINI_MODELS = ["gemini-2.5-flash"];
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const TOOLS_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 ساعات
const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 أيام (أكبر من أطول إعادة إرسال موثقة عند Zernio ~51 ساعة)
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 أيام
const LOG_LIST_LIMIT = 30;

// حد أقصى لعدد دورات Plan→Act→Reflect لكل حدث — حماية من التكلفة/التكرار
// اللانهائي، مش قرار على مضمون الرد.
const MAX_AGENT_STEPS = 10;

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
// 3) عميل MCP الخام (JSON-RPC 2.0 فوق Streamable HTTP) — بدون أي منطق خاص
//    بـ Zernio؛ list/call فقط، زي بروتوكول MCP نفسه بالظبط.
// -----------------------------------------------------------------------------

function parseSSE(text) {
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  if (!lines.length) throw new Error("SSE response had no data lines");
  return JSON.parse(lines[lines.length - 1].slice(5).trim());
}

async function mcpRequest(env, sessionId, method, params, isNotification = false) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer " + env.ZERNIO_API_KEY,
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body = { jsonrpc: "2.0", method, params: params || {} };
  if (!isNotification) body.id = crypto.randomUUID();

  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const newSessionId = res.headers.get("Mcp-Session-Id") || sessionId || null;

  if (isNotification) return { sessionId: newSessionId, result: null };

  if (!res.ok && res.status !== 202) {
    const errText = await res.text().catch(() => "");
    throw new Error(`MCP HTTP ${res.status} على ${method}: ${errText.slice(0, 300)}`);
  }

  const contentType = res.headers.get("Content-Type") || "";
  const raw = await res.text();
  let payload;
  try {
    payload = contentType.includes("text/event-stream") ? parseSSE(raw) : JSON.parse(raw);
  } catch (err) {
    throw new Error(`تعذّر تحليل رد MCP لـ ${method}: ${err.message}`);
  }

  if (payload.error) {
    const err = new Error(`MCP JSON-RPC error [${payload.error.code}] على ${method}: ${payload.error.message}`);
    err.mcpErrorCode = payload.error.code;
    throw err;
  }

  return { sessionId: newSessionId, result: payload.result };
}

// Session جديدة كل استدعاء — أبسط وأتين من محاولة إعادة استخدامها عبر
// invocations منفصلة على منصة serverless. Mcp-Session-Id اختياري حسب الـ
// spec، فمفيش مشكلة لو Zernio ميرجّعوش.
async function mcpInitialize(env) {
  const initRes = await mcpRequest(env, null, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "zernio-social-inbox-agent", version: "2.0.0" },
  });
  const sessionId = initRes.sessionId || null;
  await mcpRequest(env, sessionId, "notifications/initialized", {}, true);
  return sessionId;
}

async function mcpListToolsPaginated(env, sessionId) {
  let allTools = [];
  let cursor;
  let guard = 0;
  do {
    const { result } = await mcpRequest(env, sessionId, "tools/list", cursor ? { cursor } : {});
    allTools = allTools.concat((result && result.tools) || []);
    cursor = result && result.nextCursor;
    guard++;
  } while (cursor && guard < 20);
  return allTools;
}

function extractToolResultText(result) {
  const blocks = (result && result.content) || [];
  const parts = blocks.map((b) =>
    b.type === "text" ? b.text : `[محتوى غير نصي: type=${b.type}${b.mimeType ? ", mimeType=" + b.mimeType : ""}]`
  );
  if (result && result.structuredContent) parts.push("[structuredContent]: " + JSON.stringify(result.structuredContent));
  return parts.join("\n").trim();
}

async function mcpCallTool(env, sessionId, name, args) {
  const { result } = await mcpRequest(env, sessionId, "tools/call", { name, arguments: args || {} });
  const text = extractToolResultText(result);
  return { ok: !(result && result.isError), text, isError: !!(result && result.isError) };
}

// كاش بسيط لـ tools/list في KV — تفصيل تنفيذي داخلي بحت، الموديل مش شايفه
// ولا فارق معاه، بس بيوفّر round-trip لـ MCP في كل حدث.
async function getCachedToolsList(env, sessionId) {
  const cached = await kvGetJSON(env, "tools:list");
  if (cached) return cached;
  const tools = await mcpListToolsPaginated(env, sessionId);
  await kvSetJSON(env, "tools:list", tools, TOOLS_CACHE_TTL_SECONDS);
  return tools;
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

// نداء Gemini واحد بموديل/مفتاح ثابتين (combo محدد سلفًا) — بدون أي تبديل
// داخلي. التبديل بين الموديلات بقى مسؤولية الحلقة الكاملة (runAgentLoop)،
// مش هنا. مفيش استخدام لآلية tools/functionDeclarations بتاعة Gemini خالص —
// بروتوكول الاستدعاء بروتوكول عام (نص عادي + JSON نحلله إحنا)، مستقل عن أي
// provider. responseMimeType هنا مجرد تحسين موثوقية خاص بـ Gemini (يجبره
// يرجع JSON صالح دايمًا)، مش شرط أساسي للبروتوكول نفسه.
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
// بروتوكول استدعاء الأدوات هنا مبني من الصفر، بدون أي اعتماد على آلية
// "function calling" الخاصة بأي provider (زي tools/functionDeclarations/
// functionCall بتاعة Gemini). السبب: كل provider (وأحيانًا كل موديل من نفس
// الـ provider) عنده تفاصيل تنفيذ مختلفة لآلية function calling بتاعته (أسماء
// أدوار، شكل تسلسل الاستدعاء...)، وده سبب أعطال حقيقية شفناها فعليًا. بدل
// كده، الموديل بيرد بنص عادي (role: user/model بس، مفيش role خاص)، والنص ده
// لازم يكون كائن JSON واحد بواحد من ثلاث أشكال ثابتة، وإحنا اللي بنحلله.
// البروتوكول ده هيشتغل مع أي LLM بيقدر يرد بنص، مهما كان الـ provider.

// أشكال رد الموديل المسموحة:
//   {"action": "list_tools"}
//   {"action": "call_tool", "name": "...", "arguments": {...}}
//   {"action": "final", "text": "..."}

const AGENT_SYSTEM_INSTRUCTION = [
  "أنت وكيل ذكي بيستقبل أحداث webhook خام من منصة Zernio (إدارة حسابات سوشيال ميديا: فيسبوك وانستجرام).",
  "",
  "طريقة الرد (مهم جدًا تلتزم بيها بالحرف): كل رد منك لازم يكون كائن JSON واحد بس، من غير أي نص تاني قبله أو بعده أو أي markdown، بواحد من الأشكال الثلاثة دول بالظبط:",
  '1) {"action": "list_tools"} — لعرض كل الأدوات المتاحة حاليًا على سيرفر Zernio MCP.',
  '2) {"action": "call_tool", "name": "الاسم الحقيقي للأداة", "arguments": {...}} — لتنفيذ أداة حقيقية فعليًا. arguments هنا كائن JSON مباشر (مش نص فيه JSON)، فيه الـ parameters المطلوبة لهذه الأداة بالظبط زي ما ظهرت في list_tools.',
  '3) {"action": "final", "text": "..."} — لما تنتهي من كل الأفعال المطلوبة، أو تقرر عدم الحاجة لأي فعل من الأساس.',
  "",
  "ملاحظة مهمة عن list_tools: بترجّع بس الأدوات الأساسية الظاهرة دايمًا (حسابات، منشورات، تعليقات، تحليلات...). أدوات كتير تانية (زي إرسال رسائل خاصة/DM) متعمّدة تكون مخفية ومش هتظهر هنا مباشرة، ومتاحة بس عن طريق أداة اسمها search_tools — واللي هي نفسها موجودة كسطر عادي في نتيجة list_tools. لو محتاج قدرة (زي 'إرسال رسالة') ومش شايفها في القائمة، ده معناه لازم تستخدم call_tool بالاسم search_tools ومعاه query يوصف اللي محتاجه (مثلاً \"send a direct message reply\")، مش إنك تفترض إن الأداة مش موجودة.",
  "",
  "طريقة عملك:",
  "1. اقرا الحدث الخام اللي وصلك بعناية وافهم نوعه (تعليق، رسالة، أو أي حدث تاني) والمطلوب فعله، لو فيه حاجة أصلاً.",
  "2. لو الحدث لا يحتاج أي فعل (إشعار نشر منشور، تفاعل بسيط، حدث غير متعلق بالتفاعل مع عميل)، اكتفِ بـ action: final ونص قصير يشرح السبب من غير ما تستخدم أي أداة.",
  "3. لو محتاج فعل فعلي، استخدم list_tools الأول. لو الأداة المناسبة مش ظاهرة فيها، استخدم call_tool بالاسم search_tools لتكتشفها (زي ما اتشرح فوق)، بعدين call_tool تاني بالاسم الحقيقي اللي لقيته لتنفيذها.",
  "3ب. اربط نوع الأداة بشكل الحدث: لو الحدث الخام فيه conversationId (يعني رسالة/DM)، ممنوع تستخدم أي أداة اسمها فيها comments — دور بـ search_tools عن أداة اسمها فيها messages. لو الحدث فيه postId أو platformPostId من غير conversationId (يعني تعليق)، أدوات comments_* هي الصح.",
  "3ج. لو نفس الأداة فشلت مرتين بأخطاء زي 'not found' أو 'invalid' أو 'platform_api_error'، الأغلب إنك مستخدم الأداة الغلط أصلاً، مش إن الـ IDs غلط. ارجع لـ search_tools بدل ما تكرر نفس الأداة بـ IDs مختلفة.",
  "3د. لو الحدث فيه conversationId (رسالة/DM)، لازم قبل أي رد تجيب آخر 20 رسالة في نفس المحادثة (أداة زي messages_get_inbox_conversation_messages، دورها بـ search_tools لو مش ظاهرة) عشان تفهم السياق الكامل — حتى لو الرسالة الحالية شكلها واضحة لوحدها.",
  "4. استخدم الـ IDs الحقيقية الموجودة في نص الحدث بالظبط (مثل comment id، conversation id، account id) — لا تخترع أي قيمة غير موجودة في النص.",
  "5. لو نداء أداة رجع خطأ، اقرا رسالة الخطأ بعناية وصحّح الـ arguments أو جرّب أداة بديلة قبل ما تستسلم.",
  "6. لو بتصيغ ردًا فعليًا لعميل، اكتبه بنفس لغته (عربي فصحى أو عامية أو إنجليزي) وخليه ودود ومختصر ومحترف.",
  "7. تحذير حاسم: صياغة نص الرد لوحدها متكفيش. لو قررت إن فيه رد لازم يوصل للعميل، لازم تكون نفّذت أداة الإرسال المناسبة فعليًا عن طريق call_tool قبل ما تختم بـ action: final — رد نهائي فيه محتوى موجّه للعميل من غير تنفيذ أداة إرسال = العميل مايستقبلش أي حاجة خالص.",
  "8. لما تنتهي فعلاً (نفذت كل الأفعال المطلوبة بنجاح، أو قررت من البداية عدم الحاجة لأي فعل)، ردّ بـ action: final — هذا هو اللي بيوقف المعالجة.",
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

async function executeAction(env, sessionId, action) {
  if (action.action === "list_tools") {
    const tools = await getCachedToolsList(env, sessionId);
    const toolsJson = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
    return (
      toolsJson +
      "\n\nملاحظة: دي الأدوات الأساسية بس. لو القدرة اللي محتاجها (زي إرسال رسالة خاصة/DM) مش ظاهرة هنا، استخدم call_tool بالاسم search_tools ومعاه query يوصف اللي محتاجه بالظبط."
    );
  }

  if (action.action === "call_tool") {
    const toolName = action.name;
    if (!toolName || typeof toolName !== "string") return "لازم تحدد name (الاسم الحقيقي للأداة) كنص.";
    const toolArgs = action.arguments && typeof action.arguments === "object" ? action.arguments : {};

    // كاش لنداءات search_tools تحديدًا (بحث = قراءة، آمن نكاشه) — بيوفر
    // ثانيتين-تلاتة على كل حدث بعد أول مرة، مهم لأن الميزانية الكلية للحدث
    // محدودة بحوالي 30 ثانية (حد ctx.waitUntil في Cloudflare Workers).
    // مبنكاشش أي أداة تانية (خصوصًا أفعال الإرسال) — دي قراءة بحتة بس.
    if (toolName === "search_tools" && typeof toolArgs.query === "string") {
      const cacheKey = `search:${toolArgs.query.toLowerCase().trim()}`;
      const cached = await kvGetJSON(env, cacheKey);
      if (cached) return cached.text;

      const result = await mcpCallTool(env, sessionId, toolName, toolArgs);
      const text = result.text || (result.ok ? "(نجح، بدون رد نصي)" : "فشل تنفيذ الأداة بدون تفاصيل إضافية.");
      if (result.ok) await kvSetJSON(env, cacheKey, { text }, TOOLS_CACHE_TTL_SECONDS);
      return text;
    }

    const result = await mcpCallTool(env, sessionId, toolName, toolArgs);
    return result.text || (result.ok ? "(نجح التنفيذ، بدون رد نصي من الأداة)" : "فشل تنفيذ الأداة بدون تفاصيل إضافية.");
  }

  return `action غير معروف: "${action.action}". استخدم بس: list_tools أو call_tool أو final.`;
}

// دورة كاملة بموديل واحد ثابت — بترجع نتيجة دايمًا (مفيهاش throw خالص، حتى
// لو فشلت)، عشان الخطوات اللي حصلت قبل أي فشل متتسجلش أبدًا وتضيع.
async function runAgentLoopWithModel(env, sessionId, rawEventText, combo) {
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
        parts: [{ text: "ردك مش كائن JSON صالح بالشكل المطلوب. رجّع بس واحد من الأشكال الثلاثة المتفق عليها، بدون أي نص إضافي." }],
      });
      continue;
    }

    if (action.action === "final") {
      const finalText = typeof action.text === "string" ? action.text : "";
      steps.push({ step: i + 1, ts: isoNow(), type: "final", text: finalText });
      return { ok: true, steps, finalText, stopReason: "final", geminiAttempts };
    }

    if (action.action === "list_tools" || action.action === "call_tool") {
      let resultText;
      try {
        resultText = await executeAction(env, sessionId, action);
      } catch (err) {
        resultText = "خطأ فى التنفيذ: " + err.message;
      }
      steps.push({
        step: i + 1,
        ts: isoNow(),
        type: "call",
        name: action.action === "call_tool" ? action.name : "list_tools",
        args: action.action === "call_tool" ? action.arguments : undefined,
        result: String(resultText).slice(0, 500),
      });
      contents.push({ role: "model", parts: [{ text: rawText }] });
      contents.push({ role: "user", parts: [{ text: `نتيجة التنفيذ:\n${resultText}` }] });
      continue;
    }

    // action.action قيمة مش من الثلاثة المعروفة
    steps.push({ step: i + 1, ts: isoNow(), type: "unknown-action", raw: String(action.action).slice(0, 100) });
    contents.push({ role: "model", parts: [{ text: rawText }] });
    contents.push({
      role: "user",
      parts: [{ text: `"action": "${action.action}" مش معروف. استخدم بس: list_tools أو call_tool أو final.` }],
    });
  }

  return { ok: true, steps, finalText: null, stopReason: "max-steps", geminiAttempts };
}

// الغلاف الخارجي: بيجرب موديل واحد ثابت للحدث كله. لو فشل *قبل أي فعل حقيقي*
// (مفيش خطوة type:"call" في الأثر لسه)، آمن نجرب موديل تاني من الصفر. لو
// فشل *بعد* ما فعل حقيقي حصل، بنوقف فورًا ونسجل بدل ما نعيد المحاولة —
// عشان منعملش فعل مكرر (زي إرسال رسالة مرتين) بموديل مختلف مش عارف إن
// الأول خلص جزء من الشغل خلاص.
async function runAgentLoop(env, sessionId, rawEventText) {
  const combos = buildGeminiCombos(env);
  if (!combos.length) {
    return { steps: [], finalText: null, stopReason: "error", error: "مفيش GEMINI_API_KEY متظبط", geminiAttempts: [] };
  }

  let lastResult = null;
  for (const combo of combos) {
    const result = await runAgentLoopWithModel(env, sessionId, rawEventText, combo);
    if (result.ok) return result;
    lastResult = result;
    const hadRealAction = result.steps.some((s) => s.type === "call");
    if (hadRealAction) return result; // فعل حقيقي حصل بالفعل — منكررش بموديل تاني
  }
  return lastResult || { steps: [], finalText: null, stopReason: "error", error: "كل الموديلات فشلت", geminiAttempts: [] };
}

// -----------------------------------------------------------------------------
// 6) معالجة الحدث الوارد
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

  let trace;
  let initError = null;
  try {
    const sessionId = await mcpInitialize(env);
    trace = await runAgentLoop(env, sessionId, rawBody);
  } catch (err) {
    // فشل قبل ما الحلقة تبدأ أصلاً (مثلاً initialize نفسها فشلت) — حالة
    // نادرة، runAgentLoop نفسها بترجع نتيجة دايمًا ومبترميش استثناء.
    console.error("handleZernioEvent failed before agent loop", eventType, err);
    initError = err.message;
  }

  const finishedAt = isoNow();
  const entry = {
    eventId,
    event: eventType,
    trigger,
    timing: { receivedAt, startedAt, finishedAt, durationMs: new Date(finishedAt) - new Date(startedAt) },
  };

  if (initError) {
    Object.assign(entry, { outcome: "error", error: initError });
  } else {
    Object.assign(entry, {
      outcome: trace.stopReason,
      finalText: trace.finalText,
      error: trace.error,
      geminiAttempts: trace.geminiAttempts,
      steps: trace.steps,
    });
  }

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

  if (url.searchParams.get("refresh") === "1") {
    await env.ZERNIO_KV.delete("tools:list").catch(() => {});
  }

  const secrets = {
    ZERNIO_API_KEY: !!env.ZERNIO_API_KEY,
    ZERNIO_WEBHOOK_SECRET: !!env.ZERNIO_WEBHOOK_SECRET,
    GEMINI_API_KEY: !!env.GEMINI_API_KEY,
  };

  let mcp = { connected: false };
  try {
    const sessionId = await mcpInitialize(env);
    const tools = await getCachedToolsList(env, sessionId);
    mcp = { connected: true, toolCount: tools.length, toolNames: tools.map((t) => t.name) };
  } catch (err) {
    mcp = { connected: false, error: err.message };
  }

  const eventId = url.searchParams.get("eventId");
  const since = computeSinceDate(url);
  const logs = await listRecentLogs(env, { eventId, since });

  return jsonResponse({ ok: true, secrets, mcp, logs });
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
