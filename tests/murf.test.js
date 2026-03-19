const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");

const { createMurfService, generateVoice } = require("../services/murf");

async function createTempOutputDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vos-murf-"));
}

test("generateVoice returns null for empty text instead of throwing", async () => {
  const outputDir = await createTempOutputDir();
  const service = createMurfService({
    apiKey: "test-key",
    autoCleanup: false,
    outputDir,
  });

  const audioUrl = await service.generateVoice("   ");
  assert.equal(audioUrl, null);
});

test("generateVoice returns null when MURF_API_KEY is missing", async () => {
  const outputDir = await createTempOutputDir();
  const service = createMurfService({
    apiKey: "",
    autoCleanup: false,
    outputDir,
  });

  const audioUrl = await service.generateVoice("Hello");
  assert.equal(audioUrl, null);
});

test("generateVoice resolves default voices, saves base64 audio, and reuses session cache", async () => {
  const outputDir = await createTempOutputDir();
  let postCalls = 0;
  let capturedVoiceId = null;
  const httpClient = {
    post: async (url, payload) => {
      postCalls += 1;
      capturedVoiceId = payload.voiceId;
      return {
        data: Readable.from([
          JSON.stringify({
            audioBase64: Buffer.from("mock-audio-base64").toString("base64"),
          }),
        ]),
        headers: {
          "content-type": "application/json",
        },
        status: 200,
      };
    },
  };

  const service = createMurfService({
    apiKey: "test-key",
    autoCleanup: false,
    httpClient,
    outputDir,
  });

  const firstUrl = await service.generateVoice("Namaste", {
    language: "hi-IN",
    sessionId: "session-cache",
  });
  const secondUrl = await service.generateVoice("Namaste", {
    language: "hi-IN",
    sessionId: "session-cache",
  });

  assert.equal(capturedVoiceId, "hi-IN-khyati");
  assert.equal(postCalls, 1);
  assert.equal(firstUrl, secondUrl);

  const savedFile = path.join(outputDir, "session-cache", path.basename(firstUrl));
  const fileBuffer = await fs.readFile(savedFile);
  assert.equal(fileBuffer.toString("utf8"), "mock-audio-base64");
});

test("generateVoice sends api-key headers and falls back from FALCON to GEN2", async () => {
  const outputDir = await createTempOutputDir();
  const capturedRequests = [];
  const httpClient = {
    post: async (url, payload, config) => {
      capturedRequests.push({
        config,
        payload,
        url,
      });

      if (capturedRequests.length === 1) {
        const error = new Error("Request failed with status code 400");
        error.response = {
          data: Buffer.from(
            JSON.stringify({
              errorCode: "BAD_REQUEST",
              errorMessage: "Invalid value FALCON for ModelVersion. Possible value: GEN2",
            })
          ),
          headers: {},
          status: 400,
        };
        throw error;
      }

      return {
        data: Readable.from([
          JSON.stringify({
            audioBase64: Buffer.from("fallback-audio").toString("base64"),
          }),
        ]),
        headers: {
          "content-type": "application/json",
        },
        status: 200,
      };
    },
  };

  const service = createMurfService({
    apiKey: "test-key",
    autoCleanup: false,
    httpClient,
    outputDir,
  });

  const relativeUrl = await service.generateVoice("Hello there", {
    sessionId: "fallback-model",
  });

  assert.equal(capturedRequests.length, 2);
  assert.equal(capturedRequests[0].config.headers["api-key"], "test-key");
  assert.equal(capturedRequests[0].payload.text, "Hello there");
  assert.equal(capturedRequests[0].payload.format, "MP3");
  assert.equal(capturedRequests[0].payload.modelVersion, "FALCON");
  assert.equal(capturedRequests[1].payload.modelVersion, "GEN2");
  assert.equal(relativeUrl.startsWith("/generated/fallback-model/"), true);
});

test("generateVoice keeps cache isolated across sessions", async () => {
  const outputDir = await createTempOutputDir();
  let postCalls = 0;
  const httpClient = {
    post: async () => {
      postCalls += 1;
      return {
        data: Readable.from([
          JSON.stringify({
            audioBase64: Buffer.from(`audio-${postCalls}`).toString("base64"),
          }),
        ]),
        headers: {
          "content-type": "application/json",
        },
        status: 200,
      };
    },
  };

  const service = createMurfService({
    apiKey: "test-key",
    autoCleanup: false,
    httpClient,
    outputDir,
  });

  const firstUrl = await service.generateVoice("hello", {
    sessionId: "one",
  });
  const secondUrl = await service.generateVoice("hello", {
    sessionId: "two",
  });

  assert.equal(postCalls, 2);
  assert.notEqual(firstUrl, secondUrl);
});

test("generateVoice deduplicates concurrent stream requests in the same session", async () => {
  const outputDir = await createTempOutputDir();
  let postCalls = 0;
  const httpClient = {
    post: async () => {
      postCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        data: Readable.from([Buffer.from("stream-audio")]),
        headers: {
          "content-type": "audio/mpeg",
        },
        status: 200,
      };
    },
  };

  const service = createMurfService({
    apiKey: "test-key",
    autoCleanup: false,
    httpClient,
    outputDir,
  });

  const [firstUrl, secondUrl] = await Promise.all([
    service.generateVoice("same text", {
      lowLatency: true,
      sessionId: "concurrent",
    }),
    service.generateVoice("same text", {
      lowLatency: true,
      sessionId: "concurrent",
    }),
  ]);

  assert.equal(postCalls, 1);
  assert.equal(firstUrl, secondUrl);
});

test("generateVoice supports legacy locale and downloads audio from a returned URL", async () => {
  const outputDir = await createTempOutputDir();
  let capturedVoiceId = null;
  const httpClient = {
    get: async () => ({
      data: Readable.from([Buffer.from("downloaded-audio")]),
      status: 200,
    }),
    post: async (url, payload) => {
      capturedVoiceId = payload.voiceId;
      return {
        data: Readable.from([
          JSON.stringify({
            audioUrl: "https://files.example.com/audio.mp3",
          }),
        ]),
        headers: {
          "content-type": "application/json",
        },
        status: 200,
      };
    },
  };

  const service = createMurfService({
    apiKey: "test-key",
    autoCleanup: false,
    httpClient,
    outputDir,
  });

  const relativeUrl = await service.generateVoice("Bonjour", {
    locale: "fr-FR",
    sessionId: "legacy-locale",
  });
  const fileBuffer = await fs.readFile(
    path.join(outputDir, "legacy-locale", path.basename(relativeUrl))
  );

  assert.equal(capturedVoiceId, "fr-FR-axel");
  assert.equal(fileBuffer.toString("utf8"), "downloaded-audio");
});

test("generateVoice resolves german and japanese voices from short language codes", async () => {
  const outputDir = await createTempOutputDir();
  const capturedVoices = [];
  const httpClient = {
    post: async (url, payload) => {
      capturedVoices.push(payload.voiceId);
      return {
        data: Readable.from([
          JSON.stringify({
            audioBase64: Buffer.from("polyglot-audio").toString("base64"),
          }),
        ]),
        headers: {
          "content-type": "application/json",
        },
        status: 200,
      };
    },
  };

  const service = createMurfService({
    apiKey: "test-key",
    autoCleanup: false,
    httpClient,
    outputDir,
  });

  await service.generateVoice("Guten Tag", {
    language: "de",
    sessionId: "de-session",
  });
  await service.generateVoice("Konnichiwa", {
    language: "ja",
    sessionId: "ja-session",
  });

  assert.deepEqual(capturedVoices, ["de-DE-lia", "ja-JP-kenji"]);
});

test("generateVoice returns null when upstream Murf request fails", async () => {
  const outputDir = await createTempOutputDir();
  const httpClient = {
    post: async () => {
      const error = new Error("Request failed with status code 500");
      error.response = {
        data: Buffer.from("upstream failed"),
        headers: {},
        status: 500,
      };
      throw error;
    },
  };

  const service = createMurfService({
    apiKey: "test-key",
    autoCleanup: false,
    httpClient,
    outputDir,
  });

  const audioUrl = await service.generateVoice("Hello");
  assert.equal(audioUrl, null);
});

test("cleanupGeneratedAudio removes expired files and prunes stale cache entries", async () => {
  const outputDir = await createTempOutputDir();
  const httpClient = {
    post: async () => ({
      data: Readable.from([
        JSON.stringify({
          audioBase64: Buffer.from("old-audio").toString("base64"),
        }),
      ]),
      headers: {
        "content-type": "application/json",
      },
      status: 200,
    }),
  };

  const service = createMurfService({
    apiKey: "test-key",
    autoCleanup: false,
    httpClient,
    outputDir,
  });

  const relativeUrl = await service.generateVoice("expire me", {
    sessionId: "cleanup",
  });
  const filePath = path.join(outputDir, "cleanup", path.basename(relativeUrl));
  const oldTime = new Date(Date.now() - 31 * 60 * 1000);
  await fs.utimes(filePath, oldTime, oldTime);

  const result = await service.cleanupGeneratedAudio();
  const stats = await fs.stat(filePath).catch(() => null);

  assert.equal(stats, null);
  assert.equal(result.deletedFiles.includes(filePath), true);
});

test("top-level generateVoice keeps the requested API contract", async () => {
  const originalApiKey = process.env.MURF_API_KEY;
  process.env.MURF_API_KEY = "";

  try {
    const audioUrl = await generateVoice("hello from singleton");
    assert.equal(audioUrl, null);
  } finally {
    process.env.MURF_API_KEY = originalApiKey;
  }
});
