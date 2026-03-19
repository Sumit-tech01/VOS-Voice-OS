const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");

const {
  canUseDebugRoute,
  cleanupExpiredFiles,
  createRealtimeHub,
  createServer,
  extractBearerToken,
  formatHttpError,
  isAuthorizedWebSocketUpgrade,
  logEnvironmentValues,
  processTestMurfRequest,
  processTestVoiceRequest,
  probeOllama,
  runStartupCleanup,
  validateEnvironment,
} = require("../server");

test("processTestMurfRequest returns audio URL for the demo phrase", async () => {
  const response = await processTestMurfRequest({
    murfService: {
      generateVoice: async (text, options) => {
        assert.equal(text, "Hello this is VOS voice system");
        assert.equal(options.sessionId, "test-murf");
        return "/generated/test-murf/voice_123.mp3";
      },
    },
  });

  assert.equal(response.audioUrl, "/generated/test-murf/voice_123.mp3");
  assert.equal(response.sessionId, "test-murf");
  assert.equal(response.text, "Hello this is VOS voice system");
});

test("processTestVoiceRequest validates text", async () => {
  await assert.rejects(
    () =>
      processTestVoiceRequest(
        {
          sessionId: "123",
          text: "   ",
        },
        {
          murfService: {
            generateVoice: async () => "/generated/123/voice_123.mp3",
          },
        }
      ),
    (error) => error.code === "MURF_VALIDATION_ERROR" && error.statusCode === 400
  );
});

test("formatHttpError returns clean JSON metadata for Murf errors", () => {
  const formatted = formatHttpError({
    code: "MURF_API_ERROR",
    message: "Murf upstream failed",
    statusCode: 502,
  });

  assert.deepEqual(formatted, {
    body: {
      code: "MURF_API_ERROR",
      error: "Murf upstream failed",
    },
    statusCode: 502,
  });
});

test("validateEnvironment checks required startup variables and logs masked values", () => {
  const env = {
    AI_PROVIDER: "ollama",
    API_SECRET: "secret-1234567890",
    DEBUG: "true",
    MURF_API_KEY: "ap2_1234567890_secret",
    MURF_API_URL: "https://api.murf.ai/v1/speech/generate",
    OLLAMA_BASE_URL: "http://localhost:11434",
    OLLAMA_MODEL: "llama3:latest",
    PORT: "3000",
  };
  const originalLog = console.log;
  const lines = [];

  console.log = (...args) => {
    lines.push(args.join(" "));
  };

  try {
    assert.deepEqual(validateEnvironment(env), {
      isValid: true,
      missing: [],
    });

    logEnvironmentValues(env);
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.includes("PORT = 3000"), true);
  assert.equal(lines.includes("DEBUG = true"), true);
  assert.equal(
    lines.includes("API_SECRET = secr...7890 [length:17]"),
    true
  );
  assert.equal(
    lines.includes("MURF_API_KEY = ap2_...cret [length:21]"),
    true
  );
  assert.equal(
    lines.includes("MURF_API_URL = https://api.murf.ai/v1/speech/generate"),
    true
  );
  assert.equal(lines.includes("AI_PROVIDER = ollama"), true);
  assert.equal(lines.includes("OLLAMA_BASE_URL = http://localhost:11434"), true);
  assert.equal(lines.includes("OLLAMA_MODEL = llama3:latest"), true);
});

test("extractBearerToken parses Authorization bearer tokens", () => {
  assert.equal(extractBearerToken("Bearer local-dev-secret"), "local-dev-secret");
  assert.equal(extractBearerToken("bearer   another-token"), "another-token");
  assert.equal(extractBearerToken("Token nope"), "");
  assert.equal(extractBearerToken(""), "");
});

test("debug routes are only exposed locally by default", () => {
  assert.equal(
    canUseDebugRoute({
      headers: {
        host: "localhost:3000",
      },
      ip: "127.0.0.1",
      socket: {
        remoteAddress: "127.0.0.1",
      },
    }),
    true
  );

  assert.equal(
    canUseDebugRoute({
      headers: {
        host: "voice.example.com",
      },
      ip: "203.0.113.20",
      socket: {
        remoteAddress: "203.0.113.20",
      },
    }),
    false
  );
});

test("websocket upgrade auth allows localhost and remote token access", () => {
  const localAllowed = isAuthorizedWebSocketUpgrade(
    {
      headers: {
        host: "localhost:3000",
      },
      socket: {
        remoteAddress: "127.0.0.1",
      },
    },
    new URL("http://localhost/ws?sessionId=abc"),
    {
      API_SECRET: "local-dev-secret",
      NODE_ENV: "development",
    }
  );

  const remoteAllowed = isAuthorizedWebSocketUpgrade(
    {
      headers: {
        host: "voice.example.com",
        origin: "https://voice.example.com",
      },
      socket: {
        remoteAddress: "203.0.113.20",
      },
    },
    new URL("http://voice.example.com/ws?sessionId=abc&token=local-dev-secret"),
    {
      API_SECRET: "local-dev-secret",
      NODE_ENV: "production",
    }
  );

  const remoteRejected = isAuthorizedWebSocketUpgrade(
    {
      headers: {
        host: "voice.example.com",
        origin: "https://voice.example.com",
      },
      socket: {
        remoteAddress: "203.0.113.20",
      },
    },
    new URL("http://voice.example.com/ws?sessionId=abc"),
    {
      API_SECRET: "local-dev-secret",
      NODE_ENV: "production",
    }
  );

  assert.equal(localAllowed, true);
  assert.equal(remoteAllowed, true);
  assert.equal(remoteRejected, false);
});

test("probeOllama logs success when the configured model is available", async () => {
  const originalGet = global.process.env.OLLAMA_BASE_URL;
  const originalModel = global.process.env.OLLAMA_MODEL;
  const originalLog = console.log;
  const lines = [];

  process.env.OLLAMA_BASE_URL = "http://localhost:11434";
  process.env.OLLAMA_MODEL = "llama3:latest";
  console.log = (...args) => {
    lines.push(args.join(" "));
  };

  try {
    await probeOllama({
      get: async () => ({
        data: {
          models: [{ name: "llama3:latest" }],
        },
      }),
    });
  } finally {
    process.env.OLLAMA_BASE_URL = originalGet;
    process.env.OLLAMA_MODEL = originalModel;
    console.log = originalLog;
  }

  assert.equal(
    lines.includes('[STARTUP] ✅ Ollama OK — model "llama3:latest" ready.'),
    true
  );
});

test("runStartupCleanup removes audio and memory files older than one hour", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vos-startup-cleanup-"));
  const audioDir = path.join(tempRoot, "generated");
  const memoryDir = path.join(tempRoot, "memory");

  await fs.mkdir(path.join(audioDir, "session-a"), { recursive: true });
  await fs.mkdir(memoryDir, { recursive: true });

  const oldAudioPath = path.join(audioDir, "session-a", "voice_old.mp3");
  const freshAudioPath = path.join(audioDir, "session-a", "voice_fresh.mp3");
  const oldMemoryPath = path.join(memoryDir, "session-old.json");
  const freshMemoryPath = path.join(memoryDir, "session-fresh.json");

  await fs.writeFile(oldAudioPath, "old-audio");
  await fs.writeFile(freshAudioPath, "fresh-audio");
  await fs.writeFile(oldMemoryPath, "{}");
  await fs.writeFile(freshMemoryPath, "{}");

  const oldTime = new Date(Date.now() - 61 * 60 * 1000);
  const freshTime = new Date();
  await fs.utimes(oldAudioPath, oldTime, oldTime);
  await fs.utimes(freshAudioPath, freshTime, freshTime);
  await fs.utimes(oldMemoryPath, oldTime, oldTime);
  await fs.utimes(freshMemoryPath, freshTime, freshTime);

  const result = await runStartupCleanup({
    audioDir,
    maxAgeMs: 60 * 60 * 1000,
    memoryDir,
  });

  assert.equal(result.audioCleanup.deletedFiles.includes(oldAudioPath), true);
  assert.equal(result.memoryCleanup.deletedFiles.includes(oldMemoryPath), true);
  assert.notEqual(await fs.stat(freshAudioPath).catch(() => null), null);
  assert.notEqual(await fs.stat(freshMemoryPath).catch(() => null), null);
});

test("cleanupExpiredFiles preserves hidden placeholder files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vos-cleanup-hidden-"));
  const audioDir = path.join(tempRoot, "generated");

  await fs.mkdir(audioDir, { recursive: true });
  await fs.writeFile(path.join(audioDir, ".gitkeep"), "");

  const result = await cleanupExpiredFiles(audioDir, 60 * 60 * 1000);

  assert.deepEqual(result.deletedFiles, []);
  assert.notEqual(await fs.stat(path.join(audioDir, ".gitkeep")).catch(() => null), null);
});

test("websocket server emits session:ready on /ws?sessionId=xxx", async (t) => {
  const dependencies = {
    aiService: {
      generateReply: async () => ({
        model: "mock-model",
        provider: "mock-ai",
        text: "Mock reply",
      }),
    },
    commandRouter: {
      route: async () => ({ handled: false }),
    },
    intentService: {
      detectIntent: () => ({ entities: {}, name: "conversation", type: "message" }),
      getSupportedLanguages: () => [],
      getSupportedModes: () => [],
    },
    memoryService: {
      getSession: async (sessionId) => ({
        history: [],
        language: "en",
        lastAssistantResponse: "",
        mode: "assistant",
        sessionId,
        targetLanguage: "en",
        timestamp: "2026-03-15T00:00:00.000Z",
        updatedAt: "2026-03-15T00:00:00.000Z",
      }),
    },
    murfService: {
      stopCleanupJob: () => {},
    },
    realtimeHub: createRealtimeHub(),
  };

  const server = createServer({ dependencies });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    if (error && error.code === "EPERM") {
      t.skip("Sandbox blocks binding to a local port for websocket verification.");
      return;
    }

    throw error;
  }

  const { port } = server.address();
  const message = await new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionId=session-ws`);

    client.once("message", (raw) => {
      client.close();
      resolve(JSON.parse(String(raw)));
    });

    client.once("error", reject);
  });

  await new Promise((resolve) => server.close(resolve));

  assert.equal(message.type, "session:ready");
  assert.equal(message.payload.sessionId, "session-ws");
  assert.equal(message.payload.session.sessionId, "session-ws");
});
