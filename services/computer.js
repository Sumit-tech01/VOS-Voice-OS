// services/computer.js — VOS Mac Computer Control
// Executes safe system actions: open apps, search, screenshot, volume, etc.

'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execAsync = promisify(exec);

// ── SAFETY BLOCKLIST ──────────────────────────────
// These substrings are never allowed anywhere in params
const BLOCKED_TERMS = ['rm ', 'rmdir', 'delete', 'format', 'uninstall', 'shutdown', 'sudo', 'su '];

function isSafe(params) {
  const paramsText = JSON.stringify(params || {}).toLowerCase();
  return !BLOCKED_TERMS.some(term => paramsText.includes(term));
}

// ── APP NAME MAP ──────────────────────────────────
const APP_MAP = {
  // Communication
  'whatsapp':           'WhatsApp',
  'whats app':          'WhatsApp',
  'telegram':           'Telegram',
  'messages':           'Messages',
  'facetime':           'FaceTime',
  'mail':               'Mail',
  'slack':              'Slack',
  'zoom':               'Zoom',
  'teams':              'Microsoft Teams',
  'microsoft teams':    'Microsoft Teams',

  // Browsers
  'chrome':             'Google Chrome',
  'google chrome':      'Google Chrome',
  'safari':             'Safari',
  'firefox':            'Firefox',
  'brave':              'Brave Browser',
  'edge':               'Microsoft Edge',
  'browser':            'Google Chrome',

  // Productivity
  'notes':              'Notes',
  'calendar':           'Calendar',
  'reminders':          'Reminders',
  'finder':             'Finder',
  'terminal':           'Terminal',
  'vs code':            'Visual Studio Code',
  'vscode':             'Visual Studio Code',
  'visual studio code': 'Visual Studio Code',
  'xcode':              'Xcode',
  'word':               'Microsoft Word',
  'excel':              'Microsoft Excel',
  'powerpoint':         'Microsoft PowerPoint',
  'notion':             'Notion',
  'pages':              'Pages',
  'numbers':            'Numbers',

  // Media
  'spotify':            'Spotify',
  'music':              'Music',
  'podcasts':           'Podcasts',
  'photos':             'Photos',
  'vlc':                'VLC',

  // Utilities
  'calculator':         'Calculator',
  'settings':           'System Preferences',
  'system preferences': 'System Preferences',
  'system settings':    'System Settings',
  'activity monitor':   'Activity Monitor',
  'preview':            'Preview',
  'textedit':           'TextEdit',
  'text edit':          'TextEdit',

  // Browsers (extra)
  'opera':              'Opera',
  'opera browser':      'Opera',

  // Social (web-based, open in browser)
};

// ── OPEN APP ─────────────────────────────────────
async function openApp(appName) {
  const normalized = String(appName || '').toLowerCase().trim();
  const macApp = APP_MAP[normalized] || appName;

  try {
    await execAsync(`open -a "${macApp.replace(/"/g, '\\"')}"`);
    console.log('[COMPUTER] Opened:', macApp);
    return { success: true, reply: `Opening ${macApp} for you.` };
  } catch (_) {
    // Fallback: try the raw name the user said
    try {
      await execAsync(`open -a "${String(appName).replace(/"/g, '\\"')}"`);
      return { success: true, reply: `Opening ${appName}.` };
    } catch (e2) {
      console.error('[COMPUTER] App not found:', appName, e2.message);
      return { success: false, reply: `I couldn't find "${appName}". Is it installed on your Mac?` };
    }
  }
}

// ── SEARCH WEB ────────────────────────────────────
async function searchWeb(query) {
  const encoded = encodeURIComponent(String(query || '').trim());
  const url = `https://www.google.com/search?q=${encoded}`;
  try {
    await execAsync(`open "${url}"`);
    console.log('[COMPUTER] Search:', query);
    return { success: true, reply: `Searching for "${query}" in your browser.` };
  } catch (e) {
    return { success: false, reply: `Couldn't open a browser to search. Is Chrome or Safari installed?` };
  }
}

// ── OPEN URL ─────────────────────────────────────
async function openURL(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  try {
    await execAsync(`open "${url.replace(/"/g, '\\"')}"`);
    return { success: true, reply: `Opening ${url}.` };
  } catch (e) {
    return { success: false, reply: `Couldn't open that URL.` };
  }
}

// ── TAKE SCREENSHOT ───────────────────────────────
async function takeScreenshot() {
  const filename = `screenshot_${Date.now()}.png`;
  const savePath = `${os.homedir()}/Desktop/${filename}`;
  try {
    await execAsync(`screencapture -x "${savePath}"`);
    console.log('[COMPUTER] Screenshot saved:', savePath);
    return { success: true, reply: `Screenshot saved to your Desktop as ${filename}.` };
  } catch (e) {
    return { success: false, reply: `Couldn't take a screenshot. Error: ${e.message}` };
  }
}

// ── TYPE TEXT ─────────────────────────────────────
async function typeText(text) {
  // Escape for AppleScript string literal
  const safe = String(text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "System Events" to keystroke "${safe}"`;
  try {
    await execAsync(`osascript -e '${script}'`);
    return { success: true, reply: `Typed: ${text}` };
  } catch (e) {
    return { success: false, reply: `Couldn't type text. Make sure Accessibility permissions are enabled for Terminal in System Settings → Privacy → Accessibility.` };
  }
}

// ── SET VOLUME ────────────────────────────────────
async function setVolume(level) {
  const vol = Math.min(100, Math.max(0, parseInt(level) || 50));
  try {
    await execAsync(`osascript -e 'set volume output volume ${vol}'`);
    return { success: true, reply: `Volume set to ${vol}%.` };
  } catch (e) {
    return { success: false, reply: `Couldn't change volume.` };
  }
}

// ── MUTE / UNMUTE ─────────────────────────────────
async function setMute(mute) {
  const flag = mute ? 'true' : 'false';
  try {
    await execAsync(`osascript -e 'set volume output muted ${flag}'`);
    return { success: true, reply: mute ? 'Muted.' : 'Unmuted.' };
  } catch (e) {
    return { success: false, reply: `Couldn't ${mute ? 'mute' : 'unmute'}.` };
  }
}

// ── SLEEP ─────────────────────────────────────────
async function sleepMac() {
  try {
    await execAsync('pmset sleepnow');
    return { success: true, reply: 'Putting your Mac to sleep.' };
  } catch (e) {
    return { success: false, reply: `Couldn't sleep the Mac.` };
  }
}

// ── LOCK SCREEN ───────────────────────────────────
async function lockScreen() {
  try {
    await execAsync(`osascript -e 'tell application "System Events" to keystroke "q" using {command down, control down}'`);
    return { success: true, reply: 'Locking the screen.' };
  } catch (e) {
    return { success: false, reply: `Couldn't lock the screen.` };
  }
}

// ── OPEN FOLDER ────────────────────────────────
async function openFolder(folderName) {
  const home = os.homedir();
  const normalized = String(folderName || '').toLowerCase().trim();
  const FOLDER_MAP = {
    'downloads':  `${home}/Downloads`,
    'download':   `${home}/Downloads`,   // alias
    'desktop':    `${home}/Desktop`,
    'documents':  `${home}/Documents`,
    'document':   `${home}/Documents`,   // alias
    'pictures':   `${home}/Pictures`,
    'photos':     `${home}/Pictures`,    // alias
    'music':      `${home}/Music`,
    'movies':     `${home}/Movies`,
    'videos':     `${home}/Movies`,      // alias
    'home':       home,
    'trash':      `${home}/.Trash`,
  };
  const folderPath = FOLDER_MAP[normalized] || `${home}/${folderName}`;
  try {
    await execAsync(`open "${folderPath.replace(/"/g, '\\"')}"`);
    console.log('[COMPUTER] Opened folder:', folderPath);
    return { success: true, reply: `Opening ${folderName} folder.` };
  } catch (e) {
    return { success: false, reply: `Couldn't find the ${folderName} folder.` };
  }
}

// ── MAIN DISPATCHER ───────────────────────────────
async function executeComputerTask(action, params) {
  console.log('[COMPUTER] Task:', action, params);

  if (!isSafe(params)) {
    console.warn('[COMPUTER] Blocked unsafe params:', params);
    return { success: false, reply: "I can't do that — it's a protected action." };
  }

  switch (action) {
    case 'open_app':
      return openApp(params.app || params.query || '');
    case 'open_folder':
      return openFolder(params.folder || params.app || params.query || '');
    case 'search_web':
      return searchWeb(params.query || '');
    case 'open_url':
      return openURL(params.url || params.query || '');
    case 'take_screenshot':
      return takeScreenshot();
    case 'type_text':
      return typeText(params.text || params.query || '');
    case 'set_volume':
      return setVolume(params.level || params.query || '50');
    case 'mute':
      return setMute(true);
    case 'unmute':
      return setMute(false);
    case 'sleep':
      return sleepMac();
    case 'lock':
      return lockScreen();
    default:
      return { success: false, reply: `I don't know how to "${action}" yet.` };
  }
}

module.exports = { executeComputerTask };
