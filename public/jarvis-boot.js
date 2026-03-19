// jarvis-boot.js — External boot sequence + right-panel helpers
// Loaded as a deferred external script to satisfy CSP (script-src 'self')

(function () {
  // ── BOOT SEQUENCE ─────────────────────────────────────────────
  var overlay = document.getElementById('boot-overlay');
  var bootLine = document.getElementById('boot-line');
  var fill = document.getElementById('boot-bar-fill');

  var LINES = [
    'NEURAL NETWORKS ONLINE...',
    'VOICE STACK READY...',
    'OPERATOR TERMINAL ACTIVE...',
  ];

  function dismissBoot() {
    if (!overlay) return;
    if (fill) fill.style.width = '100%';
    setTimeout(function () {
      overlay.style.transition = 'opacity 0.5s ease';
      overlay.style.opacity = '0';
      setTimeout(function () { overlay.style.display = 'none'; }, 550);
    }, 200);
  }

  // Hard-cap: always dismiss after 4s
  var hardTimer = setTimeout(dismissBoot, 4000);

  function typeText(el, text, speed, cb) {
    var i = 0;
    el.textContent = '';
    var t = setInterval(function () {
      el.textContent += text[i++];
      if (i >= text.length) {
        clearInterval(t);
        if (cb) setTimeout(cb, 150);
      }
    }, speed);
  }

  var lineIdx = 0;
  function nextLine() {
    if (!bootLine) { dismissBoot(); return; }
    if (lineIdx >= LINES.length) {
      clearTimeout(hardTimer);
      dismissBoot();
      return;
    }
    var pct = Math.round(((lineIdx + 1) / LINES.length) * 90) + '%';
    if (fill) fill.style.width = pct;
    typeText(bootLine, LINES[lineIdx++], 18, nextLine);
  }

  setTimeout(nextLine, 200);

  // ── UPTIME COUNTER ─────────────────────────────────────────────
  var uptimeEl = document.getElementById('uptime-display');
  if (uptimeEl) {
    var startTime = Date.now();
    setInterval(function () {
      var s = Math.floor((Date.now() - startTime) / 1000);
      var h = String(Math.floor(s / 3600)).padStart(2, '0');
      var m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      var sec = String(s % 60).padStart(2, '0');
      uptimeEl.textContent = h + ':' + m + ':' + sec;
    }, 1000);
  }

  // ── AUDIO VISUALIZER ──────────────────────────────────────────
  var player = document.getElementById('audio-player');
  var viz = document.getElementById('audio-viz');
  if (player && viz) {
    player.addEventListener('play',  function () { viz.classList.add('viz-active'); });
    player.addEventListener('pause', function () { viz.classList.remove('viz-active'); });
    player.addEventListener('ended', function () { viz.classList.remove('viz-active'); });
  }

  // ── EVENT STREAM ──────────────────────────────────────────────
  var stream = document.getElementById('event-stream');
  var MAX_EVENTS = 6;
  window.__logEvent = function (type) {
    if (!stream) return;
    var now = new Date();
    var ts = now.toTimeString().slice(0, 8);
    var item = document.createElement('div');
    item.className = 'event-item';
    item.innerHTML =
      '<span class="event-time">' + ts + '</span>' +
      '<span class="event-type">' + String(type).slice(0, 28) + '</span>';
    stream.prepend(item);
    while (stream.children.length > MAX_EVENTS) stream.removeChild(stream.lastChild);
  };

  // ── INTENT BADGE ──────────────────────────────────────────────
  window.__updateIntent = function (intent) {
    var badge = document.getElementById('intent-badge');
    if (!badge) return;
    badge.textContent = intent || '\u2014';
    badge.className = 'intent-badge';
    if (!intent || intent === '\u2014') { badge.classList.add('intent-idle'); return; }
    if (intent.includes('computer')) badge.classList.add('intent-computer');
    else if (intent.includes('conversation')) badge.classList.add('intent-convo');
    else if (intent.includes('translat')) badge.classList.add('intent-trans');
    else if (intent.includes('unsupported')) badge.classList.add('intent-warn');
    else badge.classList.add('intent-idle');
  };

  // ── LAST REPLY OBSERVER ───────────────────────────────────────
  var lastReplyEl = document.getElementById('last-reply-text');
  var chatEl = document.getElementById('chat');
  if (lastReplyEl && chatEl) {
    var observer = new MutationObserver(function () {
      var msgs = chatEl.querySelectorAll('.msg.assistant');
      if (msgs.length) {
        var last = msgs[msgs.length - 1];
        var bubble = last.querySelector('.bubble');
        if (bubble && last.id !== 'typing') {
          lastReplyEl.textContent = bubble.textContent;
        }
      }
    });
    observer.observe(chatEl, { childList: true, subtree: true });
  }

  // ── MOBILE HAMBURGER ──────────────────────────────────────────
  var hamburger = document.getElementById('hamburger');
  var leftPanel = document.getElementById('panel-left');
  if (hamburger && leftPanel) {
    hamburger.addEventListener('click', function () {
      leftPanel.classList.toggle('mobile-open');
    });
  }
})();
