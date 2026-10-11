// SmoothBoost - popup controller

const DEFAULT_SETTINGS = {
  settingsVersion: 3,
  globalEnabled: true,
  mode: 'ultra',
  customSettings: {
    killAnimations: false,
    killTransitions: false,
    killBlurFilters: false,
    killScrollHijack: false,
    pauseBackgroundMedia: false,
    throttleCanvasFps: false,
    contentVisibility: false,
    pauseOffscreenAnimations: false,
    fpsLimit: 30
  },
  siteOverrides: {}
};
const GITHUB_ISSUE_URL = 'https://github.com/BiniFn/SmoothBoost/issues/new';
const UPDATE_CACHE_KEY = 'smoothBoostLatestReleaseCheck';
const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let currentTab = null;
let currentHostname = '';
let config = null;
let lastDiagnostics = null;

const domainLabel = document.getElementById('domain-label');
const siteToggle = document.getElementById('site-toggle');
const btnUltra = document.getElementById('btn-ultra');
const btnBalanced = document.getElementById('btn-balanced');
const btnCustom = document.getElementById('btn-custom');
const resetBtn = document.getElementById('reset-defaults');
const controlsTab = document.getElementById('tab-controls');
const helpTab = document.getElementById('tab-help');
const controlsPanel = document.getElementById('controls-panel');
const helpPanel = document.getElementById('help-panel');
const statusDot = document.getElementById('status-dot');
const statusPage = document.getElementById('status-page');
const statusDetail = document.getElementById('status-detail');
const statusProfile = document.getElementById('status-profile');
const statusSiteRule = document.getElementById('status-site-rule');
const siteRuleRow = document.getElementById('site-rule-row');
const toggleAnim = document.getElementById('toggle-animations');
const toggleTrans = document.getElementById('toggle-transitions');
const toggleBlur = document.getElementById('toggle-blur');
const toggleScroll = document.getElementById('toggle-scroll');
const toggleMedia = document.getElementById('toggle-media');
const toggleFps = document.getElementById('toggle-fps');
const toggleOffscreen = document.getElementById('toggle-offscreen-animations');
const toggleContentVisibility = document.getElementById('toggle-content-visibility');
const diagnosticsButton = document.getElementById('diagnose-page');
const diagnosticsSummary = document.getElementById('diagnostics-summary');
const diagnosticsResults = document.getElementById('diagnostics-results');
const diagnosticsSuggestions = document.getElementById('diagnostics-suggestions');
const siteBrokenButton = document.getElementById('site-broken');
const bugReportLink = document.getElementById('bug-report-link');
const updateStatus = document.getElementById('update-status');
const checkUpdatesButton = document.getElementById('check-updates');
const downloadUpdateLink = document.getElementById('download-update');
const releaseUpdateLink = document.getElementById('release-update-link');

const PRESET_CONFIGS = {
  ultra: {
    killAnimations: false,
    killTransitions: false,
    killBlurFilters: true,
    killScrollHijack: false,
    pauseBackgroundMedia: true,
    throttleCanvasFps: false,
    pauseOffscreenAnimations: true,
    contentVisibility: false
  },
  balanced: {
    killAnimations: false,
    killTransitions: false,
    killBlurFilters: false,
    killScrollHijack: false,
    pauseBackgroundMedia: false,
    throttleCanvasFps: false,
    pauseOffscreenAnimations: false,
    contentVisibility: false
  }
};

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  if (tab?.url && /^https?:\/\//i.test(tab.url)) {
    try {
      currentHostname = new URL(tab.url).hostname.toLowerCase();
      domainLabel.textContent = currentHostname;
    } catch (_error) {
      domainLabel.textContent = 'Current tab';
    }
  } else {
    domainLabel.textContent = 'Browser page (inactive)';
    siteToggle.disabled = true;
    siteBrokenButton.disabled = true;
  }

  const stored = await chrome.storage.local.get('smoothBoostConfig');
  config = {
    ...DEFAULT_SETTINGS,
    ...(stored.smoothBoostConfig || {}),
    customSettings: { ...DEFAULT_SETTINGS.customSettings, ...(stored.smoothBoostConfig?.customSettings || {}) },
    siteOverrides: stored.smoothBoostConfig?.siteOverrides || {}
  };
  renderUI();
  requestPageStatus();
  bindEvents();
  bugReportLink.href = buildIssueUrl(false);
  void checkForUpdates();
}

function renderUpdateResult(result, checkedAt, note = '') {
  downloadUpdateLink.hidden = true;
  releaseUpdateLink.hidden = true;

  if (!result) {
    updateStatus.textContent = note || 'Could not read the latest GitHub release. Try again.';
    return;
  }

  const freshness = note || (checkedAt ? ` Checked ${new Date(checkedAt).toLocaleString()}.` : '');
  if (result.status === 'update') {
    updateStatus.textContent = `Update available: ${result.latestVersion}.${freshness}`;
    downloadUpdateLink.href = result.downloadUrl;
    downloadUpdateLink.textContent = `Download SmoothBoost ${result.latestVersion}`;
    downloadUpdateLink.hidden = false;
    return;
  }
  if (result.status === 'update-without-zip') {
    updateStatus.textContent = `Version ${result.latestVersion} is available, but its ZIP is not attached yet.${freshness}`;
    releaseUpdateLink.href = result.releaseUrl;
    releaseUpdateLink.hidden = false;
    return;
  }
  if (result.status === 'ahead') {
    updateStatus.textContent = `This installed version is newer than the latest GitHub release (${result.latestVersion}).${freshness}`;
    return;
  }
  updateStatus.textContent = `You're up to date (${result.currentVersion}).${freshness}`;
}

async function checkForUpdates(force = false) {
  const currentVersion = chrome.runtime.getManifest().version;
  let cached = null;
  try {
    const stored = await chrome.storage.local.get(UPDATE_CACHE_KEY);
    cached = stored[UPDATE_CACHE_KEY];
  } catch (_error) {
    // Continue with a network check if extension storage is unavailable.
  }

  const isFresh = cached && Number.isFinite(cached.checkedAt)
    && Date.now() - cached.checkedAt >= 0
    && Date.now() - cached.checkedAt < UPDATE_CACHE_TTL_MS;
  const cachedResult = isFresh ? SmoothBoostUpdates.fromCache(currentVersion, cached) : null;
  if (!force && cachedResult) {
    renderUpdateResult(cachedResult, cached.checkedAt);
    return;
  }

  checkUpdatesButton.disabled = true;
  checkUpdatesButton.textContent = 'Checking…';
  updateStatus.textContent = 'Checking GitHub for a newer version…';
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(SmoothBoostUpdates.RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    const result = SmoothBoostUpdates.fromRelease(currentVersion, release);
    if (!result) throw new Error('GitHub release metadata was not valid');

    const checkedAt = Date.now();
    try {
      await chrome.storage.local.set({
        [UPDATE_CACHE_KEY]: {
          checkedAt,
          latestVersion: result.latestVersion,
          hasZip: result.hasZip
        }
      });
    } catch (_error) {
      // The result is still useful even when it cannot be cached.
    }
    renderUpdateResult(result, checkedAt);
  } catch (_error) {
    if (cachedResult) {
      renderUpdateResult(cachedResult, cached.checkedAt, 'GitHub could not be reached; showing the last checked result.');
    } else {
      renderUpdateResult(null, null, 'Could not check GitHub. Check your connection and try again.');
    }
  } finally {
    window.clearTimeout(timeoutId);
    checkUpdatesButton.disabled = false;
    checkUpdatesButton.textContent = 'Check now';
  }
}

function getSiteState() {
  if (!currentHostname) return { enabled: config.globalEnabled, mode: config.mode || 'ultra' };
  const override = config.siteOverrides?.[currentHostname] || {};
  return {
    enabled: override.enabled !== undefined ? override.enabled : config.globalEnabled,
    mode: override.mode || config.mode || 'ultra'
  };
}

function getCustomSettings() {
  const site = currentHostname ? config.siteOverrides?.[currentHostname] : null;
  return {
    ...DEFAULT_SETTINGS.customSettings,
    ...(config.customSettings || {}),
    ...(site?.customSettings || {})
  };
}

function getEffectiveSettings() {
  const { enabled, mode } = getSiteState();
  if (!enabled) return { enabled: false, mode: 'off' };
  if (mode === 'ultra') return { enabled: true, mode, ...PRESET_CONFIGS.ultra };
  if (mode === 'balanced') return { enabled: true, mode, ...PRESET_CONFIGS.balanced };
  return { enabled: true, mode: 'custom', ...getCustomSettings() };
}

function renderUI() {
  const { enabled, mode } = getSiteState();
  siteToggle.checked = enabled;
  document.body.classList.toggle('site-disabled', !enabled);
  [btnUltra, btnBalanced, btnCustom].forEach((button) => button.classList.remove('active'));
  ({ ultra: btnUltra, balanced: btnBalanced, custom: btnCustom }[mode] || btnCustom).classList.add('active');

  const switchValues = mode === 'custom' ? getCustomSettings() : PRESET_CONFIGS[mode] || PRESET_CONFIGS.ultra;
  toggleAnim.checked = !!switchValues.killAnimations;
  toggleTrans.checked = !!switchValues.killTransitions;
  toggleBlur.checked = !!switchValues.killBlurFilters;
  toggleScroll.checked = !!switchValues.killScrollHijack;
  toggleMedia.checked = !!switchValues.pauseBackgroundMedia;
  toggleFps.checked = !!switchValues.throttleCanvasFps;
  toggleOffscreen.checked = !!switchValues.pauseOffscreenAnimations;
  toggleContentVisibility.checked = !!switchValues.contentVisibility;

  const customOnly = mode !== 'custom';
  [toggleAnim, toggleTrans, toggleBlur, toggleScroll, toggleMedia, toggleFps, toggleOffscreen, toggleContentVisibility]
    .forEach((input) => { input.disabled = customOnly; });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response, error = null) => {
      if (settled) return;
      settled = true;
      resolve({ response, error });
    };
    try {
      const result = chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
        const error = chrome.runtime.lastError;
        finish(response, error || null);
      });
      if (result && typeof result.then === 'function') result.then((response) => finish(response)).catch((error) => finish(undefined, error));
    } catch (error) {
      finish(undefined, error);
    }
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        resolve({ response, error: error || null });
      });
    } catch (error) {
      resolve({ response: undefined, error });
    }
  });
}

async function injectCurrentTabScripts() {
  if (!currentTab?.id || !getSiteState().enabled) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, frameIds: [0] },
      world: 'MAIN',
      files: ['scripts/page-hook.js']
    });
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, frameIds: [0] },
      files: ['scripts/content.js']
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function saveAndBroadcast() {
  await chrome.storage.local.set({ smoothBoostConfig: config });
  await sendRuntimeMessage({ type: 'SYNC_CONTENT_SCRIPTS' });
  if (!currentTab?.id) return;

  const { enabled } = getSiteState();
  const result = await sendTabMessage(currentTab.id, { type: 'CONFIG_UPDATED', config });
  if (enabled && result.error) await injectCurrentTabScripts();

  if (currentTab.url) {
    const isEnabled = getSiteState().enabled;
    const mode = getSiteState().mode;
    chrome.action.setBadgeText({ tabId: currentTab.id, text: isEnabled ? (mode === 'ultra' ? 'MAX' : 'ON') : 'OFF' });
    chrome.action.setBadgeBackgroundColor({ tabId: currentTab.id, color: isEnabled ? '#10b981' : '#6b7280' });
  }
  requestPageStatus();
}

function updateSiteOverride(patch) {
  if (currentHostname) {
    config.siteOverrides ||= {};
    config.siteOverrides[currentHostname] = { ...(config.siteOverrides[currentHostname] || {}), ...patch };
  } else {
    Object.assign(config, patch);
  }
}

function setMode(mode) {
  updateSiteOverride({ mode });
  renderUI();
  saveAndBroadcast();
}

function setCustomSetting(key, value) {
  const current = getCustomSettings();
  current[key] = value;
  updateSiteOverride({ mode: 'custom', customSettings: current });
  renderUI();
  saveAndBroadcast();
}

function renderRuleStatus(status) {
  if (status === 'paused') statusSiteRule.textContent = 'Paused';
  else if (status === 'waiting' || status === 'armed') statusSiteRule.textContent = 'Waiting for autoplay';
  else if (status === 'unconfirmed') statusSiteRule.textContent = 'Not confirmed';
  else statusSiteRule.textContent = 'Off';
}

function renderReloadStatus() {
  statusDot.className = 'status-dot is-warning';
  statusPage.textContent = 'Reload tab to activate';
  statusDetail.textContent = 'Reload this tab after installing or updating SmoothBoost.';
  statusProfile.textContent = '—';
  siteRuleRow.hidden = true;
}

function renderUnsupportedStatus() {
  statusDot.className = 'status-dot is-muted';
  statusPage.textContent = 'Unsupported page';
  statusDetail.textContent = 'The browser does not allow extensions to run on this page.';
  statusProfile.textContent = '—';
  siteRuleRow.hidden = true;
}

function renderSiteOffStatus() {
  statusDot.className = 'status-dot is-muted';
  statusPage.textContent = 'Off for this site';
  statusDetail.textContent = 'SmoothBoost is not injected here. Turn it on and reload this tab to apply it.';
  statusProfile.textContent = 'Off';
  siteRuleRow.hidden = true;
}

function requestPageStatus(attempt = 0) {
  if (!currentTab?.id || !currentTab.url || !/^https?:\/\//i.test(currentTab.url)) {
    renderUnsupportedStatus();
    return;
  }
  sendTabMessage(currentTab.id, { type: 'GET_STATUS' }).then(({ response, error }) => {
    if (!error && response?.status === 'initializing' && attempt < 8) {
      window.setTimeout(() => requestPageStatus(attempt + 1), 125);
      return;
    }
    if (!error && response?.status === 'initializing') {
      renderReloadStatus();
      return;
    }
    if (error || !response?.status) {
      if (!getSiteState().enabled) renderSiteOffStatus();
      else renderReloadStatus();
      return;
    }

    statusDot.className = response.enabled ? 'status-dot is-active' : 'status-dot is-muted';
    statusPage.textContent = response.enabled ? 'Active' : 'Off for this site';
    statusDetail.textContent = response.enabled
      ? 'SmoothBoost is running in this tab.'
      : 'SmoothBoost is loaded, but paused for this site.';
    statusProfile.textContent = response.enabled
      ? ({ ultra: 'Maximum', balanced: 'Balanced', custom: 'Custom' }[response.mode] || 'Custom')
      : 'Off';
    const onReanime = response.siteRule !== 'not-applicable';
    siteRuleRow.hidden = !onReanime;
    if (onReanime) renderRuleStatus(response.siteRule);
  });
}

function renderDiagnostics(diagnostics) {
  lastDiagnostics = diagnostics;
  diagnosticsResults.hidden = false;
  document.getElementById('count-autoplay').textContent = String(diagnostics.autoplayVideos);
  document.getElementById('count-blur').textContent = String(diagnostics.blurElements);
  document.getElementById('count-animations').textContent = String(diagnostics.animationLoops);
  document.getElementById('count-frames').textContent = diagnostics.longFrameApi ? String(diagnostics.longFrames) : 'N/A';
  diagnosticsSummary.textContent = diagnostics.longFrameApi
    ? `Recent 30-second sample; ${diagnostics.sampledElements} elements checked for blur.`
    : `Long-frame reporting is not available here; ${diagnostics.sampledElements} elements checked for blur.`;
  renderSuggestions(diagnostics);
}

function renderSuggestions(diagnostics) {
  const settings = getEffectiveSettings();
  const suggestions = [];
  if (diagnostics.autoplayVideos > 0 && !settings.pauseBackgroundMedia) {
    suggestions.push(['pauseBackgroundMedia', 'Pause offscreen autoplay previews']);
  }
  if (diagnostics.blurElements > 0 && !settings.killBlurFilters) {
    suggestions.push(['killBlurFilters', 'Reduce backdrop blur']);
  }
  if (diagnostics.animationLoops > 0 && !settings.pauseOffscreenAnimations) {
    suggestions.push(['pauseOffscreenAnimations', 'Pause offscreen animations']);
  }
  if (diagnostics.longFrames > 0 && diagnostics.longFrameApi && !settings.throttleCanvasFps) {
    suggestions.push(['throttleCanvasFps', 'Try adaptive frame limiting']);
  }
  diagnosticsSuggestions.replaceChildren();
  if (!suggestions.length) {
    diagnosticsSuggestions.hidden = true;
    return;
  }
  diagnosticsSuggestions.hidden = false;
  for (const [key, label] of suggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-button';
    button.textContent = label;
    button.addEventListener('click', () => setCustomSetting(key, true));
    diagnosticsSuggestions.appendChild(button);
  }
}

async function runDiagnostics() {
  if (!currentTab?.id) return;
  diagnosticsButton.disabled = true;
  diagnosticsButton.textContent = 'Checking';
  const { response, error } = await sendTabMessage(currentTab.id, { type: 'GET_DIAGNOSTICS' });
  diagnosticsButton.disabled = false;
  diagnosticsButton.textContent = 'Check';
  if (!error && response?.diagnostics) {
    renderDiagnostics(response.diagnostics);
  } else {
    diagnosticsSummary.textContent = getSiteState().enabled
      ? 'Reload this tab to collect page activity.'
      : 'Turn SmoothBoost on for this site to inspect page activity.';
  }
}

function buildIssueUrl(siteBroken) {
  const profile = getSiteState().mode || 'unknown';
  const browser = typeof navigator !== 'undefined' ? (navigator.userAgent || 'Unknown browser') : 'Unknown browser';
  const title = siteBroken ? `[Bug] Site looks broken on ${currentHostname || 'this page'}` : '[Bug] SmoothBoost issue';
  const counts = lastDiagnostics
    ? `\nDiagnostics: autoplay videos ${lastDiagnostics.autoplayVideos}, blur panels ${lastDiagnostics.blurElements}, looping animations ${lastDiagnostics.animationLoops}, long frames ${lastDiagnostics.longFrames}.`
    : '';
  const body = [
    '## Page details',
    `- Site: ${currentHostname || 'unknown'}`,
    `- Profile: ${profile}`,
    `- Browser: ${browser}`,
    siteBroken ? '- SmoothBoost was turned off for this site from the popup.' : '',
    counts,
    '',
    '## What happened?',
    '',
    '## Steps to reproduce',
    '1. ',
    '',
    '## Expected result',
    '',
    '## Actual result',
    ''
  ].filter(Boolean).join('\n');
  return `${GITHUB_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

function bindEvents() {
  controlsTab.addEventListener('click', () => selectTab('controls'));
  helpTab.addEventListener('click', () => selectTab('help'));
  checkUpdatesButton.addEventListener('click', () => { void checkForUpdates(true); });
  siteToggle.addEventListener('change', () => {
    updateSiteOverride({ enabled: siteToggle.checked });
    renderUI();
    saveAndBroadcast();
  });
  btnUltra.addEventListener('click', () => setMode('ultra'));
  btnBalanced.addEventListener('click', () => setMode('balanced'));
  btnCustom.addEventListener('click', () => setMode('custom'));

  [
    [toggleAnim, 'killAnimations'],
    [toggleTrans, 'killTransitions'],
    [toggleBlur, 'killBlurFilters'],
    [toggleScroll, 'killScrollHijack'],
    [toggleMedia, 'pauseBackgroundMedia'],
    [toggleFps, 'throttleCanvasFps'],
    [toggleOffscreen, 'pauseOffscreenAnimations'],
    [toggleContentVisibility, 'contentVisibility']
  ].forEach(([input, key]) => input.addEventListener('change', () => setCustomSetting(key, input.checked)));

  diagnosticsButton.addEventListener('click', runDiagnostics);
  siteBrokenButton.addEventListener('click', async () => {
    if (!currentHostname || !currentTab?.id) return;
    updateSiteOverride({ enabled: false });
    renderUI();
    await saveAndBroadcast();
    await chrome.tabs.create({ url: buildIssueUrl(true) });
  });
  bugReportLink.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: buildIssueUrl(false) });
  });

  resetBtn.addEventListener('click', async () => {
    config = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    renderUI();
    await saveAndBroadcast();
  });
}

function selectTab(tabName) {
  const showControls = tabName === 'controls';
  controlsTab.classList.toggle('is-selected', showControls);
  helpTab.classList.toggle('is-selected', !showControls);
  controlsTab.setAttribute('aria-selected', String(showControls));
  helpTab.setAttribute('aria-selected', String(!showControls));
  controlsTab.tabIndex = showControls ? 0 : -1;
  helpTab.tabIndex = showControls ? -1 : 0;
  controlsPanel.hidden = !showControls;
  helpPanel.hidden = showControls;
}

document.addEventListener('DOMContentLoaded', init);
