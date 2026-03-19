// VOS Voice OS - Clean Frontend Rebuild
// Handles WS, STT, chat, UI states - 100% functional

(function() {
  'use strict';

  const _shown = new Set();
  function addMessageToChat(role, text) {
    appendMsg(role, text);
  }
  function showReply(text, id) {
    if (!text?.trim()) return;
    text = text.replace(/^(Assistant:|VOSSAI:|VOS:|User:|Human:|Me:)\s*/gi, '').trim();
    if (id && _shown.has(id)) return;
    if (id) {
      _shown.add(id);
      if (_shown.size > 30) _shown.delete(_shown.values().next().value);
    }
    addMessageToChat('assistant', text);
  }

  // 1. CONFIG - Support both formats from server
  const CFG = window.__VOS_CONFIG__ || window.APP_CONFIG || {};
  const TOKEN = CFG.apiToken || CFG.apiSecret || '';
  if (!TOKEN) {
    console.error('[VOS] No token in app-config.js - API/WS will fail');
  }

  // 2. STATE
  let SESSION_ID = localStorage.getItem('vos_session_id');
  let currentMode = 'assistant';
  let currentLang = 'en';
  let micState = 'idle';
  let isRecognitionRunning = false;
  let ws = null;
  let recognition = null;
  let lastMicClick = 0;

  function getSessionId() {
    let id = localStorage.getItem('vos_session_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('vos_session_id', id);
    }
    return id;
  }

  SESSION_ID = getSessionId();

  // 3. DOM ELEMENTS - Safe query after DOM ready
  function getElements() {
    return {
      chat: document.getElementById('chat'),
      empty: document.getElementById('empty'),
      textInput: document.getElementById('text-input'),
      micBtn: document.getElementById('mic-btn'),
      micStatus: document.getElementById('mic-status'),
      sendBtn: document.getElementById('send-btn'),
      audioPlayer: document.getElementById('audio-player'),
      toast: document.getElementById('toast'),
      wsDot: document.getElementById('ws-dot'),
      wsLabel: document.getElementById('ws-label'),
      sessionDisplay: document.getElementById('session-display'),
      modeDisplay: document.getElementById('mode-display'),
      latencyDisplay: document.getElementById('latency-display'),
      memoryDisplay: document.getElementById('memory-display'),
      modelDisplay: document.getElementById('model-display'),
      modeList: document.getElementById('mode-list'),
      langSelect: document.getElementById('lang-select')
    };
  }

  let els = {};  // populated inside DOMContentLoaded — DOM not ready yet at parse time

  // 4. WS CONNECTION
  function connectWS() {
    if (ws) ws.close();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws?sessionId=${SESSION_ID}&token=${TOKEN}`;
    
    ws = new WebSocket(url);
    
    ws.onopen = () => {
      console.log('[VOS] WS connected');
      setStatus('connected');
      els.sessionDisplay.textContent = SESSION_ID.slice(0,8) + '...';
    };
    
    ws.onclose = () => {
      console.log('[VOS] WS disconnected');
      setStatus('disconnected');
      setTimeout(connectWS, 3000);
    };
    
    ws.onerror = (e) => {
      console.error('[VOS] WS error', e);
      setStatus('error');
    };
    
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleEvent(data);
      } catch(err) {
        console.error('[VOS] WS parse error', err);
      }
    };
    
    return ws;
  }

  // 5. WS EVENT HANDLER
  function handleEvent(data) {
    const { type, payload = {} } = data;
    
    switch(type) {
      case 'session:ready':
        updateSession(payload);
        break;
      case 'assistant:thinking':
        showTyping();
        break;
      case 'assistant:text':
        hideTyping();
        showReply(payload.text || payload.replyText, payload.turnId);
        break;
      case 'assistant:audio':
        playAudio(payload.audioUrl);
        break;
      case 'memory:cleared':
        clearChat();
        break;
      case 'mode:changed':
        updateMode(payload.mode);
        break;
      case 'error':
        showToast(payload.detail || 'Error', 'error');
        break;
      default:
        console.log('[VOS] Unknown event', type);
    }
  }

  // 6. SEND MESSAGE
  async function sendMessage(text, source) {
    if (!text?.trim()) return;
    const trimmed = text.trim();
    const turnId = crypto.randomUUID();
    const msgSource = source || 'text';

    appendMsg('user', trimmed);
    showTyping();
    clearInput();

    try {
      const res = await fetch('/api/voice/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TOKEN}`
        },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          turnId: turnId,
          text: trimmed,
          mode: currentMode,
          language: currentLang,
          targetLanguage: currentLang,
          source: msgSource
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        hideTyping();
        showToast('Error: ' + (err.error || res.status), 'error');
        return;
      }

      const data = await res.json();
      hideTyping();

      if (data.replyText) {
        showReply(data.replyText || data.text, data.turnId || turnId);
      }
      if (data.audioUrl) {
        playAudio(data.audioUrl);
      }
      updateTelemetry(data);
    } catch(e) {
      hideTyping();
      showToast('Connection error', 'error');
      console.error('[VOS] Send failed:', e);
    } finally {
      // Always reset mic — otherwise a failed request leaves micState='processing'
      // which silently blocks every future mic press
      if (micState === 'processing') {
        setMicState('idle');
      }
    }
  }

  // 7. STT
  function initSTT() {
    const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechAPI) {
      console.warn('[STT] Not supported — use Chrome or Edge');
      if (els.micBtn) {
        els.micBtn.disabled = true;
        els.micBtn.title = 'Speech not available — use Chrome';
      }
      return;
    }

    recognition = new SpeechAPI();
    recognition.continuous = false;      // MUST be false — true causes restart loops
    recognition.interimResults = false;  // final results only
    recognition.maxAlternatives = 1;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isRecognitionRunning = true;
      setMicState('listening');
      console.log('[STT] Started listening');
    };

    recognition.onresult = (e) => {
      // Use e.resultIndex — NOT hardcoded 0 — to get the current utterance slot
      const result = e.results[e.resultIndex];
      if (!result || !result.isFinal) return;  // guard: only final results
      const transcript = result[0]?.transcript?.trim();
      if (!transcript) return;
      console.log('[STT] Heard:', transcript);
      setMicState('processing');
      sendMessage(transcript, 'voice');
    };

    recognition.onerror = (e) => {
      isRecognitionRunning = false;
      setMicState('idle');
      console.error('[STT] Error:', e.error);

      const msgs = {
        'not-allowed':         'Mic blocked. Click the lock icon in Chrome and allow microphone.',
        'no-speech':           'No speech detected. Please try again.',
        'network':             'Network error during speech recognition.',
        'audio-capture':       'No microphone found. Please connect one.',
        'aborted':             null,  // silent
        'service-not-allowed': 'Speech recognition requires localhost or HTTPS.'
      };
      const msg = msgs[e.error];
      if (msg) showToast(msg, 'error');
    };

    recognition.onend = () => {
      isRecognitionRunning = false;
      // Only reset UI if we're not actively processing a result
      // (sendMessage's finally block will reset to idle once done)
      if (micState === 'listening') {
        setMicState('idle');
      }
      console.log('[STT] Ended');
    };

    console.log('[STT] Initialized ✅');
  }

  function startListening() {
    if (!recognition) {
      showToast('Speech not available. Use Chrome browser.', 'error');
      return;
    }
    // Debounce
    const now = Date.now();
    if (now - lastMicClick < 300) return;
    lastMicClick = now;

    if (isRecognitionRunning) {
      console.warn('[STT] Already running');
      return;
    }

    // Set language based on current selection
    const langMap = {
      'en': 'en-US', 'hi': 'hi-IN', 'es': 'es-ES',
      'fr': 'fr-FR', 'de': 'de-DE', 'ja': 'ja-JP'
    };
    recognition.lang = langMap[currentLang] || 'en-US';

    try {
      recognition.start();
    } catch(e) {
      isRecognitionRunning = false;
      setMicState('idle');
      console.error('[STT] start() failed:', e.message);
      if (e.message && e.message.includes('already started')) {
        // Abort and retry after 400ms
        try { recognition.abort(); } catch(_) {}
        setTimeout(startListening, 400);
      } else {
        showToast('Could not start microphone.', 'error');
      }
    }
  }

  function stopListening() {
    if (!isRecognitionRunning) return;
    try {
      recognition.stop();
    } catch(e) {
      console.warn('[STT] stop() failed:', e.message);
      isRecognitionRunning = false;
      setMicState('idle');
    }
  }

  // 8. UI HELPERS
  function appendMsg(role, text) {
    const empty = els.empty;
    if (empty) empty.remove();
    
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}`;
    bubble.textContent = text;  // SAFE - textContent
    
    div.appendChild(bubble);
    els.chat.appendChild(div);
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  function showTyping() {
    if (document.getElementById('typing')) return;
    
    const div = document.createElement('div');
    div.id = 'typing';
    div.className = 'msg assistant';
    div.innerHTML = '<div class="bubble assistant">···</div>';  // Static dots OK
    els.chat.appendChild(div);
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  function hideTyping() {
    const typing = document.getElementById('typing');
    if (typing) typing.remove();
  }

  function setMicState(state) {
    micState = state;
    const labels = { idle: 'VOICE READY', listening: 'ANALYZING VOICE INPUT...', processing: 'PROCESSING...', speaking: 'TRANSMITTING RESPONSE' };
    if (els.micBtn) {
      els.micBtn.className = els.micBtn.className
        .replace(/\b(idle|listening|processing|speaking)\b/g, '').trim();
      els.micBtn.classList.add(state);
    }
    // Drive arc-reactor-wrap class for CSS sonar/EQ animations
    const wrap = document.getElementById('arc-wrap');
    if (wrap) {
      wrap.classList.remove('idle','listening','processing','speaking');
      wrap.classList.add(state);
    }
    if (els.micStatus) els.micStatus.textContent = labels[state] || state.toUpperCase();
    if (window.__logEvent) window.__logEvent('MIC:' + state.toUpperCase());
  }

  function setStatus(status) {
    if (els.wsDot) {
      els.wsDot.className = `ws-dot ${status}`;
    }
    if (els.wsLabel) {
      els.wsLabel.textContent = status === 'connected' ? 'ONLINE' : 'OFFLINE';
      els.wsLabel.className = 'ws-label' + (status === 'connected' ? ' connected-text' : '');
    }
    if (window.__logEvent) window.__logEvent('WS:' + status.toUpperCase());
  }

  function showToast(msg, type = 'info') {
    els.toast.textContent = msg;
    els.toast.className = `toast ${type} show`;
    setTimeout(() => els.toast.className = 'toast', 3000);
  }

  function playAudio(url) {
    if (!url || !els.audioPlayer) return;
    els.audioPlayer.src = url;
    els.audioPlayer.play().catch(e => console.error('[Audio]', e));
  }

  function clearInput() {
    els.textInput.value = '';
  }

  function clearChat() {
    els.chat.innerHTML = '';
    const empty = document.createElement('div');
    empty.id = 'empty';
    empty.style.cssText = 'text-align:center;padding:40px;color:#666;font-size:12px';
    empty.innerHTML = 'Session cleared';
    els.chat.appendChild(empty);
  }

  function updateMode(mode) {
    currentMode = mode;
    els.modeDisplay.textContent = mode;
    document.querySelectorAll('[data-mode]').forEach(el => {
      el.classList.toggle('active', el.dataset.mode === mode);
    });
  }

  function updateTelemetry(data) {
    if (data.latencyMs && els.latencyDisplay) els.latencyDisplay.textContent = data.latencyMs + 'ms';
    if (data.sessionMeta?.turnCount && els.memoryDisplay) els.memoryDisplay.textContent = data.sessionMeta.turnCount;
    if (data.detectedIntent && window.__updateIntent) window.__updateIntent(data.detectedIntent);
    if (data.detectedIntent && window.__logEvent) window.__logEvent('INTENT:' + data.detectedIntent.toUpperCase());
    setMicState('speaking');
    // Auto-reset speaking state after audio ends or after timeout
    const player = document.getElementById('audio-player');
    if (player && data.audioUrl) {
      const onDone = () => { setMicState('idle'); player.removeEventListener('ended', onDone); };
      player.addEventListener('ended', onDone);
      setTimeout(() => setMicState('idle'), 8000); // safety fallback
    } else {
      setTimeout(() => setMicState('idle'), 300);
    }
  }

  function updateSession(payload) {
    els.sessionDisplay.textContent = payload.sessionId.slice(0,8) + '...';
    els.memoryDisplay.textContent = payload.sessionMeta?.turnCount || 0;
    els.modeDisplay.textContent = payload.sessionMeta?.mode || 'assistant';
  }

  // 9. EVENTS
  function bindEvents() {
    // Send
    els.sendBtn.addEventListener('click', () => sendMessage(els.textInput.value));
    els.textInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(els.textInput.value);
      }
    });

    // Mic — toggle: click starts listening, click again stops
    if (els.micBtn) {
      els.micBtn.addEventListener('click', () => {
        if (micState === 'idle') {
          startListening();
        } else if (micState === 'listening') {
          stopListening();
        }
        // Ignore clicks during processing / speaking
      });
      console.log('[VOS] mic-btn listener attached ✅');
    } else {
      console.error('[VOS] ❌ mic-btn not found in HTML');
    }

    // Modes
    els.modeList.addEventListener('click', e => {
      const item = e.target.closest('[data-mode]');
      if (!item) return;
      updateMode(item.dataset.mode);
    });

    // Lang
    els.langSelect.addEventListener('change', e => {
      currentLang = e.target.value;
    });

    // Quick actions
    document.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'clear') sendMessage('clear memory');
        else if (action === 'repeat') sendMessage('repeat');
        else if (action === 'help') sendMessage('help');
        else if (action === 'stop') els.audioPlayer.pause();
      });
    });

    // Chips
    document.querySelectorAll('[data-text]').forEach(chip => {
      chip.addEventListener('click', () => sendMessage(chip.dataset.text));
    });
  }

  // 10. INIT
  document.addEventListener('DOMContentLoaded', () => {
    // Populate DOM refs NOW — DOM is ready
    els = getElements();

    console.log('[VOS] Starting...', {token: TOKEN ? 'OK' : 'MISSING', session: SESSION_ID});
    
    // Connect WS
    connectWS();
    
    // Init STT
    initSTT();
    
    // Bind events
    bindEvents();
    
    console.log('[VOS] Ready ✅');
    
    // Welcome
    setTimeout(() => {
      if (els.chat && els.chat.children.length === 0) {
        showReply('VOS online. Type or speak.');
      }
    }, 500);
  });

})();

