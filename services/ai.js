require("dotenv").config();

const axios = require("axios");

const DEFAULT_MODEL = "tinyllama:latest";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_HISTORY_ITEMS = 1;  // keep minimal — reduces stale-context hallucinations
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
  const isTutor = resolvedMode === 'tutor';
  const isTranslator = resolvedMode === 'translator';
  const lang = formatLanguage(language);

  // ── TUTOR MODE ──────────────────────────────────────────────
  if (resolvedMode === 'tutor') {
    return [
      `You are a teacher explaining to a curious 10-year-old child.`,
      `Always reply in ${lang}.`,
      `RULES YOU MUST FOLLOW:`,
      `- Use the simplest words possible.`,
      `- Give exactly ONE real-world analogy to explain the concept.`,
      `- Maximum 3 short sentences total.`,
      `- Never use technical jargon without explaining it first.`,
      `- Never use bullet points or numbered lists.`,
      `- Never start your reply with "Tutor:" or "Teacher:" or "Assistant:".`,
      `- Sound warm and encouraging like a friendly teacher.`,
      `Example good response to "what is gravity":`,
      `"Gravity is like an invisible magnet inside the Earth that pulls everything toward it. That's why when you drop a ball, it always falls down instead of floating up."`,
    ].join(' ');
  }

  // ── TRANSLATOR MODE ──────────────────────────────────────────
  if (resolvedMode === 'translator') {
    const fromLang = formatLanguage(language);
    const toLang = formatLanguage(targetLanguage) || formatLanguage(language);
    return [
      `You are a translation machine. Your ONLY job is to translate text.`,
      `Translate from ${fromLang} to ${toLang}.`,
      `STRICT RULES:`,
      `- Output ONLY the translated text.`,
      `- Do NOT add any explanation.`,
      `- Do NOT say "Translation:" or "Here is the translation".`,
      `- Do NOT add extra sentences before or after.`,
      `- Do NOT say "I translated this from..." or anything similar.`,
      `- If the input is already in ${toLang}, just output it as-is.`,
      `Example: Input "Hello" → Output "Hola" (if translating to Spanish).`,
      `Nothing else. Just the translation.`,
    ].join(' ');
  }

  // ── CUSTOMER SUPPORT MODE ────────────────────────────────────
  if (resolvedMode === 'customer-support') {
    return [
      `You are a friendly customer support agent for VOS Voice Assistant.`,
      `Always reply in ${lang}.`,
      `RULES YOU MUST FOLLOW:`,
      `- Start by acknowledging the customer's concern with empathy.`,
      `- Give exactly ONE clear actionable solution or next step.`,
      `- Maximum 2 sentences.`,
      `- Be warm, calm, and professional.`,
      `- Never use bullet points or lists.`,
      `- Never start with "Support:" or "Agent:" or "Assistant:".`,
      `- If you don't know the answer, say "I'll look into that for you right away."`,
      `Example good response to "my audio is not working":`,
      `"I'm sorry to hear that! Please try refreshing the page and checking your browser's microphone permissions."`,
    ].join(' ');
  }

  // ── ASSISTANT MODE (default) ──────────────────────────────────
  return [
    `IMPORTANT: Reply in English only. Never use French or any other language.`,
    `You are VOS, a helpful voice assistant.`,
    `Reply in ${lang}.`,
    `Answer directly. 1-2 sentences max. No bullets. No markdown.`,
    `Never ask questions back. Never say you are an AI or introduce yourself.`,
    `If you cannot do something say: I cannot do that.`,
    `Never roleplay. Never write fake conversations.`,
  ].join(' ');
}


function buildPrompt({ history, language, mode, targetLanguage, text }) {
  const safeText = String(text || '').trim().slice(0, MAX_TEXT_LENGTH);
  const normalizedHistory = normalizeHistory(history);

  // For translator: skip history entirely — just translate the text
  if (normalizeMode(mode) === 'translator') {
    const systemPrompt = buildSystemPrompt({ language, mode, targetLanguage });
    return `${systemPrompt}\n\nText to translate: ${safeText}\nTranslation:`;
  }

  const systemPrompt = buildSystemPrompt({ language, mode, targetLanguage });

  const parts = [systemPrompt];

  if (normalizedHistory.length > 0) {
    for (const item of normalizedHistory) {
      // Clean any leaked prefixes from history
      const cleanText = item.text
        .replace(/^(Assistant:|VOS:|User:|Human:|Me:)\s*/gi, '')
        .trim();
      if (item.role === 'assistant') {
        parts.push(`VOS: ${cleanText}`);
      } else {
        parts.push(`Human: ${cleanText}`);
      }
    }
  }

  parts.push(`\nHuman: ${safeText}`);
  parts.push('VOS:'); // Model completes naturally from here

  return parts.join('\n');
}


function extractResponseText(response, mode) {
  const rawText = String(response?.data?.response || '').trim();
  let text = rawText;
  if (!text) return FALLBACK_REPLY_TEXT;

  // Remove role prefixes model may have echoed
  text = text.replace(/^(VOS:|Assistant:|Human:|User:|Me:|Interlocutor:|Speaker:|Bot:)\s*/gi, '').trim();

  // Remove all markdown formatting (not voice-friendly)
  text = text
    .replace(/\*\*(.*?)\*\*/g, '$1')   // bold
    .replace(/\*(.*?)\*/g, '$1')        // italic
    .replace(/__(.*?)__/g, '$1')        // underline
    .replace(/#{1,6}\s/g, '')           // headers
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^\s*[-*•]\s+/gm, '')     // bullet points
    .replace(/^\s*\d+\.\s+/gm, '')     // numbered lists
    .trim();

  // If the model echoed instructions, keep first line
  if (/\n/.test(text) && /(RULES YOU MUST FOLLOW|guidelines)/i.test(text)) {
    text = text.split(/\n+/).map((t) => t.trim()).filter(Boolean)[0] || text;
  }

  // Cut off at first fake conversation line
  const cutoff = text.search(/\n+(Human:|User:|Me:|Assistant:)/i);
  if (cutoff > 0) text = text.slice(0, cutoff).trim();

  // Remove incomplete sentence at end (model cutoff by num_predict)
  const lastEnd = Math.max(
    text.lastIndexOf('.'),
    text.lastIndexOf('!'),
    text.lastIndexOf('?')
  );
  if (lastEnd > text.length * 0.4 && lastEnd < text.length - 3) {
    text = text.slice(0, lastEnd + 1).trim();
  }

  // For translator: strip any explanation that leaked through
  if (mode === 'translator') {
    const idx = rawText.toLowerCase().rfind('translation:');
    if (idx >= 0) {
      text = rawText.slice(idx + 'translation:'.length).trim();
    }
    // Strip common translation prefixes tinyllama adds
    text = text
      .replace(/^(Translation:|Translated:|In \w+:|The translation is:?)\s*/gi, '')
      .trim();

    // Remove anything after the first sentence or newline
    const firstBreak = text.search(/[.!?\n]/);
    if (firstBreak > 0 && firstBreak < text.length - 1) {
      text = text.slice(0, firstBreak + 1).trim();
    }
  }

  // Reject clearly wrong responses (French spam, roleplay, bad preambles, etc.)
  const REJECT_PATTERNS = [
    /Nous vous/i,
    /Pour plus d.information/i,
    /cliquez sur le bouton/i,
    /notre gamme de produits/i,
    /produits en ligne/i,
    /\b(Bonjour|Bonsoir|Merci|Voici|Voil\u00e0)\b/,
    /^(VOS:|AI:|Assistant:|Interlocutor:|Speaker:|Bot:)\s*(Certainly|Sure|Of course|Hello|Hi there|I'm a)/i,
    /^Interlocutor:/i,
    /^(Hi there,?\s+I'm|Hello,?\s+I'm)\s+(a |an )?(?:friendly |helpful )?AI/i,
    /Can you tell me more about/i,
  ];
  if (REJECT_PATTERNS.some(p => p.test(text))) {
    console.warn('[AI] Rejected bad response:', text.slice(0, 80));
    return "I'm not sure about that. Could you rephrase your question?";
  }

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
    const code = error?.code || 'UNKNOWN';
    const status = error?.response?.status;
    console.error(`[AI] Failed — ${code} ${status || ''}: ${error?.message}`);

    if (code === 'ECONNREFUSED') {
      return 'Ollama is not running. Please start it with: ollama serve';
    }
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
      return 'The AI took too long. Please try a shorter question.';
    }
    if (status === 404) {
      return `Model not found. Please run: ollama pull ${getModel()}`;
    }
    return 'I could not process that. Please try again.';
  }
}


async function generateReply({
  text,
  history,
  mode,
  language,
  targetLanguage,
}) {
  const resolvedMode = normalizeMode(mode);
  const isTutor = resolvedMode === 'tutor';
  const isTranslator = resolvedMode === 'translator';
  const normalizedInput = String(text || '').trim().toLowerCase();
  if (resolvedMode === 'assistant' && ['hey', 'hi', 'hello', 'hey there', 'hello there'].includes(normalizedInput)) {
    return 'Hey! How can I help you?';
  }


  const cacheKey = getCacheKey(text, mode, language);
  const cached = replyCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    debugAiLog('[AI] Cache hit');
    const cleaned = String(cached.text || '')
      .trim()
      .replace(/^(Assistant:|VOSSAI:|VOS:|User:|Human:|Me:)\s*/gi, '')
      .trim()
      .replace(/\*\*|\*|__|`/g, '')
      .trim()
      .replace(/^#+\s*/g, '')
      .trim()
      .replace(/^Conversation:\s*/i, '')
      .trim();
    return cleaned || cached.text;
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

    let res;
    try {
      res = await axios.post(
        ollamaUrl,
        {
          model: model,
          prompt: prompt,
          stream: false,
          options: {
            stop: ["Human:", "\nHuman:", "User:", "\nUser:", "Me:", "\nMe:", "VOS:", "\nVOS:", "Text to translate:", "Customer:", "Agent:", "Teacher:", "Tutor:", "Support:"],
            num_predict: isTranslator ? 40 : isTutor ? 120 : 80,
            temperature: isTranslator ? 0.1 : 0.7,
            repeat_penalty: 1.15,
            top_k: isTranslator ? 5 : 20,
            top_p: isTranslator ? 0.5 : 0.8,
            num_ctx: 512
          }
        },
        {
          timeout: requestTimeoutMs,
        }
      );
    } catch (e) {
      e.step = 'ollama-call';
      throw e;
    }

    debugAiLog("OLLAMA RESPONSE OK");
    const replyText = extractResponseText(res, resolvedMode);

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
