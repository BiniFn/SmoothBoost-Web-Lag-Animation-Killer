const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const hookSource = fs.readFileSync(path.join(__dirname, '../scripts/page-hook.js'), 'utf8');

function createHarness({ hostname = 'example.com', hero = null } = {}) {
  let nextId = 1;
  const frames = [];
  const intervals = new Map();
  const timeouts = [];
  const emittedEvents = [];

  class MockEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = !!options.bubbles;
      this.cancelable = !!options.cancelable;
      this.defaultPrevented = false;
      this.target = null;
      this.currentTarget = null;
    }

    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  }

  class MockCustomEvent extends MockEvent {
    constructor(type, options = {}) {
      super(type, options);
      this.detail = options.detail;
    }
  }

  class MockEventTarget {
    constructor() {
      this.listeners = new Map();
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    dispatchEvent(event) {
      event.target = this;
      event.currentTarget = this;
      for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
      return !event.defaultPrevented;
    }
  }

  class MockWindow extends MockEventTarget {
    constructor() {
      super();
      this.location = { hostname };
      this.top = this;
      this.dispatchedEvents = emittedEvents;
    }

    requestAnimationFrame(callback) {
      const id = nextId++;
      frames.push({ id, callback });
      return id;
    }

    cancelAnimationFrame(id) {
      const index = frames.findIndex((frame) => frame.id === id);
      if (index >= 0) frames.splice(index, 1);
    }

    setInterval(callback, delay, ...args) {
      const id = nextId++;
      intervals.set(id, { callback, delay, args });
      return id;
    }

    clearInterval(id) {
      intervals.delete(id);
    }

    setTimeout(callback, delay) {
      const id = nextId++;
      timeouts.push({ id, callback, delay });
      return id;
    }

    dispatchEvent(event) {
      emittedEvents.push(event);
      return super.dispatchEvent(event);
    }
  }

  class MockMediaElement {
    play() {
      return Promise.resolve();
    }
  }

  class MockVideoElement extends MockMediaElement {}

  const window = new MockWindow();
  const document = new MockEventTarget();
  document.documentElement = {};
  document.body = {};
  document.activeElement = null;
  document.querySelector = (selector) => selector === '[aria-label="Hero carousel"]' ? hero : null;
  const originals = {
    addEventListener: MockEventTarget.prototype.addEventListener,
    preventDefault: MockEvent.prototype.preventDefault,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    play: MockMediaElement.prototype.play
  };

  vm.runInNewContext(hookSource, {
    window,
    document,
    EventTarget: MockEventTarget,
    Event: MockEvent,
    CustomEvent: MockCustomEvent,
    HTMLMediaElement: MockMediaElement,
    HTMLVideoElement: MockVideoElement,
    Promise,
    Map,
    Number
  });

  return {
    window,
    frames,
    intervals,
    timeouts,
    emittedEvents,
    hero,
    originals,
    prototypes: {
      eventTarget: MockEventTarget.prototype,
      event: MockEvent.prototype,
      media: MockMediaElement.prototype
    },
    setConfig(detail) {
      window.dispatchEvent(new MockCustomEvent('__SMOOTHBOOST_UPDATE_PAGE_HOOK__', { detail }));
    },
    runFrame(timestamp) {
      const frame = frames.shift();
      assert.ok(frame, 'a native animation frame should be queued');
      frame.callback(timestamp);
    },
    runTimeouts() {
      for (const timer of timeouts.splice(0)) timer.callback();
    }
  };
}

test('inactive page hook leaves APIs unchanged and restores wrappers when disabled', () => {
  const harness = createHarness();

  assert.equal(harness.prototypes.eventTarget.addEventListener, harness.originals.addEventListener);
  assert.equal(harness.prototypes.event.preventDefault, harness.originals.preventDefault);
  assert.equal(harness.window.requestAnimationFrame, harness.originals.requestAnimationFrame);
  assert.equal(harness.window.cancelAnimationFrame, harness.originals.cancelAnimationFrame);
  assert.equal(harness.prototypes.media.play, harness.originals.play);
  assert.equal('__SMOOTHBOOST_HOOK_LOADED__' in harness.window, false);

  harness.setConfig({
    enabled: true,
    killScrollHijack: true,
    pauseBackgroundMedia: true,
    throttleCanvasFps: false
  });
  assert.notEqual(harness.prototypes.eventTarget.addEventListener, harness.originals.addEventListener);
  assert.notEqual(harness.prototypes.event.preventDefault, harness.originals.preventDefault);
  assert.equal(harness.prototypes.media.play, harness.originals.play, 'the page hook never blocks media playback');
  assert.equal(harness.window.requestAnimationFrame, harness.originals.requestAnimationFrame);

  harness.setConfig({ enabled: false, killScrollHijack: false, pauseBackgroundMedia: false });
  assert.equal(harness.prototypes.eventTarget.addEventListener, harness.originals.addEventListener);
  assert.equal(harness.prototypes.event.preventDefault, harness.originals.preventDefault);
  assert.equal(harness.prototypes.media.play, harness.originals.play);
  assert.equal(harness.window.requestAnimationFrame, harness.originals.requestAnimationFrame);
});

test('Maximum leaves requestAnimationFrame uncapped', () => {
  const harness = createHarness();
  harness.setConfig({ enabled: true, throttleCanvasFps: false, fpsLimit: 30 });

  let receivedTimestamp = null;
  harness.window.requestAnimationFrame((timestamp) => { receivedTimestamp = timestamp; });
  harness.runFrame(12);

  assert.equal(receivedTimestamp, 12);
  assert.equal(harness.frames.length, 0);
});

test('optional frame limiter honors the configured FPS limit', () => {
  const harness = createHarness();
  harness.setConfig({ enabled: true, throttleCanvasFps: true, fpsLimit: 20 });

  let receivedTimestamp = null;
  harness.window.requestAnimationFrame((timestamp) => { receivedTimestamp = timestamp; });
  harness.runFrame(10);
  assert.equal(receivedTimestamp, null);
  harness.runFrame(45);
  assert.equal(receivedTimestamp, null);
  harness.runFrame(50);

  assert.equal(receivedTimestamp, 50);
});

test('optional frame limiter cancellation works before and during a wait', () => {
  const beforeFirstFrame = createHarness();
  beforeFirstFrame.setConfig({ enabled: true, throttleCanvasFps: true, fpsLimit: 30 });
  let calledBeforeFirstFrame = false;
  const firstId = beforeFirstFrame.window.requestAnimationFrame(() => { calledBeforeFirstFrame = true; });
  beforeFirstFrame.window.cancelAnimationFrame(firstId);
  assert.equal(beforeFirstFrame.frames.length, 0);
  assert.equal(calledBeforeFirstFrame, false);

  const duringWait = createHarness();
  duringWait.setConfig({ enabled: true, throttleCanvasFps: true, fpsLimit: 30 });
  let calledDuringWait = false;
  const waitingId = duringWait.window.requestAnimationFrame(() => { calledDuringWait = true; });
  duringWait.runFrame(10);
  assert.equal(duringWait.frames.length, 1);
  duringWait.window.cancelAnimationFrame(waitingId);
  assert.equal(duringWait.frames.length, 0);
  assert.equal(calledDuringWait, false);
});

test('Re:Anime autoplay interval stops after the hero rotates and restores its original slide', () => {
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
  harness.setConfig({ enabled: true, pauseReanimeCarousel: true, throttleCanvasFps: false });

  let id = harness.window.setInterval(() => { title = 'ONE PIECE'; }, 5000);
  assert.equal(harness.intervals.size, 1);
  harness.intervals.get(id).callback();
  harness.runTimeouts();

  assert.equal(harness.intervals.has(id), false, 'the autoplay interval is cancelled');
  assert.equal(title, 'BLEACH', 'the slide shown before the autoplay tick is restored');
  assert.equal(harness.emittedEvents.some((event) => event.type === '__SMOOTHBOOST_REANIME_STATUS__' && event.detail.status === 'paused'), true);

  buttons[1].click();
  assert.equal(title, 'ONE PIECE', 'manual slide controls remain usable');

  harness.setConfig({ enabled: false, pauseReanimeCarousel: false });
  assert.equal(harness.intervals.size, 1, 'disabling SmoothBoost resumes the page interval');
});
