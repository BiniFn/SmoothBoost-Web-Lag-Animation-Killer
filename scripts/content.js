// SmoothBoost - Content Script (ISOLATED world, document_start)
// Applies page styles, coordinates the page-world hook, and reports live state.

(function () {
  'use strict';

  const STYLE_ID = 'smoothboost-injected-styles';
  const isTopFrame = window === window.top;
  const REANIME_HOST = 'reanime.to';
  const REANIME_HERO_SELECTOR = [
    '[aria-label="Hero carousel"]',
    '[aria-label*="hero carousel" i]',
    '[data-testid*="hero-carousel" i]'
  ].join(', ');
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
      fpsLimit: 30
    },
    siteOverrides: {}
  };

  let videoObserver = null;
  let carouselObserver = null;
  let waitingForVideoRoot = false;
  let waitingForCarouselRoot = false;
  let waitingForStyleRoot = false;
  let carouselStatusTimer = null;
  let pendingCss = '';
  let currentCarousel = null;
  let currentSettings = { enabled: false };
  let initialized = false;
  let reanimeRuleState = 'not-applicable';
  let storageChangeCount = 0;

  function isReanimeHost() {
    return window.location.hostname.toLowerCase() === REANIME_HOST;
  }

  function isReanimeHomePage() {
    return isReanimeHost() && (window.location.pathname === '/' || window.location.pathname === '/home');
  }

  // Helper to determine active settings for current hostname.
  function resolveEffectiveSettings(config, hostname) {
    config = config || DEFAULT_CONFIG;

    const siteOverride = config.siteOverrides?.[hostname];
    const isEnabled = siteOverride?.enabled !== undefined ? siteOverride.enabled : config.globalEnabled;
    if (!isEnabled) return { enabled: false, mode: 'off' };

    const mode = siteOverride?.mode || config.mode || 'ultra';

    if (mode === 'ultra') {
      return {
        enabled: true,
        mode: 'ultra',
        killAnimations: false,
        killTransitions: false,
        killBlurFilters: true,
        killScrollHijack: false,
        pauseBackgroundMedia: true,
        // Maximum keeps page animation frames uncapped to preserve responsiveness.
        throttleCanvasFps: false,
        fpsLimit: 30
      };
    }

    if (mode === 'balanced') {
      return {
        enabled: true,
        mode: 'balanced',
        killAnimations: false,
        killTransitions: false,
        killBlurFilters: false,
        killScrollHijack: false,
        pauseBackgroundMedia: false,
        throttleCanvasFps: false,
        fpsLimit: 60
      };
    }

    const custom = config.customSettings || {};
    return {
      enabled: true,
      mode: 'custom',
      killAnimations: !!custom.killAnimations,
      killTransitions: !!custom.killTransitions,
      killBlurFilters: !!custom.killBlurFilters,
      killScrollHijack: !!custom.killScrollHijack,
      pauseBackgroundMedia: !!custom.pauseBackgroundMedia,
      throttleCanvasFps: !!custom.throttleCanvasFps,
      fpsLimit: custom.fpsLimit || 30
    };
  }

  // Generate CSS only for settings that are active on this site.
  function buildStylesheet(settings) {
    if (!settings.enabled) return '';

    let css = '/* SmoothBoost performance styles */\n';

    if (settings.killScrollHijack) {
      css += `
        html, body {
          scroll-behavior: auto !important;
        }
      `;
    }

    if (settings.killAnimations) {
      css += `
        *, *::before, *::after {
          animation-duration: 0.0001s !important;
          animation-iteration-count: 1 !important;
          animation-delay: 0s !important;
          animation-play-state: running !important;
          animation-fill-mode: both !important;
        }
      `;
    }

    if (settings.killTransitions) {
      css += `
        *, *::before, *::after {
          transition-duration: 0.0001s !important;
          transition-delay: 0s !important;
        }
      `;
    }

    if (settings.killBlurFilters) {
      css += `
        *, *::before, *::after {
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
        }
      `;
    }

    return css;
  }

  function applyStyles(css) {
    pendingCss = css;
    let styleEl = document.getElementById(STYLE_ID);
    if (!css) {
      if (styleEl) styleEl.remove();
      return;
    }

    const parent = document.head || document.documentElement;
    if (!parent) {
      if (!waitingForStyleRoot) {
        waitingForStyleRoot = true;
        document.addEventListener('DOMContentLoaded', () => {
          waitingForStyleRoot = false;
          applyStyles(pendingCss);
        }, { once: true });
      }
      return;
    }

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      parent.appendChild(styleEl);
    }
    styleEl.textContent = css;
  }

  function syncWithPageHook(settings) {
    window.dispatchEvent(new CustomEvent('__SMOOTHBOOST_UPDATE_PAGE_HOOK__', {
      detail: {
        enabled: settings.enabled,
        pauseBackgroundMedia: settings.pauseBackgroundMedia,
        pauseReanimeCarousel: settings.enabled && isReanimeHomePage(),
        throttleCanvasFps: settings.throttleCanvasFps,
        fpsLimit: settings.fpsLimit
      }
    }));
  }

  function handleVideos(settings) {
    if (videoObserver) {
      videoObserver.disconnect();
      videoObserver = null;
    }
    const resumeSmoothBoostPausedVideos = () => {
      document.querySelectorAll('video[data-smoothboost-paused="true"]').forEach((video) => {
        video.removeAttribute('data-smoothboost-paused');
        const playback = video.play();
        playback?.catch?.(() => {});
      });
    };
    // Keep every embedded player and its media pipeline under the page's
    // control. Only inspect ambient previews in the top-level document.
    if (!isTopFrame || !settings.enabled || !settings.pauseBackgroundMedia) {
      resumeSmoothBoostPausedVideos();
      return;
    }

    const pauseVideo = (video) => {
      const isAmbientPreview = video.autoplay && video.loop && video.muted && !video.controls;
      if (!video.paused && isAmbientPreview) {
        video.pause();
        video.setAttribute('data-smoothboost-paused', 'true');
      }
    };

    document.querySelectorAll('video').forEach(pauseVideo);
    videoObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.tagName === 'VIDEO') {
            pauseVideo(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll('video').forEach(pauseVideo);
          }
        }
      }
    });

    const root = document.documentElement || document.body;
    if (root) {
      videoObserver.observe(root, { childList: true, subtree: true });
    } else if (!waitingForVideoRoot) {
      waitingForVideoRoot = true;
      document.addEventListener('DOMContentLoaded', () => {
        waitingForVideoRoot = false;
        handleVideos(currentSettings);
      }, { once: true });
    }
  }

  function findHeroCarousel(root) {
    if (!root) return null;
    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(REANIME_HERO_SELECTOR)) return root;
    return root.querySelector?.(REANIME_HERO_SELECTOR) || null;
  }

  function applyReanimeCarouselRule() {
    if (!isReanimeHomePage()) {
      if (carouselObserver) {
        carouselObserver.disconnect();
        carouselObserver = null;
      }
      if (carouselStatusTimer) {
        clearTimeout(carouselStatusTimer);
        carouselStatusTimer = null;
      }
      currentCarousel = null;
      reanimeRuleState = 'not-applicable';
      return;
    }

    if (!currentSettings.enabled) {
      if (carouselObserver) {
        carouselObserver.disconnect();
        carouselObserver = null;
      }
      if (carouselStatusTimer) {
        clearTimeout(carouselStatusTimer);
        carouselStatusTimer = null;
      }
      currentCarousel = null;
      reanimeRuleState = 'off';
      return;
    }

    const root = document.documentElement;
    if (!root) {
      reanimeRuleState = 'waiting';
      if (!waitingForCarouselRoot) {
        waitingForCarouselRoot = true;
        document.addEventListener('DOMContentLoaded', () => {
          waitingForCarouselRoot = false;
          applyReanimeCarouselRule();
        }, { once: true });
      }
      return;
    }
    if (root && !carouselObserver) {
      carouselObserver = new MutationObserver((mutations) => {
        if (currentCarousel?.isConnected) return;
        currentCarousel = null;
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            const carousel = findHeroCarousel(node);
            if (carousel) {
              engageHeroCarousel(carousel);
              return;
            }
          }
        }
      });
      carouselObserver.observe(root, { childList: true, subtree: true });
    }

    const carousel = findHeroCarousel(document);
    if (carousel) {
      engageHeroCarousel(carousel);
    } else if (!currentCarousel?.isConnected) {
      reanimeRuleState = 'waiting';
    }
  }

  function engageHeroCarousel(carousel) {
    if (carousel === currentCarousel) {
      if (reanimeRuleState !== 'paused' && reanimeRuleState !== 'unconfirmed') {
        reanimeRuleState = 'armed';
      }
      return;
    }
    currentCarousel = carousel;
    reanimeRuleState = 'armed';
    if (carouselStatusTimer) clearTimeout(carouselStatusTimer);
    carouselStatusTimer = setTimeout(() => {
      carouselStatusTimer = null;
      if (currentCarousel === carousel && reanimeRuleState === 'armed') {
        reanimeRuleState = 'unconfirmed';
      }
    }, 12000);
    // Stop watching the whole page as soon as the hero is found; the carousel
    // retains its own controls and subsequent slide content needs no tracking.
    if (carouselObserver) {
      carouselObserver.disconnect();
      carouselObserver = null;
    }
  }

  function applySettings(settings) {
    if (!isTopFrame) {
      currentSettings = { enabled: false, mode: 'off' };
      applyStyles('');
      syncWithPageHook(currentSettings);
      handleVideos(currentSettings);
      initialized = true;
      return;
    }
    currentSettings = settings;
    applyStyles(buildStylesheet(settings));
    syncWithPageHook(settings);
    handleVideos(settings);
    applyReanimeCarouselRule();
  }

  function refreshReanimeRoute(force = false) {
    const currentPath = window.location.pathname;
    setTimeout(() => {
      if (!force && window.location.pathname === currentPath) return;
      applyReanimeCarouselRule();
      syncWithPageHook(currentSettings);
    }, 50);
  }

  window.addEventListener('popstate', () => refreshReanimeRoute(true));
  window.addEventListener('hashchange', () => refreshReanimeRoute(true));
  document.addEventListener('click', (event) => {
    if (event.target?.closest?.('a[href]')) refreshReanimeRoute();
  }, true);

  async function init() {
    if (!isTopFrame) {
      initialized = true;
      return;
    }
    const hostname = window.location.hostname;
    const initialStorageChangeCount = storageChangeCount;
    const { smoothBoostConfig } = await chrome.storage.local.get('smoothBoostConfig');
    // A popup or shortcut can update storage while this document is starting.
    // If that happened, keep the newer storage event instead of applying a
    // potentially stale result from the initial read.
    if (storageChangeCount === initialStorageChangeCount) {
      applySettings(resolveEffectiveSettings(smoothBoostConfig, hostname));
    }
    initialized = true;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.smoothBoostConfig) return;
    storageChangeCount += 1;
    applySettings(resolveEffectiveSettings(changes.smoothBoostConfig.newValue, window.location.hostname));
    initialized = true;
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CONFIG_UPDATED') {
      applySettings(resolveEffectiveSettings(message.config, window.location.hostname));
      sendResponse?.({ success: true });
    } else if (message.type === 'GET_STATUS') {
      if (!initialized) {
        sendResponse?.({ status: 'initializing' });
      } else {
        sendResponse?.({
          status: 'active',
          enabled: currentSettings.enabled,
          mode: currentSettings.mode || 'off',
          siteRule: isReanimeHomePage() ? reanimeRuleState : 'not-applicable'
        });
      }
    }
    return true;
  });

  window.addEventListener('__SMOOTHBOOST_REANIME_STATUS__', (event) => {
    if (!isReanimeHost() || !currentSettings.enabled) return;
    const status = event.detail?.status;
    if (status === 'paused') {
      if (carouselStatusTimer) {
        clearTimeout(carouselStatusTimer);
        carouselStatusTimer = null;
      }
      reanimeRuleState = 'paused';
    } else if (status === 'waiting' && currentCarousel?.isConnected && reanimeRuleState !== 'paused') {
      reanimeRuleState = 'armed';
      if (!carouselStatusTimer) {
        const carousel = currentCarousel;
        carouselStatusTimer = setTimeout(() => {
          carouselStatusTimer = null;
          if (currentCarousel === carousel && reanimeRuleState === 'armed') {
            reanimeRuleState = 'unconfirmed';
          }
        }, 12000);
      }
    }
  });

  init().catch(() => {
    initialized = true;
    currentSettings = { enabled: false, mode: 'off' };
    applyStyles('');
    syncWithPageHook(currentSettings);
    applyReanimeCarouselRule();
  });
})();
