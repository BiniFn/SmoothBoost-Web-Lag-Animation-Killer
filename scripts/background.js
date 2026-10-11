// SmoothBoost - Background Service Worker (Manifest V3)

const DEFAULT_SETTINGS = {
  settingsVersion: 3,
  globalEnabled: true,
  mode: "ultra",
  customSettings: {
    killAnimations: false,
    killTransitions: false,
    killBlurFilters: false,
    killScrollHijack: false,
    pauseBackgroundMedia: false,
    throttleCanvasFps: false,
    pauseOffscreenAnimations: false,
    contentVisibility: false,
    fpsLimit: 30
  },
  siteOverrides: {}
};

const REGISTERED_SCRIPT_IDS = ["smoothboost-content", "smoothboost-page-hook"];
let registrationQueue = Promise.resolve();

function getEffectiveSiteSettings(config, hostname) {
  const siteOverride = config.siteOverrides?.[hostname] || {};
  const enabled = siteOverride.enabled !== undefined ? siteOverride.enabled : config.globalEnabled !== false;
  const mode = siteOverride.mode || config.mode || "ultra";
  const custom = {
    ...DEFAULT_SETTINGS.customSettings,
    ...(config.customSettings || {}),
    ...(siteOverride.customSettings || {})
  };
  return { enabled, mode, custom };
}

function toMatchPattern(hostname) {
  try {
    const normalized = new URL(`https://${hostname}`).hostname;
    if (normalized !== hostname.toLowerCase() || hostname.includes("*")) return null;
    return `*://${normalized}/*`;
  } catch (_error) {
    return null;
  }
}

async function syncRegisteredScripts() {
  if (!chrome.scripting?.registerContentScripts || !chrome.scripting?.unregisterContentScripts) return;

  const { smoothBoostConfig } = await chrome.storage.local.get("smoothBoostConfig");
  const config = { ...DEFAULT_SETTINGS, ...(smoothBoostConfig || {}) };

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: REGISTERED_SCRIPT_IDS });
    const existingIds = existing.map((script) => script.id).filter((id) => REGISTERED_SCRIPT_IDS.includes(id));
    if (existingIds.length) await chrome.scripting.unregisterContentScripts({ ids: existingIds });
  } catch (_error) {
    // Continue to registration; a fresh install has no existing scripts.
  }

  const siteEntries = Object.entries(config.siteOverrides || {});
  const excludedHosts = config.globalEnabled === false ? [] : siteEntries
    .filter(([, override]) => override?.enabled === false)
    .map(([hostname]) => toMatchPattern(hostname))
    .filter(Boolean);
  const matches = config.globalEnabled === false
    ? siteEntries.filter(([, override]) => override?.enabled === true)
      .map(([hostname]) => toMatchPattern(hostname)).filter(Boolean)
    : ["<all_urls>"];
  if (!matches.length) return;

  const common = {
    matches,
    ...(excludedHosts.length ? { excludeMatches: excludedHosts } : {}),
    allFrames: false,
    runAt: "document_start"
  };

  await chrome.scripting.registerContentScripts([
    {
      id: "smoothboost-content",
      ...common,
      js: ["scripts/content.js"],
      world: "ISOLATED"
    },
    {
      id: "smoothboost-page-hook",
      ...common,
      js: ["scripts/page-hook.js"],
      world: "MAIN"
    }
  ]);
}

function queueScriptSync() {
  registrationQueue = registrationQueue.catch(() => {}).then(syncRegisteredScripts);
  return registrationQueue;
}

// Initialize settings and ensure dynamic registrations follow the saved site
// state after installs, upgrades, service-worker restarts, and settings edits.
chrome.runtime.onInstalled.addListener(async ({ reason } = {}) => {
  const existing = await chrome.storage.local.get("smoothBoostConfig");
  const current = existing?.smoothBoostConfig;

  if (!current) {
    await chrome.storage.local.set({ smoothBoostConfig: DEFAULT_SETTINGS });
  } else if (reason === "update" && (current.settingsVersion || 0) < DEFAULT_SETTINGS.settingsVersion) {
    const previousVersion = current.settingsVersion || 0;
    const upgradedCustom = {
      ...DEFAULT_SETTINGS.customSettings,
      ...(current.customSettings || {})
    };
    if (previousVersion < 2) {
      upgradedCustom.killAnimations = false;
      upgradedCustom.killTransitions = false;
      upgradedCustom.killBlurFilters = false;
      upgradedCustom.killScrollHijack = false;
      upgradedCustom.pauseBackgroundMedia = false;
    }
    await chrome.storage.local.set({
      smoothBoostConfig: {
        ...current,
        settingsVersion: DEFAULT_SETTINGS.settingsVersion,
        customSettings: upgradedCustom,
        siteOverrides: current.siteOverrides || {}
      }
    });
  }

  await queueScriptSync();
});

chrome.runtime.onStartup?.addListener(() => {
  queueScriptSync().catch(() => {});
});

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName === "local" && changes.smoothBoostConfig) {
    queueScriptSync().catch(() => {});
  }
});

// Update the toolbar badge for the active site.
async function updateBadge(tabId, url) {
  if (!url || !url.startsWith("http")) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }

  try {
    const domain = new URL(url).hostname;
    const { smoothBoostConfig } = await chrome.storage.local.get("smoothBoostConfig");
    const config = { ...DEFAULT_SETTINGS, ...(smoothBoostConfig || {}) };
    const { enabled, mode } = getEffectiveSiteSettings(config, domain);
    chrome.action.setBadgeText({ tabId, text: enabled ? (mode === "ultra" ? "MAX" : "ON") : "OFF" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: enabled ? "#10b981" : "#6b7280" });
  } catch (_error) {
    // Ignore invalid or browser-owned URLs.
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) await updateBadge(tabId, tab.url);
  } catch (_error) {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) updateBadge(tabId, tab.url);
});

// Consume both the callback error and newer Promise rejection forms. A missing
// content-script receiver is expected on unsupported pages and disabled sites.
function sendTabMessage(tabId, message) {
  let settled = false;
  const finish = () => { settled = true; };
  try {
    const result = chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, () => {
      void chrome.runtime.lastError;
      finish();
    });
    if (result && typeof result.catch === "function") result.catch(finish);
  } catch (_error) {
    finish();
  }
  return settled;
}

chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SYNC_CONTENT_SCRIPTS") {
    queueScriptSync().then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
    return true;
  }
  return false;
});

// Handle keyboard shortcut (Alt+Shift+S / Option+Shift+S).
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-speed-boost") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) return;

  const domain = new URL(tab.url).hostname;
  const { smoothBoostConfig } = await chrome.storage.local.get("smoothBoostConfig");
  const config = { ...DEFAULT_SETTINGS, ...(smoothBoostConfig || {}) };
  const current = getEffectiveSiteSettings(config, domain).enabled;
  config.siteOverrides = {
    ...(config.siteOverrides || {}),
    [domain]: { ...(config.siteOverrides?.[domain] || {}), enabled: !current }
  };

  await chrome.storage.local.set({ smoothBoostConfig: config });
  await queueScriptSync();
  await updateBadge(tab.id, tab.url);
  sendTabMessage(tab.id, { type: "CONFIG_UPDATED", config });
});
