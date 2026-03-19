const test = require("node:test");
const assert = require("node:assert/strict");
const { processPreferencesRequest, processVoiceMessage } = require("../routes/voice");

test("POST /message returns response payload and emits realtime events", async () => {
  const events = [];
  const session = {
    history: [],
    language: "en-US",
    lastAssistantResponse: "",
    mode: "assistant",
    sessionId: "session-1",
    targetLanguage: "en-US",
  };

  const memoryService = {
    appendTurn: async (sessionId, turn) => {
      session.history.push(turn);
      if (turn.role === "assistant") {
        session.lastAssistantResponse = turn.text;
      }
      return session;
    },
    clearSession: async () => session,
    getSession: async () => session,
    updatePreferences: async (sessionId, updates) => {
      Object.assign(session, updates);
      return session;
    },
    updateSession: async (sessionId, updates) => {
      Object.assign(session, updates);
      return session;
    },
  };

  const response = await processVoiceMessage(
    {
      language: "en-US",
      mode: "assistant",
      sessionId: "session-1",
      text: "Hello there",
      source: "voice",
      targetLanguage: "en-US",
      turnId: "turn-1",
    },
    {
      aiService: {
        generateReply: async () => {
          assert.deepEqual(events.map((event) => event.type), ["assistant:thinking"]);

          return {
            model: "mock-model",
            provider: "mock-ai",
            text: "Mock assistant reply",
          };
        },
      },
      commandRouter: {
        route: async () => ({ handled: false }),
      },
      intentService: {
        detectIntent: () => ({ entities: {}, name: "conversation", type: "message" }),
      },
      memoryService,
      murfService: {
        generateVoice: async () => {
          assert.deepEqual(events.map((event) => event.type), [
            "assistant:thinking",
            "assistant:text",
          ]);
          return "/generated/session-1/reply.mp3";
        },
      },
      realtimeHub: {
        send: (sessionId, type, payload) => {
          events.push({ payload, sessionId, type });
        },
      },
    }
  );

  assert.equal(response.replyText, "Mock assistant reply");
  assert.equal(response.audioUrl, "/generated/session-1/reply.mp3");
  assert.equal(response.turnId, "turn-1");
  assert.deepEqual(events.map((event) => event.type), [
    "assistant:thinking",
    "assistant:text",
    "assistant:audio",
  ]);
  assert.equal(events.every((event) => event.payload.turnId === "turn-1"), true);
});

test("POST /message keeps REST response and emits websocket events for commands", async () => {
  const events = [];
  const session = {
    history: [],
    language: "en",
    lastAssistantResponse: "Earlier reply",
    mode: "assistant",
    sessionId: "session-2",
    targetLanguage: "en",
  };

  const memoryService = {
    appendTurn: async (sessionId, turn) => {
      session.history.push(turn);
      if (turn.role === "assistant") {
        session.lastAssistantResponse = turn.text;
      }
      return session;
    },
    clearSession: async () => session,
    getConversationHistory: async () => [
      { role: "user", text: "repeat" },
      { role: "assistant", text: "Earlier reply" },
    ],
    getSession: async () => session,
    updatePreferences: async (sessionId, updates) => {
      Object.assign(session, updates);
      return session;
    },
    updateSession: async (sessionId, updates) => {
      Object.assign(session, updates);
      return session;
    },
  };

  const response = await processVoiceMessage(
    {
      language: "en",
      mode: "assistant",
      sessionId: "session-2",
      text: "repeat",
      source: "voice",
      targetLanguage: "en",
    },
    {
      aiService: {
        generateReply: async () => {
          throw new Error("AI should not be called for handled commands");
        },
      },
      commandRouter: {
        route: async () => ({
          audioUrl: "/generated/session-2/repeat.mp3",
          clientAction: null,
          events: [],
          handled: true,
          language: "en",
          mode: "assistant",
          replyText: "Earlier reply",
          targetLanguage: "en",
          warning: null,
        }),
      },
      intentService: {
        detectIntent: () => ({ entities: {}, name: "repeat", type: "command" }),
      },
      memoryService,
      murfService: {
        generateVoice: async () => "/generated/session-2/repeat.mp3",
      },
      realtimeHub: {
        send: (sessionId, type, payload) => {
          events.push({ payload, sessionId, type });
        },
      },
    }
  );

  assert.equal(response.replyText, "Earlier reply");
  assert.equal(response.audioUrl, "/generated/session-2/repeat.mp3");
  assert.deepEqual(events.map((event) => event.type), [
    "assistant:thinking",
    "assistant:text",
    "assistant:audio",
  ]);
});

test("POST /message emits mode:changed for mode switch commands", async () => {
  const events = [];
  const session = {
    history: [],
    language: "en",
    lastAssistantResponse: "",
    mode: "assistant",
    sessionId: "session-4",
    targetLanguage: "en",
  };

  const memoryService = {
    appendTurn: async (sessionId, turn) => {
      session.history.push(turn);
      if (turn.role === "assistant") {
        session.lastAssistantResponse = turn.text;
      }
      return session;
    },
    clearSession: async () => session,
    getSession: async () => session,
    updatePreferences: async (sessionId, updates) => {
      Object.assign(session, updates);
      return session;
    },
    updateSession: async (sessionId, updates) => {
      Object.assign(session, updates);
      return session;
    },
  };

  const response = await processVoiceMessage(
    {
      language: "en",
      mode: "assistant",
      sessionId: "session-4",
      text: "switch to tutor",
      source: "voice",
      targetLanguage: "en",
      turnId: "turn-mode",
    },
    {
      aiService: {
        generateReply: async () => {
          throw new Error("AI should not be called for handled commands");
        },
      },
      commandRouter: {
        route: async () => ({
          audioUrl: "/generated/session-4/mode.mp3",
          clientAction: null,
          events: [
            {
              payload: {
                mode: "tutor",
                sessionId: "session-4",
              },
              type: "mode:changed",
            },
          ],
          handled: true,
          language: "en",
          mode: "tutor",
          replyText: "Mode switched to tutor. I am ready for your next request.",
          targetLanguage: "en",
          warning: null,
        }),
      },
      intentService: {
        detectIntent: () => ({
          entities: { mode: "tutor" },
          name: "mode-switch",
          type: "command",
        }),
      },
      memoryService,
      murfService: {
        generateVoice: async () => "/generated/session-4/mode.mp3",
      },
      realtimeHub: {
        send: (sessionId, type, payload) => {
          events.push({ payload, sessionId, type });
        },
      },
    }
  );

  assert.equal(response.mode, "tutor");
  assert.equal(response.turnId, "turn-mode");
  assert.deepEqual(events.map((event) => event.type), [
    "assistant:thinking",
    "mode:changed",
    "assistant:text",
    "assistant:audio",
  ]);
  assert.equal(events.every((event) => event.payload.turnId === "turn-mode"), true);
});

test("POST /message emits memory:cleared for clear memory commands", async () => {
  const events = [];
  const session = {
    history: [],
    language: "en",
    lastAssistantResponse: "",
    mode: "assistant",
    sessionId: "session-5",
    targetLanguage: "en",
  };

  const memoryService = {
    appendTurn: async (sessionId, turn) => {
      session.history.push(turn);
      if (turn.role === "assistant") {
        session.lastAssistantResponse = turn.text;
      }
      return session;
    },
    clearSession: async () => session,
    getSession: async () => session,
    updatePreferences: async (sessionId, updates) => {
      Object.assign(session, updates);
      return session;
    },
    updateSession: async (sessionId, updates) => {
      Object.assign(session, updates);
      return session;
    },
  };

  const response = await processVoiceMessage(
    {
      language: "en",
      mode: "assistant",
      sessionId: "session-5",
      text: "clear memory",
      source: "voice",
      targetLanguage: "en",
    },
    {
      aiService: {
        generateReply: async () => {
          throw new Error("AI should not be called for handled commands");
        },
      },
      commandRouter: {
        route: async () => ({
          audioUrl: null,
          clientAction: null,
          events: [
            {
              payload: {
                sessionId: "session-5",
              },
              type: "memory:cleared",
            },
          ],
          handled: true,
          language: "en",
          mode: "assistant",
          replyText: "Session memory cleared. Ready for a new conversation.",
          targetLanguage: "en",
          warning: null,
        }),
      },
      intentService: {
        detectIntent: () => ({
          entities: {},
          name: "clear-memory",
          type: "command",
        }),
      },
      memoryService,
      murfService: {
        generateVoice: async () => null,
      },
      realtimeHub: {
        send: (sessionId, type, payload) => {
          events.push({ payload, sessionId, type });
        },
      },
    }
  );

  assert.match(response.replyText, /memory cleared/i);
  assert.deepEqual(events.map((event) => event.type), [
    "assistant:thinking",
    "memory:cleared",
    "assistant:text",
  ]);
});

test("POST /preferences persists mode and language updates and emits session sync events", async () => {
  const events = [];
  const session = {
    history: [],
    language: "en",
    lastAssistantResponse: "",
    lastAudioUrl: null,
    mode: "assistant",
    sessionId: "session-3",
    targetLanguage: "en",
    updatedAt: "2026-03-14T10:00:00.000Z",
  };

  const memoryService = {
    getSession: async () => ({ ...session }),
    updatePreferences: async (sessionId, updates) => {
      Object.assign(session, updates, {
        updatedAt: "2026-03-14T10:01:00.000Z",
      });
      return session;
    },
  };

  const response = await processPreferencesRequest(
    {
      language: "hi",
      mode: "tutor",
      sessionId: "session-3",
      targetLanguage: "fr",
    },
    {
      memoryService,
      realtimeHub: {
        send: (sessionId, type, payload) => {
          events.push({ payload, sessionId, type });
        },
      },
    }
  );

  assert.equal(response.success, true);
  assert.equal(response.session.mode, "tutor");
  assert.equal(response.session.language, "hi");
  assert.equal(response.session.targetLanguage, "fr");
  assert.equal(response.sessionMeta.mode, "tutor");
  assert.equal(response.sessionMeta.language, "hi");
  assert.equal(response.sessionMeta.turnCount, 0);
  assert.deepEqual(events.map((event) => event.type), [
    "session:updated",
    "mode:changed",
  ]);
});

test("POST /message still returns REST response when websocket send fails", async () => {
  const session = {
    history: [],
    language: "en",
    lastAssistantResponse: "",
    mode: "assistant",
    sessionId: "session-ws-fail",
    targetLanguage: "en",
  };

  const memoryService = {
    appendTurn: async (sessionId, turn) => {
      session.history.push(turn);
      if (turn.role === "assistant") {
        session.lastAssistantResponse = turn.text;
      }
      return session;
    },
    clearSession: async () => session,
    getSession: async () => session,
    updatePreferences: async (sessionId, updates) => {
      Object.assign(session, updates);
      return session;
    },
    updateSession: async (sessionId, updates) => {
      Object.assign(session, updates);
      return session;
    },
  };

  const response = await processVoiceMessage(
    {
      language: "en",
      mode: "assistant",
      sessionId: "session-ws-fail",
      source: "chat",
      targetLanguage: "en",
      text: "Hello with broken ws",
    },
    {
      aiService: {
        generateReply: async () => ({
          model: "mock-model",
          provider: "mock-ai",
          text: "REST should still work",
        }),
      },
      commandRouter: {
        route: async () => ({ handled: false }),
      },
      intentService: {
        detectIntent: () => ({ entities: {}, name: "conversation", type: "message" }),
      },
      memoryService,
      murfService: {
        generateVoice: async () => "/generated/session-ws-fail/reply.mp3",
      },
      realtimeHub: {
        send: async () => {
          throw new Error("ws send failed");
        },
      },
    }
  );

  assert.equal(response.replyText, "REST should still work");
  assert.equal(response.audioUrl, "/generated/session-ws-fail/reply.mp3");
});

test("POST /message returns System error text when the main handler fails internally", async () => {
  const session = {
    history: [],
    language: "en",
    lastAssistantResponse: "",
    mode: "assistant",
    sessionId: "session-system-error",
    targetLanguage: "en",
    timestamp: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
  };
  const events = [];

  const response = await processVoiceMessage(
    {
      language: "en",
      mode: "assistant",
      sessionId: "session-system-error",
      source: "chat",
      targetLanguage: "en",
      text: "hello",
    },
    {
      aiService: {
        generateReply: async () => {
          throw new Error("AI exploded");
        },
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
        appendTurn: async (sessionId, turn) => {
          session.history.push(turn);
          return session;
        },
        getConversationHistory: async () => [{ role: "user", text: "hello" }],
        getSession: async () => session,
        updatePreferences: async (sessionId, updates) => {
          Object.assign(session, updates);
          return session;
        },
        updateSession: async (sessionId, updates) => {
          Object.assign(session, updates);
          return session;
        },
      },
      murfService: {
        generateVoice: async () => "/generated/session-system-error/reply.mp3",
      },
      realtimeHub: {
        send: (sessionId, type, payload) => {
          events.push({ payload, sessionId, type });
        },
      },
    }
  );

  assert.equal(response.replyText, "System error");
  assert.equal(response.text, "System error");
  assert.equal(response.audioUrl, null);
  assert.equal(response.provider, "system");
  assert.deepEqual(events.map((event) => event.type), [
    "assistant:thinking",
    "assistant:text",
    "error",
  ]);
});
