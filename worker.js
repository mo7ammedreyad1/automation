// =============================================================================
// Zernio Social Inbox Agent — Cloudflare Worker
// =============================================================================
//
// وظيفة الملف: يستقبل webhooks من Zernio (تعليقات + رسايل خاصة على فيسبوك/
// انستجرام)، يرد عليهم أوتوماتيكيًا باستخدام Gemini + أدوات Zernio عن طريق
// MCP، وكل ده في الخلفية من غير أي تدخل يدوي. صفحة "/" بتعرض الحالة وآخر
// الأحداث للمتابعة بس.
//
// لا يوجد تسجيل دخول ولا قاعدة بيانات مستخدمين — single-tenant بالكامل.
// كل الأسرار بتتحط يدوي في Cloudflare Dashboard (Settings → Variables and
// Secrets) أو عن طريق `wrangler secret put`.
//
// الأسرار المطلوبة:
//   ZERNIO_API_KEY        — مفتاح حساب Zernio (Bearer token لـ MCP)
//   ZERNIO_WEBHOOK_SECRET  — السر اللي حطيته وقت إنشاء الـ webhook عند Zernio
//   GEMINI_API_KEY         — مفتاح Gemini واحد أو أكتر مفصولين بفاصلة
//   GEMINI_MODELS           — اختياري، قائمة موديلات مفصولة بفاصلة (fallback)
//   STATUS_KEY               — اختياري، لحماية صفحة "/" بمفتاح بسيط في الرابط
//
// KV binding المطلوب في wrangler.jsonc: باسم ZERNIO_KV
//
// =============================================================================

// -----------------------------------------------------------------------------
// 1) ثوابت عامة
// -----------------------------------------------------------------------------

const MCP_URL = "https://mcp.zernio.com/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// كام ثانية نعتبر بعدها الـ tool registry المخزّن في KV "قديم" ونعيد الاكتشاف.
const TOOL_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 ساعات
// عمر مفاتيح الـ dedup في KV — أكبر من أطول مدة إعادة إرسال موثقة عند Zernio (~51 ساعة).
const DEDUP_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 أيام
// عمر سجلات المتابعة (activity log) في KV.
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 أيام
const LOG_LIST_LIMIT = 30;

// المنصات اللي هنرد عليها فعليًا. أي حدث لمنصة تانية بيتسجل بس من غير رد.
const SUPPORTED_PLATFORMS = new Set(["facebook", "instagram"]);

// إعدادات اكتشاف الأدوات: لكل قدرة محتاجينها، اسم داخلي + عبارة بحث تُرسل لـ
// search_tools + regex للتعرف على الأداة الصح من نتيجة البحث + اسم متغيّر بيئة
// اختياري لو عايز "تجاوز" البحث وتحدد اسم الأداة الحقيقي يدوي (بعد ما تكتشفه
// مرة من اللوجات، تقدر تثبّته هنا وتوفر نداء search_tools في كل مرة).
const TOOL_CAPABILITIES = {
  reply_publicly: {
    searchQuery: "reply publicly to a comment on a social media post",
    nameHint: /comments?.*reply/i,
    excludeHint: /private/i,
    overrideEnv: "ZERNIO_TOOL_COMMENT_REPLY",
  },
  reply_privately: {
    searchQuery: "send a private reply to a comment (DM the commenter)",
    nameHint: /comments?.*(private|reply)/i,
    requireHint: /private/i,
    overrideEnv: "ZERNIO_TOOL_COMMENT_PRIVATE_REPLY",
  },
  hide_comment: {
    searchQuery: "hide a comment on a post from public view",
    nameHint: /comments?.*hide/i,
    overrideEnv: "ZERNIO_TOOL_COMMENT_HIDE",
  },
  send_message: {
    searchQuery: "send a direct message reply in an inbox conversation",
    nameHint: /messages?.*send/i,
    overrideEnv: "ZERNIO_TOOL_DM_SEND",
  },
  get_conversation_history: {
    searchQuery: "get messages in an inbox conversation history",
    nameHint: /messages?.*(get|list).*conversation/i,
    overrideEnv: "ZERNIO_TOOL_DM_HISTORY",
  },
  send_typing_indicator: {
    searchQuery: "send typing indicator in inbox conversation",
    nameHint: /typing/i,
    overrideEnv: "ZERNIO_TOOL_DM_TYPING",
    optional: true,
  },
};

// -----------------------------------------------------------------------------
// 2) أدوات مساعدة عامة (JSON responses, hex, HMAC, KV wrappers)
// -----------------------------------------------------------------------------

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// HMAC-SHA256 hex — بديل Web Crypto لـ crypto.createHmac بتاعة Node (مش متاحة
// في بيئة Cloudflare Workers).
async function hmacSha256Hex(secret, rawBody) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return bufferToHex(sig);
}

// مقارنة نصين بزمن ثابت تقريبًا (defense-in-depth ضد timing attacks).
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
    const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
    await env.ZERNIO_KV.put(key, JSON.stringify(value), opts);
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

// تسجيل حدث في activity log (يُقرأ من صفحة الحالة "/").
async function logActivity(env, entry) {
  const key = `log:${isoNow()}:${shortId()}`;
  await kvSetJSON(env, key, entry, LOG_TTL_SECONDS);
}

// -----------------------------------------------------------------------------
// 3) عميل MCP (JSON-RPC 2.0 فوق Streamable HTTP) — نسخة مُصلَّحة
// -----------------------------------------------------------------------------

// آخر data: line في رد SSE، بترجع الـ JSON بتاعها.
function parseSSE(text) {
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  if (!lines.length) throw new Error("SSE response had no data lines");
  const last = lines[lines.length - 1].slice(5).trim();
  return JSON.parse(last);
}

// نداء JSON-RPC واحد. المفتاح دايمًا في الـ header (Authorization)، أبدًا مش
// جوه جسم JSON-RPC نفسه — ده الفرق اللي شرحناه قبل كده.
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

  if (isNotification) {
    // notifications/initialized مفيهاش رد متوقع.
    return { sessionId: newSessionId, result: null };
  }

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
    // خطأ على مستوى JSON-RPC نفسه (مش على مستوى تنفيذ الأداة) — بنحافظ على
    // الـ code والـ message بدل ما نحوّلهم لنص عام.
    const err = new Error(`MCP JSON-RPC error [${payload.error.code}] على ${method}: ${payload.error.message}`);
    err.mcpErrorCode = payload.error.code;
    throw err;
  }

  return { sessionId: newSessionId, result: payload.result };
}

// initialize + notifications/initialized. Session جديدة كل مرة (أبسط وأتين
// على منصة serverless من محاولة إعادة استخدام Mcp-Session-Id عبر invocations
// منفصلة).
async function mcpInitialize(env) {
  const initRes = await mcpRequest(env, null, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "zernio-social-inbox-agent", version: "1.0.0" },
  });
  const sessionId = initRes.sessionId;
  if (!sessionId) throw new Error("مفيش Mcp-Session-Id راجع من initialize");
  await mcpRequest(env, sessionId, "notifications/initialized", {}, true);
  return sessionId;
}

// tools/list مع معالجة pagination كاملة — الفجوة اللي كانت موجودة في كود
// Buffer القديم وبتتفادى هنا: نلف طول ما فيه nextCursor.
async function mcpListToolsPaginated(env, sessionId) {
  let allTools = [];
  let cursor = undefined;
  let guard = 0;
  do {
    const params = cursor ? { cursor } : {};
    const { result } = await mcpRequest(env, sessionId, "tools/list", params);
    allTools = allTools.concat((result && result.tools) || []);
    cursor = result && result.nextCursor;
    guard++;
  } while (cursor && guard < 20); // guard دفاعي ضد لوب لا نهائي لو السيرفر اتصرف غريب
  return allTools;
}

// استخراج نص قابل للاستخدام من نتيجة tools/call، مع الحفاظ على أي content
// block مش نصي (بدل ما يتشال بصمت زي كود Buffer القديم).
function extractToolResultText(result) {
  const blocks = (result && result.content) || [];
  const parts = [];
  for (const b of blocks) {
    if (b.type === "text") {
      parts.push(b.text);
    } else {
      parts.push(`[محتوى غير نصي: type=${b.type}${b.mimeType ? ", mimeType=" + b.mimeType : ""}]`);
    }
  }
  if (result && result.structuredContent) {
    parts.push("[structuredContent]: " + JSON.stringify(result.structuredContent));
  }
  return parts.join("\n").trim();
}

// نداء tools/call كامل — بيرجّع {ok, text, isError, raw}. isError بييجي من
// حقل الـ result.isError الرسمي في الـ spec، مش من تخمين نص الخطأ.
async function mcpCallTool(env, sessionId, name, args) {
  const { result } = await mcpRequest(env, sessionId, "tools/call", {
    name,
    arguments: args || {},
  });
  const text = extractToolResultText(result);
  return { ok: !(result && result.isError), text, isError: !!(result && result.isError), raw: result };
}

// -----------------------------------------------------------------------------
// 4) اكتشاف وتخزين أدوات Zernio (Discovery + Cache)
// -----------------------------------------------------------------------------

// نتيجة search_tools مش موثقة الشكل بالظبط، فبنتعامل معاها بمرونة: نحاول
// JSON.parse أول حاجة (array أو {tools:[...]} أو {results:[...]})، ولو فشل
// نلجأ لـ regex كملاذ أخير بيلقط أسماء الأدوات من النص الخام.
function parseSearchToolsResult(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.tools)) return parsed.tools;
    if (Array.isArray(parsed.results)) return parsed.results;
  } catch (_) {
    // مش JSON — تابع لمحاولة الـ regex تحت.
  }
  const names = [...text.matchAll(/"?name"?\s*[:=]\s*"([a-zA-Z0-9_]+)"/g)].map((m) => ({ name: m[1] }));
  return names;
}

// اختيار أفضل أداة من نتائج البحث حسب regex التطابق/الاستبعاد/الإلزام
// المُعرّفة لكل قدرة في TOOL_CAPABILITIES.
function pickBestCandidate(candidates, cfg) {
  const filtered = candidates.filter((c) => {
    if (!c.name || !cfg.nameHint.test(c.name)) return false;
    if (cfg.excludeHint && cfg.excludeHint.test(c.name)) return false;
    if (cfg.requireHint && !cfg.requireHint.test(c.name)) return false;
    return true;
  });
  return filtered[0] || null;
}

function parseAccountsListResult(text) {
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed.accounts || parsed.data || [];
    return list.map((a) => ({
      id: a._id || a.id || a.accountId,
      platform: a.platform,
      username: a.username || a.displayName,
    }));
  } catch (_) {
    return [];
  }
}

// دورة اكتشاف كاملة: session جديد → tools/list (لجلب schema بتاعة search_tools
// و call_tool نفسهم، وهما دول core tools بيترجعوا مباشرة) → search_tools مرة
// لكل قدرة محتاجينها من TOOL_CAPABILITIES → accounts_list لتخصيص الـ prompt.
// أي فشل جزئي (قدرة واحدة مش متلاقية) بيتسجل كـ warning من غير ما يوقف باقي
// الاكتشاف — degradation ناعم بدل فشل كامل.
async function discoverToolRegistry(env) {
  const sessionId = await mcpInitialize(env);
  const coreTools = await mcpListToolsPaginated(env, sessionId);
  const byName = new Map(coreTools.map((t) => [t.name, t]));
  const searchToolsMeta = byName.get("search_tools");
  const callToolMeta = byName.get("call_tool");

  const warnings = [];
  if (!searchToolsMeta || !callToolMeta) {
    warnings.push("مش لاقي search_tools أو call_tool ضمن الأدوات الأساسية من tools/list.");
  }

  const discovered = {};
  for (const [key, cfg] of Object.entries(TOOL_CAPABILITIES)) {
    const overrideName = cfg.overrideEnv && env[cfg.overrideEnv];
    if (overrideName) {
      discovered[key] = { name: overrideName, inputSchema: null, source: "override" };
      continue;
    }
    if (!searchToolsMeta) continue; // مفيش search_tools أصلاً، مش هينفع نكتشف حاجة
    try {
      const searchRes = await mcpCallTool(env, sessionId, "search_tools", { query: cfg.searchQuery });
      const candidates = parseSearchToolsResult(searchRes.text);
      const match = pickBestCandidate(candidates, cfg);
      if (match) {
        discovered[key] = { name: match.name, inputSchema: match.inputSchema || null, source: "search" };
      } else if (!cfg.optional) {
        warnings.push(`تعذّر اكتشاف أداة "${key}" — النتائج: ${candidates.map((c) => c.name).join(", ") || "(فاضية)"}`);
      }
    } catch (err) {
      if (!cfg.optional) warnings.push(`فشل البحث عن "${key}": ${err.message}`);
    }
  }

  let accounts = [];
  try {
    const accRes = await mcpCallTool(env, sessionId, "accounts_list", {});
    accounts = parseAccountsListResult(accRes.text);
  } catch (err) {
    warnings.push("تعذّر جلب accounts_list: " + err.message);
  }

  return {
    discoveredAt: isoNow(),
    callToolSchema: (callToolMeta && callToolMeta.inputSchema) || null,
    searchToolsSchema: (searchToolsMeta && searchToolsMeta.inputSchema) || null,
    coreToolCount: coreTools.length,
    tools: discovered,
    accounts,
    warnings,
  };
}

// الدالة العامة المستخدمة في باقي الكود: بتقرا من KV (لو موجود ومش منتهي —
// KV بيرجّع null تلقائي بعد انتهاء الـ TTL)، ولو مفيش، بتعمل اكتشاف جديد
// وتخزّنه.
async function getToolRegistry(env, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await kvGetJSON(env, "discovery:tools");
    if (cached) return cached;
  }
  const fresh = await discoverToolRegistry(env);
  await kvSetJSON(env, "discovery:tools", fresh, TOOL_CACHE_TTL_SECONDS);
  return fresh;
}

// -----------------------------------------------------------------------------
// 5) تنفيذ أدوات Zernio (الأفعال الفعلية: رد، رد خاص، إخفاء، DM)
// -----------------------------------------------------------------------------

// call_tool مش موثق شكل الـ arguments بتاعته بالظبط في التوثيق المتاح، فبنبني
// الـ arguments ديناميكيًا من الـ inputSchema الحقيقي بتاعه (لو متوفر من
// tools/list): بندوّر على property اسمها فيه "name" لحقن اسم الأداة الحقيقية،
// وproperty اسمها فيه "argument"/"param"/"input" لحقن الـ arguments. لو الـ
// schema مش متوفر (مثلاً وقت استخدام override يدوي)، بنستخدم الشكل القياسي
// {name, arguments} المطابق لشكل tools/call نفسه في بروتوكول MCP.
function buildCallToolArgs(callToolSchema, realToolName, realArgs) {
  const props = callToolSchema && callToolSchema.properties;
  if (!props) return { name: realToolName, arguments: realArgs || {} };

  const keys = Object.keys(props);
  const nameKey = keys.find((k) => /name/i.test(k)) || "name";
  const argsKey =
    keys.find((k) => /argument|param|input/i.test(k) && k !== nameKey) || "arguments";

  return { [nameKey]: realToolName, [argsKey]: realArgs || {} };
}

// نداء أداة مُكتشفة (long-tail) عن طريق call_tool. بيرجّع نفس شكل mcpCallTool
// العادي، زائد علم notDiscovered لو القدرة دي مش موجودة في الـ registry أصلاً.
async function callDiscoveredTool(env, sessionId, registry, capabilityKey, args) {
  const toolMeta = registry.tools[capabilityKey];
  if (!toolMeta) {
    return { ok: false, notDiscovered: true, text: `القدرة "${capabilityKey}" مش مكتشفة حاليًا.` };
  }
  const callArgs = buildCallToolArgs(registry.callToolSchema, toolMeta.name, args);
  return mcpCallTool(env, sessionId, "call_tool", callArgs);
}

// أداة core (من الـ ~50 الظاهرين دايمًا) بتتنادى مباشرة، من غير call_tool.
async function callCoreTool(env, sessionId, name, args) {
  return mcpCallTool(env, sessionId, name, args);
}

// --- الأفعال الفعلية: كل واحدة بتاخد الـ IDs من الكود (مش من الموديل) وتاخد
// النص/السبب من قرار Gemini بس. ده بيمنع أي احتمال إن الموديل "يخترع" ID غلط.

async function replyPublicly(env, sessionId, registry, { commentId, accountId, text }) {
  return callDiscoveredTool(env, sessionId, registry, "reply_publicly", {
    commentId,
    accountId,
    text,
  });
}

async function replyPrivately(env, sessionId, registry, { commentId, accountId, text }) {
  return callDiscoveredTool(env, sessionId, registry, "reply_privately", {
    commentId,
    accountId,
    text,
  });
}

async function hideComment(env, sessionId, registry, { commentId, accountId }) {
  return callDiscoveredTool(env, sessionId, registry, "hide_comment", {
    commentId,
    accountId,
  });
}

async function sendMessage(env, sessionId, registry, { conversationId, accountId, text }) {
  // التوثيق نفسه مش متسق على اسم الحقل (message ولا text) عبر صفحتين مختلفتين
  // — فبنبعت الاتنين سوا كحل احترازي، مفروض السيرفر يتجاهل أي حقل مش متعرف
  // عليه.
  return callDiscoveredTool(env, sessionId, registry, "send_message", {
    conversationId,
    accountId,
    text,
    message: text,
  });
}

async function getConversationHistory(env, sessionId, registry, { conversationId, accountId, limit = 6 }) {
  return callDiscoveredTool(env, sessionId, registry, "get_conversation_history", {
    conversationId,
    accountId,
    limit,
  });
}

async function sendTypingIndicator(env, sessionId, registry, { conversationId, accountId }) {
  // Best-effort بحت — أي فشل هنا متسجلش كخطأ رئيسي ومبيوقفش باقي المعالجة.
  try {
    return await callDiscoveredTool(env, sessionId, registry, "send_typing_indicator", {
      conversationId,
      accountId,
    });
  } catch (err) {
    return { ok: false, text: err.message };
  }
}

// -----------------------------------------------------------------------------
// 6) عميل Gemini (function calling)
// -----------------------------------------------------------------------------

function parseCommaList(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// بيبني كل تركيبات (مفتاح × موديل) للتبديل التلقائي عند quota/rate-limit.
function buildGeminiCombos(env) {
  const keys = parseCommaList(env.GEMINI_API_KEY);
  const models = parseCommaList(env.GEMINI_MODELS);
  const finalModels = models.length ? models : DEFAULT_GEMINI_MODELS;
  const combos = [];
  for (const model of finalModels) {
    for (const key of keys) combos.push({ key, model });
  }
  return combos;
}

// نداء Gemini بـ function calling إجباري (mode: ANY) — الموديل لازم يرجّع
// استدعاء دالة واحدة من اللي احنا حددناهاله، مفيش رد نصي حر.
async function callGeminiForDecision(env, systemInstruction, userContent, functionDeclarations) {
  const combos = buildGeminiCombos(env);
  if (!combos.length) throw new Error("مفيش GEMINI_API_KEY متظبط");

  let lastErr = null;
  for (const { key, model } of combos) {
    try {
      const url = `${GEMINI_API_BASE}/${model}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          tools: [{ functionDeclarations }],
          toolConfig: { functionCallingConfig: { mode: "ANY" } },
          generationConfig: { temperature: 0.4 },
        }),
      });

      if (res.status === 429 || res.status === 503) {
        lastErr = new Error(`Gemini ${res.status} على ${model} — بجرّب التالي`);
        continue; // quota/rate-limit — جرّب التركيبة التالية
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = await res.json();
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const fnPart = parts.find((p) => p.functionCall);
      if (fnPart) return { name: fnPart.functionCall.name, args: fnPart.functionCall.args || {} };

      // مفيش function call رغم mode:"ANY" — حالة نادرة، نرجّع do_nothing احترازي.
      const textPart = parts.find((p) => p.text);
      return { name: "do_nothing", args: { reason: "لم يرجع الموديل استدعاء دالة: " + (textPart ? textPart.text.slice(0, 200) : "") } };
    } catch (err) {
      lastErr = err;
      // خطأ حقيقي (مش quota) — لسه بنجرّب باقي التركيبات لو موجودة، لكن بنسجله.
      console.error("Gemini call failed", model, err.message);
    }
  }
  throw lastErr || new Error("كل تركيبات Gemini فشلت من غير سبب واضح");
}

// -----------------------------------------------------------------------------
// 7) معالجة الأحداث (تعليق / رسالة) — بناء السياق واتخاذ القرار والتنفيذ
// -----------------------------------------------------------------------------

// دوال ثابتة نتحكم فيها إحنا (مش أسماء Zernio الخام) — عشان الموديل يشتغل
// بواجهة بسيطة ومستقرة، والـ IDs التقنية (comment id, account id...) بتتحط
// من الكود مش من الموديل، يعني الموديل مايقدرش "يخترع" ID غلط.
const FUNCTION_DECLARATIONS_COMMENT = [
  {
    name: "reply_publicly",
    description: "رد علني يظهر تحت التعليق نفسه ويراه كل الناس.",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING", description: "نص الرد، بنفس لغة التعليق الوارد." } },
      required: ["text"],
    },
  },
  {
    name: "reply_privately",
    description:
      "رسالة خاصة تُرسل لصاحب التعليق بدل الرد العلني. استخدمها للمعلومات الحساسة زي السعر بالتفصيل أو رقم تليفون أو بيانات شخصية.",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING", description: "نص الرسالة الخاصة." } },
      required: ["text"],
    },
  },
  {
    name: "hide_comment",
    description: "إخفاء التعليق من العرض العام بدون أي رد — للتعليقات المسيئة أو السبام أو غير اللائقة.",
    parameters: {
      type: "OBJECT",
      properties: { reason: { type: "STRING", description: "سبب الإخفاء، لغرض السجل الداخلي فقط." } },
      required: ["reason"],
    },
  },
  {
    name: "do_nothing",
    description: "عدم اتخاذ أي إجراء — التعليق لا يستدعي ردًا (إعجاب بسيط، غموض، غير موجه كسؤال فعلي).",
    parameters: {
      type: "OBJECT",
      properties: { reason: { type: "STRING", description: "سبب عدم الرد." } },
      required: ["reason"],
    },
  },
];

const FUNCTION_DECLARATIONS_MESSAGE = [
  {
    name: "send_message",
    description: "إرسال رد نصي على الرسالة الواردة في نفس المحادثة.",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING", description: "نص الرد، بنفس لغة الرسالة الواردة." } },
      required: ["text"],
    },
  },
  {
    name: "do_nothing",
    description: "عدم الرد الآن — الرسالة غير واضحة كفاية لصياغة رد مسؤول، أو لا تحتاج ردًا فوريًا.",
    parameters: {
      type: "OBJECT",
      properties: { reason: { type: "STRING", description: "سبب عدم الرد." } },
      required: ["reason"],
    },
  },
];

function buildSystemInstruction(registry) {
  const accountsDesc =
    registry.accounts && registry.accounts.length
      ? registry.accounts.map((a) => `- ${a.platform}: @${a.username || a.id}`).join("\n")
      : "(لا توجد معلومات عن الحسابات المتصلة حاليًا)";

  return [
    "أنت مساعد يرد نيابةً عن صاحب الحساب على تعليقات ورسائل فيسبوك وانستجرام.",
    "الحسابات المتصلة:",
    accountsDesc,
    "",
    "تعليمات:",
    "- رُد بنفس لغة الرسالة/التعليق الوارد (عربي فصحى، عامية مصرية، أو إنجليزي حسب الوارد).",
    "- خليك ودود ومختصر ومحترف، من غير ردود طويلة أو رسمية زيادة عن اللزوم.",
    "- لو المحتوى مسيء أو سبام بوضوح، استخدم hide_comment بدل الرد عليه.",
    "- لو معلومات حساسة (سعر بالتفصيل، رقم تليفون، بيانات شخصية) اتطلبت في تعليق عام، فضّل reply_privately.",
    "- لو مش متأكد أو الرسالة/التعليق مش محتاج رد فعلي، استخدم do_nothing واذكر السبب بوضوح.",
    "- ما تختلقش معلومات عن منتج أو خدمة مش موجودة أصلاً في السياق اللي وصلك.",
  ].join("\n");
}

async function processCommentEvent(env, payload) {
  const { comment, post, account } = payload;
  const base = { kind: "comment", platform: account && account.platform, eventId: payload.id };

  if (!account || !SUPPORTED_PLATFORMS.has(account.platform)) {
    return { ...base, action: "skip", detail: "منصة غير مدعومة" };
  }
  if (comment.author && comment.author.isOwnAccount) {
    return { ...base, action: "skip", detail: "تعليق من الحساب نفسه (echo) — تم تجاهله لمنع الحلقة" };
  }

  const registry = await getToolRegistry(env);
  const sessionId = await mcpInitialize(env);

  const authorLabel = (comment.author && (comment.author.name || comment.author.username)) || "مستخدم";
  const contextText = [
    `نوع الحدث: تعليق جديد على منشور ${account.platform}.`,
    `اسم المعلّق: ${authorLabel}`,
    `نص التعليق: "${comment.text}"`,
    `سياق المنشور: ${(post && post.content) || "(غير معروف)"}`,
  ].join("\n");

  const decision = await callGeminiForDecision(
    env,
    buildSystemInstruction(registry),
    contextText,
    FUNCTION_DECLARATIONS_COMMENT
  );

  let result;
  switch (decision.name) {
    case "reply_publicly":
      result = await replyPublicly(env, sessionId, registry, {
        commentId: comment.id,
        accountId: account.id,
        text: decision.args.text,
      });
      break;
    case "reply_privately":
      result = await replyPrivately(env, sessionId, registry, {
        commentId: comment.id,
        accountId: account.id,
        text: decision.args.text,
      });
      break;
    case "hide_comment":
      result = await hideComment(env, sessionId, registry, { commentId: comment.id, accountId: account.id });
      break;
    case "do_nothing":
    default:
      result = { ok: true, text: "تم التجاهل: " + ((decision.args && decision.args.reason) || "") };
      break;
  }

  return { ...base, action: decision.name, decision: decision.args, ok: result.ok, detail: result.text };
}

async function processMessageEvent(env, payload) {
  const { message, account, conversation } = payload;
  const base = { kind: "message", platform: account && account.platform, eventId: payload.id };

  if (!account || !SUPPORTED_PLATFORMS.has(account.platform)) {
    return { ...base, action: "skip", detail: "منصة غير مدعومة" };
  }
  if (message.direction !== "incoming") {
    return { ...base, action: "skip", detail: "رسالة صادرة (ليست واردة) — تم تجاهلها" };
  }

  const registry = await getToolRegistry(env);
  const sessionId = await mcpInitialize(env);

  // مؤشر "بيكتب..." اختياري، best-effort، ما بيوقفش المعالجة لو فشل.
  sendTypingIndicator(env, sessionId, registry, {
    conversationId: message.conversationId,
    accountId: account.id,
  }).catch(() => {});

  let historyText = "";
  try {
    const history = await getConversationHistory(env, sessionId, registry, {
      conversationId: message.conversationId,
      accountId: account.id,
      limit: 6,
    });
    if (history.ok) historyText = history.text;
  } catch (_) {
    // فشل جلب التاريخ مش قاطع — نكمل بدون سياق تاريخي.
  }

  const senderLabel = (message.sender && (message.sender.name || message.sender.username)) || "مستخدم";
  const contextText = [
    `نوع الحدث: رسالة خاصة جديدة على ${account.platform}.`,
    `المرسل: ${senderLabel}`,
    `نص الرسالة: "${message.text || ""}"`,
    historyText ? `آخر رسائل المحادثة (للسياق فقط):\n${historyText}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const decision = await callGeminiForDecision(
    env,
    buildSystemInstruction(registry),
    contextText,
    FUNCTION_DECLARATIONS_MESSAGE
  );

  let result;
  if (decision.name === "send_message") {
    result = await sendMessage(env, sessionId, registry, {
      conversationId: message.conversationId,
      accountId: account.id,
      text: decision.args.text,
    });
  } else {
    result = { ok: true, text: "تم التجاهل: " + ((decision.args && decision.args.reason) || "") };
  }

  return { ...base, action: decision.name, decision: decision.args, ok: result.ok, detail: result.text };
}

// نقطة الدخول لمعالجة أي حدث webhook — بتوجّه حسب نوع الحدث، وأي خطأ غير
// متوقع بيتسجل بدل ما يطلع كـ exception غير مُمسوك جوه ctx.waitUntil.
async function handleZernioEvent(env, payload) {
  const eventType = payload.event;
  try {
    let outcome;
    if (eventType === "comment.received") {
      outcome = await processCommentEvent(env, payload);
    } else if (eventType === "message.received") {
      outcome = await processMessageEvent(env, payload);
    } else {
      outcome = { kind: "other", event: eventType, action: "logged-only" };
    }
    await logActivity(env, { ts: isoNow(), event: eventType, ...outcome });
  } catch (err) {
    console.error("handleZernioEvent failed", eventType, err);
    await logActivity(env, {
      ts: isoNow(),
      event: eventType,
      action: "error",
      ok: false,
      detail: err.message,
    });
  }
}

// -----------------------------------------------------------------------------
// 8) استقبال الـ webhook (تحقق توقيع + dedup + رد سريع + معالجة خلفية)
// -----------------------------------------------------------------------------

async function handleWebhook(request, env, ctx) {
  const rawBody = await request.text();

  const signature = request.headers.get("X-Zernio-Signature");
  if (!signature) return textResponse("No signature provided.", 401);
  if (!env.ZERNIO_WEBHOOK_SECRET) return textResponse("Server not configured (ZERNIO_WEBHOOK_SECRET).", 500);

  const computed = await hmacSha256Hex(env.ZERNIO_WEBHOOK_SECRET, rawBody);
  if (!safeEqualHex(computed, signature)) return textResponse("Invalid signature", 400);

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return textResponse("Invalid JSON body", 400);
  }

  // Dedup فوري (at-least-once delivery موثقة رسميًا من Zernio) — بنستخدم
  // X-Zernio-Event-Id لو موجود، وإلا payload.id.
  const eventId = request.headers.get("X-Zernio-Event-Id") || payload.id;
  if (eventId) {
    const dedupKey = `dedup:${eventId}`;
    const already = await env.ZERNIO_KV.get(dedupKey).catch(() => null);
    if (already) return jsonResponse({ ok: true, dedup: true });
    // بنسجل الـ dedup key فورًا (await، مش waitUntil) عشان لو محاولة تانية
    // وصلت خلال نفس الثواني القليلة تلاقيه مسجّل فعلاً.
    await env.ZERNIO_KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS }).catch(() => {});
  }

  // لازم رد 2xx خلال 5 ثواني وإلا Zernio هتعتبرها فشلت وتعيد المحاولة (جدول
  // إعادة محاولات يمتد لغاية ~51 ساعة). فبنرجّع الرد فورًا، والمعالجة الفعلية
  // (Gemini + أدوات Zernio) بتكمل في الخلفية عن طريق waitUntil.
  ctx.waitUntil(handleZernioEvent(env, payload));

  return jsonResponse({ ok: true });
}

// -----------------------------------------------------------------------------
// 9) صفحة الحالة "/"
// -----------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function listRecentLogs(env) {
  try {
    const listRes = await env.ZERNIO_KV.list({ prefix: "log:", limit: 1000 });
    const keys = listRes.keys.map((k) => k.name).sort().reverse().slice(0, LOG_LIST_LIMIT);
    const entries = await Promise.all(keys.map((k) => kvGetJSON(env, k)));
    return entries.filter(Boolean);
  } catch (err) {
    console.error("listRecentLogs failed", err);
    return [];
  }
}

function renderStatusHTML({ secretsOk, mcpStatus, toolsInfo, logs }) {
  const secretsRows = Object.entries(secretsOk)
    .map(([k, v]) => `<tr><td>${k}</td><td>${v ? "✅ متظبط" : "❌ ناقص"}</td></tr>`)
    .join("");

  const toolsRows = toolsInfo
    ? Object.entries(toolsInfo.tools)
        .map(([k, t]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.source)}</td></tr>`)
        .join("")
    : "";

  const missingCapabilities = toolsInfo
    ? Object.keys(TOOL_CAPABILITIES).filter((k) => !TOOL_CAPABILITIES[k].optional && !toolsInfo.tools[k])
    : [];

  const warningsList = [...((toolsInfo && toolsInfo.warnings) || [])];
  if (missingCapabilities.length) {
    warningsList.push("قدرات غير مكتشفة حاليًا: " + missingCapabilities.join(", "));
  }
  const warningsHtml = warningsList.length
    ? `<div class="warn"><strong>تحذيرات:</strong><ul>${warningsList.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`
    : "";

  const accountsHtml =
    toolsInfo && toolsInfo.accounts && toolsInfo.accounts.length
      ? toolsInfo.accounts.map((a) => `${escapeHtml(a.platform)}: @${escapeHtml(a.username || a.id)}`).join("<br>")
      : "(لا يوجد)";

  const logsRows = logs
    .map(
      (l) => `
    <tr>
      <td>${escapeHtml(l.ts)}</td>
      <td>${escapeHtml(l.event || l.kind || "")}</td>
      <td>${escapeHtml(l.action || "")}</td>
      <td>${l.ok === false ? "❌" : "✅"}</td>
      <td>${escapeHtml((l.detail || "").toString().slice(0, 200))}</td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>حالة Zernio Social Inbox Agent</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Tahoma, sans-serif; background:#0b0d12; color:#e6e6e6; margin:0; padding:24px; }
  h1 { font-size: 20px; }
  h2 { font-size:16px; margin-top:32px; border-bottom:1px solid #2a2e3a; padding-bottom:6px; }
  table { width:100%; border-collapse: collapse; margin-top:8px; font-size:13px; }
  td, th { padding:6px 10px; border-bottom:1px solid #1e2230; text-align:right; vertical-align:top; }
  .warn { background:#332200; border:1px solid #665500; padding:10px; border-radius:8px; margin-top:12px; font-size:13px; }
  .card { background:#12141c; border:1px solid #22263a; border-radius:12px; padding:16px; margin-top:12px; }
  code { background:#1c2030; padding:2px 6px; border-radius:4px; }
</style>
</head>
<body>
  <h1>🩺 حالة Zernio Social Inbox Agent</h1>

  <h2>الأسرار</h2>
  <div class="card"><table>${secretsRows}</table></div>

  <h2>اتصال Zernio MCP</h2>
  <div class="card">
    <p>الحالة: <code>${escapeHtml(mcpStatus)}</code></p>
    <p>الحسابات المتصلة:<br>${accountsHtml}</p>
    ${toolsInfo ? `<table><tr><th>القدرة</th><th>الأداة المكتشفة</th><th>المصدر</th></tr>${toolsRows}</table>` : ""}
    ${warningsHtml}
  </div>

  <h2>آخر ${logs.length} حدث</h2>
  <div class="card">
    <table>
      <tr><th>الوقت</th><th>الحدث</th><th>الإجراء</th><th>نجح؟</th><th>تفاصيل</th></tr>
      ${logsRows || "<tr><td colspan='5'>لا يوجد أحداث بعد</td></tr>"}
    </table>
  </div>
</body>
</html>`;
}

async function handleStatusPage(request, env) {
  const url = new URL(request.url);
  if (env.STATUS_KEY) {
    const key = url.searchParams.get("key");
    if (key !== env.STATUS_KEY) return textResponse("Unauthorized. ضيف ?key=... في الرابط.", 401);
  }

  const secretsOk = {
    ZERNIO_API_KEY: !!env.ZERNIO_API_KEY,
    ZERNIO_WEBHOOK_SECRET: !!env.ZERNIO_WEBHOOK_SECRET,
    GEMINI_API_KEY: !!env.GEMINI_API_KEY,
  };

  let mcpStatus = "غير معروف";
  let toolsInfo = null;
  try {
    toolsInfo = await getToolRegistry(env);
    mcpStatus = `متصل — ${toolsInfo.coreToolCount} أداة أساسية، اكتُشف ${Object.keys(toolsInfo.tools).length}/${Object.keys(TOOL_CAPABILITIES).length} قدرة، آخر تحديث ${toolsInfo.discoveredAt}`;
  } catch (err) {
    mcpStatus = "فشل الاتصال: " + err.message;
  }

  const logs = await listRecentLogs(env);
  return htmlResponse(renderStatusHTML({ secretsOk, mcpStatus, toolsInfo, logs }));
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

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
        return await handleStatusPage(request, env);
      }

      // Endpoint اختياري صغير لإجبار إعادة اكتشاف الأدوات يدويًا من غير
      // انتظار انتهاء الـ TTL — مفيد بعد أي تغيير عند Zernio.
      if (request.method === "GET" && url.pathname === "/api/rediscover") {
        if (env.STATUS_KEY && url.searchParams.get("key") !== env.STATUS_KEY) {
          return textResponse("Unauthorized", 401);
        }
        const registry = await getToolRegistry(env, { forceRefresh: true });
        return jsonResponse({ ok: true, registry });
      }

      return textResponse("Not found", 404);
    } catch (err) {
      console.error("Unhandled fetch error", err);
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },
};
