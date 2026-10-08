// SmoothBoost - Page Hook (Runs in MAIN world at document_start)
// Install page-realm overrides only while the user has enabled the matching feature.

(function () {
  'use strict';

  let config = {
    enabled: false,
    killScrollHijack: false,
    pauseBackgroundMedia: false,
    pauseReanimeCarousel: false,
    throttleCanvasFps: false,
    fpsLimit: 30
  };

  const REANIME_HERO_SELECTOR = '[aria-label="Hero carousel"]';
  const hostname = window.location?.hostname?.toLowerCase() || '';
  const isReanimeTopFrame = window === window.top &&
    (hostname === 'reanime.to' || hostname.endsWith('.reanime.to'));
  const nativeSetInterval = window.setInterval;
  const nativeClearInterval = window.clearInterval;
  const nativeSetTimeout = window.setTimeout;
  const carouselIntervals = new Map();
  let pausedCarouselInterval = null;
  let lastCarouselInteractionAt = 0;
  let reanimeCarouselPaused = false;

  const scrollHooks = {
    addOriginal: null,
    addWrapper: null,
    preventOriginal: null,
    preventWrapper: null
  };
  const frameHooks = {
    requestOriginal: null,
    requestWrapper: null,
    cancelOriginal: null,
    cancelWrapper: null
  };
  let lastFrameTime = 0;
  const pendingFrames = new Map();

  function getHeroCarousel() {
    if (!isReanimeTopFrame) return null;
    return document.querySelector(REANIME_HERO_SELECTOR);
  }

  function getHeroTitle(carousel) {
    if (!carousel) return '';
    const image = carousel.querySelector('img[alt]');
    if (image?.alt?.trim()) return image.alt.trim();
    const heading = carousel.querySelector('h1, h2, h3');
    return heading?.textContent?.trim() || '';
  }

  function findHeroSlideButton(carousel, title) {
    if (!carousel || !title) return null;
    return [...carousel.querySelectorAll('button')].find((button) => {
      const accessibleName = button.getAttribute('aria-label') || button.getAttribute('title') || '';
      return accessibleName === `Go to ${title}` || button.textContent?.trim() === `Go to ${title}`;
    }) || null;
  }

  function publishCarouselStatus(status) {
    if (!isReanimeTopFrame) return;
    window.dispatchEvent(new CustomEvent('__SMOOTHBOOST_REANIME_STATUS__', { detail: { status } }));
  }

  function resumePausedCarouselInterval() {
    const state = pausedCarouselInterval;
    pausedCarouselInterval = null;
    reanimeCarouselPaused = false;
    if (!state || state.clearedByPage || !getHeroCarousel()) {
      if (state) carouselIntervals.delete(state.id);
      return;
    }
    state.paused = false;
    carouselIntervals.delete(state.id);
    // Go through the wrapper again so the timer remains managed if the user
    // turns SmoothBoost back on without reloading the tab.
    window.setInterval(state.callback, state.delay, ...state.args);
    publishCarouselStatus('waiting');
  }

  function pauseCarouselInterval(state, carousel, previousTitle) {
    if (state.paused || pausedCarouselInterval) return;
    state.paused = true;
    nativeClearInterval.call(window, state.id);
    pausedCarouselInterval = state;
    reanimeCarouselPaused = true;

    // The first autoplay tick may happen while the page is starting. Restore
    // the slide visible before that tick when a matching manual control exists.
    const recentManualInput = Date.now() - lastCarouselInteractionAt < 1200;
    if (!recentManualInput && getHeroTitle(carousel) !== previousTitle) {
      findHeroSlideButton(carousel, previousTitle)?.click();
    }
    publishCarouselStatus('paused');
  }

  function installReanimeCarouselTimerGuard() {
    if (!isReanimeTopFrame || typeof nativeSetInterval !== 'function' || typeof nativeClearInterval !== 'function') return;

    window.addEventListener('pointerdown', (event) => {
      const carousel = getHeroCarousel();
      if (event.isTrusted && carousel?.contains(event.target)) lastCarouselInteractionAt = Date.now();
    }, true);
    window.addEventListener('keydown', (event) => {
      const carousel = getHeroCarousel();
      if (event.isTrusted && carousel?.contains(document.activeElement)) lastCarouselInteractionAt = Date.now();
    }, true);

    window.setInterval = function (callback, delay, ...args) {
      const intervalDelay = Number(delay);
      // Only inspect normal, multi-second page timers. Short polling and long
      // background heartbeats pass straight through unless they touch the hero.
      if (reanimeCarouselPaused || typeof callback !== 'function' || !Number.isFinite(intervalDelay) || intervalDelay < 2000 || intervalDelay > 15000) {
        return nativeSetInterval.call(window, callback, delay, ...args);
      }

      const state = { callback, delay, args, id: null, paused: false, clearedByPage: false, checkPending: false };
      const wrappedCallback = function (...callbackArgs) {
        if (state.paused || reanimeCarouselPaused || !config.enabled || !config.pauseReanimeCarousel) {
          return callback.apply(this, callbackArgs);
        }

        const carousel = getHeroCarousel();
        const previousTitle = getHeroTitle(carousel);
        const result = callback.apply(this, callbackArgs);
        if (!previousTitle || state.checkPending) return result;

        state.checkPending = true;
        nativeSetTimeout.call(window, () => {
          state.checkPending = false;
          if (state.paused || reanimeCarouselPaused || !config.enabled || !config.pauseReanimeCarousel) return;
          const currentCarousel = getHeroCarousel();
          const currentTitle = getHeroTitle(currentCarousel);
          if (currentCarousel === carousel && currentTitle && currentTitle !== previousTitle) {
            pauseCarouselInterval(state, carousel, previousTitle);
          }
        }, 80);
        return result;
      };

      state.id = nativeSetInterval.call(window, wrappedCallback, delay, ...args);
      carouselIntervals.set(state.id, state);
      return state.id;
    };

    window.clearInterval = function (id) {
      const state = carouselIntervals.get(id);
      if (state) {
        state.clearedByPage = true;
        carouselIntervals.delete(id);
      }
      return nativeClearInterval.call(window, id);
    };
  }

  installReanimeCarouselTimerGuard();

  function isTopLevelTarget(target) {
    return target === window || target === document || target === document.documentElement || target === document.body;
  }

  function restoreScrollHooks() {
    if (scrollHooks.addWrapper && EventTarget.prototype.addEventListener === scrollHooks.addWrapper) {
      EventTarget.prototype.addEventListener = scrollHooks.addOriginal;
    }
    if (scrollHooks.preventWrapper && Event.prototype.preventDefault === scrollHooks.preventWrapper) {
      Event.prototype.preventDefault = scrollHooks.preventOriginal;
    }
    scrollHooks.addOriginal = null;
    scrollHooks.addWrapper = null;
    scrollHooks.preventOriginal = null;
    scrollHooks.preventWrapper = null;
  }

  function syncScrollHooks() {
    if (!config.enabled || !config.killScrollHijack) {
      restoreScrollHooks();
      return;
    }
    if (!scrollHooks.addWrapper) {
      scrollHooks.addOriginal = EventTarget.prototype.addEventListener;
      scrollHooks.addWrapper = function (type, listener, options) {
        if (config.enabled && config.killScrollHijack && (type === 'wheel' || type === 'mousewheel') && isTopLevelTarget(this)) {
          if (typeof options === 'boolean') {
            options = { passive: true, capture: options };
          } else if (typeof options === 'object' && options !== null) {
            options = { ...options, passive: true };
          } else {
            options = { passive: true };
          }
        }
        return scrollHooks.addOriginal.call(this, type, listener, options);
      };
      EventTarget.prototype.addEventListener = scrollHooks.addWrapper;
    }
    if (!scrollHooks.preventWrapper) {
      scrollHooks.preventOriginal = Event.prototype.preventDefault;
      scrollHooks.preventWrapper = function () {
        if (config.enabled && config.killScrollHijack && (this.type === 'wheel' || this.type === 'mousewheel') && isTopLevelTarget(this.currentTarget || this.target)) {
          return;
        }
        return scrollHooks.preventOriginal.apply(this, arguments);
      };
      Event.prototype.preventDefault = scrollHooks.preventWrapper;
    }
  }

  function restoreFrameHooks() {
    // Keep wrappers until throttled callbacks drain so their public IDs remain
    // cancellable and callbacks already waiting for a frame are not dropped.
    if (pendingFrames.size > 0) return;
    if (frameHooks.requestWrapper && window.requestAnimationFrame === frameHooks.requestWrapper) {
      window.requestAnimationFrame = frameHooks.requestOriginal;
    }
    if (frameHooks.cancelWrapper && window.cancelAnimationFrame === frameHooks.cancelWrapper) {
      window.cancelAnimationFrame = frameHooks.cancelOriginal;
    }
    frameHooks.requestOriginal = null;
    frameHooks.requestWrapper = null;
    frameHooks.cancelOriginal = null;
    frameHooks.cancelWrapper = null;
  }

  function syncFrameHooks() {
    if (!config.enabled || !config.throttleCanvasFps) {
      restoreFrameHooks();
      return;
    }
    if (frameHooks.requestWrapper) return;

    frameHooks.requestOriginal = window.requestAnimationFrame;
    frameHooks.cancelOriginal = window.cancelAnimationFrame;
    frameHooks.requestWrapper = function (callback) {
      if (!config.enabled || !config.throttleCanvasFps) {
        return frameHooks.requestOriginal.call(window, callback);
      }

      const state = { cancelled: false, externalId: null, nativeId: null };
      const schedule = () => {
        state.nativeId = frameHooks.requestOriginal.call(window, function (now) {
          if (state.cancelled) return;

          if (!config.enabled || !config.throttleCanvasFps) {
            pendingFrames.delete(state.externalId);
            callback.call(window, now);
            restoreFrameHooks();
            return;
          }

          const requestedFps = Number(config.fpsLimit);
          const fps = Number.isFinite(requestedFps) ? Math.min(120, Math.max(1, requestedFps)) : 30;
          const interval = 1000 / fps;
          const elapsed = now - lastFrameTime;
          if (elapsed >= interval) {
            lastFrameTime = now - (elapsed % interval);
            pendingFrames.delete(state.externalId);
            callback.call(window, now);
            restoreFrameHooks();
          } else {
            // Keep the same public request cancellable while waiting for a slot.
            schedule();
          }
        });

        if (state.externalId === null) {
          state.externalId = state.nativeId;
          pendingFrames.set(state.externalId, state);
        }
      };

      schedule();
      return state.externalId;
    };
    frameHooks.cancelWrapper = function (id) {
      const state = pendingFrames.get(id);
      if (!state) return frameHooks.cancelOriginal.call(window, id);

      state.cancelled = true;
      pendingFrames.delete(id);
      const result = frameHooks.cancelOriginal.call(window, state.nativeId);
      restoreFrameHooks();
      return result;
    };
    window.requestAnimationFrame = frameHooks.requestWrapper;
    window.cancelAnimationFrame = frameHooks.cancelWrapper;
  }

  function syncHooks() {
    syncScrollHooks();
    syncFrameHooks();
  }

  // This event is page-visible. It carries only the current page's performance
  // switches and never extension data or privileged capabilities.
  window.addEventListener('__SMOOTHBOOST_UPDATE_PAGE_HOOK__', function (event) {
    if (!event.detail) return;
    config = { ...config, ...event.detail };
    syncHooks();
    if (!config.enabled || !config.pauseReanimeCarousel) {
      resumePausedCarouselInterval();
    } else if (reanimeCarouselPaused) {
      publishCarouselStatus('paused');
    } else {
      publishCarouselStatus('waiting');
    }
  });
})();
