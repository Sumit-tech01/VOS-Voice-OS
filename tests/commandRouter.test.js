const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { createCommandRouter } = require("../services/commandRouter");
const { createMemoryService } = require("../services/memory");

async function createRouterHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vos-command-router-"));
  const memoryService = createMemoryService({ baseDir: tempDir, maxTurns: 16 });
  const murfService = {
    async generateVoice(text, options) {
      return `/generated/${options.sessionId}/voice.mp3`;
    },
  };

  return {
    memoryService,
    router: createCommandRouter({
      memoryService,
      murfService,
    }),
  };
}

test("command router handles mode switch commands and always returns text", async () => {
  const { memoryService, router } = await createRouterHarness();
  await memoryService.getSession("session-mode");

  const response = await router.route({
    detectedIntent: {
      entities: {},
      name: "conversation",
      type: "message",
    },
    language: "en",
    mode: "assistant",
    session: await memoryService.getSession("session-mode"),
    sessionId: "session-mode",
    source: "voice",
    targetLanguage: "en",
    text: "switch to tutor",
  });

  const session = await memoryService.getSession("session-mode");

  assert.equal(response.handled, true);
  assert.equal(typeof response.text, "string");
  assert.equal(typeof response.replyText, "string");
  assert.equal(response.text, response.replyText);
  assert.match(response.replyText, /mode switched to tutor/i);
  assert.equal(response.mode, "tutor");
  assert.equal(response.language, "en");
  assert.equal(session.mode, "tutor");
});

test("command router handles support alias and returns a spoken reply", async () => {
  const { memoryService, router } = await createRouterHarness();

  const response = await router.route({
    detectedIntent: null,
    language: "en",
    mode: "assistant",
    session: await memoryService.getSession("session-support"),
    sessionId: "session-support",
    source: "voice",
    targetLanguage: "en",
    text: "switch to support",
  });

  assert.equal(response.handled, true);
  assert.equal(response.mode, "customer-support");
  assert.equal(typeof response.text, "string");
  assert.equal(typeof response.replyText, "string");
  assert.equal(response.text, response.replyText);
  assert.ok(response.replyText.length > 0);
});

test("command router handles generic change language with guidance text", async () => {
  const { memoryService, router } = await createRouterHarness();

  const response = await router.route({
    detectedIntent: {
      entities: {},
      name: "conversation",
      type: "message",
    },
    language: "en",
    mode: "assistant",
    session: await memoryService.getSession("session-language"),
    sessionId: "session-language",
    source: "voice",
    targetLanguage: "en",
    text: "change language",
  });

  assert.equal(response.handled, true);
  assert.equal(typeof response.text, "string");
  assert.equal(typeof response.replyText, "string");
  assert.equal(response.text, response.replyText);
  assert.match(response.replyText, /change language to english/i);
});

test("command router handles clear memory, repeat, and help with text responses", async () => {
  const { memoryService, router } = await createRouterHarness();

  await memoryService.appendTurn("session-commands", {
    role: "assistant",
    source: "assistant",
    text: "Previous answer",
  });

  const repeatResponse = await router.route({
    detectedIntent: {
      entities: {},
      name: "repeat",
      type: "command",
    },
    language: "en",
    mode: "assistant",
    session: await memoryService.getSession("session-commands"),
    sessionId: "session-commands",
    source: "voice",
    targetLanguage: "en",
    text: "repeat",
  });

  const helpResponse = await router.route({
    detectedIntent: {
      entities: {},
      name: "help",
      type: "command",
    },
    language: "en",
    mode: "assistant",
    session: await memoryService.getSession("session-commands"),
    sessionId: "session-commands",
    source: "voice",
    targetLanguage: "en",
    text: "help",
  });

  const clearResponse = await router.route({
    detectedIntent: {
      entities: {},
      name: "clear-memory",
      type: "command",
    },
    language: "en",
    mode: "assistant",
    session: await memoryService.getSession("session-commands"),
    sessionId: "session-commands",
    source: "voice",
    targetLanguage: "en",
    text: "clear memory",
  });

  assert.equal(repeatResponse.replyText, "Previous answer");
  assert.match(helpResponse.replyText, /switch to tutor/i);
  assert.match(clearResponse.replyText, /session memory cleared/i);
  assert.equal(repeatResponse.text, repeatResponse.replyText);
  assert.equal(helpResponse.text, helpResponse.replyText);
  assert.equal(clearResponse.text, clearResponse.replyText);
});

test("command router returns a text field even when no command is handled", async () => {
  const { memoryService, router } = await createRouterHarness();

  const response = await router.route({
    detectedIntent: {
      entities: {},
      name: "conversation",
      type: "message",
    },
    language: "en",
    mode: "assistant",
    session: await memoryService.getSession("session-none"),
    sessionId: "session-none",
    source: "voice",
    targetLanguage: "en",
    text: "tell me something interesting",
  });

  assert.equal(response.handled, false);
  assert.equal(typeof response.text, "string");
  assert.equal(response.text, "");
  assert.equal(response.replyText, "");
  assert.equal(typeof response.replyText, "string");
  assert.equal(response.language, "en");
  assert.equal(response.mode, "assistant");
});
