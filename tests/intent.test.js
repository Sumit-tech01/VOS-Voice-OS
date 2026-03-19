const test = require("node:test");
const assert = require("node:assert/strict");

const { createIntentService } = require("../services/intent");

test("detects mode switch commands", () => {
  const intentService = createIntentService();
  const intent = intentService.detectIntent("switch to tutor mode");

  assert.equal(intent.type, "command");
  assert.equal(intent.name, "mode-switch");
  assert.equal(intent.entities.mode, "tutor");
});

test("detects assistant mode command", () => {
  const intentService = createIntentService();
  const intent = intentService.detectIntent("switch to assistant");

  assert.equal(intent.type, "command");
  assert.equal(intent.name, "mode-switch");
  assert.equal(intent.entities.mode, "assistant");
});

test("detects translator mode command", () => {
  const intentService = createIntentService();
  const intent = intentService.detectIntent("switch to translator");

  assert.equal(intent.type, "command");
  assert.equal(intent.name, "mode-switch");
  assert.equal(intent.entities.mode, "translator");
});

test("detects support mode alias command", () => {
  const intentService = createIntentService();
  const intent = intentService.detectIntent("switch to support");

  assert.equal(intent.type, "command");
  assert.equal(intent.name, "mode-switch");
  assert.equal(intent.entities.mode, "customer-support");
});

test("detects regular conversation", () => {
  const intentService = createIntentService();
  const intent = intentService.detectIntent("Explain the water cycle");

  assert.equal(intent.type, "message");
  assert.equal(intent.name, "conversation");
});

test("keeps translation demo prompt as conversation", () => {
  const intentService = createIntentService();
  const intent = intentService.detectIntent("translate hello to hindi");

  assert.equal(intent.type, "message");
  assert.equal(intent.name, "conversation");
});

test("detects explicit target language commands", () => {
  const intentService = createIntentService();
  const intent = intentService.detectIntent("set target language to hindi");

  assert.equal(intent.type, "command");
  assert.equal(intent.name, "target-language-switch");
  assert.equal(intent.entities.language, "hi");
});

test("detects language switch to hindi", () => {
  const intentService = createIntentService();
  const intent = intentService.detectIntent("change language to hindi");

  assert.equal(intent.type, "command");
  assert.equal(intent.name, "language-switch");
  assert.equal(intent.entities.language, "hi");
});

test("detects language switch to english", () => {
  const intentService = createIntentService();
  const intent = intentService.detectIntent("change language to english");

  assert.equal(intent.type, "command");
  assert.equal(intent.name, "language-switch");
  assert.equal(intent.entities.language, "en");
});

test("detects language switch to spanish", () => {
  const intentService = createIntentService();
  const intent = intentService.detectIntent("change language to spanish");

  assert.equal(intent.type, "command");
  assert.equal(intent.name, "language-switch");
  assert.equal(intent.entities.language, "es");
});
