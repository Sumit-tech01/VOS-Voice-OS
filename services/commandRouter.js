const { executeComputerTask } = require('./computer');

function resolveSpeechLocale(mode, language, targetLanguage) {
  return mode === "translator" ? targetLanguage || language : language;
}

function isDebugEnabled() {
  return String(process.env.DEBUG || "").trim().toLowerCase() === "true";
}

function debugRouterLog(...args) {
  if (isDebugEnabled()) {
    console.log(...args);
  }
}

const LANGUAGE_ALIASES = {
  de: "de",
  german: "de",
  en: "en",
  english: "en",
  es: "es",
  spanish: "es",
  fr: "fr",
  french: "fr",
  hi: "hi",
  hindi: "hi",
  ja: "ja",
  japanese: "ja",
};

function normalizeCommandText(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveFallbackIntent(text, detectedIntent) {
  if (detectedIntent && detectedIntent.type === "command") {
    return detectedIntent;
  }

  const normalizedText = normalizeCommandText(text);

  if (normalizedText === "switch to tutor" || normalizedText === "switch to tutor mode") {
    return {
      entities: { mode: "tutor" },
      name: "mode-switch",
      type: "command",
    };
  }

  if (
    normalizedText === "switch to assistant" ||
    normalizedText === "switch to assistant mode"
  ) {
    return {
      entities: { mode: "assistant" },
      name: "mode-switch",
      type: "command",
    };
  }

  if (
    normalizedText === "switch to translator" ||
    normalizedText === "switch to translator mode"
  ) {
    return {
      entities: { mode: "translator" },
      name: "mode-switch",
      type: "command",
    };
  }

  if (
    normalizedText === "switch to support" ||
    normalizedText === "switch to support mode" ||
    normalizedText === "switch to customer support"
  ) {
    return {
      entities: { mode: "customer-support" },
      name: "mode-switch",
      type: "command",
    };
  }

  if (
    normalizedText === "clear memory" ||
    normalizedText === "repeat" ||
    normalizedText === "help"
  ) {
    return {
      entities: {},
      name: normalizedText === "clear memory" ? "clear-memory" : normalizedText,
      type: "command",
    };
  }

  if (
    normalizedText === "change language" ||
    normalizedText === "switch language" ||
    normalizedText === "set language"
  ) {
    return {
      entities: {},
      name: "language-switch-help",
      type: "command",
    };
  }

  const languageMatch = normalizedText.match(
    /^(?:change|switch|set) language to (english|hindi|spanish|french|german|japanese|en|hi|es|fr|de|ja)$/
  );

  if (languageMatch) {
    return {
      entities: { language: LANGUAGE_ALIASES[languageMatch[1]] || "en" },
      name: "language-switch",
      type: "command",
    };
  }

  return {
    entities: {},
    name: "conversation",
    type: "message",
  };
}

function formatMode(mode) {
  return mode.replace(/-/g, " ");
}

function formatLanguage(locale, supportedLanguages) {
  const match = supportedLanguages.find((item) => item.code === locale);
  return match ? match.label : locale;
}

function buildRouteResult({
  audioUrl = null,
  clientAction = null,
  events = [],
  handled = false,
  language = "en",
  mode = "assistant",
  targetLanguage = language,
  text = "",
  warning = null,
} = {}) {
  const replyText = typeof text === "string" ? text : "";

  return {
    audioUrl,
    clientAction,
    events,
    handled,
    language,
    mode,
    replyText,
    targetLanguage,
    text: replyText,
    warning,
  };
}

function createCommandRouter({ memoryService, murfService }) {
  const supportedLanguages = [
    { code: "de", label: "German" },
    { code: "en", label: "English" },
    { code: "es", label: "Spanish" },
    { code: "fr", label: "French" },
    { code: "hi", label: "Hindi" },
    { code: "ja", label: "Japanese" },
  ];

  async function speak(replyText, options) {
    if (!replyText) {
      return null;
    }

    try {
      debugRouterLog("MURF START", {
        locale: options?.locale || "en",
        sessionId: options?.sessionId || "command",
      });
      const audioUrl = await murfService.generateVoice(replyText, options);
      debugRouterLog("MURF DONE", {
        audioUrl,
        sessionId: options?.sessionId || "command",
      });
      return audioUrl;
    } catch (error) {
      debugRouterLog("COMMAND RESULT", {
        error: error?.message || "Unknown Murf error",
        sessionId: options?.sessionId || "command",
      });
      return null;
    }
  }

  async function appendAssistantTurn(sessionId, responseLocale, mode, replyText, intentName) {
    await memoryService.appendTurn(sessionId, {
      intent: intentName,
      language: responseLocale,
      mode,
      role: "assistant",
      source: "assistant",
      text: replyText,
    });
  }

  async function route({
    detectedIntent,
    language,
    mode,
    session,
    sessionId,
    source,
    targetLanguage,
    text,
  }) {
    const resolvedIntent = resolveFallbackIntent(text, detectedIntent);
    debugRouterLog("ROUTER INPUT", {
      language,
      mode,
      sessionId,
      text,
    });
    debugRouterLog("MODE", mode);
    debugRouterLog("COMMAND DETECTED", resolvedIntent?.name || "conversation");

    if (!resolvedIntent || resolvedIntent.type !== "command") {
      debugRouterLog("ROUTER OUTPUT", {
        handled: false,
        replyText: "",
        sessionId,
      });
      return buildRouteResult({
        handled: false,
        language,
        mode,
        targetLanguage,
        text: "",
      });
    }

    const responseLocale = resolveSpeechLocale(mode, language, targetLanguage);
    let replyText = "";
    let clientAction = null;
    let nextMode = mode;
    let nextLanguage = language;
    let nextTargetLanguage = targetLanguage;
    const events = [];

    if (resolvedIntent.name !== "clear-memory") {
      await memoryService.appendTurn(sessionId, {
        intent: resolvedIntent.name,
        language,
        mode,
        role: "user",
        source,
        text,
      });
    }

    switch (resolvedIntent.name) {
      case 'computer-action': {
        const { action, params } = resolvedIntent.entities || {};
        const computerResult = await executeComputerTask(action, params || {});
        replyText = computerResult.reply || 'Done.';
        await appendAssistantTurn(
          sessionId,
          responseLocale,
          mode,
          replyText,
          resolvedIntent.name
        );
        break;
      }

      case 'unsupported-action': {
        replyText = resolvedIntent.entities?.reply || "I can't do that yet. What else can I help with?";
        await appendAssistantTurn(sessionId, responseLocale, mode, replyText, resolvedIntent.name);
        break;
      }

      case "clear-memory":
        await memoryService.clearSession(sessionId, {
          language,
          mode,
          targetLanguage,
        });
        replyText = "Session memory cleared. Ready for a new conversation.";
        events.push({
          type: "memory:cleared",
          payload: { sessionId },
        });
        await appendAssistantTurn(
          sessionId,
          responseLocale,
          mode,
          replyText,
          resolvedIntent.name
        );
        break;

      case "repeat":
        replyText =
          session.lastAssistantResponse ||
          "There is nothing to repeat yet. Ask me something first.";
        await appendAssistantTurn(
          sessionId,
          responseLocale,
          mode,
          replyText,
          resolvedIntent.name
        );
        break;

      case "stop-audio":
        replyText = "Stopping audio playback now.";
        clientAction = "stop-audio";
        await appendAssistantTurn(
          sessionId,
          responseLocale,
          mode,
          replyText,
          resolvedIntent.name
        );
        break;

      case "help":
        replyText =
          "You can ask what is your name, who made you, explain ai, tell joke, translate hello to hindi, switch to tutor, clear memory, repeat, stop audio, or say help.";
        await appendAssistantTurn(
          sessionId,
          responseLocale,
          mode,
          replyText,
          resolvedIntent.name
        );
        break;

      case "mode-switch":
        nextMode = resolvedIntent.entities.mode || mode;
        await memoryService.updatePreferences(sessionId, {
          mode: nextMode,
        });
        replyText = `Mode switched to ${formatMode(
          nextMode
        )}. I am ready for your next request.`;
        events.push({
          type: "mode:changed",
          payload: {
            mode: nextMode,
            sessionId,
          },
        });
        await appendAssistantTurn(
          sessionId,
          resolveSpeechLocale(nextMode, language, targetLanguage),
          nextMode,
          replyText,
          resolvedIntent.name
        );
        break;

      case "language-switch":
        nextLanguage = resolvedIntent.entities.language || language;
        await memoryService.updatePreferences(sessionId, {
          language: nextLanguage,
        });
        replyText = `Language switched to ${formatLanguage(
          nextLanguage,
          supportedLanguages
        )}.`;
        await appendAssistantTurn(
          sessionId,
          nextLanguage,
          nextMode,
          replyText,
          resolvedIntent.name
        );
        break;

      case "language-switch-help":
        replyText =
          "Please say change language to English, Hindi, Spanish, French, German, or Japanese.";
        await appendAssistantTurn(
          sessionId,
          responseLocale,
          nextMode,
          replyText,
          resolvedIntent.name
        );
        break;

      case "target-language-switch":
        nextTargetLanguage = resolvedIntent.entities.language || targetLanguage;
        await memoryService.updatePreferences(sessionId, {
          targetLanguage: nextTargetLanguage,
        });
        replyText = `Target translation language set to ${formatLanguage(
          nextTargetLanguage,
          supportedLanguages
        )}.`;
        await appendAssistantTurn(
          sessionId,
          language,
          nextMode,
          replyText,
          resolvedIntent.name
        );
        break;

      default:
        return buildRouteResult({
          handled: false,
          language,
          mode,
          targetLanguage,
          text: "",
        });
    }

    let audioUrl = null;
    let warning = null;

    if (resolvedIntent.name !== "stop-audio") {
      audioUrl = await speak(replyText, {
        locale: resolveSpeechLocale(nextMode, nextLanguage, nextTargetLanguage),
        lowLatency: true,
        sessionId,
      });

      if (!audioUrl) {
        warning = "Murf voice generation is unavailable right now.";
      } else {
        await memoryService.updateSession(sessionId, {
          lastAudioUrl: audioUrl,
        });
      }
    }

    debugRouterLog("COMMAND RESULT", {
      audioUrl,
      clientAction,
      handled: true,
      replyText,
      sessionId,
      warning,
    });
    debugRouterLog("ROUTER OUTPUT", {
      language: nextLanguage,
      mode: nextMode,
      replyText,
      sessionId,
      targetLanguage: nextTargetLanguage,
    });

    return buildRouteResult({
      audioUrl,
      clientAction,
      events,
      handled: true,
      language: nextLanguage,
      mode: nextMode,
      targetLanguage: nextTargetLanguage,
      text: replyText,
      warning,
    });
  }

  return {
    route,
  };
}

module.exports = {
  createCommandRouter,
};
