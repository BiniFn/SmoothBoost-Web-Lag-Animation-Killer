const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const contentSource = fs.readFileSync(path.join(__dirname, '../scripts/content.js'), 'utf8');
const siteRules = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/site-rules.json'), 'utf8'));

function makeElement(tagName = 'DIV', attributes = {}) {
  const values = new Map(Object.entries(attributes));
  const styleValues = new Map();
  const style = {
    setProperty(name, value, priority = '') { styleValues.set(name, { value, priority }); },
    getPropertyValue(name) { return styleValues.get(name)?.value || ''; },
    getPropertyPriority(name) { return styleValues.get(name)?.priority || ''; },
    removeProperty(name) { styleValues.delete(name); }
  };
  return {
    nodeType: 1,
    tagName,
    style,
    paused: false,
    isConnected: true,
    autoplay: false,
    loop: false,
    muted: false,
    controls: false,
    attributes: values,
    setAttribute(name, value) { values.set(name, String(value)); },
    getAttribute(name) { return values.get(name) || null; },
    removeAttribute(name) { values.delete(name); },
    querySelectorAll() { return []; },
    matches() { return false; },
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); }
  };
}

async function createFrame(hostname, { topFrame = true, videos = [], extraElements = [], animations = [] } = {}) {
  const styles = new Map();
  const dispatchedEvents = [];
  const observers = [];
  let storageListener;
  let messageListener;
  const root = makeElement('HTML');
  root.querySelectorAll = (selector) => selector === '*' ? extraElements : [];
  root.getAnimations = () => animations;
  const head = {
    appendChild(element) { styles.set(element.id, element); element.parentNode = head; }
  };
  const document = {
    head,
    body: {},
    documentElement: root,
    addEventListener() {},
    createElement() {
      return { id: '', textContent: '', remove() { styles.delete(this.id); } };
    },
    getElementById(id) { return styles.get(id) || null; },
    querySelectorAll(selector) {
      if (selector === 'video' || selector === 'video[data-smoothboost-paused="true"]') return videos;
      if (selector === '*') return extraElements;
      if (selector.includes('data-smoothboost-blur')) return extraElements.filter((element) => element.getAttribute('data-smoothboost-blur') === 'true');
      return [];
    },
    getAnimations() { return animations; }
  };

  class MockMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  class MockIntersectionObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
    trigger(target, visible) {
      this.callback([{ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]);
    }
  }
  class MockCustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }

  const windowListeners = new Map();
  const window = {
    location: { hostname, pathname: hostname === 'reanime.to' ? '/home' : '/page' },
    setTimeout,
    clearTimeout,
    getComputedStyle(element) {
      return element === extraElements[0] && extraElements[0].blurred
        ? { backdropFilter: 'blur(12px)', webkitBackdropFilter: 'none', backgroundColor: 'rgba(20, 30, 40, 0.2)', animationName: 'none' }
        : { backdropFilter: 'none', webkitBackdropFilter: 'none', backgroundColor: 'transparent', animationName: element.animationName || 'none' };
    },
    dispatchEvent(event) { dispatchedEvents.push(event); for (const listener of windowListeners.get(event.type) || []) listener(event); },
    addEventListener(type, listener) { const values = windowListeners.get(type) || []; values.push(listener); windowListeners.set(type, values); },
    removeEventListener() {}
  };
  window.top = topFrame ? window : {};
  const chrome = {
    storage: {
      onChanged: { addListener(listener) { storageListener = listener; } },
      local: { async get() { return {}; } }
    },
    runtime: {
      getURL() { return 'chrome-extension://test/data/site-rules.json'; },
      onMessage: { addListener(listener) { messageListener = listener; } }
    }
  };

  vm.runInNewContext(contentSource, {
    chrome,
    document,
    window,
    MutationObserver: MockMutationObserver,
    IntersectionObserver: MockIntersectionObserver,
    CustomEvent: MockCustomEvent,
    PerformanceObserver: undefined,
    fetch: async () => ({ ok: true, async json() { return siteRules; } }),
    performance,
    Promise,
    setTimeout,
    clearTimeout
  });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    styles,
    observers,
    dispatchedEvents,
    setConfig(config) { storageListener({ smoothBoostConfig: { newValue: config } }, 'local'); },
    getStatus() {
      let response;
      messageListener({ type: 'GET_STATUS' }, {}, (value) => { response = value; });
      return response;
    },
    getDiagnostics() {
      let response;
      messageListener({ type: 'GET_DIAGNOSTICS' }, {}, (value) => { response = value; });
      return response;
    },
    triggerIntersection(target, visible) {
      const observer = observers.find((candidate) => candidate instanceof MockIntersectionObserver && candidate.targets.has(target));
      assert.ok(observer, 'an IntersectionObserver tracks this target');
      observer.trigger(target, visible);
    }
  };
}

test('Maximum pauses only offscreen ambient previews; visible and player videos remain available', async () => {
  const preview = makeElement('VIDEO');
  Object.assign(preview, { autoplay: true, loop: true, muted: true, controls: false });
  const visiblePreview = makeElement('VIDEO');
  Object.assign(visiblePreview, { autoplay: true, loop: true, muted: true, controls: false });
  const player = makeElement('VIDEO');
  Object.assign(player, { autoplay: true, loop: false, muted: true, controls: false });
  const frame = await createFrame('example.com', { videos: [preview, visiblePreview, player] });

  assert.equal(frame.getStatus().enabled, true);
  assert.ok(frame.styles.has('smoothboost-injected-styles'));
  assert.doesNotMatch(frame.styles.get('smoothboost-injected-styles').textContent, /animation-duration:|transition-duration:|content-visibility/);
  frame.triggerIntersection(preview, false);
  frame.triggerIntersection(visiblePreview, true);
  assert.equal(preview.paused, true, 'an offscreen muted looping preview pauses');
  assert.equal(visiblePreview.paused, false, 'a visible preview stays available');
  assert.equal(player.paused, false, 'a non-looping player stays available');

  frame.triggerIntersection(preview, true);
  assert.equal(preview.paused, false, 'the preview resumes when it enters the viewport');

  frame.setConfig({ globalEnabled: false, mode: 'ultra', siteOverrides: {} });
  assert.equal(preview.getAttribute('data-smoothboost-paused'), null);
});

test('Balanced leaves page styles and background media unchanged', async () => {
  const preview = makeElement('VIDEO');
  Object.assign(preview, { autoplay: true, loop: true, muted: true, controls: false });
  const frame = await createFrame('crunchyroll.com', { videos: [preview] });
  frame.setConfig({ globalEnabled: true, mode: 'balanced', siteOverrides: {} });

  const css = frame.styles.get('smoothboost-injected-styles').textContent;
  assert.doesNotMatch(css, /animation-duration:|transition-duration:|backdrop-filter:|content-visibility/);
  assert.equal(frame.observers.some((observer) => observer.targets?.has(preview)), false);
  assert.equal(preview.paused, false);
});

test('Custom pauses offscreen CSS animations and resumes them when visible', async () => {
  const animated = makeElement('DIV');
  animated.animationName = 'infinite-spin';
  const frame = await createFrame('example.com', {
    extraElements: [animated],
    animations: [{ effect: { target: animated } }]
  });
  frame.setConfig({
    globalEnabled: true,
    mode: 'custom',
    customSettings: { pauseOffscreenAnimations: true },
    siteOverrides: {}
  });

  assert.match(frame.styles.get('smoothboost-injected-styles').textContent, /animation-play-state: paused/);
  frame.triggerIntersection(animated, false);
  assert.equal(animated.getAttribute('data-smoothboost-offscreen-animation'), 'true');
  frame.triggerIntersection(animated, true);
  assert.equal(animated.getAttribute('data-smoothboost-offscreen-animation'), null);
});

test('removing backdrop blur raises translucent panel opacity and restores its original style when disabled', async () => {
  const panel = makeElement('DIV');
  panel.blurred = true;
  panel.querySelectorAll = () => [];
  const frame = await createFrame('example.com', { extraElements: [panel] });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(panel.getAttribute('data-smoothboost-blur'), 'true');
  assert.match(panel.style.getPropertyValue('background-color'), /0\.92\)/);
  frame.setConfig({ globalEnabled: true, mode: 'balanced', siteOverrides: {} });
  assert.equal(panel.getAttribute('data-smoothboost-blur'), null);
  assert.equal(panel.style.getPropertyValue('background-color'), '');
});

test('page status and diagnostics report measured page data', async () => {
  const video = makeElement('VIDEO');
  Object.assign(video, { autoplay: true, loop: true, muted: true, controls: false });
  const frame = await createFrame('example.com', { videos: [video] });
  const result = frame.getDiagnostics();
  assert.equal(result.status, 'active');
  assert.equal(result.diagnostics.autoplayVideos, 1);
  assert.equal(typeof result.diagnostics.animationLoops, 'number');
  assert.equal(result.diagnostics.longFrameApi, false);
});
