const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const popupSource = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');

class FakeElement {
  constructor() {
    this.textContent = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.classes = new Set();
    this.attributes = new Map();
    this.tabIndex = 0;
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !this.classes.has(name) : force;
        if (shouldAdd) this.classes.add(name);
        else this.classes.delete(name);
        return shouldAdd;
      }
    };
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

async function renderPopup({ url, response, hasReceiver = true }) {
  const elements = new Map();
  const documentListeners = new Map();
  const body = new FakeElement();
  const runtime = { lastError: undefined };
  let messageCount = 0;

  const document = {
    body,
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    }
  };

  const chrome = {
    tabs: {
      async query() { return [{ id: 55, url }]; },
      sendMessage(tabId, message, options, callback) {
        messageCount++;
        assert.equal(tabId, 55);
        assert.equal(message.type, 'GET_STATUS');
        assert.equal(options.frameId, 0);
        if (!hasReceiver) {
          runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
          callback(undefined);
          runtime.lastError = undefined;
        } else {
          callback(response);
        }
      }
    },
    storage: {
      local: {
        async get() {
          return { smoothBoostConfig: { globalEnabled: true, mode: 'ultra', customSettings: {}, siteOverrides: {} } };
        },
        async set() {}
      }
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {}
    },
    runtime
  };

  vm.runInNewContext(popupSource, { document, chrome, window: { setTimeout } });
  await documentListeners.get('DOMContentLoaded')();
  return { elements, messageCount };
}

test('popup reports an active script and the Re:Anime rule state', async () => {
  const { elements } = await renderPopup({
    url: 'https://reanime.to/home',
    response: { status: 'active', enabled: true, mode: 'ultra', siteRule: 'paused' }
  });

  assert.equal(elements.get('status-page').textContent, 'Active');
  assert.equal(elements.get('status-profile').textContent, 'Maximum');
  assert.equal(elements.get('status-site-rule').textContent, 'Paused');
  assert.equal(elements.get('site-rule-row').hidden, false);
});

test('popup reports a missing receiver as a reload request', async () => {
  const { elements, messageCount } = await renderPopup({
    url: 'https://example.com/',
    hasReceiver: false
  });

  assert.equal(messageCount, 1);
  assert.equal(elements.get('status-page').textContent, 'Reload tab to activate');
  assert.match(elements.get('status-detail').textContent, /Reload this tab/);
});

test('popup reports browser-owned pages as unsupported without messaging them', async () => {
  const { elements, messageCount } = await renderPopup({ url: 'chrome://extensions/' });

  assert.equal(messageCount, 0);
  assert.equal(elements.get('status-page').textContent, 'Unsupported page');
  assert.match(elements.get('status-detail').textContent, /does not allow extensions/);
});

test('popup switches between Controls and Help & Bugs tabs', async () => {
  const { elements } = await renderPopup({ url: 'https://example.com/', response: { status: 'active', enabled: true, mode: 'ultra' } });
  elements.get('tab-help').listeners.get('click')();

  assert.equal(elements.get('help-panel').hidden, false);
  assert.equal(elements.get('controls-panel').hidden, true);
  assert.equal(elements.get('tab-help').attributes.get('aria-selected'), 'true');
  assert.equal(elements.get('tab-controls').tabIndex, -1);

  elements.get('tab-controls').listeners.get('click')();
  assert.equal(elements.get('help-panel').hidden, true);
  assert.equal(elements.get('controls-panel').hidden, false);
});
