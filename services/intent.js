const SUPPORTED_LANGUAGES = [
  { code: "de", label: "German" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
];

const SUPPORTED_MODES = [
  { id: "assistant", label: "Assistant" },
  { id: "tutor", label: "Tutor" },
  { id: "translator", label: "Translator" },
  { id: "customer-support", label: "Customer Support" },
];

const LANGUAGE_ALIASES = {
  de: "de",
  german: "de",
  "de de": "de",
  "de-de": "de",
  en: "en",
  english: "en",
  "en us": "en",
  "en-us": "en",
  es: "es",
  spanish: "es",
  "es es": "es",
  "es-es": "es",
  fr: "fr",
  french: "fr",
  "fr fr": "fr",
  "fr-fr": "fr",
  hi: "hi",
  hindi: "hi",
  "hi in": "hi",
  "hi-in": "hi",
  ja: "ja",
  japanese: "ja",
  "ja jp": "ja",
  "ja-jp": "ja",
};

const MODE_ALIASES = {
  assistant: "assistant",
  tutor: "tutor",
  translator: "translator",
  "customer support": "customer-support",
  support: "customer-support",
};

function escapePattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTargetLanguageCommand(text) {
  return (
    /^translate (to|into) [a-z -]+$/.test(text) ||
    /^(set|change|switch).*(target language|output language|translation language).*(to|into) [a-z -]+$/.test(
      text
    ) ||
    /^(target language|output language|translation language).*(to|into) [a-z -]+$/.test(
      text
    )
  );
}

function isModeSwitchCommand(text, mode) {
  const aliases = Object.entries(MODE_ALIASES)
    .filter(([, value]) => value === mode)
    .map(([alias]) => alias);

  if (!/^(switch|change|set|use)\b/.test(text)) {
    return false;
  }

  return aliases.some((alias) =>
    new RegExp(`\\b${escapePattern(alias)}\\b(?:\\s+mode)?$`).test(text)
  );
}

function createIntentService() {
  function findLanguage(text) {
    const candidates = Object.keys(LANGUAGE_ALIASES).sort(
      (a, b) => b.length - a.length
    );

    for (const candidate of candidates) {
      if (text.includes(candidate)) {
        return LANGUAGE_ALIASES[candidate];
      }
    }

    return null;
  }

  function findMode(text) {
    const candidates = Object.keys(MODE_ALIASES).sort((a, b) => b.length - a.length);

    for (const candidate of candidates) {
      if (text.includes(candidate)) {
        return MODE_ALIASES[candidate];
      }
    }

    return null;
  }

  function detectIntent(input) {
    const text = String(input || "").trim().toLowerCase();

    // ── UNSUPPORTED ACTIONS ───────────────────────────────
    // Catch requests VOS cannot do rather than sending them to AI
    const UNSUPPORTED_PATTERNS = [
      /analyse\s+(my\s+)?(mac|computer|system|disk|files)/i,
      /analyze\s+(my\s+)?(mac|computer|system|disk|files)/i,
      /access\s+(my\s+)?(mic|microphone|camera|webcam)/i,
      /check\s+(my\s+)?(mac|system|disk|storage|ram|cpu|memory|battery)/i,
      /scan\s+(my\s+)?(mac|computer|files|disk)/i,
      /monitor\s+(my\s+)?(mac|system|cpu|ram)/i,
      /read\s+(my\s+)?(files|disk|hard drive)/i,
      /hack\s+(my\s+)?(mac|computer)/i,
    ];
    for (const pattern of UNSUPPORTED_PATTERNS) {
      if (pattern.test(text)) {
        return {
          confidence: 0.95,
          entities: {
            reply: "I can't do that yet. I can open apps, search the web, take screenshots, and control volume. What else can I help with?"
          },
          name: 'unsupported-action',
          type: 'command',
        };
      }
    }

    // ── COMPUTER / APP CONTROL (checked first — high confidence patterns) ──

    // Folder open (before generic open): "open downloads folder", "open downloads"
    const FOLDER_NAMES = 'downloads|download|desktop|documents|document|pictures|photos|music|movies|videos';
    const folderMatch1 = text.match(new RegExp(`^(?:can\\s+you\\s+)?(?:please\\s+)?(?:open|launch)\\s+(${FOLDER_NAMES})(?:\\s+folder)?$`, 'i'));
    const folderMatch2 = text.match(/^(?:can\s+you\s+)?(?:please\s+)?(?:open|launch)\s+(.+?)\s+folder$/i);
    if (folderMatch1 || folderMatch2) {
      const folder = ((folderMatch1 || folderMatch2)[1] || '').trim();
      return {
        confidence: 0.98,
        entities: { action: 'open_folder', params: { folder } },
        name: 'computer-action',
        type: 'command',
      };
    }

    // Open URL: "open www.google.com", "go to example.com", "visit github.com"
    const openUrlMatch = text.match(/^(?:can\s+you\s+)?(?:go to|open|visit)\s+((?:https?:\/\/|www\.)\S+)/i);
    if (openUrlMatch) {
      return {
        confidence: 0.97,
        entities: { action: 'open_url', params: { url: openUrlMatch[1].trim() } },
        name: 'computer-action',
        type: 'command',
      };
    }

    // Open/launch/start/run app — flexible: handles "can you", "please", trailing noise
    // Trailing noise stripped: "in X browser", "new tab", "app", "for me", "on my mac" etc.
    {
      const NOISE_SUFFIX = /\s+(?:in\s+\S+(?:\s+browser)?|new\s+tab(?:\s+and\s+\S+)?|app(?:lication)?|program|please|for\s+me|on\s+(?:my\s+)?mac|my\s+mac)$/i;
      const m = text.match(/^(?:can\s+you\s+)?(?:please\s+)?(?:open|launch|start|run)\s+(.+)/i);
      if (m) {
        let appName = m[1].trim();
        // Strip trailing noise iteratively until stable
        let prev;
        do { prev = appName; appName = appName.replace(NOISE_SUFFIX, '').trim(); } while (appName !== prev);
        if (appName.length > 0) {
          return {
            confidence: 0.97,
            entities: { action: 'open_app', params: { app: appName } },
            name: 'computer-action',
            type: 'command',
          };
        }
      }
      // Bare "open" with nothing after — ask for clarification
      if (/^(?:can\s+you\s+)?(?:please\s+)?(?:open|launch|start|run)\s*$/i.test(text)) {
        return {
          confidence: 0.90,
          entities: { reply: 'Which app would you like me to open?' },
          name: 'unsupported-action',
          type: 'command',
        };
      }
    }

    // Search: "search for weather", "search python tutorial"
    const searchMatch = text.match(/^search\s+(?:for\s+)?(.+)/i);
    if (searchMatch) {
      return {
        confidence: 0.96,
        entities: { action: 'search_web', params: { query: searchMatch[1].trim() } },
        name: 'computer-action',
        type: 'command',
      };
    }

    // Google/look up: "google flights to delhi"
    const googleMatch = text.match(/^(?:google|look up|find)\s+(.+)/i);
    if (googleMatch) {
      return {
        confidence: 0.95,
        entities: { action: 'search_web', params: { query: googleMatch[1].trim() } },
        name: 'computer-action',
        type: 'command',
      };
    }

    // Screenshot: "take a screenshot", "take screenshot"
    if (/take\s+(?:a\s+)?(?:screenshot|screen\s+shot|screen\s+capture)/i.test(text)) {
      return {
        confidence: 0.99,
        entities: { action: 'take_screenshot', params: {} },
        name: 'computer-action',
        type: 'command',
      };
    }

    // Type text: "type hello world"
    const typeMatch = text.match(/^type\s+(.+)/i);
    if (typeMatch) {
      return {
        confidence: 0.95,
        entities: { action: 'type_text', params: { text: typeMatch[1].trim() } },
        name: 'computer-action',
        type: 'command',
      };
    }

    // Volume: "set volume to 80"
    const volumeMatch = text.match(/set\s+(?:the\s+)?volume\s+(?:to\s+)?(\d+)/i);
    if (volumeMatch) {
      return {
        confidence: 0.97,
        entities: { action: 'set_volume', params: { level: volumeMatch[1] } },
        name: 'computer-action',
        type: 'command',
      };
    }

    // Mute / unmute
    if (/\b(?:mute|silence)\b/i.test(text) && !/unmute/.test(text)) {
      return {
        confidence: 0.96,
        entities: { action: 'mute', params: {} },
        name: 'computer-action',
        type: 'command',
      };
    }
    if (/\bunmute\b/i.test(text)) {
      return {
        confidence: 0.96,
        entities: { action: 'unmute', params: {} },
        name: 'computer-action',
        type: 'command',
      };
    }

    // Sleep
    if (/^(?:sleep|put.*to sleep|go to sleep)$/i.test(text)) {
      return {
        confidence: 0.95,
        entities: { action: 'sleep', params: {} },
        name: 'computer-action',
        type: 'command',
      };
    }

    // Lock screen
    if (/^(?:lock|lock (?:the )?(?:screen|mac|computer))$/i.test(text)) {
      return {
        confidence: 0.95,
        entities: { action: 'lock', params: {} },
        name: 'computer-action',
        type: 'command',
      };
    }
    // ── END COMPUTER ACTIONS ───────────────────────

    if (!text) {
      return {
        confidence: 0,
        entities: {},
        name: "conversation",
        type: "message",
      };
    }

    if (
      text === "help" ||
      text.includes("what can you do") ||
      text.includes("show commands")
    ) {
      return {
        confidence: 0.98,
        entities: {},
        name: "help",
        type: "command",
      };
    }

    if (
      text.includes("clear memory") ||
      text.includes("reset memory") ||
      text.includes("forget this conversation")
    ) {
      return {
        confidence: 0.99,
        entities: {},
        name: "clear-memory",
        type: "command",
      };
    }

    if (
      text === "repeat" ||
      text.includes("repeat that") ||
      text.includes("say that again") ||
      text.includes("repeat last response")
    ) {
      return {
        confidence: 0.98,
        entities: {},
        name: "repeat",
        type: "command",
      };
    }

    if (
      text === "stop" ||
      text.includes("stop audio") ||
      text.includes("stop speaking") ||
      text.includes("pause audio")
    ) {
      return {
        confidence: 0.96,
        entities: {},
        name: "stop-audio",
        type: "command",
      };
    }

    const mode = findMode(text);
    if (mode && isModeSwitchCommand(text, mode)) {
      return {
        confidence: 0.95,
        entities: { mode },
        name: "mode-switch",
        type: "command",
      };
    }

    const language = findLanguage(text);
    if (language && isTargetLanguageCommand(text)) {
      return {
        confidence: 0.9,
        entities: { language },
        name: "target-language-switch",
        type: "command",
      };
    }

    if (
      language &&
      (/switch.*language/.test(text) ||
        /change.*language/.test(text) ||
        /set.*language/.test(text) ||
        /speak in/.test(text) ||
        /respond in/.test(text))
    ) {
      return {
        confidence: 0.91,
        entities: { language },
        name: "language-switch",
        type: "command",
      };
    }

    return {
      confidence: 0.5,
      entities: {},
      name: "conversation",
      type: "message",
    };
  }

  return {
    detectIntent,
    getSupportedLanguages: () => SUPPORTED_LANGUAGES,
    getSupportedModes: () => SUPPORTED_MODES,
  };
}

module.exports = {
  createIntentService,
};
