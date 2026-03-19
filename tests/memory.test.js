const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { createMemoryService, getSessionFilePath } = require("../services/memory");

test("persists and trims session history", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vos-memory-"));
  const memoryService = createMemoryService({ baseDir: tempDir, maxTurns: 16 });

  for (let index = 0; index < 20; index += 1) {
    await memoryService.appendTurn("session-a", {
      role: index % 2 === 0 ? "user" : "assistant",
      source: "test",
      text: `turn-${index}`,
    });
  }

  const session = await memoryService.getSession("session-a");
  assert.equal(session.history.length, 16);
  assert.equal(session.history[0].text, "turn-4");
  assert.equal(session.history.at(-1).text, "turn-19");
});

test("returns simplified conversation history for AI usage", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vos-memory-"));
  const memoryService = createMemoryService({ baseDir: tempDir, maxTurns: 16 });

  await memoryService.appendTurn("session-b", {
    role: "user",
    source: "test",
    text: "hello",
  });
  await memoryService.appendTurn("session-b", {
    provider: "ollama",
    role: "assistant",
    source: "assistant",
    text: "hi there",
  });

  const history = await memoryService.getConversationHistory("session-b");

  assert.deepEqual(history, [
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi there" },
  ]);
});

test("stores the active mode in session memory and turns", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vos-memory-"));
  const memoryService = createMemoryService({ baseDir: tempDir, maxTurns: 16 });

  await memoryService.updatePreferences("session-c", {
    mode: "tutor",
  });

  await memoryService.appendTurn("session-c", {
    role: "user",
    source: "test",
    text: "Explain gravity",
  });

  const session = await memoryService.getSession("session-c");

  assert.equal(session.mode, "tutor");
  assert.equal(session.history[0].mode, "tutor");
});

test("normalizes and stores supported languages in session memory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vos-memory-"));
  const memoryService = createMemoryService({ baseDir: tempDir, maxTurns: 16 });

  await memoryService.updatePreferences("session-d", {
    language: "es-ES",
    targetLanguage: "fr-FR",
  });

  await memoryService.appendTurn("session-d", {
    language: "es-ES",
    role: "user",
    source: "test",
    text: "hola",
  });

  const session = await memoryService.getSession("session-d");
  const history = await memoryService.getConversationHistory("session-d");

  assert.equal(session.language, "es");
  assert.equal(session.targetLanguage, "fr");
  assert.equal(session.history[0].language, "es");
  assert.deepEqual(history, [{ role: "user", text: "hola" }]);
});

test("supports german and japanese language codes in session memory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vos-memory-"));
  const memoryService = createMemoryService({ baseDir: tempDir, maxTurns: 16 });

  await memoryService.updatePreferences("session-e", {
    language: "de-DE",
    targetLanguage: "ja-JP",
  });

  await memoryService.appendTurn("session-e", {
    language: "de-DE",
    role: "user",
    source: "test",
    text: "hallo",
  });

  const session = await memoryService.getSession("session-e");
  const history = await memoryService.getConversationHistory("session-e");

  assert.equal(session.language, "de");
  assert.equal(session.targetLanguage, "ja");
  assert.equal(session.history[0].language, "de");
  assert.deepEqual(history, [{ role: "user", text: "hallo" }]);
});

test("stores each session in data/memory style files with required fields and a 16-message limit", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vos-memory-"));
  const memoryService = createMemoryService({ baseDir: tempDir, maxTurns: 16 });

  await memoryService.saveSession("session-file", {
    language: "fr",
    mode: "translator",
    lastReply: "bonjour",
  });

  for (let index = 0; index < 18; index += 1) {
    await memoryService.addTurn(
      "session-file",
      index % 2 === 0 ? "user" : "assistant",
      `message-${index}`
    );
  }

  const filePath = getSessionFilePath(tempDir, "session-file");
  const rawFile = JSON.parse(await fs.readFile(filePath, "utf8"));
  const session = await memoryService.getSession("session-file");

  assert.equal(path.basename(filePath), "session-file.json");
  assert.equal(rawFile.mode, "translator");
  assert.equal(rawFile.language, "fr");
  assert.equal(typeof rawFile.lastReply, "string");
  assert.equal(Array.isArray(rawFile.history), true);
  assert.equal(rawFile.history.length, 16);
  assert.equal(session.sessionId, "session-file");
  assert.equal(session.history.length, 16);
});

test("memory service returns safe session objects even when the base directory is invalid", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vos-memory-invalid-"));
  const blockedPath = path.join(tempDir, "blocked-file");
  await fs.writeFile(blockedPath, "not-a-directory", "utf8");

  const memoryService = createMemoryService({ baseDir: blockedPath, maxTurns: 16 });

  const session = await memoryService.getSession("session-safe");
  const savedSession = await memoryService.saveSession("session-safe", {
    language: "es",
    mode: "tutor",
  });
  const turnSession = await memoryService.addTurn("session-safe", "user", "hola");
  const clearedSession = await memoryService.clearSession("session-safe", {
    language: "fr",
  });
  const history = await memoryService.getConversationHistory("session-safe");

  assert.equal(session.sessionId, "session-safe");
  assert.equal(savedSession.sessionId, "session-safe");
  assert.equal(savedSession.language, "es");
  assert.equal(savedSession.mode, "tutor");
  assert.equal(turnSession.sessionId, "session-safe");
  assert.equal(clearedSession.sessionId, "session-safe");
  assert.equal(clearedSession.language, "fr");
  assert.deepEqual(history, []);
});
