const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const contentSource = fs.readFileSync(path.join(__dirname, '../scripts/content.js'), 'utf8');

async function createFrame(hostname, { topFrame = true, videos = [] } = {}) {
  const styles = new Map();
  const dispatchedEvents = [];
  let storageListener;
  let messageListener;

  const head = {
    appendChild(element) {
      styles.set(element.id, element);
      element.parentNode = head;
    }
  };
  const document = {
    head,
    body: {},
    documentElement: { nodeType: 1 },
    addEventListener() {},
    createElement() {
      return {
        id: '',
        textContent: '',
        remove() { styles.delete(this.id); }
      };
    },
    getElementById(id) { return styles.get(id) || null; },
    querySelectorAll(selector) {
      return selector === 'video' || selector === 'video[data-smoothboost-paused="true"]' ? videos : [];
    }
  };

  class MockMutationObserver {
    observe() {}
    disconnect() {}
  }
  class MockCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }

  const window = {
    location: { hostname },
    dispatchEvent(event) { dispatchedEvents.push(event); },
    addEventListener() {}
  };
  window.top = topFrame ? window : {};
  const chrome = {
    storage: {
      onChanged: { addListener(listener) { storageListener = listener; } },
      local: { async get() { return {}; } }
    },
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } }
    }
  };

  vm.runInNewContext(contentSource, {
    chrome,
    document,
    window,
    MutationObserver: MockMutationObserver,
    CustomEvent: MockCustomEvent,
    Node: { ELEMENT_NODE: 1 }
  });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    styles,
    dispatchedEvents,
    setConfig(config) {
      storageListener({ smoothBoostConfig: { newValue: config } }, 'local');
    },
    getStatus() {
      let response;
      messageListener({ type: 'GET_STATUS' }, {}, (value) => { response = value; });
      return response;
    }
  };
}

test('only the top frame applies page changes and only pauses ambient autoplay previews', async () => {
  const makeVideo = ({ autoplay, loop, muted, controls }) => ({
    autoplay, loop, muted, controls, paused: false, attributes: new Set(),
    pause() { this.paused = true; },
    setAttribute(name) { this.attributes.add(name); },
    removeAttribute(name) { this.attributes.delete(name); },
    play() { this.paused = false; return Promise.resolve(); }
  });
  const preview = makeVideo({ autoplay: true, loop: true, muted: true, controls: false });
  const player = makeVideo({ autoplay: true, loop: false, muted: true, controls: false });
  const topFrame = await createFrame('example.com', { videos: [preview, player] });
  const embeddedPreview = makeVideo({ autoplay: true, loop: true, muted: true, controls: false });
  const embeddedFrame = await createFrame('media.example.net', { topFrame: false, videos: [embeddedPreview] });

  assert.equal(topFrame.getStatus().enabled, true);
  assert.equal(embeddedFrame.getStatus().enabled, false);
  assert.ok(topFrame.styles.has('smoothboost-injected-styles'));
  assert.equal(embeddedFrame.styles.has('smoothboost-injected-styles'), false);
  assert.equal(preview.paused, true, 'a muted, looping autoplay preview is paused');
  assert.equal(player.paused, false, 'a non-looping player remains playable');
  assert.equal(embeddedPreview.paused, false, 'embedded video frames are left alone');
  const appliedCss = topFrame.styles.get('smoothboost-injected-styles').textContent;
  assert.match(appliedCss, /backdrop-filter:\s*none/);
  assert.doesNotMatch(appliedCss, /animation-duration:|transition-duration:|box-shadow:\s*none|text-shadow:\s*none/);

  const updatedConfig = {
    globalEnabled: false,
    mode: 'ultra',
    siteOverrides: { 'example.com': { enabled: true } }
  };
  topFrame.setConfig(updatedConfig);
  embeddedFrame.setConfig(updatedConfig);

  assert.equal(topFrame.getStatus().enabled, true);
  assert.equal(embeddedFrame.getStatus().enabled, false);
  assert.ok(topFrame.styles.has('smoothboost-injected-styles'));
  assert.equal(embeddedFrame.styles.has('smoothboost-injected-styles'), false);
  assert.equal(topFrame.dispatchedEvents.at(-1).detail.enabled, true);
  assert.equal(embeddedFrame.dispatchedEvents.at(-1).detail.enabled, false);

  topFrame.setConfig({ globalEnabled: false, mode: 'ultra', siteOverrides: {} });
  assert.equal(preview.paused, false, 'turning SmoothBoost off resumes its paused preview');
  assert.equal(preview.attributes.has('data-smoothboost-paused'), false);
});

test('Balanced preserves site styles and background media', async () => {
  const preview = {
    autoplay: true, loop: true, muted: true, controls: false, paused: false,
    pause() { this.paused = true; },
    setAttribute() {}, removeAttribute() {}, play() { this.paused = false; return Promise.resolve(); }
  };
  const frame = await createFrame('crunchyroll.com', { videos: [preview] });
  frame.setConfig({ globalEnabled: true, mode: 'balanced', siteOverrides: {} });

  const css = frame.styles.get('smoothboost-injected-styles').textContent;
  assert.doesNotMatch(css, /animation-duration:|transition-duration:|backdrop-filter:/);
  assert.equal(preview.paused, false);
  assert.equal(frame.dispatchedEvents.at(-1).detail.killScrollHijack, undefined);
});
