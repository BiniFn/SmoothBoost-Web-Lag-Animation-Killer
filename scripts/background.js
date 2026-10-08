// SmoothBoost - Background Service Worker (Manifest V3)

const DEFAULT_SETTINGS = {
  globalEnabled: true,
  mode: "ultra", // "ultra" | "balanced" | "custom"
  customSettings: {
    killAnimations: true,
    killTransitions: true,
    killBlurFilters: true,
    killScrollHijack: true,
    pauseBackgroundMedia: true,
    throttleCanvasFps: false,
    fpsLimit: 30,
    forceReducedMotion: true
  },
  siteOverrides: {} // hostname -> { enabled: boolean, mode?: string }
};

// A top-level document may not have a content script (for example, while it is
// still loading or on a browser-owned page). Handle both the callback error and
// the Promise form used by newer Chromium builds so neither becomes unhandled.
function sendTabMessage(tabId, message) {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
  };

  try {
    const result = chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, () => {
      // Reading lastError inside the callback consumes Chromium's callback API
      // error, including the normal "Receiving end does not exist" case.
      void chrome.runtime.lastError;
      finish();
    });
    if (result && typeof result.catch === "function") {
      result.catch(finish);
    }
  } catch (error) {
    finish();
  }
}

// Initialize settings on installation
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("smoothBoostConfig");
  if (!existing || !existing.smoothBoostConfig) {
    await chrome.storage.local.set({ smoothBoostConfig: DEFAULT_SETTINGS });
  }
});

// Update badge for active tab
async function updateBadge(tabId, url) {
  if (!url || !url.startsWith("http")) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }

  try {
    const domain = new URL(url).hostname;
    const { smoothBoostConfig } = await chrome.storage.local.get("smoothBoostConfig");
    const config = smoothBoostConfig || DEFAULT_SETTINGS;

    const siteSetting = config.siteOverrides?.[domain];
    const isSiteEnabled = siteSetting?.enabled !== undefined
      ? siteSetting.enabled
      : config.globalEnabled;

    if (isSiteEnabled) {
      const modeText = (siteSetting?.mode || config.mode) === "ultra" ? "MAX" : "ON";
      chrome.action.setBadgeText({ tabId, text: modeText });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#10b981" }); // Emerald Green
    } else {
      chrome.action.setBadgeText({ tabId, text: "OFF" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#6b7280" }); // Slate Gray
    }
  } catch (e) {
    // Ignore invalid URLs (chrome://, about:, etc.)
  }
}

// Listen for tab activation / update
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.url) {
      updateBadge(activeInfo.tabId, tab.url);
    }
  } catch (e) {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    updateBadge(tabId, tab.url);
  }
});

// Handle keyboard shortcut (Alt+Shift+S / Option+Shift+S)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-speed-boost") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.startsWith("http")) return;

    const domain = new URL(tab.url).hostname;
    const { smoothBoostConfig } = await chrome.storage.local.get("smoothBoostConfig");
    const config = smoothBoostConfig || DEFAULT_SETTINGS;

    const currentSiteState = config.siteOverrides?.[domain]?.enabled !== undefined
      ? config.siteOverrides[domain].enabled
      : config.globalEnabled;

    const newState = !currentSiteState;

    if (!config.siteOverrides) config.siteOverrides = {};
    config.siteOverrides[domain] = {
      ...(config.siteOverrides[domain] || {}),
      enabled: newState
    };

    await chrome.storage.local.set({ smoothBoostConfig: config });
    updateBadge(tab.id, tab.url);

    // Notify tab content script
    sendTabMessage(tab.id, { type: "CONFIG_UPDATED", config });
  }
});
