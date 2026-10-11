// SmoothBoost - isolated content script. Dynamic registration keeps this out of
// pages where the user has turned the extension off.

(function () {
  'use strict';

  const STYLE_ID = 'smoothboost-injected-styles';
  const CHANNEL_ATTRIBUTE = 'data-smoothboost-channel';
  const isTopFrame = window === window.top;
  const REANIME_HOST = 'reanime.to';
  const DEFAULT_RULES = {
    genericCarouselSelectors: ['.swiper', '[data-swiper]'],
    siteRules: [{
      hosts: ['reanime.to'],
      paths: ['/', '/home'],
      heroSelectors: ['[aria-label="Hero carousel"]', '[aria-label*="hero carousel" i]', '[data-testid*="hero-carousel" i]']
    }]
  };
  const DEFAULT_CONFIG = {
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

  let currentSettings = { enabled: false, mode: 'off' };
  let initialized = false;
  let reanimeRuleState = 'not-applicable';
  let storageChangeCount = 0;
  let siteRules = DEFAULT_RULES;
  let pageHookChannel = '';
  let videoObserver = null;
  let videoMutationObserver = null;
  let animationObserver = null;
  let animationMutationObserver = null;
  let carouselMutationObserver = null;
  let styleRootObserver = null;
  let diagnosticsObserver = null;
  let pendingCss = '';
  let animationScanTimer = 0;
  let blurScanTimer = 0;
  let animationTargets = new Set();
  let pausedVideos = new Set();
  let blurStates = new Map();
  let markedCarousels = new Set();
  let hookStatusTimer = 0;
  let observedAnimationTargets = new WeakSet();
  let blurScanQueue = [];
  const longFrameTimes = [];

  function getReanimeRule() {
    const path = window.location.pathname;
    return siteRules.siteRules?.find((rule) =>
      rule.hosts?.includes(window.location.hostname.toLowerCase()) && rule.paths?.includes(path)
    ) || null;
  }

  function isReanimeHomePage() {
    return !!getReanimeRule();
  }

  function effectiveSettings(config, hostname) {
    const source = config || DEFAULT_CONFIG;
    const site = source.siteOverrides?.[hostname] || {};
    const enabled = site.enabled !== undefined ? site.enabled : source.globalEnabled !== false;
    if (!enabled) return { enabled: false, mode: 'off' };
    const mode = site.mode || source.mode || 'ultra';
    const custom = {
      ...DEFAULT_CONFIG.customSettings,
      ...(source.customSettings || {}),
      ...(site.customSettings || {})
    };

    if (mode === 'ultra') {
      return {
        enabled: true,
        mode,
        killAnimations: false,
        killTransitions: false,
        killBlurFilters: true,
        killScrollHijack: false,
        pauseBackgroundMedia: true,
        pauseOffscreenAnimations: true,
        contentVisibility: false,
        throttleCanvasFps: false,
        fpsLimit: 30
      };
    }

    if (mode === 'balanced') {
      return {
        enabled: true,
        mode,
        killAnimations: false,
        killTransitions: false,
        killBlurFilters: false,
        killScrollHijack: false,
        pauseBackgroundMedia: false,
        pauseOffscreenAnimations: false,
        contentVisibility: false,
        throttleCanvasFps: false,
        fpsLimit: 30
      };
    }

    return {
      enabled: true,
      mode: 'custom',
      ...custom,
      fpsLimit: custom.fpsLimit || 30
    };
  }

  function buildStylesheet(settings) {
    if (!settings.enabled) return '';
    let css = '/* SmoothBoost page-specific performance rules */\n';
    if (settings.killScrollHijack) {
      css += 'html, body { scroll-behavior: auto !important; }\n';
    }
    if (settings.killAnimations) {
      css += '* , *::before, *::after { animation-duration: 0.0001s !important; animation-iteration-count: 1 !important; animation-delay: 0s !important; animation-play-state: running !important; animation-fill-mode: both !important; }\n';
    }
    if (settings.killTransitions) {
      css += '* , *::before, *::after { transition-duration: 0.0001s !important; transition-delay: 0s !important; }\n';
    }
    if (settings.killBlurFilters) {
      css += '[data-smoothboost-blur="true"] { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }\n';
    }
    if (settings.pauseOffscreenAnimations) {
      css += '[data-smoothboost-offscreen-animation="true"], [data-smoothboost-offscreen-animation="true"]::before, [data-smoothboost-offscreen-animation="true"]::after { animation-play-state: paused !important; }\n';
    }
    if (settings.contentVisibility) {
      css += 'main, [role="main"] { content-visibility: auto !important; contain-intrinsic-size: auto 1000px !important; }\n';
    }
    return css;
  }

  function applyStyles(css) {
    pendingCss = css;
    let style = document.getElementById(STYLE_ID);
    if (!css) {
      style?.remove();
      return;
    }
    const parent = document.head || document.documentElement;
    if (!parent) {
      if (!styleRootObserver && typeof MutationObserver === 'function') {
        styleRootObserver = new MutationObserver(() => {
          if (document.head || document.documentElement) {
            styleRootObserver.disconnect();
            styleRootObserver = null;
            applyStyles(pendingCss);
          }
        });
        styleRootObserver.observe(document, { childList: true, subtree: true });
      }
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      parent.appendChild(style);
    }
    style.textContent = css;
  }

  function dispatchHookCommand(action) {
    const root = document.documentElement;
    const channel = pageHookChannel || root?.getAttribute?.(CHANNEL_ATTRIBUTE) || '';
    if (!channel || typeof CustomEvent !== 'function') return;
    pageHookChannel = channel;
    window.dispatchEvent(new CustomEvent(channel, { detail: { action } }));
  }

  function syncPageHook(settings) {
    const optimizeOffscreen = settings.enabled && (
      settings.mode === 'ultra' || settings.pauseOffscreenAnimations || isReanimeHomePage()
    );
    dispatchHookCommand(optimizeOffscreen ? 'optimizations-on' : 'optimizations-off');
    dispatchHookCommand(settings.enabled && settings.mode === 'custom' && settings.throttleCanvasFps
      ? 'adaptive-limit-on'
      : 'adaptive-limit-off');
  }

  function parseColor(color) {
    const match = String(color || '').match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const values = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (values.length < 3 || values.slice(0, 3).some((value) => !Number.isFinite(value))) return null;
    const alpha = values.length > 3 && Number.isFinite(values[3]) ? values[3] : 1;
    return { red: values[0], green: values[1], blue: values[2], alpha };
  }

  function inspectBlurElement(element) {
    if (!currentSettings.enabled || !currentSettings.killBlurFilters || element?.nodeType !== 1 || !element.style) return;
    let computed;
    try { computed = window.getComputedStyle?.(element); } catch (_error) { return; }
    if (!computed) return;
    const backdrop = [computed.backdropFilter, computed.webkitBackdropFilter]
      .filter((value) => value && value !== 'none');
    if (!backdrop.length) return;

    const background = parseColor(computed.backgroundColor);
    if (background && background.alpha < 0.92 && !blurStates.has(element)) {
      const property = element.style.getPropertyValue?.('background-color') || '';
      const priority = element.style.getPropertyPriority?.('background-color') || '';
      const replacement = `rgba(${Math.round(background.red)}, ${Math.round(background.green)}, ${Math.round(background.blue)}, 0.92)`;
      blurStates.set(element, { property, priority, replacement });
      element.style.setProperty?.('background-color', replacement, 'important');
    }
    element.setAttribute('data-smoothboost-blur', 'true');
  }

  function restoreBlurElements() {
    for (const [element, state] of blurStates) {
      if (element.style?.getPropertyValue?.('background-color') === state.replacement) {
        if (state.property) element.style.setProperty('background-color', state.property, state.priority);
        else element.style.removeProperty('background-color');
      }
      element.removeAttribute?.('data-smoothboost-blur');
    }
    blurStates.clear();
    document.querySelectorAll?.('[data-smoothboost-blur="true"]').forEach((element) => {
      element.removeAttribute('data-smoothboost-blur');
    });
  }

  function queueBlurScan(root = document) {
    if (!currentSettings.enabled || !currentSettings.killBlurFilters || !root) return;
    if (root.nodeType === 1) blurScanQueue.push(root);
    root.querySelectorAll?.('*').forEach((element) => blurScanQueue.push(element));
    if (blurScanTimer) return;
    const scanChunk = () => {
      blurScanTimer = 0;
      for (let count = 0; count < 180 && blurScanQueue.length; count += 1) inspectBlurElement(blurScanQueue.shift());
      if (blurScanQueue.length && currentSettings.enabled && currentSettings.killBlurFilters) {
        blurScanTimer = window.setTimeout(scanChunk, 16);
      }
    };
    blurScanTimer = window.setTimeout(scanChunk, 0);
  }

  function isAmbientPreview(video) {
    return video?.autoplay && video.loop && video.muted && !video.controls;
  }

  function pauseVideoIfOffscreen(video) {
    if (!currentSettings.enabled || !currentSettings.pauseBackgroundMedia || !isAmbientPreview(video) || video.paused) return;
    video.pause();
    video.setAttribute('data-smoothboost-paused', 'true');
    pausedVideos.add(video);
  }

  function resumeVideo(video) {
    if (!pausedVideos.has(video)) return;
    pausedVideos.delete(video);
    video.removeAttribute('data-smoothboost-paused');
    const promise = video.play?.();
    promise?.catch?.(() => {});
  }

  function stopVideoHandling({ resume = true } = {}) {
    videoObserver?.disconnect();
    videoMutationObserver?.disconnect();
    videoObserver = null;
    videoMutationObserver = null;
    if (resume) [...pausedVideos].forEach(resumeVideo);
  }

  function observeVideo(video) {
    if (video?.tagName !== 'VIDEO' || !isAmbientPreview(video)) return;
    videoObserver?.observe(video);
  }

  function startVideoHandling() {
    stopVideoHandling({ resume: false });
    if (!isTopFrame || !currentSettings.enabled || !currentSettings.pauseBackgroundMedia || typeof IntersectionObserver !== 'function') {
      [...pausedVideos].forEach(resumeVideo);
      return;
    }
    videoObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0) resumeVideo(entry.target);
        else pauseVideoIfOffscreen(entry.target);
      }
    }, { threshold: 0.01 });
    document.querySelectorAll('video').forEach(observeVideo);
    if (typeof MutationObserver === 'function') {
      videoMutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes || []) {
            if (node.tagName === 'VIDEO') observeVideo(node);
            else node.querySelectorAll?.('video').forEach(observeVideo);
          }
        }
      });
      const root = document.documentElement;
      if (root) videoMutationObserver.observe(root, { childList: true, subtree: true });
    }
  }

  function isCssAnimated(element) {
    try {
      const animationName = window.getComputedStyle?.(element)?.animationName;
      return !!animationName && animationName !== 'none';
    } catch (_error) {
      return false;
    }
  }

  function observeAnimationElement(element) {
    if (!currentSettings.enabled || !currentSettings.pauseOffscreenAnimations || element?.nodeType !== 1 || observedAnimationTargets.has(element) || !isCssAnimated(element)) return;
    observedAnimationTargets.add(element);
    animationTargets.add(element);
    animationObserver?.observe(element);
  }

  function inspectAnimationSubtree(root) {
    if (!currentSettings.enabled || !currentSettings.pauseOffscreenAnimations || !root) return;
    let animations = [];
    try { animations = root.getAnimations?.({ subtree: true }) || []; } catch (_error) {}
    for (const animation of animations) {
      const target = animation.effect?.target;
      if (target?.nodeType === 1) observeAnimationElement(target);
    }
  }

  function startAnimationHandling() {
    stopAnimationHandling();
    if (!isTopFrame || !currentSettings.enabled || !currentSettings.pauseOffscreenAnimations || typeof IntersectionObserver !== 'function') return;
    animationObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target;
        if (!element.isConnected) {
          animationTargets.delete(element);
          continue;
        }
        if (entry.isIntersecting && entry.intersectionRatio > 0) element.removeAttribute('data-smoothboost-offscreen-animation');
        else element.setAttribute('data-smoothboost-offscreen-animation', 'true');
      }
    }, { threshold: 0.01 });
    inspectAnimationSubtree(document.documentElement);
    if (typeof MutationObserver === 'function') {
      animationMutationObserver = new MutationObserver((mutations) => {
        let shouldScan = false;
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            mutation.addedNodes?.forEach((node) => { inspectAnimationSubtree(node); shouldScan = true; });
          } else if (mutation.type === 'attributes') {
            observeAnimationElement(mutation.target);
          }
        }
        if (shouldScan && animationTargets.size > 3000) {
          // Forget detached targets before the set grows on long-lived feeds.
          animationTargets = new Set([...animationTargets].filter((element) => element.isConnected));
        }
      });
      animationMutationObserver.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style']
      });
    }
  }

  function stopAnimationHandling() {
    animationObserver?.disconnect();
    animationMutationObserver?.disconnect();
    animationObserver = null;
    animationMutationObserver = null;
    for (const element of animationTargets) element.removeAttribute?.('data-smoothboost-offscreen-animation');
    animationTargets.clear();
    observedAnimationTargets = new WeakSet();
    if (animationScanTimer) window.clearTimeout(animationScanTimer);
    animationScanTimer = 0;
  }

  function matchesSelector(element, selector) {
    try { return element.matches(selector); } catch (_error) { return false; }
  }

  function markCarousels(root = document) {
    if (!currentSettings.enabled || !(currentSettings.mode === 'ultra' || currentSettings.pauseOffscreenAnimations || isReanimeHomePage())) return;
    const selectors = siteRules.genericCarouselSelectors || DEFAULT_RULES.genericCarouselSelectors;
    const mark = (element) => {
      if (element?.nodeType !== 1 || !selectors.some((selector) => matchesSelector(element, selector))) return;
      if (element.getAttribute('data-smoothboost-carousel') !== 'true') {
        element.setAttribute('data-smoothboost-carousel', 'true');
        markedCarousels.add(element);
      }
    };
    if (root.nodeType === 1) mark(root);
    try { root.querySelectorAll?.(selectors.join(',')).forEach(mark); } catch (_error) {}
  }

  function stopCarouselMarkers() {
    carouselMutationObserver?.disconnect();
    carouselMutationObserver = null;
    for (const element of markedCarousels) {
      if (element.getAttribute?.('data-smoothboost-carousel') === 'true') element.removeAttribute('data-smoothboost-carousel');
    }
    markedCarousels.clear();
  }

  function updatePageObservers() {
    startVideoHandling();
    if (currentSettings.enabled && currentSettings.pauseOffscreenAnimations) startAnimationHandling();
    else stopAnimationHandling();

    stopCarouselMarkers();
    if (currentSettings.enabled && (currentSettings.mode === 'ultra' || currentSettings.pauseOffscreenAnimations || isReanimeHomePage())) {
      markCarousels(document);
      if (typeof MutationObserver === 'function' && document.documentElement) {
        carouselMutationObserver = new MutationObserver((mutations) => {
          for (const mutation of mutations) mutation.addedNodes?.forEach(markCarousels);
        });
        carouselMutationObserver.observe(document.documentElement, { childList: true, subtree: true });
      }
    }

    if (currentSettings.enabled && currentSettings.killBlurFilters) {
      queueBlurScan(document);
      if (!blurMutationObserver && typeof MutationObserver === 'function' && document.documentElement) {
        blurMutationObserver = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === 'childList') mutation.addedNodes?.forEach(queueBlurScan);
            else if (mutation.type === 'attributes') inspectBlurElement(mutation.target);
          }
        });
        blurMutationObserver.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style']
        });
      }
    } else {
      blurMutationObserver?.disconnect();
      blurMutationObserver = null;
      if (blurScanTimer) window.clearTimeout(blurScanTimer);
      blurScanTimer = 0;
      blurScanQueue = [];
      restoreBlurElements();
    }
  }

  let blurMutationObserver = null;

  function startLongFrameObserver() {
    if (diagnosticsObserver || typeof PerformanceObserver !== 'function') return;
    try {
      const supported = PerformanceObserver.supportedEntryTypes || [];
      if (!supported.includes('long-animation-frame')) return;
      diagnosticsObserver = new PerformanceObserver((list) => {
        const now = performance.now();
        for (const entry of list.getEntries()) longFrameTimes.push(entry.startTime || now);
        while (longFrameTimes.length && now - longFrameTimes[0] > 30000) longFrameTimes.shift();
      });
      diagnosticsObserver.observe({ type: 'long-animation-frame', buffered: true });
    } catch (_error) {
      diagnosticsObserver = null;
    }
  }

  function getDiagnostics() {
    const videos = [...(document.querySelectorAll?.('video') || [])];
    const autoplayVideos = videos.filter((video) => video.autoplay && !video.controls).length;
    let blurElements = 0;
    const candidates = [...(document.querySelectorAll?.('*') || [])].slice(0, 1500);
    for (const element of candidates) {
      try {
        const style = window.getComputedStyle?.(element);
        const filter = [style?.backdropFilter, style?.webkitBackdropFilter]
          .some((value) => value && value !== 'none');
        if (filter) blurElements += 1;
      } catch (_error) {}
    }
    let animationLoops = 0;
    try {
      animationLoops = (document.getAnimations?.({ subtree: true }) || []).filter((animation) => {
        try { return animation.effect?.getTiming?.().iterations === Infinity; } catch (_error) { return false; }
      }).length;
    } catch (_error) {}
    const now = performance.now();
    while (longFrameTimes.length && now - longFrameTimes[0] > 30000) longFrameTimes.shift();
    return {
      autoplayVideos,
      blurElements,
      animationLoops,
      longFrames: longFrameTimes.length,
      sampledElements: candidates.length,
      longFrameApi: !!diagnosticsObserver
    };
  }

  function updateReanimeRuleState(status) {
    if (!isReanimeHomePage() || !currentSettings.enabled || !['paused', 'waiting', 'unconfirmed'].includes(status)) return;
    if (hookStatusTimer) {
      window.clearTimeout(hookStatusTimer);
      hookStatusTimer = 0;
    }
    reanimeRuleState = status === 'waiting' ? 'armed' : status;
    if (status === 'waiting') {
      hookStatusTimer = window.setTimeout(() => {
        hookStatusTimer = 0;
        if (reanimeRuleState === 'armed') reanimeRuleState = 'unconfirmed';
      }, 12000);
    }
  }

  function connectPageHook() {
    const channel = document.documentElement?.getAttribute?.(CHANNEL_ATTRIBUTE) || '';
    if (!channel || channel === pageHookChannel) return;
    if (pageHookChannel) window.removeEventListener(pageHookChannel, handlePageHookEvent);
    pageHookChannel = channel;
    window.addEventListener(pageHookChannel, handlePageHookEvent);
    syncPageHook(currentSettings);
  }

  function handlePageHookEvent(event) {
    if (!isReanimeHomePage() || !currentSettings.enabled || !event.detail) return;
    if (event.detail.action === 'carousel-status') updateReanimeRuleState(event.detail.status);
  }

  function observePageHookChannel() {
    connectPageHook();
    if (pageHookChannel || typeof MutationObserver !== 'function' || !document.documentElement) return;
    const observer = new MutationObserver(() => {
      connectPageHook();
      if (pageHookChannel) observer.disconnect();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [CHANNEL_ATTRIBUTE] });
    window.setTimeout(() => { observer.disconnect(); connectPageHook(); }, 1500);
  }

  function applySettings(settings) {
    if (!isTopFrame) {
      currentSettings = { enabled: false, mode: 'off' };
      applyStyles('');
      initialized = true;
      return;
    }
    const wasEnabled = currentSettings.enabled;
    currentSettings = settings;
    applyStyles(buildStylesheet(settings));
    syncPageHook(settings);
    updatePageObservers();
    if (!settings.enabled) {
      if (hookStatusTimer) window.clearTimeout(hookStatusTimer);
      hookStatusTimer = 0;
      reanimeRuleState = isReanimeHomePage() ? 'off' : 'not-applicable';
    } else if (isReanimeHomePage() && (!wasEnabled || reanimeRuleState === 'off')) {
      reanimeRuleState = 'waiting';
      window.setTimeout(() => {
        if (currentSettings.enabled && reanimeRuleState === 'waiting') reanimeRuleState = 'armed';
      }, 0);
    } else if (!isReanimeHomePage()) {
      reanimeRuleState = 'not-applicable';
    }
  }

  async function loadSiteRules() {
    try {
      const url = chrome.runtime.getURL('data/site-rules.json');
      const response = await fetch(url);
      if (!response.ok) return DEFAULT_RULES;
      const rules = await response.json();
      return {
        genericCarouselSelectors: Array.isArray(rules.genericCarouselSelectors) ? rules.genericCarouselSelectors : DEFAULT_RULES.genericCarouselSelectors,
        siteRules: Array.isArray(rules.siteRules) ? rules.siteRules : DEFAULT_RULES.siteRules
      };
    } catch (_error) {
      return DEFAULT_RULES;
    }
  }

  async function init() {
    if (!isTopFrame) {
      initialized = true;
      return;
    }
    const hostname = window.location.hostname.toLowerCase();
    const startingStorageChangeCount = storageChangeCount;
    const rulesPromise = loadSiteRules();
    const stored = await chrome.storage.local.get('smoothBoostConfig');
    startLongFrameObserver();
    if (storageChangeCount === startingStorageChangeCount) {
      applySettings(effectiveSettings(stored.smoothBoostConfig, hostname));
    }
    observePageHookChannel();
    initialized = true;
    rulesPromise.then((rules) => {
      siteRules = rules;
      if (currentSettings.enabled) updatePageObservers();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.smoothBoostConfig) return;
    storageChangeCount += 1;
    applySettings(effectiveSettings(changes.smoothBoostConfig.newValue, window.location.hostname.toLowerCase()));
    initialized = true;
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'CONFIG_UPDATED') {
      applySettings(effectiveSettings(message.config, window.location.hostname.toLowerCase()));
      sendResponse?.({ success: true });
    } else if (message.type === 'GET_STATUS') {
      sendResponse?.(initialized ? {
        status: 'active',
        enabled: currentSettings.enabled,
        mode: currentSettings.mode || 'off',
        siteRule: isReanimeHomePage() ? reanimeRuleState : 'not-applicable'
      } : { status: 'initializing' });
    } else if (message.type === 'GET_DIAGNOSTICS') {
      sendResponse?.({ status: initialized ? 'active' : 'initializing', diagnostics: getDiagnostics() });
    }
    return true;
  });

  init().catch(() => {
    initialized = true;
    currentSettings = { enabled: false, mode: 'off' };
    applyStyles('');
    updatePageObservers();
  });
})();
