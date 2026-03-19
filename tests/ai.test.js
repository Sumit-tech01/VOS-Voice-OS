const test = require("node:test");
const assert = require("node:assert/strict");

const axios = require("axios");
const {
  CONNECTION_REPLY_TEXT,
  FALLBACK_REPLY_TEXT,
  TIMEOUT_REPLY_TEXT,
  generateReply,
  getRequestTimeoutMs,
} = require("../services/ai");

test("generateReply sends assistant prompt to Ollama and returns response text", async () => {
  const originalPost = axios.post;
  let capturedUrl = null;
  let capturedBody = null;
  let capturedConfig = null;

  axios.post = async (url, body, config) => {
    capturedUrl = url;
    capturedBody = body;
    capturedConfig = config;

    return {
      data: {
        response: "Live Ollama reply",
      },
    };
  };

  try {
    const reply = await generateReply({
      history: [{ role: "assistant", text: "Previous reply" }],
      language: "en",
      mode: "assistant",
      targetLanguage: "en",
      text: "Tell me a short summary",
    });

    assert.equal(reply, "Live Ollama reply");
    assert.equal(capturedUrl, "http://localhost:11434/api/generate");
    assert.deepEqual(capturedBody, {
      model: process.env.OLLAMA_MODEL || "llama3:latest",
      prompt: [
        "You are a helpful AI assistant. Reply in English. Keep the answer short and natural.",
        "Conversation history:",
        "Assistant: Previous reply",
        "User: Tell me a short summary",
      ].join("\n"),
      stream: false,
    });
    assert.equal(capturedConfig.timeout, getRequestTimeoutMs());
  } finally {
    axios.post = originalPost;
  }
});

test("generateReply uses mode-specific prompts for all supported modes", async () => {
  const originalPost = axios.post;
  const prompts = [];

  axios.post = async (url, body) => {
    prompts.push(body.prompt);

    return {
      data: {
        response: "Mode-aware reply",
      },
    };
  };

  try {
    const modes = ["assistant", "tutor", "translator", "customer-support"];

    for (const mode of modes) {
      const reply = await generateReply({
        history: [{ role: "user", text: "previous turn" }],
        language: "en",
        mode,
        targetLanguage: "hi",
        text: "hello there",
      });

      assert.equal(reply, "Mode-aware reply");
    }

    assert.deepEqual(prompts, [
      "You are a helpful AI assistant. Reply in English. Keep the answer short and natural.\nConversation history:\nUser: previous turn\nUser: hello there",
      "You are a teacher. Explain clearly. Reply in English. Keep the answer short and easy to understand.\nConversation history:\nUser: previous turn\nUser: hello there",
      "You translate text only. Translate from English to Hindi. Return only the translated text.\nConversation history:\nUser: previous turn\nUser: hello there",
      "You are a polite support agent. Answer short. Reply in English. Keep the answer calm and practical.\nConversation history:\nUser: previous turn\nUser: hello there",
    ]);
  } finally {
    axios.post = originalPost;
  }
});

test("generateReply returns fallback text if Ollama request fails", async () => {
  const originalPost = axios.post;

  axios.post = async () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:11434");
    error.code = "ECONNREFUSED";
    throw error;
  };

  try {
    const reply = await generateReply({
      history: [],
      language: "en",
      mode: "customer-support",
      targetLanguage: "en",
      text: "My order is delayed",
    });

    assert.equal(reply, CONNECTION_REPLY_TEXT);
  } finally {
    axios.post = originalPost;
  }
});

test("generateReply returns a timeout-specific message when Ollama is slow", async () => {
  const originalPost = axios.post;

  axios.post = async () => {
    const error = new Error("timeout of 30000ms exceeded");
    error.code = "ECONNABORTED";
    throw error;
  };

  try {
    const reply = await generateReply({
      history: [],
      language: "en",
      mode: "assistant",
      targetLanguage: "en",
      text: "hello",
    });

    assert.equal(typeof reply, "string");
    assert.equal(reply, TIMEOUT_REPLY_TEXT);
  } finally {
    axios.post = originalPost;
  }
});

test("generateReply returns model-not-found guidance for 404 responses", async () => {
  const originalPost = axios.post;

  axios.post = async () => {
    const error = new Error("Request failed with status code 404");
    error.response = {
      status: 404,
    };
    throw error;
  };

  try {
    const reply = await generateReply({
      history: [],
      language: "en",
      mode: "assistant",
      targetLanguage: "en",
      text: "hello",
    });

    assert.equal(
      reply,
      `AI model not found. Please run: ollama pull ${process.env.OLLAMA_MODEL || "llama3:latest"}`
    );
  } finally {
    axios.post = originalPost;
  }
});

test("generateReply always returns a string even when Ollama response is empty", async () => {
  const originalPost = axios.post;

  axios.post = async () => ({
    data: {
      response: "",
    },
  });

  try {
    const reply = await generateReply({
      history: [],
      language: "en",
      mode: "assistant",
      targetLanguage: "en",
      text: "hello",
    });

    assert.equal(typeof reply, "string");
    assert.equal(reply, FALLBACK_REPLY_TEXT);
  } finally {
    axios.post = originalPost;
  }
});

test("generateReply does not duplicate the current user turn when history already includes it", async () => {
  const originalPost = axios.post;
  let capturedBody = null;

  axios.post = async (url, body) => {
    capturedBody = body;

    return {
      data: {
        response: "Single-turn reply",
      },
    };
  };

  try {
    const reply = await generateReply({
      history: [{ role: "user", text: "what is your name" }],
      language: "en",
      mode: "assistant",
      targetLanguage: "en",
      text: "what is your name",
    });

    assert.equal(reply, "Single-turn reply");
    assert.equal(
      capturedBody.prompt,
      [
        "You are a helpful AI assistant. Reply in English. Keep the answer short and natural.",
        "Conversation history:",
        "User: what is your name",
      ].join("\n")
    );
  } finally {
    axios.post = originalPost;
  }
});
