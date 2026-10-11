// Runs in the page's MAIN world only on sites where SmoothBoost is enabled.
// The bridge uses a random per-document event name and accepts commands only;
// it never receives site settings or extension data. The name is not secret.

(function () {
  'use strict';

  const root = document.documentElement;
  if (!root || root.getAttribute('data-smoothboost-hook-installed') === 'true') return;
  root.setAttribute('data-smoothboost-hook-installed', 'true');

  const CHANNEL_ATTRIBUTE = 'data-smoothboost-channel';
  const REANIME_HERO_SELECTOR = '[aria-label="Hero carousel"], [aria-label*="hero carousel" i], [data-testid*="hero-carousel" i]';
  const isReanime = window === window.top && window.location?.hostname?.toLowerCase() === 'reanime.to';
  const nativeSetInterval = window.setInterval;
  const nativeClearInterval = window.clearInterval;
  const nativeSetTimeout = window.setTimeout;
  const nativeClearTimeout = window.clearTimeout;
  let optimizationsEnabled = true;
  let adaptiveLimitEnabled = false;
  let throttling = false;
  let carouselObserver = null;
  let carouselMutationObserver = null;
  let pausedCarouselInstances = new Map();
  let lastCarouselInteractionAt = 0;
  let pausedCarouselInterval = null;
  let reanimeCarouselPaused = false;
  let adaptiveObserver = null;
  let adaptiveReleaseTimer = 0;

  const carouselIntervals = new Map();
  const frameHooks = { requestOriginal: null, requestWrapper: null, cancelOriginal: null, cancelWrapper: null };
  const pendingFrames = new Map();
  let lastFrameTime = 0;

  function makeChannelName() {
    const bytes = new Uint8Array(16);
    try { window.crypto.getRandomValues(bytes); }
    catch (_error) { for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256); }
    return `__smoothboost_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  const channelName = makeChannelName();
  root.setAttribute(CHANNEL_ATTRIBUTE, channelName);

  function publishCarouselStatus(status) {
    if (!isReanime) return;
    window.dispatchEvent(new CustomEvent(channelName, { detail: { action: 'carousel-status', status } }));
  }

  function getHeroCarousel() {
    if (!isReanime) return null;
    return document.querySelector(REANIME_HERO_SELECTOR);
  }

  function getHeroTitle(carousel) {
    if (!carousel) return '';
    const image = carousel.querySelector('img[alt]');
    if (image?.alt?.trim()) return image.alt.trim();
    return carousel.querySelector('h1, h2, h3')?.textContent?.trim() || '';
  }

  function findHeroSlideButton(carousel, title) {
    if (!carousel || !title) return null;
    return [...carousel.querySelectorAll('button')].find((button) => {
      const accessibleName = button.getAttribute('aria-label') || button.getAttribute('title') || '';
      return accessibleName === `Go to ${title}` || button.textContent?.trim() === `Go to ${title}`;
    }) || null;
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
    window.setInterval(state.callback, state.delay, ...state.args);
    publishCarouselStatus('waiting');
  }

  function pauseCarouselInterval(state, carousel, previousTitle) {
    if (state.paused || pausedCarouselInterval) return;
    state.paused = true;
    nativeClearInterval.call(window, state.id);
    pausedCarouselInterval = state;
    reanimeCarouselPaused = true;
    if (Date.now() - lastCarouselInteractionAt >= 1200 && getHeroTitle(carousel) !== previousTitle) {
      findHeroSlideButton(carousel, previousTitle)?.click();
    }
    publishCarouselStatus('paused');
  }

  function installReanimeTimerGuard() {
    if (!isReanime || typeof nativeSetInterval !== 'function' || typeof nativeClearInterval !== 'function') return;
    window.addEventListener('pointerdown', (event) => {
      if (event.isTrusted && getHeroCarousel()?.contains(event.target)) lastCarouselInteractionAt = Date.now();
    }, true);
    window.addEventListener('keydown', (event) => {
      if (event.isTrusted && getHeroCarousel()?.contains(document.activeElement)) lastCarouselInteractionAt = Date.now();
    }, true);

    window.setInterval = function (callback, delay, ...args) {
      const intervalDelay = Number(delay);
      if (reanimeCarouselPaused || typeof callback !== 'function' || !Number.isFinite(intervalDelay) || intervalDelay < 2000 || intervalDelay > 15000) {
        return nativeSetInterval.call(window, callback, delay, ...args);
      }
      const state = { callback, delay, args, id: null, paused: false, clearedByPage: false, checkPending: false };
      const wrappedCallback = function (...callbackArgs) {
        if (state.paused || reanimeCarouselPaused || !optimizationsEnabled) return callback.apply(this, callbackArgs);
        const carousel = getHeroCarousel();
        const previousTitle = getHeroTitle(carousel);
        const result = callback.apply(this, callbackArgs);
        if (!previousTitle || state.checkPending) return result;
        state.checkPending = true;
        nativeSetTimeout.call(window, () => {
          state.checkPending = false;
          if (state.paused || reanimeCarouselPaused || !optimizationsEnabled) return;
          const activeCarousel = getHeroCarousel();
          const currentTitle = getHeroTitle(activeCarousel);
          if (activeCarousel === carousel && currentTitle && currentTitle !== previousTitle) {
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

  function carouselElement(target) {
    if (target?.getAttribute?.('data-smoothboost-carousel') === 'true') return target;
    return target?.closest?.('[data-smoothboost-carousel="true"]') || null;
  }

  function observeCarouselElement(element) {
    if (element?.getAttribute?.('data-smoothboost-carousel') === 'true') carouselObserver?.observe(element);
  }

  function startOffscreenCarousels() {
    carouselObserver?.disconnect();
    carouselMutationObserver?.disconnect();
    carouselObserver = null;
    carouselMutationObserver = null;
    pausedCarouselInstances = new Map();
    if (!optimizationsEnabled || typeof IntersectionObserver !== 'function') return;

    carouselObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target;
        const instance = element.swiper;
        const autoplay = instance?.autoplay;
        if (!autoplay) continue;
        if (!entry.isIntersecting && autoplay.running && typeof autoplay.stop === 'function') {
          autoplay.stop();
          pausedCarouselInstances.set(element, instance);
        } else if (entry.isIntersecting && pausedCarouselInstances.get(element) === instance) {
          pausedCarouselInstances.delete(element);
          if (typeof autoplay.start === 'function') autoplay.start();
        }
      }
    }, { threshold: 0.01 });

    document.querySelectorAll('[data-smoothboost-carousel="true"]').forEach(observeCarouselElement);
    if (typeof MutationObserver === 'function' && document.documentElement) {
      carouselMutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') observeCarouselElement(mutation.target);
          mutation.addedNodes?.forEach((node) => {
            if (node.nodeType !== 1) return;
            observeCarouselElement(node);
            node.querySelectorAll?.('[data-smoothboost-carousel="true"]').forEach(observeCarouselElement);
          });
        }
      });
      carouselMutationObserver.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['data-smoothboost-carousel']
      });
    }
  }

  function resumeOffscreenCarousels() {
    for (const [element, instance] of pausedCarouselInstances) {
      if (element.isConnected && element.swiper === instance && typeof instance.autoplay?.start === 'function') instance.autoplay.start();
    }
    pausedCarouselInstances.clear();
  }

  function restoreFrameHooks() {
    if (pendingFrames.size > 0) return;
    if (frameHooks.requestWrapper && window.requestAnimationFrame === frameHooks.requestWrapper) window.requestAnimationFrame = frameHooks.requestOriginal;
    if (frameHooks.cancelWrapper && window.cancelAnimationFrame === frameHooks.cancelWrapper) window.cancelAnimationFrame = frameHooks.cancelOriginal;
    frameHooks.requestOriginal = null;
    frameHooks.requestWrapper = null;
    frameHooks.cancelOriginal = null;
    frameHooks.cancelWrapper = null;
  }

  function syncFrameHooks() {
    if (!throttling) {
      restoreFrameHooks();
      return;
    }
    if (frameHooks.requestWrapper) return;
    if (typeof window.requestAnimationFrame !== 'function' || typeof window.cancelAnimationFrame !== 'function') return;
    frameHooks.requestOriginal = window.requestAnimationFrame;
    frameHooks.cancelOriginal = window.cancelAnimationFrame;

    frameHooks.requestWrapper = function (callback) {
      if (!adaptiveLimitEnabled || !throttling) return frameHooks.requestOriginal.call(window, callback);
      const state = { cancelled: false, externalId: null, nativeId: null };
      const schedule = () => {
        state.nativeId = frameHooks.requestOriginal.call(window, (now) => {
          if (state.cancelled) return;
          if (!adaptiveLimitEnabled || !throttling) {
            pendingFrames.delete(state.externalId);
            callback.call(window, now);
            restoreFrameHooks();
            return;
          }
          const interval = 1000 / 30;
          const elapsed = now - lastFrameTime;
          if (elapsed >= interval) {
            lastFrameTime = now - (elapsed % interval);
            pendingFrames.delete(state.externalId);
            callback.call(window, now);
            restoreFrameHooks();
          } else {
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

  function engageAdaptiveThrottle() {
    if (!adaptiveLimitEnabled) return;
    throttling = true;
    if (adaptiveReleaseTimer) nativeClearTimeout.call(window, adaptiveReleaseTimer);
    adaptiveReleaseTimer = nativeSetTimeout.call(window, () => {
      adaptiveReleaseTimer = 0;
      throttling = false;
      syncFrameHooks();
    }, 6000);
    syncFrameHooks();
  }

  function stopAdaptiveThrottle() {
    adaptiveLimitEnabled = false;
    throttling = false;
    adaptiveObserver?.disconnect();
    adaptiveObserver = null;
    if (adaptiveReleaseTimer) nativeClearTimeout.call(window, adaptiveReleaseTimer);
    adaptiveReleaseTimer = 0;
    syncFrameHooks();
  }

  function startAdaptiveThrottle() {
    stopAdaptiveThrottle();
    try {
      if (typeof PerformanceObserver !== 'function' || !(PerformanceObserver.supportedEntryTypes || []).includes('long-animation-frame')) return;
      adaptiveLimitEnabled = true;
      adaptiveObserver = new PerformanceObserver((list) => {
        if (list.getEntries().some((entry) => entry.duration >= 50)) engageAdaptiveThrottle();
      });
      adaptiveObserver.observe({ type: 'long-animation-frame', buffered: true });
    } catch (_error) {
      adaptiveObserver?.disconnect();
      adaptiveObserver = null;
      adaptiveLimitEnabled = false;
    }
  }

  function setOptimizations(enabled) {
    optimizationsEnabled = enabled;
    if (!enabled) {
      resumePausedCarouselInterval();
      resumeOffscreenCarousels();
    } else {
      startOffscreenCarousels();
      if (adaptiveLimitEnabled) startAdaptiveThrottle();
      if (isReanime) publishCarouselStatus(reanimeCarouselPaused ? 'paused' : 'waiting');
    }
  }

  installReanimeTimerGuard();
  if (isReanime) publishCarouselStatus('waiting');
  startOffscreenCarousels();

  window.addEventListener(channelName, (event) => {
    const action = event.detail?.action;
    if (action === 'optimizations-on') setOptimizations(true);
    else if (action === 'optimizations-off') setOptimizations(false);
    else if (action === 'adaptive-limit-on') startAdaptiveThrottle();
    else if (action === 'adaptive-limit-off') stopAdaptiveThrottle();
  });

  // This event only signals that the per-document channel is ready. The random
  // channel name itself is also stored on the DOM root so the isolated world can
  // discover it if script startup order differs.
  window.dispatchEvent(new CustomEvent('__smoothboost_page_hook_ready__'));
})();
