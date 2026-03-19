require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const axios = require("axios");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { WebSocket, WebSocketServer } = require("ws");

const { createVoiceRouter } = require("./routes/voice");
const { generateReply, isAiFailureReply } = require("./services/ai");
const { createCommandRouter } = require("./services/commandRouter");
const { createIntentService } = require("./services/intent");
const { createMemoryService, summarizeSession } = require("./services/memory");
const { createMurfService } = require("./services/murf");

const TEST_ROUTE_TEXT = "Hello this is VOS voice system";
const REQUIRED_ENV_VARS = [
  "PORT",
  "DEBUG",
  "API_SECRET",
  "MURF_API_KEY",
  "MURF_API_URL",
  "AI_PROVIDER",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
];
const STARTUP_CLEANUP_MAX_AGE_MS = 60 * 60 * 1000;
const API_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const API_RATE_LIMIT_MAX = 20;
const GENERATED_AUDIO_DIR = path.join(__dirname, "public", "generated");
const MEMORY_DIR = path.join(__dirname, "data", "memory");
const PUBLIC_DIR = path.join(__dirname, "public");

function formatHttpError(error) {
  return {
    body: {
      code: error.code || "INTERNAL_ERROR",
      error: error.message || "Unexpected server error",
    },
    statusCode: error.statusCode || 500,
  };
}

function validateEnvironment(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter((key) => !String(env[key] || "").trim());

  if (missing.length > 0) {
    console.error(
      `[startup] Missing required environment variables: ${missing.join(", ")}`
    );
    console.error(
      "[startup] Server will continue running, but some features may be unavailable."
    );
  }

  return {
    isValid: missing.length === 0,
    missing,
  };
}

function isDebugEnabled(env = process.env) {
  return String(env.DEBUG || "").trim().toLowerCase() === "true";
}

function isTestEnv(env = process.env) {
  return String(env.NODE_ENV || "").trim().toLowerCase() === "test";
}

function debugServerLog(...args) {
  if (isDebugEnabled()) {
    console.log(...args);
  }
}

function debugServerError(label, error) {
  if (!isDebugEnabled()) {
    return;
  }

  console.error(label, error?.stack || error?.message || error);
}

function formatEnvironmentValue(key, env = process.env) {
  const value = String(env[key] || "").trim();

  if (!value) {
    return "(missing)";
  }

  if (key === "MURF_API_KEY" || key === "API_SECRET") {
    if (value.length <= 8) {
      return `[set length:${value.length}]`;
    }

    return `${value.slice(0, 4)}...${value.slice(-4)} [length:${value.length}]`;
  }

  return value;
}

function logEnvironmentValues(env = process.env) {
  if (!isDebugEnabled(env)) {
    return;
  }

  for (const key of REQUIRED_ENV_VARS) {
    console.log(`${key} = ${formatEnvironmentValue(key, env)}`);
  }
}

function getApiSecret(env = process.env) {
  return String(env.API_SECRET || "").trim();
}

function extractBearerToken(headerValue) {
  const normalized = String(headerValue || "").trim();
  const match = normalized.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isLocalHostValue(value) {
  const normalized = String(value || "").trim().toLowerCase();

  return (
    normalized === "localhost" ||
    normalized.startsWith("localhost:") ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.0.0.1:") ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.startsWith("[::1]:")
  );
}

function isLocalRequest(req) {
  const remoteAddress = String(req.ip || req.socket?.remoteAddress || "").trim();
  const hostHeader = String(req.headers.host || "").toLowerCase();

  return (
    remoteAddress === "::1" ||
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::ffff:127.0.0.1" ||
    isLocalHostValue(hostHeader)
  );
}

function canUseDebugRoute(req) {
  return isDebugEnabled() || isLocalRequest(req);
}

function isLocalOriginHeader(originHeader) {
  if (!originHeader) {
    return false;
  }

  try {
    const parsedOrigin = new URL(String(originHeader));
    return isLocalHostValue(parsedOrigin.host) || isLocalHostValue(parsedOrigin.hostname);
  } catch (error) {
    return false;
  }
}

function requireApiAuth(req, res, next) {
  if (isTestEnv()) {
    return next();
  }

  const expectedSecret = getApiSecret();
  if (!expectedSecret) {
    return res.status(503).json({
      error: "API auth is not configured",
    });
  }

  const bearerToken = extractBearerToken(req.headers.authorization);
  if (bearerToken !== expectedSecret) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  return next();
}

function createVoiceRateLimiter() {
  return rateLimit({
    windowMs: API_RATE_LIMIT_WINDOW_MS,
    max: API_RATE_LIMIT_MAX,
    legacyHeaders: false,
    standardHeaders: true,
    skip: () => isTestEnv(),
    handler: (req, res) => {
      const retryAfter =
        req.rateLimit?.resetTime instanceof Date
          ? Math.max(
              1,
              Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000)
            )
          : Math.ceil(API_RATE_LIMIT_WINDOW_MS / 1000);

      res.status(429).json({
        error: "Too many requests",
        retryAfter,
      });
    },
  });
}

function isAuthorizedWebSocketUpgrade(request, parsedUrl, env = process.env) {
  if (isTestEnv(env)) {
    console.log('[WS] Test env - allowing');
    return true;
  }

  const isLocal = isLocalRequest({
    headers: request.headers,
    ip: request.socket?.remoteAddress,
    socket: request.socket,
  }) || isLocalOriginHeader(request.headers.origin);
  
  const sessionId = String(parsedUrl.searchParams.get("sessionId") || "").trim();
  const token = String(parsedUrl.searchParams.get("token") || "").trim();
  const secret = getApiSecret(env);

  console.log('[WS AUTH]', {
    isLocal,
    sessionId: sessionId ? sessionId.slice(0,8) + '...' : 'MISSING',
    hasToken: !!token,
    hasSecret: !!secret
  });

  if (isLocal) {
    console.log('[WS] Local request - allowing');
    return true;
  }

  if (!secret) {
    console.log('[WS] No API_SECRET - rejecting');
    return false;
  }

  if (token !== secret) {
    console.log('[WS] Token mismatch - rejecting');
    return false;
  }

  console.log('[WS] Token OK - allowing');
  return true;
}

function rejectUnauthorizedUpgrade(socket) {
  try {
    socket.write(
      [
        "HTTP/1.1 401 Unauthorized",
        "Connection: close",
        "Content-Type: application/json; charset=utf-8",
        "",
        JSON.stringify({
          code: 4401,
          error: "Unauthorized WebSocket connection",
        }),
      ].join("\r\n")
    );
  } catch (error) {
    debugServerError("WS REJECT WRITE ERROR", error);
  }

  if (typeof socket.terminate === "function") {
    try {
      socket.terminate(4401);
      return;
    } catch (error) {
      debugServerError("WS REJECT TERMINATE ERROR", error);
    }
  }

  socket.destroy();
}

function applySecurityHeaders(req, res, next) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
  next();
}

async function cleanupExpiredFiles(rootDir, maxAgeMs) {
  const deletedFiles = [];
  const deletedDirectories = [];

  async function walk(currentDir, isRoot = false) {
    let entries;

    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      const stats = await fs.stat(entryPath);
      if (Date.now() - stats.mtimeMs > maxAgeMs) {
        await fs.unlink(entryPath);
        deletedFiles.push(entryPath);
      }
    }

    if (isRoot) {
      return;
    }

    const remainingEntries = await fs.readdir(currentDir);
    const visibleEntries = remainingEntries.filter((entryName) => !entryName.startsWith("."));
    if (visibleEntries.length === 0) {
      await fs.rm(currentDir, { force: true, recursive: true });
      deletedDirectories.push(currentDir);
    }
  }

  await walk(rootDir, true);

  return {
    deletedDirectories,
    deletedFiles,
    rootDir,
  };
}

async function ensureRuntimeDirectories({
  audioDir = GENERATED_AUDIO_DIR,
  memoryDir = MEMORY_DIR,
} = {}) {
  await Promise.all([
    fs.mkdir(audioDir, { recursive: true }),
    fs.mkdir(memoryDir, { recursive: true }),
  ]);

  return {
    audioDir,
    memoryDir,
  };
}

async function runStartupCleanup({
  audioDir = GENERATED_AUDIO_DIR,
  maxAgeMs = STARTUP_CLEANUP_MAX_AGE_MS,
  memoryDir = MEMORY_DIR,
} = {}) {
  try {
    const [audioCleanup, memoryCleanup] = await Promise.all([
      cleanupExpiredFiles(audioDir, maxAgeMs),
      cleanupExpiredFiles(memoryDir, maxAgeMs),
    ]);

    console.log(
      `[startup] Cleanup complete: removed ${audioCleanup.deletedFiles.length} audio files, ${memoryCleanup.deletedFiles.length} memory files.`
    );

    return {
      audioCleanup,
      memoryCleanup,
    };
  } catch (error) {
    console.error("[startup] Cleanup failed:", error.message);
    return {
      audioCleanup: null,
      memoryCleanup: null,
    };
  }
}

async function processTestMurfRequest({ murfService }) {
  const startedAt = Date.now();
  const sessionId = "test-murf";
  const audioUrl = await murfService.generateVoice(TEST_ROUTE_TEXT, {
    sessionId,
  });

  return {
    audioUrl,
    latencyMs: Date.now() - startedAt,
    sessionId,
    text: TEST_ROUTE_TEXT,
  };
}

async function processTestVoiceRequest(payload, { murfService }) {
  const startedAt = Date.now();
  const text = String(payload?.text || "").trim();
  const sessionId = String(payload?.sessionId || "").trim() || crypto.randomUUID();

  if (!text) {
    const error = new Error("text is required");
    error.code = "MURF_VALIDATION_ERROR";
    error.statusCode = 400;
    throw error;
  }

  const audioUrl = await murfService.generateVoice(text, {
    language: payload?.language,
    lowLatency: Boolean(payload?.lowLatency),
    sessionId,
    voiceId: payload?.voiceId,
  });

  return {
    audioUrl,
    latencyMs: Date.now() - startedAt,
    sessionId,
  };
}

async function testOllamaConnection({
  baseUrl = String(process.env.OLLAMA_BASE_URL || "http://localhost:11434").trim(),
  httpClient = axios,
  model = String(process.env.OLLAMA_MODEL || "llama3:latest").trim(),
  timeoutMs = 5000,
} = {}) {
  const startedAt = Date.now();
  const url = `${baseUrl.replace(/\/$/, "")}/api/generate`;
  const response = await httpClient.post(
    url,
    {
      model,
      prompt: "hello",
      stream: false,
    },
    {
      timeout: timeoutMs,
    }
  );

  return {
    latencyMs: Date.now() - startedAt,
    model,
    text: String(response?.data?.response || "").trim(),
    url,
  };
}

async function probeOllama(httpClient = axios) {
  const baseUrl = String(process.env.OLLAMA_BASE_URL || "http://localhost:11434").trim();
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const target = String(process.env.OLLAMA_MODEL || "llama3:latest").trim();

  try {
    const res = await httpClient.get(`${normalizedBaseUrl}/api/tags`, {
      timeout: 3000,
    });
    const models = Array.isArray(res.data?.models)
      ? res.data.models.map((model) => model?.name).filter(Boolean)
      : [];

    if (!models.includes(target)) {
      console.warn(`[STARTUP] ⚠️  Ollama running but model "${target}" not found.`);
      console.warn(`[STARTUP]    Available: ${models.join(", ") || "none"}`);
      console.warn(`[STARTUP]    Fix: ollama pull ${target}`);
    } else {
      console.log(`[STARTUP] ✅ Ollama OK — model "${target}" ready.`);
    }
  } catch (error) {
    console.warn(`[STARTUP] ⚠️  Ollama not reachable at ${normalizedBaseUrl}`);
    console.warn(`[STARTUP]    Fix: run "ollama serve" in a separate terminal`);
    debugServerError("OLLAMA STARTUP PROBE ERROR", error);
  }
}

function createRealtimeHub() {
  const connections = new Map();

  function attach(sessionId, socket) {
    if (!connections.has(sessionId)) {
      connections.set(sessionId, new Set());
    }

    connections.get(sessionId).add(socket);
  }

  function detach(sessionId, socket) {
    const sessionConnections = connections.get(sessionId);
    if (!sessionConnections) {
      return;
    }

    sessionConnections.delete(socket);
    if (sessionConnections.size === 0) {
      connections.delete(sessionId);
    }
  }

  function send(sessionId, type, payload = {}) {
    const sessionConnections = connections.get(sessionId);
    if (!sessionConnections || sessionConnections.size === 0) {
      return;
    }

    const message = JSON.stringify({ payload, type });
    const failedSockets = [];
    debugServerLog("WS SEND", {
      payload,
      sessionId,
      type,
    });
    for (const socket of sessionConnections) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(message);
        } catch (error) {
          debugServerError("WS SEND ERROR", error);
          failedSockets.push(socket);
        }
      }
    }

    for (const socket of failedSockets) {
      try {
        socket.terminate();
      } catch (error) {
        debugServerError("WS TERMINATE ERROR", error);
      }
      detach(sessionId, socket);
    }
  }

  function closeAll() {
    for (const sessionConnections of connections.values()) {
      for (const socket of sessionConnections) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      }
    }

    connections.clear();
  }

  return {
    attach,
    closeAll,
    detach,
    send,
  };
}

function createDependencies(overrides = {}) {
  const realtimeHub = overrides.realtimeHub || createRealtimeHub();
  const murfService = overrides.murfService || createMurfService();
  const memoryService =
    overrides.memoryService ||
    createMemoryService({
      baseDir: path.join(__dirname, "data", "memory"),
      maxTurns: 16,
    });
  const intentService = overrides.intentService || createIntentService();
  const aiService =
    overrides.aiService || {
      async generateReply(payload) {
        const text = await generateReply(payload);
        const provider =
          !text || isAiFailureReply(text) || /^System error at step /i.test(text)
            ? "ollama-fallback"
            : "ollama";

        return {
          model: process.env.OLLAMA_MODEL || "llama3:latest",
          provider,
          text,
        };
      },
    };
  const commandRouter =
    overrides.commandRouter ||
    createCommandRouter({
      memoryService,
      murfService,
    });

  return {
    aiService,
    commandRouter,
    intentService,
    memoryService,
    murfService,
    realtimeHub,
  };
}

function logStartupServices(dependencies) {
  const provider = String(process.env.AI_PROVIDER || "none").trim() || "none";

  console.log("Express started: yes");
  console.log(`AI provider: ${provider}`);
  console.log(
      `Murf ready: ${dependencies?.murfService ? "yes" : "no"}`
  );
  console.log(
      `WS ready: ${dependencies?.realtimeHub ? "yes" : "no"}`
  );
  console.log(
    `WS started: ${dependencies?.realtimeHub ? "yes" : "no"}`
  );
  console.log(
      `Memory ready: ${dependencies?.memoryService ? "yes" : "no"}`
  );
  console.log("Routes mounted: /api/voice");
  console.log(`Generated folder served: /generated -> ${GENERATED_AUDIO_DIR}`);

  if (isDebugEnabled()) {
    console.log("WS STARTED", dependencies?.realtimeHub ? "yes" : "no");
  }
}

async function runStartupDiagnostics({
  audioDir = GENERATED_AUDIO_DIR,
  env = process.env,
  httpClient = axios,
  memoryDir = MEMORY_DIR,
} = {}) {
  if (!isDebugEnabled(env)) {
    return {
      envLoaded: true,
      generatedFolderReady: true,
      memoryFolderReady: true,
      murfKeyExists: Boolean(String(env.MURF_API_KEY || "").trim()),
      ollama: null,
      port: Number(env.PORT || 3000),
    };
  }

  console.log("SERVER START");
  console.log("ENV LOADED");
  console.log("PORT", Number(env.PORT || 3000));
  console.log("MURF KEY EXISTS", Boolean(String(env.MURF_API_KEY || "").trim()));
  console.log("MEMORY FOLDER EXISTS", memoryDir);
  console.log("GENERATED FOLDER EXISTS", audioDir);

  try {
    const ollama = await testOllamaConnection({
      baseUrl: env.OLLAMA_BASE_URL,
      httpClient,
      model: env.OLLAMA_MODEL,
      timeoutMs: 5000,
    });

    console.log("OLLAMA TEST OK", {
      latencyMs: ollama.latencyMs,
      model: ollama.model,
      text: ollama.text,
      url: ollama.url,
    });

    return {
      envLoaded: true,
      generatedFolderReady: true,
      memoryFolderReady: true,
      murfKeyExists: Boolean(String(env.MURF_API_KEY || "").trim()),
      ollama,
      port: Number(env.PORT || 3000),
    };
  } catch (error) {
    console.warn("OLLAMA TEST WARNING", error?.message || error);
    if (isDebugEnabled(env) && error?.response?.data) {
      console.warn("OLLAMA TEST RESPONSE", error.response.data);
    }

    return {
      envLoaded: true,
      generatedFolderReady: true,
      memoryFolderReady: true,
      murfKeyExists: Boolean(String(env.MURF_API_KEY || "").trim()),
      ollama: null,
      port: Number(env.PORT || 3000),
    };
  }
}

function createApp(options = {}) {
  const dependencies = options.dependencies || createDependencies(options);
  const voiceRateLimiter = createVoiceRateLimiter();
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(applySecurityHeaders);
  app.use((req, res, next) => {
    debugServerLog("REQUEST RECEIVED", {
      method: req.method,
      path: req.originalUrl,
    });
    next();
  });

  // Static assets power the hackathon UI and the generated audio player.
  app.get("/app-config.js", (req, res) => {
    res.type("application/javascript");
    res.send(
      `window.__VOS_CONFIG__ = ${JSON.stringify({
        apiToken: isLocalRequest(req) ? getApiSecret() : "",
        debug: isDebugEnabled(),
      })};`
    );
  });
  app.use("/generated", express.static(GENERATED_AUDIO_DIR));
  app.use(express.static(PUBLIC_DIR));

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/test", async (req, res) => {
    if (!canUseDebugRoute(req)) {
      return res.status(403).json({
        error: "This debug route is only available locally or when DEBUG=true",
      });
    }

    try {
      const response = await processTestMurfRequest({
        murfService: dependencies.murfService,
      });
      res.json({ audioUrl: response.audioUrl });
    } catch (error) {
      console.error("Failed to generate Murf test audio:", error);
      const formatted = formatHttpError(error);
      res.status(formatted.statusCode).json(formatted.body);
    }
  });

  app.post("/test-voice", async (req, res) => {
    if (!canUseDebugRoute(req)) {
      return res.status(403).json({
        error: "This debug route is only available locally or when DEBUG=true",
      });
    }

    try {
      const response = await processTestVoiceRequest(req.body, {
        murfService: dependencies.murfService,
      });
      res.json(response);
    } catch (error) {
      console.error("Failed to generate Murf test voice:", error);
      const formatted = formatHttpError(error);
      res.status(formatted.statusCode).json(formatted.body);
    }
  });

  app.use(
    "/api/voice",
    requireApiAuth,
    voiceRateLimiter,
    createVoiceRouter({
      aiService: dependencies.aiService,
      commandRouter: dependencies.commandRouter,
      intentService: dependencies.intentService,
      memoryService: dependencies.memoryService,
      murfService: dependencies.murfService,
      realtimeHub: dependencies.realtimeHub,
    })
  );

  app.locals.dependencies = dependencies;
  return app;
}

function attachWebSocketServer(server, realtimeHub, memoryService) {
  const websocketServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const parsedUrl = new URL(request.url || "/", "http://localhost");
    if (parsedUrl.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    if (!isAuthorizedWebSocketUpgrade(request, parsedUrl)) {
      debugServerLog("WS REJECT", {
        origin: request.headers.origin || null,
        remoteAddress: request.socket?.remoteAddress || null,
      });
      rejectUnauthorizedUpgrade(socket);
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request, parsedUrl);
    });
  });

  websocketServer.on("connection", (websocket, request, parsedUrl) => {
    const sessionId =
      String(parsedUrl.searchParams.get("sessionId") || "").trim() || crypto.randomUUID();

    debugServerLog("WS CONNECT", sessionId);
    realtimeHub.attach(sessionId, websocket);
    Promise.resolve()
      .then(async () => {
        const session =
          memoryService && typeof memoryService.getSession === "function"
            ? await memoryService.getSession(sessionId)
            : null;

        if (websocket.readyState !== WebSocket.OPEN) {
          return;
        }

        debugServerLog("WS SEND", {
          sessionId,
          type: "session:ready",
        });
        websocket.send(
          JSON.stringify({
            payload: {
              connectedAt: new Date().toISOString(),
              session,
              sessionId,
              sessionMeta: session ? summarizeSession(session) : null,
            },
            type: "session:ready",
          })
        );
      })
      .catch((error) => {
        debugServerError("WS ERROR", error);
        if (websocket.readyState === WebSocket.OPEN) {
          debugServerLog("WS SEND", {
            sessionId,
            type: "error",
          });
          websocket.send(
            JSON.stringify({
              payload: {
                detail: error.message,
                sessionId,
              },
              type: "error",
            })
          );
        }
      });

    websocket.on("message", (message) => {
      debugServerLog("WS MESSAGE", {
        message: String(message || ""),
        sessionId,
      });
    });

    websocket.on("close", () => {
      debugServerLog("WS CLOSE", sessionId);
      realtimeHub.detach(sessionId, websocket);
    });

    websocket.on("error", (error) => {
      debugServerError("WS ERROR", error);
      console.error("WebSocket error:", error.message);
      realtimeHub.detach(sessionId, websocket);
    });
  });

  return websocketServer;
}

function createServer(options = {}) {
  const dependencies = options.dependencies || createDependencies(options);
  const app = createApp({ dependencies });
  const server = http.createServer(app);
  const websocketServer = attachWebSocketServer(
    server,
    dependencies.realtimeHub,
    dependencies.memoryService
  );
  const originalClose = server.close.bind(server);

  server.close = (callback) => {
    websocketServer.close();
    dependencies.realtimeHub.closeAll();

    if (dependencies.murfService && typeof dependencies.murfService.stopCleanupJob === "function") {
      dependencies.murfService.stopCleanupJob();
    }

    return originalClose(callback);
  };

  server.app = app;
  server.dependencies = dependencies;
  server.websocketServer = websocketServer;
  return server;
}

if (require.main === module) {
  (async () => {
    validateEnvironment();
    logEnvironmentValues();
    void probeOllama();
    await ensureRuntimeDirectories();
    await runStartupCleanup();

    const port = Number(process.env.PORT || 3000);
    const server = createServer();
    logStartupServices(server.dependencies);

    server.on("error", (error) => {
      console.error(`[startup] Server failed to start: ${error.message}`);
      console.error(error?.stack || error);
    });

    server.listen(port, () => {
      console.log(`Server ready: http://localhost:${port}`);
    });
  })();
}

module.exports = {
  canUseDebugRoute,
  cleanupExpiredFiles,
  createApp,
  createDependencies,
  createRealtimeHub,
  createServer,
  ensureRuntimeDirectories,
  extractBearerToken,
  formatHttpError,
  isAuthorizedWebSocketUpgrade,
  isLocalRequest,
  logStartupServices,
  logEnvironmentValues,
  processTestMurfRequest,
  processTestVoiceRequest,
  probeOllama,
  runStartupCleanup,
  runStartupDiagnostics,
  testOllamaConnection,
  validateEnvironment,
};
