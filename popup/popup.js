// SmoothBoost - Popup Controller Script

const DEFAULT_SETTINGS = {
  globalEnabled: true,
  mode: "ultra",
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
  siteOverrides: {}
};

let currentTab = null;
let currentHostname = "";
let config = null;

// DOM Elements
const domainLabel = document.getElementById("domain-label");
const siteToggle = document.getElementById("site-toggle");
const btnUltra = document.getElementById("btn-ultra");
const btnBalanced = document.getElementById("btn-balanced");
const btnCustom = document.getElementById("btn-custom");
const resetBtn = document.getElementById("reset-defaults");

const statusDot = document.getElementById("status-dot");
const statusPage = document.getElementById("status-page");
const statusDetail = document.getElementById("status-detail");
const statusProfile = document.getElementById("status-profile");
const statusSiteRule = document.getElementById("status-site-rule");
const siteRuleRow = document.getElementById("site-rule-row");

const toggleAnim = document.getElementById("toggle-animations");
const toggleTrans = document.getElementById("toggle-transitions");
const toggleBlur = document.getElementById("toggle-blur");
const toggleScroll = document.getElementById("toggle-scroll");
const toggleMedia = document.getElementById("toggle-media");
const toggleFps = document.getElementById("toggle-fps");

// Presets mapping
const PRESET_CONFIGS = {
  ultra: {
    killAnimations: true,
    killTransitions: true,
    killBlurFilters: true,
    killScrollHijack: true,
    pauseBackgroundMedia: true,
    throttleCanvasFps: false
  },
  balanced: {
    killAnimations: true,
    killTransitions: false,
    killBlurFilters: true,
    killScrollHijack: true,
    pauseBackgroundMedia: true,
    throttleCanvasFps: false
  }
};

async function init() {
  // 1. Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  if (tab && tab.url && /^https?:\/\//i.test(tab.url)) {
    try {
      const url = new URL(tab.url);
      currentHostname = url.hostname;
      domainLabel.textContent = currentHostname;
    } catch (e) {
      domainLabel.textContent = "Current tab";
    }
  } else {
    domainLabel.textContent = "Browser page (inactive)";
    siteToggle.disabled = true;
  }

  // 2. Load stored config
  const stored = await chrome.storage.local.get("smoothBoostConfig");
  config = stored.smoothBoostConfig || JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

  // 3. Render UI based on config
  renderUI();

  // 4. Query applied state from the active tab's top frame
  requestPageStatus();

  // 5. Attach event listeners
  bindEvents();
}

function getSiteState() {
  if (!currentHostname) return { enabled: config.globalEnabled, mode: config.mode };
  const override = config.siteOverrides?.[currentHostname];
  return {
    enabled: override?.enabled !== undefined ? override.enabled : config.globalEnabled,
    mode: override?.mode || config.mode || "ultra"
  };
}

function renderUI() {
  const { enabled, mode } = getSiteState();

  // Site toggle & container disabled class
  siteToggle.checked = enabled;
  if (!enabled) {
    document.body.classList.add("site-disabled");
  } else {
    document.body.classList.remove("site-disabled");
  }

  // Preset buttons
  [btnUltra, btnBalanced, btnCustom].forEach(b => b.classList.remove("active"));
  if (mode === "ultra") btnUltra.classList.add("active");
  else if (mode === "balanced") btnBalanced.classList.add("active");
  else btnCustom.classList.add("active");

  // Determine active switches values
  let switchValues;
  const isPreset = (mode === "ultra" || mode === "balanced");

  if (isPreset) {
    switchValues = PRESET_CONFIGS[mode];
  } else {
    switchValues = config.customSettings;
  }

  toggleAnim.checked = !!switchValues.killAnimations;
  toggleTrans.checked = !!switchValues.killTransitions;
  toggleBlur.checked = !!switchValues.killBlurFilters;
  toggleScroll.checked = !!switchValues.killScrollHijack;
  toggleMedia.checked = !!switchValues.pauseBackgroundMedia;
  toggleFps.checked = !!switchValues.throttleCanvasFps;

  // If in a fixed preset, make switches read-only/disabled
  const customOnly = (mode !== "custom");
  [toggleAnim, toggleTrans, toggleBlur, toggleScroll, toggleMedia, toggleFps].forEach(sw => {
    sw.disabled = customOnly;
  });
}

async function saveAndBroadcast() {
  await chrome.storage.local.set({ smoothBoostConfig: config });

  if (currentTab && currentTab.id) {
    sendTabMessage(currentTab.id, { type: "CONFIG_UPDATED", config });

    // Update badge in background
    if (currentTab.url) {
      const isSiteEnabled = getSiteState().enabled;
      chrome.action.setBadgeText({
        tabId: currentTab.id,
        text: isSiteEnabled ? (getSiteState().mode === "ultra" ? "MAX" : "ON") : "OFF"
      });
      chrome.action.setBadgeBackgroundColor({
        tabId: currentTab.id,
        color: isSiteEnabled ? "#10b981" : "#6b7280"
      });
    }

    requestPageStatus();
  }
}

function setMode(newMode) {
  if (currentHostname) {
    if (!config.siteOverrides) config.siteOverrides = {};
    config.siteOverrides[currentHostname] = {
      ...(config.siteOverrides[currentHostname] || {}),
      mode: newMode
    };
  } else {
    config.mode = newMode;
  }
  renderUI();
  saveAndBroadcast();
}

function bindEvents() {
  // Master site toggle
  siteToggle.addEventListener("change", () => {
    const isChecked = siteToggle.checked;
    if (currentHostname) {
      if (!config.siteOverrides) config.siteOverrides = {};
      config.siteOverrides[currentHostname] = {
        ...(config.siteOverrides[currentHostname] || {}),
        enabled: isChecked
      };
    } else {
      config.globalEnabled = isChecked;
    }
    renderUI();
    saveAndBroadcast();
  });

  // Preset button clicks
  btnUltra.addEventListener("click", () => setMode("ultra"));
  btnBalanced.addEventListener("click", () => setMode("balanced"));
  btnCustom.addEventListener("click", () => setMode("custom"));

  // Custom switches
  const customSwitches = [
    { el: toggleAnim, key: "killAnimations" },
    { el: toggleTrans, key: "killTransitions" },
    { el: toggleBlur, key: "killBlurFilters" },
    { el: toggleScroll, key: "killScrollHijack" },
    { el: toggleMedia, key: "pauseBackgroundMedia" },
    { el: toggleFps, key: "throttleCanvasFps" }
  ];

  customSwitches.forEach(({ el, key }) => {
    el.addEventListener("change", () => {
      config.customSettings[key] = el.checked;
      setMode("custom");
    });
  });

  // Reset defaults
  resetBtn.addEventListener("click", async () => {
    config = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    renderUI();
    await saveAndBroadcast();
  });
}

function sendTabMessage(tabId, message, callback = () => {}) {
  let settled = false;
  const finish = (response, error = null) => {
    if (settled) return;
    settled = true;
    callback(response, error);
  };

  try {
    const result = chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
      const error = chrome.runtime.lastError;
      finish(response, error || null);
    });
    if (result && typeof result.catch === "function") {
      result.catch((error) => finish(undefined, error));
    }
  } catch (error) {
    finish(undefined, error);
  }
}

function requestPageStatus(attempt = 0) {
  if (!currentTab || !currentTab.id) {
    renderUnsupportedStatus();
    return;
  }

  if (!currentTab.url || !/^https?:\/\//i.test(currentTab.url)) {
    renderUnsupportedStatus();
    return;
  }

  sendTabMessage(currentTab.id, { type: "GET_STATUS" }, (response, error) => {
    if (!error && response?.status === "initializing" && attempt < 8) {
      window.setTimeout(() => requestPageStatus(attempt + 1), 125);
      return;
    }
    if (!error && response?.status === "initializing") {
      renderReloadStatus();
      return;
    }
    if (error || !response?.status) {
      renderReloadStatus();
      return;
    }

    statusDot.className = "status-dot is-active";
    statusPage.textContent = "Active";
    statusDetail.textContent = response.enabled
      ? "SmoothBoost is running in this tab."
      : "SmoothBoost is loaded, but paused for this site.";
    statusProfile.textContent = response.enabled
      ? ({ ultra: "Maximum", balanced: "Balanced", custom: "Custom" }[response.mode] || "Custom")
      : "Off";

    const onReanime = response.siteRule !== "not-applicable";
    siteRuleRow.hidden = !onReanime;
    if (onReanime) {
      statusSiteRule.textContent = response.siteRule === "paused"
        ? "Paused"
        : response.siteRule === "waiting"
          ? "Waiting for hero"
          : response.siteRule === "armed"
            ? "Waiting for autoplay"
            : response.siteRule === "unconfirmed"
              ? "Not confirmed"
              : "Off";
    }
  });
}

function renderReloadStatus() {
  statusDot.className = "status-dot is-warning";
  statusPage.textContent = "Reload tab to activate";
  statusDetail.textContent = "Reload this tab after installing or updating SmoothBoost.";
  statusProfile.textContent = "—";
  siteRuleRow.hidden = true;
}

function renderUnsupportedStatus() {
  statusDot.className = "status-dot is-muted";
  statusPage.textContent = "Unsupported page";
  statusDetail.textContent = "The browser does not allow extensions to run on this page.";
  statusProfile.textContent = "—";
  siteRuleRow.hidden = true;
}

document.addEventListener("DOMContentLoaded", init);
