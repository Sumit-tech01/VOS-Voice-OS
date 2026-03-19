const crypto = require("crypto");
const express = require("express");
const { normalizeLanguage, summarizeSession } = require("../services/memory");

const SUPPORTED_MODES = new Set([
  "assistant",
  "tutor",
  "translator",
  "customer-support",
]);
const SYSTEM_ERROR_TEXT = "System error";
const STRICT_SYNC_SAFE_MODE = true;

function isDebugEnabled() {
  return String(process.env.DEBUG || "").trim().toLowerCase() === "true";
}

function normalizeMode(mode) {
  if (!mode) {
    return "assistant";
  }

  const normalized = String(mode).trim().toLowerCase().replace(/\s+/g, "-");
  return SUPPORTED_MODES.has(normalized) ? normalized : "assistant";
}

function normalizeLocale(locale) {
  return normalizeLanguage(locale);
}

function resolveResponseLocale(mode, language, targetLanguage) {
  return mode === "translator" ? targetLanguage || language : language;
}

function emitEvent(realtimeHub, sessionId, type, payload = {}) {
  if (!realtimeHub || typeof realtimeHub.send !== "function") {
    return;
  }

  try {
    const maybePromise = realtimeHub.send(sessionId, type, payload);
    Promise.resolve(maybePromise).catch((error) => {
      if (isDebugEnabled()) {
        console.error("WS EVENT ERROR", {
          message: error?.message || String(error || "Unknown WS event error"),
          sessionId,
          type,
        });
      }
    });
  } catch (error) {
    if (isDebugEnabled()) {
      console.error("WS EVENT ERROR", {
        message: error?.message || String(error || "Unknown WS event error"),
        sessionId,
        type,
      });
    }
  }
}

function getSupportedLanguages(intentService) {
  if (intentService && typeof intentService.getSupportedLanguages === "function") {
    return intentService.getSupportedLanguages();
  }

  return [];
}

function getSupportedModes(intentService) {
  if (intentService && typeof intentService.getSupportedModes === "function") {
    return intentService.getSupportedModes();
  }

  return [];
}

function buildSessionMeta(session) {
  return summarizeSession(session);
}

function resolveTurnId(payload) {
  const rawTurnId = String(payload?.turnId || "").trim();
  return rawTurnId || crypto.randomUUID();
}

function buildFallbackSession({
  language,
  mode,
  sessionId,
  targetLanguage,
}) {
  const now = new Date().toISOString();

  return {
    createdAt: now,
    history: [],
    language,
    lastAssistantResponse: SYSTEM_ERROR_TEXT,
    lastAudioUrl: null,
    lastReply: SYSTEM_ERROR_TEXT,
    mode,
    sessionId,
    targetLanguage,
    timestamp: now,
    updatedAt: now,
  };
}

async function buildErrorVoiceResponse(
  payload,
  error,
  { intentService, memoryService }
) {
  const sessionId =
    String(payload?.sessionId || "").trim() || crypto.randomUUID();
  const turnId = resolveTurnId(payload);
  const mode = normalizeMode(payload?.mode);
  const language = normalizeLocale(payload?.language);
  const targetLanguage = normalizeLocale(payload?.targetLanguage || language);
  const fallbackSession = await Promise.resolve(
    memoryService.getSession(sessionId)
  ).catch(() =>
    buildFallbackSession({
      language,
      mode,
      sessionId,
      targetLanguage,
    })
  );

  return {
    audioUrl: null,
    detectedIntent: "error",
    history: [],
    language: fallbackSession.language || language,
    latencyMs: 0,
    mode: fallbackSession.mode || mode,
    provider: "system",
    replyText: SYSTEM_ERROR_TEXT,
    session: fallbackSession,
    sessionMeta: buildSessionMeta(fallbackSession),
    sessionId,
    supportedLanguages: getSupportedLanguages(intentService),
    supportedModes: getSupportedModes(intentService),
    targetLanguage: fallbackSession.targetLanguage || targetLanguage,
    text: SYSTEM_ERROR_TEXT,
    turnId,
    userText: String(payload?.text || "").trim(),
    warning: error?.message || SYSTEM_ERROR_TEXT,
  };
}

function logVoiceStage(stage, sessionId, detail = "") {
  if (!isDebugEnabled()) {
    return;
  }

  if (detail) {
    console.log(stage, {
      detail,
      sessionId,
    });
    return;
  }

  console.log(stage, { sessionId });
}

async function processClearRequest(payload, { memoryService, realtimeHub }) {
  const sessionId =
    String(payload?.sessionId || "").trim() || crypto.randomUUID();
  const mode = normalizeMode(payload?.mode);
  const language = normalizeLocale(payload?.language);
  const targetLanguage = normalizeLocale(payload?.targetLanguage || language);
  const cleared = await memoryService.clearSession(sessionId, {
    language,
    mode,
    targetLanguage,
  });
  const sessionMeta = buildSessionMeta(cleared);

  emitEvent(realtimeHub, sessionId, "memory:cleared", {
    sessionId,
  });
  emitEvent(realtimeHub, sessionId, "session:updated", {
    reason: "clear",
    session: cleared,
    sessionId,
    sessionMeta,
  });

  return {
    sessionMeta,
    supportedLanguages: [],
    supportedModes: [],
    session: cleared,
    success: true,
  };
}

async function processPreferencesRequest(payload, { memoryService, realtimeHub }) {
  const sessionId =
    String(payload?.sessionId || "").trim() || crypto.randomUUID();
  const existingSession = await memoryService.getSession(sessionId);
  const nextMode = normalizeMode(payload?.mode || existingSession.mode);
  const nextLanguage = normalizeLocale(payload?.language || existingSession.language);
  const nextTargetLanguage = normalizeLocale(
    payload?.targetLanguage || existingSession.targetLanguage || nextLanguage
  );

  const session = await memoryService.updatePreferences(sessionId, {
    language: nextLanguage,
    mode: nextMode,
    targetLanguage: nextTargetLanguage,
  });
  const sessionMeta = buildSessionMeta(session);

  emitEvent(realtimeHub, sessionId, "session:updated", {
    reason: "preferences",
    session,
    sessionId,
    sessionMeta,
  });

  if (existingSession.mode !== session.mode) {
    emitEvent(realtimeHub, sessionId, "mode:changed", {
      mode: session.mode,
      sessionId,
    });
  }

  return {
    session,
    sessionId,
    sessionMeta,
    success: true,
  };
}

async function processVoiceMessage(
  payload,
  {
    aiService,
    commandRouter,
    intentService,
    memoryService,
    murfService,
    realtimeHub,
  }
) {
  const startedAt = Date.now();
  const sessionId =
    String(payload?.sessionId || "").trim() || crypto.randomUUID();
  const turnId = resolveTurnId(payload);
  const userText = String(payload?.text || "").trim();
  const requestedMode = normalizeMode(payload?.mode);
  const requestedLanguage = normalizeLocale(payload?.language);
  const requestedTargetLanguage = normalizeLocale(
    payload?.targetLanguage || requestedLanguage
  );

  if (!userText) {
    const error = new Error("text is required");
    error.statusCode = 400;
    throw error;
  }

  try {
    logVoiceStage("STEP 1 request", sessionId);
    logVoiceStage("REQUEST RECEIVED", sessionId);
    logVoiceStage("SESSION ID", sessionId);
    logVoiceStage("TURN ID", sessionId, turnId);
    logVoiceStage("TEXT RECEIVED", sessionId, userText);

    const source = String(payload?.source || "voice");

    let session = await memoryService.updatePreferences(sessionId, {
      language: requestedLanguage,
      mode: requestedMode,
      targetLanguage: requestedTargetLanguage,
    });

    const detectedIntent = intentService.detectIntent(userText, session);
    logVoiceStage("STEP 2 router", sessionId, detectedIntent.name);
    logVoiceStage("ROUTER START", sessionId, detectedIntent.name);
    // The voice request flow is intentionally sequential for core work:
    // receive request -> await router -> await ai -> await murf -> send response.
    // Realtime events are best-effort and must not block REST responses.
    emitEvent(realtimeHub, sessionId, "assistant:thinking", {
      mode: session.mode,
      sessionId,
      turnId,
      userText,
    });

    const commandResult = await commandRouter.route({
      detectedIntent,
      language: session.language,
      mode: session.mode,
      session,
      sessionId,
      source,
      targetLanguage: session.targetLanguage,
      text: userText,
    });

    if (commandResult.handled) {
      const updatedSession = await memoryService.getSession(sessionId);

      for (const event of commandResult.events || []) {
        emitEvent(realtimeHub, sessionId, event.type, {
          ...(event.payload || {}),
          ...(STRICT_SYNC_SAFE_MODE ? { turnId } : {}),
        });
      }

      if (commandResult.replyText) {
        emitEvent(realtimeHub, sessionId, "assistant:text", {
          mode: commandResult.mode,
          sessionId,
          text: commandResult.replyText,
          turnId,
        });
      }

      if (commandResult.audioUrl) {
        emitEvent(realtimeHub, sessionId, "assistant:audio", {
          audioUrl: commandResult.audioUrl,
          mode: commandResult.mode,
          sessionId,
          turnId,
        });
      }

      return {
        audioUrl: commandResult.audioUrl || null,
        clientAction: commandResult.clientAction || null,
        detectedIntent: detectedIntent.name,
        language: commandResult.language,
        latencyMs: Date.now() - startedAt,
        mode: commandResult.mode,
        replyText: commandResult.replyText,
        session: updatedSession,
        sessionMeta: buildSessionMeta(updatedSession),
        sessionId,
        supportedLanguages: getSupportedLanguages(intentService),
        supportedModes: getSupportedModes(intentService),
        targetLanguage: commandResult.targetLanguage,
        text: commandResult.replyText,
        turnId,
        userText,
        warning: commandResult.warning || null,
      };
    }

    await memoryService.appendTurn(sessionId, {
      intent: detectedIntent.name,
      language: session.language,
      mode: session.mode,
      role: "user",
      source,
      text: userText,
    });

    session = await memoryService.getSession(sessionId);
    const conversationHistory =
      typeof memoryService.getConversationHistory === "function"
        ? await memoryService.getConversationHistory(sessionId)
        : (session.history || []).map((item) => ({
            role: item.role === "assistant" ? "assistant" : "user",
            text: item.text,
          }));
    logVoiceStage("STEP 3 ai", sessionId, session.mode);
    logVoiceStage("AI START", sessionId, session.mode);
    const aiResult = await aiService.generateReply({
      history: conversationHistory,
      language: session.language,
      mode: session.mode,
      targetLanguage: session.targetLanguage,
      text: userText,
    });
    logVoiceStage("AI DONE", sessionId, aiResult.provider || "unknown");

    const responseLocale = resolveResponseLocale(
      session.mode,
      session.language,
      session.targetLanguage
    );

    await memoryService.appendTurn(sessionId, {
      intent: detectedIntent.name,
      language: responseLocale,
      mode: session.mode,
      provider: aiResult.provider,
      role: "assistant",
      source: "assistant",
      text: aiResult.text,
    });

    emitEvent(realtimeHub, sessionId, "assistant:text", {
      mode: session.mode,
      provider: aiResult.provider,
      sessionId,
      text: aiResult.text,
      turnId,
    });

    let audioUrl = null;
    let warning = null;
    const skipVoiceGeneration = !aiResult.text;

    if (skipVoiceGeneration) {
      warning = "AI generation failed";
      emitEvent(realtimeHub, sessionId, "assistant:warning", {
        detail: warning,
        sessionId,
        turnId,
      });
      emitEvent(realtimeHub, sessionId, "error", {
        detail: warning,
        message: "AI generation failed",
        sessionId,
        turnId,
      });
    } else {
      logVoiceStage("STEP 4 murf", sessionId, responseLocale);
      logVoiceStage("MURF START", sessionId, responseLocale);
      audioUrl = await murfService.generateVoice(aiResult.text, {
        lowLatency: true,
        locale: responseLocale,
        sessionId,
      });

      if (audioUrl) {
        logVoiceStage("MURF DONE", sessionId, audioUrl);
        await memoryService.updateSession(sessionId, {
          lastAudioUrl: audioUrl,
        });

        emitEvent(realtimeHub, sessionId, "assistant:audio", {
          audioUrl,
          mode: session.mode,
          sessionId,
          turnId,
        });
      } else {
        warning = "Voice generation failed";
        emitEvent(realtimeHub, sessionId, "assistant:warning", {
          detail: warning,
          sessionId,
          turnId,
        });
        emitEvent(realtimeHub, sessionId, "error", {
          detail: warning,
          message: "Voice generation failed",
          sessionId,
          turnId,
        });
      }
    }

    const updatedSession = await memoryService.getSession(sessionId);
    logVoiceStage("STEP 5 response", sessionId);

    return {
      audioUrl,
      detectedIntent: detectedIntent.name,
      history: conversationHistory,
      language: session.language,
      latencyMs: Date.now() - startedAt,
      mode: session.mode,
      provider: aiResult.provider,
      replyText: aiResult.text,
      session: updatedSession,
      sessionMeta: buildSessionMeta(updatedSession),
      sessionId,
      supportedLanguages: getSupportedLanguages(intentService),
      supportedModes: getSupportedModes(intentService),
      targetLanguage: session.targetLanguage,
      text: aiResult.text,
      turnId,
      userText,
      warning,
    };
  } catch (error) {
    if (isDebugEnabled()) {
      console.error("VOICE HANDLER ERROR", error?.stack || error?.message || error);
    }

    const fallbackSession = await Promise.resolve(
      memoryService.getSession(sessionId)
    ).catch(() =>
      buildFallbackSession({
        language: requestedLanguage,
        mode: requestedMode,
        sessionId,
        targetLanguage: requestedTargetLanguage,
      })
    );

    emitEvent(realtimeHub, sessionId, "assistant:text", {
      mode: requestedMode,
      provider: "system",
      sessionId,
      text: SYSTEM_ERROR_TEXT,
      turnId,
    });
    emitEvent(realtimeHub, sessionId, "error", {
      detail: error?.message || SYSTEM_ERROR_TEXT,
      message: SYSTEM_ERROR_TEXT,
      sessionId,
      turnId,
    });

    return {
      audioUrl: null,
      detectedIntent: "error",
      history: [],
      language: fallbackSession.language || requestedLanguage,
      latencyMs: Date.now() - startedAt,
      mode: fallbackSession.mode || requestedMode,
      provider: "system",
      replyText: SYSTEM_ERROR_TEXT,
      session: fallbackSession,
      sessionMeta: buildSessionMeta(fallbackSession),
      sessionId,
      supportedLanguages: getSupportedLanguages(intentService),
      supportedModes: getSupportedModes(intentService),
      targetLanguage: fallbackSession.targetLanguage || requestedTargetLanguage,
      text: SYSTEM_ERROR_TEXT,
      turnId,
      userText,
      warning: SYSTEM_ERROR_TEXT,
    };
  }
}

function createVoiceRouter({
  aiService,
  commandRouter,
  intentService,
  memoryService,
  murfService,
  realtimeHub,
}) {
  const router = express.Router();

  router.get("/state", async (req, res, next) => {
    try {
      const sessionId = String(req.query.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).json({ error: "sessionId is required" });
      }

      const session = await memoryService.getSession(sessionId);

      res.json({
        session,
        sessionMeta: buildSessionMeta(session),
        supportedLanguages: getSupportedLanguages(intentService),
        supportedModes: getSupportedModes(intentService),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/clear", async (req, res, next) => {
    try {
      const response = await processClearRequest(req.body, {
        memoryService,
        realtimeHub,
      });
      response.supportedLanguages = getSupportedLanguages(intentService);
      response.supportedModes = getSupportedModes(intentService);
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.post("/preferences", async (req, res, next) => {
    try {
      const response = await processPreferencesRequest(req.body, {
        memoryService,
        realtimeHub,
      });
      response.supportedLanguages = getSupportedLanguages(intentService);
      response.supportedModes = getSupportedModes(intentService);
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.post("/message", async (req, res, next) => {
    try {
      const response = await processVoiceMessage(req.body, {
        aiService,
        commandRouter,
        intentService,
        memoryService,
        murfService,
        realtimeHub,
      });
      logVoiceStage("STEP 5 response", response.sessionId);
      logVoiceStage("RESPONSE SENT", response.sessionId);
      return res.json(response);
    } catch (error) {
      console.error('[ROUTE ERROR]', error?.message, error?.stack?.split('\n')[1]);
      return res.status(500).json({
        error: 'System error',
        detail: error?.message,
        step: error?.step || 'unknown'
      });
    }
  });

  router.use((error, req, res, next) => {
    const sessionId = String(req.body?.sessionId || req.query?.sessionId || "").trim();
    if (isDebugEnabled()) {
      console.error("VOICE ROUTE ERROR", error?.stack || error?.message || error);
    }

    if (sessionId) {
      emitEvent(realtimeHub, sessionId, "error", {
        detail: error.message,
        message: "Voice request failed",
        sessionId,
      });
    }

    res.status(error.statusCode || 500).json({
      error: error.message || "Unexpected server error",
    });
    logVoiceStage("RESPONSE SENT", sessionId || "unknown");
  });

  return router;
}

module.exports = {
  createVoiceRouter,
  processClearRequest,
  processPreferencesRequest,
  processVoiceMessage,
};
