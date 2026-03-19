const fs = require("fs");
const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

const DEFAULT_API_URL = "https://api.murf.ai/v1/speech/generate";
// Keep generated audio inside the project even if the server is started from another cwd.
const DEFAULT_OUTPUT_DIR = path.join(__dirname, "..", "public", "generated");
const DEFAULT_LOW_LATENCY_TIMEOUT_MS = 5000;
const DEFAULT_STANDARD_TIMEOUT_MS = 8000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const FILE_TTL_MS = 30 * 60 * 1000;
const TEST_TEXT = "Hello this is murf test";
const PRIMARY_MODEL_VERSION = "FALCON";
const FALLBACK_MODEL_VERSION = "GEN2";

const DEFAULT_VOICES = {
  "de-DE":
    process.env.MURF_DEFAULT_VOICE_DE || process.env.MURF_VOICE_DE_DE || "de-DE-lia",
  "en-US":
    process.env.MURF_DEFAULT_VOICE_EN || process.env.MURF_VOICE_EN_US || "en-US-natalie",
  "es-ES":
    process.env.MURF_DEFAULT_VOICE_ES || process.env.MURF_VOICE_ES_ES || "es-ES-carla",
  "fr-FR":
    process.env.MURF_DEFAULT_VOICE_FR || process.env.MURF_VOICE_FR_FR || "fr-FR-axel",
  "hi-IN":
    process.env.MURF_DEFAULT_VOICE_HI || process.env.MURF_VOICE_HI_IN || "hi-IN-khyati",
  "ja-JP":
    process.env.MURF_DEFAULT_VOICE_JA || process.env.MURF_VOICE_JA_JP || "ja-JP-kenji",
};

let singletonService = null;

function createMurfError(message, statusCode, code, cause) {
  const error = new Error(message);
  error.cause = cause;
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isReadableStream(value) {
  return Boolean(value) && typeof value.pipe === "function" && typeof value.on === "function";
}

function isDebugEnabled(explicitDebug) {
  if (typeof explicitDebug === "boolean") {
    return explicitDebug;
  }

  return String(process.env.DEBUG || "").trim().toLowerCase() === "true";
}

function sanitizeSessionId(sessionId) {
  return String(sessionId || "default-session")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 120);
}

function sanitizeHeadersForLogs(headers = {}) {
  const sanitized = {};

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "api-key") {
      sanitized[key] = `[length:${String(value || "").length}]`;
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

function serializeLogValue(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("utf8");
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }

  return value;
}

function formatRawErrorData(value) {
  const serialized = serializeLogValue(value);

  if (typeof serialized === "string") {
    return serialized;
  }

  if (serialized === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(serialized, null, 2);
  } catch (error) {
    return String(serialized);
  }
}

function debugLog(debugEnabled, label, payload) {
  if (!debugEnabled) {
    return;
  }

  console.log(label, payload);
}

function logSafeFailure(debugEnabled, label, error) {
  const message = error?.message || String(error || "Unknown Murf error");
  debugLog(debugEnabled, label, message);

  if (debugEnabled && error?.stack) {
    console.error(error.stack);
  }
}

function resolveLanguage(options = {}) {
  return String(options.language || options.locale || "en-US").trim() || "en-US";
}

function resolveVoiceId(options = {}) {
  const language = resolveLanguage(options);
  if (options.voiceId) {
    return String(options.voiceId).trim();
  }

  if (DEFAULT_VOICES[language]) {
    return DEFAULT_VOICES[language];
  }

  const languagePrefix = language.split("-")[0];
  const match = Object.entries(DEFAULT_VOICES).find(([locale]) =>
    locale.toLowerCase().startsWith(languagePrefix.toLowerCase())
  );

  return match ? match[1] : DEFAULT_VOICES["en-US"];
}

function buildCacheKey(text, options, voiceId) {
  return JSON.stringify({
    language: resolveLanguage(options),
    lowLatency: Boolean(options.lowLatency),
    text: String(text || "").trim().toLowerCase(),
    voiceId,
  });
}

function buildRequestBody(text, voiceId, modelVersion) {
  return {
    format: "MP3",
    modelVersion,
    text,
    voiceId,
  };
}

async function ensureDirectory(directoryPath) {
  await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function collectReadable(readable) {
  const chunks = [];

  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function normalizeResponsePayload(data) {
  if (!data) {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  if (isReadableStream(data)) {
    return collectReadable(data);
  }

  return data;
}

function tryParseJson(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "object" && !Buffer.isBuffer(value)) {
    return value;
  }

  const asString = Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value).trim();
  if (!asString) {
    return null;
  }

  try {
    return JSON.parse(asString);
  } catch (error) {
    return null;
  }
}

async function downloadAudioFile(httpClient, audioUrl) {
  const response = await httpClient.get(audioUrl, {
    responseType: "arraybuffer",
    timeout: DEFAULT_STANDARD_TIMEOUT_MS,
  });

  const payload = await normalizeResponsePayload(response.data);
  if (Buffer.isBuffer(payload)) {
    return payload;
  }

  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }

  if (typeof payload === "string") {
    return Buffer.from(payload);
  }

  throw createMurfError(
    "Downloaded audio file was empty",
    502,
    "MURF_RESPONSE_ERROR"
  );
}

async function extractAudioBuffer(response, httpClient) {
  const payload = await normalizeResponsePayload(response.data);
  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();

  if (Buffer.isBuffer(payload) && contentType.includes("audio")) {
    return payload;
  }

  const parsed = tryParseJson(payload);
  if (parsed) {
    const base64Audio =
      parsed.audioBase64 ||
      parsed.encodedAudio ||
      parsed.base64 ||
      parsed.data?.audioBase64 ||
      parsed.data?.encodedAudio;

    if (base64Audio) {
      return Buffer.from(base64Audio, "base64");
    }

    const audioUrl =
      parsed.audioUrl ||
      parsed.audio_url ||
      parsed.audioFile ||
      parsed.audio_file ||
      parsed.data?.audioUrl ||
      parsed.data?.audioFile;

    if (audioUrl) {
      return downloadAudioFile(httpClient, audioUrl);
    }
  }

  if (Buffer.isBuffer(payload)) {
    return payload;
  }

  if (typeof payload === "string" && payload.trim()) {
    return Buffer.from(payload.trim(), "base64");
  }

  throw createMurfError(
    "Murf API response did not include audio content",
    502,
    "MURF_RESPONSE_ERROR"
  );
}

function createSessionCache() {
  return new Map();
}

async function isExpired(filePath, maxAgeMs) {
  try {
    const stats = await fs.promises.stat(filePath);
    return Date.now() - stats.mtimeMs > maxAgeMs;
  } catch (error) {
    return true;
  }
}

function logAxiosError(debugEnabled, error) {
  if (!debugEnabled) {
    error._murfLogged = true;
    return;
  }

  const rawErrorData = formatRawErrorData(error.response?.data);
  const errorPayload = {
    errorHeaders: error.response?.headers,
    errorMessage: error.message,
    errorStatus: error.response?.status,
    responseData: serializeLogValue(error.response?.data),
  };

  console.error(`MURF RAW ERROR:\n${rawErrorData}`);
  console.error("ERROR STATUS", errorPayload.errorStatus);
  console.error("ERROR RESPONSE", errorPayload.responseData);
  console.error("ERROR HEADERS", errorPayload.errorHeaders);
  console.error("ERROR MESSAGE", errorPayload.errorMessage);
  debugLog(debugEnabled, "MURF ERROR", errorPayload);
  error._murfLogged = true;
}

function createMurfService(options = {}) {
  const apiKey = String(options.apiKey ?? process.env.MURF_API_KEY ?? "").trim();
  const apiUrl = String(options.apiUrl ?? process.env.MURF_API_URL ?? DEFAULT_API_URL).trim();
  const httpClient = options.httpClient || axios;
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  const debugEnabled = isDebugEnabled(options.debug);
  const autoCleanup = options.autoCleanup !== false;
  const cleanupIntervalMs = options.cleanupIntervalMs || CLEANUP_INTERVAL_MS;
  const maxAgeMs = options.maxAgeMs || FILE_TTL_MS;
  const requestTimeoutMs = Number(
    options.timeoutMs || process.env.MURF_TIMEOUT_MS || DEFAULT_STANDARD_TIMEOUT_MS
  );
  const lowLatencyTimeoutMs = Number(
    options.lowLatencyTimeoutMs ||
      process.env.MURF_LOW_LATENCY_TIMEOUT_MS ||
      DEFAULT_LOW_LATENCY_TIMEOUT_MS
  );
  const sessionAudioCache = new Map();
  const inFlightRequests = new Map();

  function getSessionCache(sessionId) {
    if (!sessionAudioCache.has(sessionId)) {
      sessionAudioCache.set(sessionId, createSessionCache());
    }

    return sessionAudioCache.get(sessionId);
  }

  function getInFlightCache(sessionId) {
    if (!inFlightRequests.has(sessionId)) {
      inFlightRequests.set(sessionId, new Map());
    }

    return inFlightRequests.get(sessionId);
  }

  async function saveAudioFile(buffer, sessionId) {
    const safeSessionId = sanitizeSessionId(sessionId);
    const sessionDirectory = path.join(outputDir, safeSessionId);
    const fileName = `voice_${Date.now()}.mp3`;
    const filePath = path.join(sessionDirectory, fileName);
    const tempPath = `${filePath}.tmp`;

    try {
      await ensureDirectory(sessionDirectory);
      await fs.promises.writeFile(tempPath, buffer);
      await fs.promises.rename(tempPath, filePath);
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {});
      throw createMurfError(
        "Failed to save generated Murf audio",
        500,
        "MURF_FILE_ERROR",
        error
      );
    }

    debugLog(debugEnabled, "FILE SAVED", true);
    debugLog(debugEnabled, "FILE PATH", filePath);

    return {
      filePath,
      relativeUrl: `/generated/${safeSessionId}/${fileName}`,
    };
  }

  async function postToMurf(body, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      "api-key": apiKey,
    };

    debugLog(debugEnabled, "REQUEST START", {
      apiKeyLength: apiKey.length,
      apiUrl,
      headers: sanitizeHeadersForLogs(headers),
      requestBody: body,
    });

    const response = await httpClient.post(apiUrl, body, {
      headers,
      responseType: "arraybuffer",
      timeout: options.lowLatency ? lowLatencyTimeoutMs : requestTimeoutMs,
    });

    debugLog(debugEnabled, "REQUEST DONE", {
      responseData: serializeLogValue(response.data),
      responseStatus: response.status,
    });

    return response;
  }

  function shouldFallbackToGen2(error) {
    const status = error?.response?.status;
    const rawData = formatRawErrorData(error?.response?.data).toLowerCase();

    if (status === 403) {
      return true;
    }

    return (
      status === 400 &&
      (rawData.includes("falcon") ||
        rawData.includes("modelversion") ||
        rawData.includes("not available"))
    );
  }

  async function requestAudio(text, voiceId, options = {}) {
    try {
      debugLog(debugEnabled, "TEXT", text);
      debugLog(debugEnabled, "VOICE", voiceId);
      debugLog(debugEnabled, "MODEL", PRIMARY_MODEL_VERSION);
      const response = await postToMurf(
        buildRequestBody(text, voiceId, PRIMARY_MODEL_VERSION),
        options
      );
      return {
        modelVersion: PRIMARY_MODEL_VERSION,
        response,
      };
    } catch (error) {
      logAxiosError(debugEnabled, error);
      if (!shouldFallbackToGen2(error)) {
        throw error;
      }

      debugLog(debugEnabled, "MODEL", FALLBACK_MODEL_VERSION);
      debugLog(debugEnabled, "FALLBACK", "Falcon not enabled, using gen2");
      const response = await postToMurf(
        buildRequestBody(text, voiceId, FALLBACK_MODEL_VERSION),
        options
      );
      return {
        modelVersion: FALLBACK_MODEL_VERSION,
        response,
      };
    }
  }

  async function cleanupGeneratedAudio() {
    const deletedFiles = [];

    await fs.promises.mkdir(outputDir, { recursive: true });
    const sessionEntries = await fs.promises.readdir(outputDir, {
      withFileTypes: true,
    });

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) {
        continue;
      }

      const sessionDirectory = path.join(outputDir, sessionEntry.name);
      const fileEntries = await fs.promises.readdir(sessionDirectory, {
        withFileTypes: true,
      });

      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile()) {
          continue;
        }

        const filePath = path.join(sessionDirectory, fileEntry.name);
        if (!(await isExpired(filePath, maxAgeMs))) {
          continue;
        }

        await fs.promises.unlink(filePath).catch(() => {});
        deletedFiles.push(filePath);
      }
    }

    for (const [sessionId, cache] of sessionAudioCache.entries()) {
      for (const [cacheKey, entry] of cache.entries()) {
        if (!entry || !entry.filePath || (await isExpired(entry.filePath, maxAgeMs))) {
          cache.delete(cacheKey);
        }
      }

      if (cache.size === 0) {
        sessionAudioCache.delete(sessionId);
      }
    }

    debugLog(debugEnabled, "cleanup", {
      deletedFiles,
      outputDir,
    });

    return {
      deletedFiles,
    };
  }

  async function generateVoice(text, options = {}) {
    try {
      const cleanText = String(text || "").trim();
      const safeSessionId = sanitizeSessionId(options.sessionId || "default-session");
      const voiceId = resolveVoiceId(options);
      const cacheKey = buildCacheKey(cleanText, options, voiceId);
      const sessionCache = getSessionCache(safeSessionId);
      const inFlightCache = getInFlightCache(safeSessionId);

      if (!cleanText) {
        logSafeFailure(
          debugEnabled,
          "MURF SAFE FAILURE",
          createMurfError(
            "Text is required for voice generation",
            400,
            "MURF_VALIDATION_ERROR"
          )
        );
        return null;
      }

      if (!apiKey) {
        logSafeFailure(
          debugEnabled,
          "MURF SAFE FAILURE",
          createMurfError(
            "MURF_API_KEY is missing in the environment",
            500,
            "MURF_CONFIG_ERROR"
          )
        );
        return null;
      }

      const cachedEntry = sessionCache.get(cacheKey);
      if (
        cachedEntry &&
        cachedEntry.filePath &&
        !(await isExpired(cachedEntry.filePath, maxAgeMs))
      ) {
        debugLog(debugEnabled, "cache-hit", {
          filePath: cachedEntry.filePath,
          session: safeSessionId,
          text: cleanText,
          voice: voiceId,
        });
        return cachedEntry.relativeUrl;
      }

      if (cachedEntry) {
        sessionCache.delete(cacheKey);
      }

      if (inFlightCache.has(cacheKey)) {
        debugLog(debugEnabled, "dedupe-hit", {
          session: safeSessionId,
          text: cleanText,
          voice: voiceId,
        });
        return inFlightCache.get(cacheKey);
      }

      const startedAt = Date.now();
      const pendingRequest = (async () => {
        try {
          debugLog(debugEnabled, "TEXT", cleanText);
          debugLog(debugEnabled, "VOICE", voiceId);
          const result = await requestAudio(cleanText, voiceId, {
            lowLatency: Boolean(options.lowLatency),
          });
          const audioBuffer = await extractAudioBuffer(result.response, httpClient);
          const savedFile = await saveAudioFile(audioBuffer, safeSessionId);

          sessionCache.set(cacheKey, {
            createdAt: Date.now(),
            filePath: savedFile.filePath,
            relativeUrl: savedFile.relativeUrl,
          });

          const latencyMs = Date.now() - startedAt;
          debugLog(debugEnabled, "REQUEST DONE", {
            filePath: savedFile.filePath,
            latencyMs,
            modelVersion: result.modelVersion,
            session: safeSessionId,
            text: cleanText,
            voice: voiceId,
          });

          return savedFile.relativeUrl;
        } catch (error) {
          if (axios.isAxiosError(error) && !error._murfLogged) {
            logAxiosError(debugEnabled, error);
          }

          logSafeFailure(debugEnabled, "MURF SAFE FAILURE", error);
          return null;
        } finally {
          inFlightCache.delete(cacheKey);
        }
      })();

      inFlightCache.set(cacheKey, pendingRequest);
      return await pendingRequest;
    } catch (error) {
      logSafeFailure(debugEnabled, "MURF SAFE FAILURE", error);
      return null;
    }
  }

  async function testMurfConnection(options = {}) {
    const audioUrl = await generateVoice(TEST_TEXT, {
      ...options,
      sessionId: options.sessionId || "test-connection",
    });

    return {
      audioUrl,
      status: audioUrl ? "ok" : "error",
    };
  }

  const cleanupTimer =
    autoCleanup &&
    setInterval(() => {
      cleanupGeneratedAudio().catch((error) => {
        debugLog(debugEnabled, "cleanup-error", {
          message: error.message,
        });
      });
    }, cleanupIntervalMs);

  if (cleanupTimer && typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }

  return {
    cleanupGeneratedAudio,
    generateVoice,
    stopCleanupJob: () => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
      }
    },
    testMurfConnection,
  };
}

function getSingletonService() {
  if (!singletonService) {
    singletonService = createMurfService();
  }

  return singletonService;
}

async function generateVoice(text, options = {}) {
  return getSingletonService().generateVoice(text, options);
}

async function testMurfConnection(options = {}) {
  return getSingletonService().testMurfConnection(options);
}

module.exports = {
  createMurfService,
  generateVoice,
  testMurfConnection,
};
