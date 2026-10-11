const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const hookSource = fs.readFileSync(path.join(__dirname, '../scripts/page-hook.js'), 'utf8');

function createHarness({ hostname = 'example.com', hero = null, carousels = [] } = {}) {
  let nextId = 1;
  const frames = [];
  const intervals = new Map();
  const timeouts = new Map();
  const emittedEvents = [];
  const intersectionObservers = [];
  const performanceObservers = [];

  class MockEventTarget {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
    }
    dispatchEvent(event) {
      event.target = this;
      event.currentTarget = this;
      for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
      return true;
    }
  }
  class MockCustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  class MockIntersectionObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); intersectionObservers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
    trigger(target, visible) { this.callback([{ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]); }
  }
  class MockMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }
  class MockPerformanceObserver {
    static supportedEntryTypes = ['long-animation-frame'];
    constructor(callback) { this.callback = callback; performanceObservers.push(this); }
    observe() {}
    disconnect() {}
    emit(duration = 70) { this.callback({ getEntries: () => [{ duration }] }); }
  }

  const attributes = new Map();
  const root = {
    isConnected: true,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) || null; },
    querySelectorAll() { return []; }
  };
  const window = new MockEventTarget();
  window.location = { hostname };
  window.top = window;
  window.crypto = { getRandomValues(bytes) { bytes.fill(17); return bytes; } };
  window.requestAnimationFrame = (callback) => {
    const id = nextId++;
    frames.push({ id, callback });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const index = frames.findIndex((frame) => frame.id === id);
    if (index >= 0) frames.splice(index, 1);
  };
  window.setInterval = (callback, delay, ...args) => {
    const id = nextId++;
    intervals.set(id, { callback, delay, args });
    return id;
  };
  window.clearInterval = (id) => intervals.delete(id);
  window.setTimeout = (callback, delay) => {
    const id = nextId++;
    timeouts.set(id, { callback, delay });
    return id;
  };
  window.clearTimeout = (id) => timeouts.delete(id);
  window.dispatchedEvents = emittedEvents;
  const dispatchWindowEvent = window.dispatchEvent.bind(window);
  window.dispatchEvent = (event) => {
    emittedEvents.push(event);
    return dispatchWindowEvent(event);
  };
  const document = new MockEventTarget();
  document.documentElement = root;
  document.body = {};
  document.activeElement = null;
  document.querySelector = (selector) => selector.includes('hero-carousel') || selector.includes('Hero carousel') ? hero : null;
  document.querySelectorAll = (selector) => selector === '[data-smoothboost-carousel="true"]' ? carousels : [];

  const originals = {
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval
  };

  vm.runInNewContext(hookSource, {
    window,
    document,
    CustomEvent: MockCustomEvent,
    IntersectionObserver: MockIntersectionObserver,
    MutationObserver: MockMutationObserver,
    PerformanceObserver: MockPerformanceObserver,
    Date,
    Map,
    Number,
    Uint8Array,
    Math
  });

  const channel = root.getAttribute('data-smoothboost-channel');
  function dispatchAction(action, extra = {}) {
    window.dispatchEvent(new MockCustomEvent(channel, { detail: { action, ...extra } }));
  }
  function runFrame(timestamp) {
    const frame = frames.shift();
    assert.ok(frame, 'a native animation frame should be queued');
    frame.callback(timestamp);
  }
  function runTimeout(delay) {
    const found = [...timeouts.entries()].find(([, timer]) => timer.delay === delay);
    assert.ok(found, `a ${delay}ms timeout should be queued`);
    timeouts.delete(found[0]);
    found[1].callback();
  }

  return { window, document, root, channel, frames, intervals, timeouts, emittedEvents, intersectionObservers, performanceObservers, originals, dispatchAction, runFrame, runTimeout };
}

test('page hook uses a random per-load command channel and accepts no arbitrary settings', () => {
  const harness = createHarness();
  assert.match(harness.channel, /^__smoothboost_[0-9a-f]{32}$/);
  assert.notEqual(harness.channel, '__SMOOTHBOOST_UPDATE_PAGE_HOOK__');
  assert.equal(harness.emittedEvents.some((event) => event.type === '__smoothboost_page_hook_ready__' && event.detail === undefined), true);

  harness.dispatchAction('set-config', { enabled: true, throttleCanvasFps: true });
  assert.equal(harness.window.requestAnimationFrame, harness.originals.requestAnimationFrame);
  harness.dispatchAction('optimizations-off');
  harness.dispatchAction('adaptive-limit-on');
  assert.equal(harness.window.requestAnimationFrame, harness.originals.requestAnimationFrame, 'limiting waits for a long-frame signal');
  harness.performanceObservers.at(-1).emit();
  assert.notEqual(harness.window.requestAnimationFrame, harness.originals.requestAnimationFrame, 'adaptive limiting still works without carousel optimizations');
});

test('Maximum keeps animation frames uncapped until an adaptive trigger is observed', () => {
  const harness = createHarness();
  let receivedTimestamp = null;
  harness.window.requestAnimationFrame((timestamp) => { receivedTimestamp = timestamp; });
  harness.runFrame(12);
  assert.equal(receivedTimestamp, 12);

  harness.dispatchAction('adaptive-limit-on');
  harness.performanceObservers.at(-1).emit();
  let throttledTimestamp = null;
  harness.window.requestAnimationFrame((timestamp) => { throttledTimestamp = timestamp; });
  harness.runFrame(20);
  assert.equal(throttledTimestamp, null);
  harness.runFrame(55);
  assert.equal(throttledTimestamp, 55);
  harness.runTimeout(6000);
  assert.equal(harness.window.requestAnimationFrame, harness.originals.requestAnimationFrame, 'the wrapper is removed after frames recover');
});

test('adaptive 30 FPS limiter preserves requestAnimationFrame cancellation', () => {
  const harness = createHarness();
  harness.dispatchAction('adaptive-limit-on');
  harness.performanceObservers.at(-1).emit();
  let called = false;
  const id = harness.window.requestAnimationFrame(() => { called = true; });
  harness.runFrame(10);
  assert.equal(harness.frames.length, 1, 'the callback remains queued while waiting for a frame slot');
  harness.window.cancelAnimationFrame(id);
  assert.equal(harness.frames.length, 0);
  assert.equal(called, false);

  harness.dispatchAction('adaptive-limit-off');
  assert.equal(harness.window.requestAnimationFrame, harness.originals.requestAnimationFrame);
});

test('generic Swiper autoplay pauses only while offscreen and resumes on entry', () => {
  const autoplay = {
    running: true,
    stop() { this.running = false; },
    start() { this.running = true; }
  };
  const carousel = {
    isConnected: true,
    swiper: { autoplay },
    getAttribute(name) { return name === 'data-smoothboost-carousel' ? 'true' : null; }
  };
  const harness = createHarness({ carousels: [carousel] });
  const observer = harness.intersectionObservers[0];
  observer.trigger(carousel, false);
  assert.equal(autoplay.running, false);
  observer.trigger(carousel, true);
  assert.equal(autoplay.running, true);
});

test('Re:Anime autoplay pauses after one rotation, restores the slide, and keeps manual controls', () => {
  let title = 'BLEACH';
  const buttons = [
    { getAttribute: (name) => name === 'aria-label' ? 'Go to BLEACH' : null, textContent: '', click() { title = 'BLEACH'; } },
    { getAttribute: (name) => name === 'aria-label' ? 'Go to ONE PIECE' : null, textContent: '', click() { title = 'ONE PIECE'; } }
  ];
  const hero = {
    isConnected: true,
    contains(target) { return target === this; },
    querySelector(selector) { return selector === 'img[alt]' ? { alt: title } : null; },
    querySelectorAll(selector) { return selector === 'button' ? buttons : []; }
  };
  const harness = createHarness({ hostname: 'reanime.to', hero });
  const id = harness.window.setInterval(() => { title = 'ONE PIECE'; }, 5000);
  assert.equal(harness.intervals.size, 1);
  harness.intervals.get(id).callback();
  harness.runTimeout(80);

  assert.equal(harness.intervals.has(id), false, 'the autoplay interval is cancelled');
  assert.equal(title, 'BLEACH', 'the prior hero slide is restored');
  assert.equal(harness.emittedEvents.some((event) => event.type === harness.channel && event.detail?.status === 'paused'), true);
  buttons[1].click();
  assert.equal(title, 'ONE PIECE', 'manual slide controls remain usable');

  harness.dispatchAction('optimizations-off');
  assert.equal(harness.intervals.size, 1, 'turning the feature off resumes the original interval');
  assert.equal(harness.window.setInterval === harness.originals.setInterval, false, 'timer wrapper remains cancellable for a later re-enable');
});
