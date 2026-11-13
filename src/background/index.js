// ============================================================
// Background Service Worker
// ============================================================

let recognitionPort = null;

let targetTabId = null;
chrome.storage.session.get('targetTabId').then(({ targetTabId: saved }) => {
  if (saved != null && targetTabId == null) targetTabId = saved;
});

function setTargetTab(tabId) {
  targetTabId = tabId;
  chrome.storage.session.set({ targetTabId: tabId });
}

chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

// ── Offscreen document lifecycle ─────────────────────────────
let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Continuous microphone capture for wake-word detection and voice commands.',
  });

  try {
    await creatingOffscreen;
    console.log('[Shadow] Offscreen recognition host created.');
  } finally {
    creatingOffscreen = null;
  }
}

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen().catch((err) =>
    console.warn('[Shadow] Offscreen create failed on startup:', err)
  );
});

// ── Icon click: summon Shadow on the current tab ─────────────
// Track last summon to prevent onActivated from stealing targetTabId
let lastSummonTime = 0;
let lastSummonTab = null;

chrome.action.onClicked.addListener(async (tab) => {
  setTargetTab(tab.id);
  lastSummonTime = Date.now();
  lastSummonTab = tab.id;
  console.log('[Shadow] Summoning on tab', tab.id);

  try {
    await ensureOffscreen();
  } catch (err) {
    console.warn('[Shadow] Offscreen create failed:', err);
  }

  chrome.tabs.sendMessage(
    tab.id,
    { type: 'SHADOW_SUMMON' },
    () => void chrome.runtime.lastError
  );
});

// ── Port from the offscreen recognition host ─────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'recognition') return;

  recognitionPort = port;

  port.onMessage.addListener((message) => {
    if (message.type === 'RECOGNITION_READY') {
      console.log('[Shadow] Recognition host ready — listening for "Arise".');
      return;
    }

    if (
      message.type === 'RECOGNITION_WAKE' ||
      message.type === 'RECOGNITION_RESULT' ||
      message.type === 'RECOGNITION_ERROR' ||
      message.type === 'RECOGNITION_MIC_BLOCKED' ||
      message.type === 'RECOGNITION_ENDED'
    ) {
      (async () => {
        if (targetTabId == null) {
          const { targetTabId: saved } = await chrome.storage.session.get('targetTabId');
          if (saved != null) targetTabId = saved;
        }
        if (targetTabId != null) {
          console.log('[Shadow] Relaying', message.type, 'to tab', targetTabId);
          chrome.tabs.sendMessage(targetTabId, message, () => {
            if (chrome.runtime.lastError) {
              console.warn('[Shadow] Relay failed:', chrome.runtime.lastError.message);
            }
          });
        } else {
          console.warn('[Shadow] No target tab yet — click the Shadow icon on a page, or switch tabs once.');
        }
      })();
    }
  });

  port.onDisconnect.addListener(() => {
    recognitionPort = null;
    console.log('[Shadow] Recognition host disconnected.');
  });
});

// ── Restore awake state when following the user ──────────────
async function restoreShadowIfAwake(tabId) {
  const { shadowAwake } = await chrome.storage.session.get('shadowAwake');
  if (shadowAwake) {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'SHADOW_RESTORE' },
      () => void chrome.runtime.lastError
    );
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Shadow] Extension installed.');

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
  }

  ensureOffscreen().catch((err) =>
    console.warn('[Shadow] Offscreen create failed on install:', err)
  );
});

// Follow the user across tab switches.
// Don't retarget for 3s after a summon — gives SHADOW_SUMMON
// time to reach the content script before targetTabId changes.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (Date.now() - lastSummonTime < 3000 && tabId !== lastSummonTab) {
    console.log('[Shadow] Ignoring tab switch during summon window');
    return;
  }
  setTargetTab(tabId);
  console.log('[Shadow] Following user to tab', tabId);
  restoreShadowIfAwake(tabId);
});

// Restore on page load within same tab (navigation, refresh).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && tabId === targetTabId) {
    restoreShadowIfAwake(tabId);
  }
});

// Relay messages between content scripts and the recognition host.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SHADOW_STATE') {
    chrome.storage.session.set({ shadowState: message.data });
    sendResponse({ ok: true });
    return true;
  }

  if (
    message.type === 'RECOGNITION_START' ||
    message.type === 'RECOGNITION_STOP' ||
    message.type === 'RECOGNITION_MUTE' ||
    message.type === 'RECOGNITION_UNMUTE'
  ) {
    if (sender.tab && recognitionPort) {
      recognitionPort.postMessage(message);
    }
    return false;
  }

  if (message.type === 'OPEN_PERMISSION_PAGE') {
    chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
    return false;
  }

  // ── Screenshot capture for vision input ──────────────────
  if (message.type === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.captureVisibleTab(
      sender.tab?.windowId,
      { format: 'jpeg', quality: 50 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ dataUrl });
        }
      }
    );
    return true; // async response
  }

  return false;
});