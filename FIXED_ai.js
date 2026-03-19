require("dotenv").config();

const axios = require("axios");

const DEFAULT_MODEL = "tinyllama:latest";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_HISTORY_ITEMS = 3;
const MAX_TEXT_LENGTH = 200;
const CACHE_MAX = 50;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const replyCache = new Map();
const FALLBACK_REPLY_TEXT = "AI is temporarily unavailable. Please try again.";
const CONNECTION_REPLY_TEXT =
  "I can't reach the AI engine. Please start Ollama and try again.";
const TIMEOUT_REPLY_TEXT =
  "The AI took too long to respond. Please try a shorter question.";

function isDebugEnabled() {
  return String(process.env.DEBUG || "").trim().toLowerCase() === "true";
}

function debugAiLog(...args) {
  if (isDebugEnabled()) {
    console.log(...args);
  }
}

function previewText(value, maxLength = 180) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}... [${normalized.length} chars]`;
}

function getBaseUrl() {
  return String(process.env.OLLAMA_BASE_URL || "http://localhost:11434").trim();
}

function getRequestTimeoutMs() {
  const parsedTimeout = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS, 10);
  return Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_TIMEOUT_MS;
}

const LANGUAGE_LABELS = {
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  ja: "Japanese",
};

const LANGUAGE_ALIASES = {
  de: "de",
  german: "de",
  "de-de": "de",
  en: "en",
  english: "en",
  "en-us": "en",
  es: "es",
  spanish: "es",
  "es-es": "es",
  fr: "fr",
  french: "fr",
  "fr-fr": "fr",
  hi: "hi",
  hindi: "hi",
  "hi-in": "hi",
  ja: "ja",
  japanese: "ja",
  "ja-jp": "ja",
};

function getModel() {
  return String(process.env.OLLAMA_MODEL || DEFAULT_MODEL).trim();
}

function normalizeMode(mode) {
  const normalized = String(mode || "assistant")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");

  if (
    normalized === "assistant" ||
    normalized === "tutor" ||
    normalized === "translator" ||
    normalized === "customer-support"
  ) {
    return normalized;
  }

  return "assistant";
}

function normalizeLanguage(language) {
  const normalized = String(language || "en")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");

  return LANGUAGE_ALIASES[normalized] || "en";
}

function formatLanguage(language) {
  return LANGUAGE_LABELS[normalizeLanguage(language)] || "English";
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((item) => item && typeof item.text === "string")
    .slice(-MAX_HISTORY_ITEMS)
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      text: item.text.trim().slice(0, 240),
    }))
    .filter((item) => item.text);
}

function getCacheKey(text, mode, language) {
  return `${normalizeMode(mode)}:${normalizeLanguage(language)}:${text.toLowerCase().trim().slice(0, 80)}`;
}

function buildSystemPrompt({ language, mode, targetLanguage }) {
  const resolvedMode = normalizeMode(mode);
  const responseLanguage = formatLanguage(language);
  const targetLang = formatLanguage(targetLanguage);

  if (resolvedMode === "tutor") {
    return `You are a teacher. Explain simply in ${responseLanguage}. Be brief.`;
  }

  if (resolvedMode === "translator") {
    return `Translate to ${targetLang} only. Return translation only.`;
  }

  if (resolvedMode === "customer-support") {
    return `You are support. Reply short and calm in ${responseLanguage}.`;
  }

  return `You are a helpful assistant. Reply in ${responseLanguage}. Be brief.`;
}

function buildPrompt({ history, language, mode, targetLanguage, text }) {
  const safeText = String(text || "").trim().slice(0, MAX_TEXT_LENGTH);
  const normalizedHistory = normalizeHistory(history);
  const sections = [buildSystemPrompt({ language, mode, targetLanguage })];

  for (const item of normalizedHistory) {
    const speaker = item.role === "assistant" ? "Assistant" : "User";
    sections.push(`${speaker}: ${item.text}`);
  }

  sections.push(`User: ${safeText}`);

  return sections.join("\n");
}

function extractResponseText(response) {
  const text = String(response?.data?.response || "").trim();
  return text || FALLBACK_REPLY_TEXT;
}

function formatErrorData(value) {
  if (value === undefined) {
    return undefined;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

async function generateReply({
  text,
  history,
  mode,
  language,
  targetLanguage,
}) {
  const cacheKey = getCacheKey(text, mode, language);
  const cached = replyCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    debugAiLog('[AI] Cache hit');
    return cached.text;
  }

  const prompt = buildPrompt({
    history,
    language,
    mode,
    targetLanguage,
    text,
  });
  const model = getModel();
  const baseUrl = getBaseUrl();
  const ollamaUrl = `${baseUrl.replace(/\/$/, "")}/api/generate`;
  const requestTimeoutMs = getRequestTimeoutMs();
  const resolvedHistory = normalizeHistory(history);
  const resolvedMode = normalizeMode(mode);
  const provider = String(process.env.AI_PROVIDER || "ollama").trim() || "ollama";

  try {
    debugAiLog("AI PROVIDER", provider);
    debugAiLog("MODE", resolvedMode);
    debugAiLog("TEXT", previewText(text));
    debugAiLog("HISTORY LENGTH", resolvedHistory.length);
    debugAiLog("PROMPT", previewText(prompt));
    debugAiLog("MODEL", model);
    debugAiLog("BASE_URL", baseUrl);
    debugAiLog("CALLING OLLAMA");

    const res = await axios.post(
      ollamaUrl,
      {
        model: model,
        prompt: prompt,
        stream: false,
        options: {
          num_predict: 80,
          num_ctx: 512,
          temperature: 0.7,
          top_k: 20,
          top_p: 0.8,
          repeat_penalty: 1.1,
        },
      },
      {
        timeout: requestTimeoutMs,
      }
    );

    debugAiLog("OLLAMA RESPONSE OK");
    const replyText = extractResponseText(res);

    // Cache success
    if (replyCache.size >= CACHE_MAX) {
      const firstKey = replyCache.keys().next().value;
      replyCache.delete(firstKey);
    }
    replyCache.set(cacheKey, { text: replyText, ts: Date.now() });

    return typeof replyText === "string" && replyText.trim()
      ? replyText
      : FALLBACK_REPLY_TEXT;
  } catch (error) {
    const errMsg = error?.code || error?.message || "unknown";
    const errStatus = error?.response?.status || "no-response";
    console.error(`[AI] Ollama call failed — code:${errMsg} status:${errStatus}`);
    console.error(
      "[AI DEBUG] Full error:",
      error?.message,
      error?.code,
      error?.response?.status,
      error?.response?.data
    );
    debugAiLog("OLLAMA ERROR", error.message);
    debugAiLog("OLLAMA ERROR RESPONSE", formatErrorData(error?.response?.data));

    if (error?.response?.status === 404) {
      return `AI model not found. Please run: ollama pull ${model}`;
    }

    if (
      error?.code === "ECONNREFUSED" ||
      error?.code === "EHOSTUNREACH" ||
      error?.code === "ENOTFOUND"
    ) {
      return CONNECTION_REPLY_TEXT;
    }

    if (
      error?.code === "ETIMEDOUT" ||
      error?.code === "ECONNABORTED" ||
      /timeout/i.test(String(error?.message || ""))
    ) {
      return TIMEOUT_REPLY_TEXT;
    }

    return FALLBACK_REPLY_TEXT;
  }
}

function isAiFailureReply(text) {
  const normalized = String(text || "").trim();

  return (
    normalized === FALLBACK_REPLY_TEXT ||
    normalized === CONNECTION_REPLY_TEXT ||
    normalized === TIMEOUT_REPLY_TEXT ||
    normalized.startsWith("AI model not found. Please run: ollama pull ")
  );
}

module.exports = {
  CONNECTION_REPLY_TEXT,
  FALLBACK_REPLY_TEXT,
  TIMEOUT_REPLY_TEXT,
  generateReply,
  getRequestTimeoutMs,
  isAiFailureReply,
};
**FILE COMPLETE** ✅ services/ai.js

1. FIXED: Prompt size (history 3, text 200, brief prompts, no "history:" label)
2. FIXED: Ollama options (num_predict 80, num_ctx 512, etc.)
3. DEFAULT_MODEL = "tinyllama:latest" 
4. FIXED: Cache (50 entries, 5min TTL)

**Next .env**:
```
OLLAMA_MODEL=tinyllama:latest
```
(Added full .env if missing)

**Speed expected**: 1-3s tinyllama, 4-8s phi3, cache <50ms
