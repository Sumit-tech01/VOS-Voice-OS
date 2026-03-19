const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const DEFAULT_BASE_DIR = path.join(__dirname, "..", "data", "memory");
const DEFAULT_MAX_TURNS = 16;

const SUPPORTED_MODES = new Set([
  "assistant",
  "tutor",
  "translator",
  "customer-support",
]);

const LANGUAGE_ALIASES = {
  de: "de",
  german: "de",
  "de-de": "de",
  "de de": "de",
  en: "en",
  english: "en",
  "en-us": "en",
  "en us": "en",
  es: "es",
  spanish: "es",
  "es-es": "es",
  "es es": "es",
  fr: "fr",
  french: "fr",
  "fr-fr": "fr",
  "fr fr": "fr",
  hi: "hi",
  hindi: "hi",
  "hi-in": "hi",
  "hi in": "hi",
  ja: "ja",
  japanese: "ja",
  "ja-jp": "ja",
  "ja jp": "ja",
};

let defaultMemoryService = null;

function isDebugEnabled() {
  return String(process.env.DEBUG || "").trim().toLowerCase() === "true";
}

function debugMemoryLog(...args) {
  if (isDebugEnabled()) {
    console.log(...args);
  }
}

function logMemoryFailure(label, error, sessionId) {
  debugMemoryLog(label, {
    message: error?.message || String(error || "Unknown memory error"),
    sessionId: sanitizeSessionId(sessionId),
  });
}

function sanitizeSessionId(sessionId) {
  return String(sessionId || "anonymous-session")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 120);
}

function normalizeMode(mode) {
  const normalized = String(mode || "assistant")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");

  return SUPPORTED_MODES.has(normalized) ? normalized : "assistant";
}

function normalizeLanguage(language) {
  const normalized = String(language || "en")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");

  return LANGUAGE_ALIASES[normalized] || "en";
}

function buildDefaultSession(sessionId, overrides = {}) {
  const safeSessionId = sanitizeSessionId(sessionId);
  const now = new Date().toISOString();
  const mode = normalizeMode(overrides.mode || "assistant");
  const language = normalizeLanguage(overrides.language || "en");
  const targetLanguage = normalizeLanguage(
    overrides.targetLanguage || overrides.language || language
  );
  const lastReply = String(
    overrides.lastReply ?? overrides.lastAssistantResponse ?? ""
  ).trim();

  return {
    createdAt: now,
    history: [],
    language,
    lastAssistantResponse: lastReply,
    lastAudioUrl: null,
    lastReply,
    mode,
    sessionId: safeSessionId,
    targetLanguage,
    timestamp: now,
    updatedAt: now,
  };
}

function stripRolePrefixes(text) {
  return String(text || "")
    .replace(/^(Assistant:|VOS:|User:|Human:|Me:)\s*/gi, "")
    .trim();
}

function getSessionFilePath(baseDir, sessionId) {
  return path.join(baseDir, `${sanitizeSessionId(sessionId)}.json`);
}

function normalizeTurn(turn, session) {
  const text = String(turn?.text || "").trim();

  if (!text) {
    return null;
  }

  return {
    id: String(turn?.id || crypto.randomUUID()),
    intent: turn?.intent || "conversation",
    language: normalizeLanguage(turn?.language || session.language),
    mode: normalizeMode(turn?.mode || session.mode),
    provider: turn?.provider || null,
    role: turn?.role === "assistant" ? "assistant" : "user",
    source: turn?.source || "voice",
    text,
    timestamp: turn?.timestamp || new Date().toISOString(),
  };
}

function toConversationHistory(history, maxTurns = DEFAULT_MAX_TURNS) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((item) => item && item.role && typeof item.text === "string")
    // Bug 3 fix: exclude computer-action turns from AI context
    .filter((item) => item.intent !== 'computer-action')
    .slice(-maxTurns)
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      text: item.text,
    }));
}

function normalizeSession(sessionId, raw = {}, maxTurns = DEFAULT_MAX_TURNS) {
  const defaults = buildDefaultSession(sessionId);
  const safeSessionId = sanitizeSessionId(sessionId);
  const baseSession = {
    ...defaults,
    ...raw,
    language: normalizeLanguage(raw.language || defaults.language),
    mode: normalizeMode(raw.mode || defaults.mode),
    sessionId: safeSessionId,
    targetLanguage: normalizeLanguage(
      raw.targetLanguage || raw.language || defaults.targetLanguage
    ),
  };

  const history = Array.isArray(raw.history)
    ? raw.history
        .map((item) => normalizeTurn(item, baseSession))
        .filter(Boolean)
        .slice(-maxTurns)
    : [];

  const lastAssistantTurn = [...history].reverse().find((item) => item.role === "assistant");
  const lastReply = String(
    raw.lastReply ??
      raw.lastAssistantResponse ??
      lastAssistantTurn?.text ??
      defaults.lastReply
  ).trim();
  const timestamp = raw.timestamp || raw.updatedAt || defaults.timestamp;

  return {
    ...baseSession,
    history,
    lastAssistantResponse: lastReply,
    lastReply,
    timestamp,
    updatedAt: raw.updatedAt || timestamp,
  };
}

function toPersistedSession(sessionId, raw = {}, maxTurns = DEFAULT_MAX_TURNS) {
  const session = normalizeSession(sessionId, raw, maxTurns);

  return {
    createdAt: session.createdAt,
    history: session.history.slice(-maxTurns),
    language: session.language,
    lastAudioUrl: session.lastAudioUrl || null,
    lastAssistantResponse: session.lastAssistantResponse,
    lastReply: session.lastReply,
    mode: session.mode,
    sessionId: session.sessionId,
    targetLanguage: session.targetLanguage,
    timestamp: session.timestamp,
    updatedAt: session.updatedAt,
  };
}

function summarizeSession(session) {
  const normalizedSession = normalizeSession(session?.sessionId, session);
  const history = normalizedSession.history;
  const lastTurn = history.at(-1) || null;
  const assistantTurns = history.filter((item) => item.role === "assistant").length;
  const userTurns = history.filter((item) => item.role === "user").length;

  return {
    assistantTurns,
    hasAudio: Boolean(normalizedSession.lastAudioUrl),
    language: normalizedSession.language,
    lastIntent: lastTurn?.intent || "conversation",
    lastSource: lastTurn?.source || null,
    lastUpdatedAt: normalizedSession.timestamp,
    mode: normalizedSession.mode,
    sessionId: normalizedSession.sessionId,
    targetLanguage: normalizedSession.targetLanguage,
    turnCount: history.length,
    userTurns,
  };
}

function createMemoryService({
  baseDir = DEFAULT_BASE_DIR,
  maxTurns = DEFAULT_MAX_TURNS,
} = {}) {
  const sessionLocks = new Map();

  async function ensureBaseDir() {
    try {
      await fs.mkdir(baseDir, { recursive: true });
      return true;
    } catch (error) {
      logMemoryFailure("MEMORY BASE DIR ERROR", error, "base-dir");
      return false;
    }
  }

  function buildSafeSession(sessionId, overrides = {}, error = null) {
    const session = normalizeSession(sessionId, overrides, maxTurns);

    if (error) {
      logMemoryFailure("MEMORY SAFE FALLBACK", error, sessionId);
    }

    debugMemoryLog("SESSION CREATE", sanitizeSessionId(sessionId));
    debugMemoryLog("HISTORY SIZE", session.history.length);
    debugMemoryLog("MODE", session.mode);
    debugMemoryLog("LANGUAGE", session.language);
    return session;
  }

  async function readSession(sessionId) {
    const safeSessionId = sanitizeSessionId(sessionId);
    const baseDirReady = await ensureBaseDir();

    if (!baseDirReady) {
      return buildSafeSession(safeSessionId);
    }

    const filePath = getSessionFilePath(baseDir, safeSessionId);

    try {
      const raw = await fs.readFile(filePath, "utf8");
      try {
        const session = normalizeSession(safeSessionId, JSON.parse(raw), maxTurns);
        debugMemoryLog("SESSION LOAD", safeSessionId);
        debugMemoryLog("HISTORY SIZE", session.history.length);
        debugMemoryLog("MODE", session.mode);
        debugMemoryLog("LANGUAGE", session.language);
        return session;
      } catch (parseError) {
        debugMemoryLog("SESSION PARSE ERROR", parseError.message);
        console.error('[MEMORY] Corrupt file, resetting:', filePath);
        await fs.unlink(filePath).catch(() => {});
        return buildSafeSession(safeSessionId, {}, parseError);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        return buildSafeSession(safeSessionId);
      }

      return buildSafeSession(safeSessionId, {}, error);
    }
  }

  async function writeSession(sessionId, session) {
    const safeSessionId = sanitizeSessionId(sessionId);
    const baseDirReady = await ensureBaseDir();
    const filePath = getSessionFilePath(baseDir, safeSessionId);
    const tempPath = `${filePath}.tmp`;
    const normalized = toPersistedSession(safeSessionId, session, maxTurns);

    if (!baseDirReady) {
      return normalizeSession(safeSessionId, normalized, maxTurns);
    }

    try {
      await fs.writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf8");
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      return buildSafeSession(safeSessionId, normalized, error);
    }
    debugMemoryLog("SESSION SAVE", {
      filePath,
      sessionId: safeSessionId,
    });
    debugMemoryLog("HISTORY SIZE", normalized.history.length);
    debugMemoryLog("MODE", normalized.mode);
    debugMemoryLog("LANGUAGE", normalized.language);

    return normalizeSession(safeSessionId, normalized, maxTurns);
  }

  async function withLock(sessionId, callback) {
    const safeSessionId = sanitizeSessionId(sessionId);
    const previous = sessionLocks.get(safeSessionId) || Promise.resolve();
    const next = previous.catch(() => {}).then(callback);

    sessionLocks.set(
      safeSessionId,
      next.finally(() => {
        if (sessionLocks.get(safeSessionId) === next) {
          sessionLocks.delete(safeSessionId);
        }
      })
    );

    try {
      return await next;
    } catch (error) {
      return buildSafeSession(safeSessionId, {}, error);
    }
  }

  async function getSession(sessionId) {
    return readSession(sessionId);
  }

  async function saveSession(sessionId, data = {}) {
    return withLock(sessionId, async () => {
      const safeSessionId = sanitizeSessionId(sessionId);
      const current = await readSession(safeSessionId);
      const history =
        data.history === undefined
          ? current.history
          : Array.isArray(data.history)
            ? data.history
            : current.history;
      const now = new Date().toISOString();

      return writeSession(safeSessionId, {
        ...current,
        ...data,
        history,
        lastReply:
          data.lastReply ?? data.lastAssistantResponse ?? current.lastReply,
        sessionId: safeSessionId,
        timestamp: now,
        updatedAt: now,
      });
    });
  }

  async function addTurn(sessionId, role, text, extras = {}) {
    return withLock(sessionId, async () => {
      const safeSessionId = sanitizeSessionId(sessionId);
      const current = await readSession(safeSessionId);
      const cleanText = role === "assistant" ? stripRolePrefixes(text) : String(text || "").trim();

      const nextTurn = normalizeTurn(
        {
          ...extras,
          role,
          text: cleanText,
        },
        current
      );

      if (!nextTurn) {
        return current;
      }

      const history = [...current.history, nextTurn].slice(-maxTurns);
      const now = new Date().toISOString();

      return writeSession(safeSessionId, {
        ...current,
        history,
        lastReply:
          nextTurn.role === "assistant" ? nextTurn.text : current.lastReply,
        timestamp: now,
        updatedAt: now,
      });
    });
  }

  async function appendTurn(sessionId, turn) {
    return addTurn(sessionId, turn?.role, turn?.text, turn);
  }

  async function clearSession(sessionId, overrides = {}) {
    return withLock(sessionId, async () => {
      const safeSessionId = sanitizeSessionId(sessionId);
      return writeSession(safeSessionId, buildDefaultSession(safeSessionId, overrides));
    });
  }

  async function updateSession(sessionId, updates) {
    return saveSession(sessionId, updates);
  }

  async function updatePreferences(sessionId, updates = {}) {
    const current = await getSession(sessionId);

    return saveSession(sessionId, {
      language: normalizeLanguage(updates.language || current.language),
      mode: normalizeMode(updates.mode || current.mode),
      targetLanguage: normalizeLanguage(
        updates.targetLanguage ||
          current.targetLanguage ||
          updates.language ||
          current.language
      ),
    });
  }

  async function getConversationHistory(sessionId) {
    try {
      const session = await getSession(sessionId);
      debugMemoryLog("HISTORY SIZE", session.history.length);
      return toConversationHistory(session.history, maxTurns);
    } catch (error) {
      logMemoryFailure("MEMORY HISTORY ERROR", error, sessionId);
      return [];
    }
  }

  return {
    addTurn,
    appendTurn,
    clearSession,
    getConversationHistory,
    getSession,
    saveSession,
    updatePreferences,
    updateSession,
  };
}

function getDefaultMemoryService() {
  if (!defaultMemoryService) {
    defaultMemoryService = createMemoryService();
  }

  return defaultMemoryService;
}

async function getSession(sessionId) {
  return getDefaultMemoryService().getSession(sessionId);
}

async function saveSession(sessionId, data) {
  return getDefaultMemoryService().saveSession(sessionId, data);
}

async function addTurn(sessionId, role, text, extras) {
  return getDefaultMemoryService().addTurn(sessionId, role, text, extras);
}

async function clearSession(sessionId, overrides) {
  return getDefaultMemoryService().clearSession(sessionId, overrides);
}

module.exports = {
  addTurn,
  clearSession,
  createMemoryService,
  getSession,
  getSessionFilePath,
  normalizeLanguage,
  normalizeMode,
  saveSession,
  summarizeSession,
  toPersistedSession,
  toConversationHistory,
};
