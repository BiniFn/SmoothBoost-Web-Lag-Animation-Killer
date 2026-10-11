const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const backgroundSource = fs.readFileSync(path.join(__dirname, '../scripts/background.js'), 'utf8');

async function runInstallation(existingConfig, reason) {
  let installListener;
  let storedConfig = existingConfig ? { smoothBoostConfig: existingConfig } : {};
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: {
      onInstalled: { addListener(listener) { installListener = listener; } },
      lastError: undefined
    },
    storage: {
      local: {
        async get() { return storedConfig; },
        async set(value) { storedConfig = value; }
      }
    },
    tabs: { onActivated: event(), onUpdated: event() },
    commands: { onCommand: event() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
  };

  vm.runInNewContext(backgroundSource, { chrome, URL, Promise });
  await installListener({ reason });
  return storedConfig.smoothBoostConfig;
}

test('upgrade resets unsafe legacy Custom defaults and preserves profile and frame limiter', async () => {
  const migrated = await runInstallation({
    globalEnabled: true,
    mode: 'custom',
    customSettings: {
      killAnimations: true,
      killTransitions: true,
      killBlurFilters: true,
      killScrollHijack: true,
      pauseBackgroundMedia: true,
      throttleCanvasFps: true,
      fpsLimit: 24
    },
    siteOverrides: { 'example.com': { mode: 'custom', enabled: false } }
  }, 'update');

  assert.equal(migrated.settingsVersion, 3);
  assert.equal(migrated.mode, 'custom');
  assert.equal(migrated.customSettings.killAnimations, false);
  assert.equal(migrated.customSettings.killTransitions, false);
  assert.equal(migrated.customSettings.killBlurFilters, false);
  assert.equal(migrated.customSettings.killScrollHijack, false);
  assert.equal(migrated.customSettings.pauseBackgroundMedia, false);
  assert.equal(migrated.customSettings.throttleCanvasFps, true);
  assert.equal(migrated.customSettings.fpsLimit, 24);
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.siteOverrides)), { 'example.com': { mode: 'custom', enabled: false } });
});

test('fresh install starts with safe Custom defaults', async () => {
  const installed = await runInstallation(null, 'install');

  assert.equal(installed.settingsVersion, 3);
  assert.equal(installed.customSettings.killAnimations, false);
  assert.equal(installed.customSettings.killScrollHijack, false);
  assert.equal(installed.customSettings.pauseBackgroundMedia, false);
});

test('dynamic scripts exclude disabled sites while retaining the all-sites default', async () => {
  let installListener;
  let registered = [];
  const storedConfig = {
    settingsVersion: 3,
    globalEnabled: true,
    mode: 'ultra',
    customSettings: {},
    siteOverrides: { 'example.com': { enabled: false } }
  };
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: {
      onInstalled: { addListener(listener) { installListener = listener; } },
      onMessage: event(), onStartup: event(), lastError: undefined
    },
    storage: {
      local: { async get() { return { smoothBoostConfig: storedConfig }; }, async set() {} },
      onChanged: event()
    },
    scripting: {
      async getRegisteredContentScripts() { return []; },
      async unregisterContentScripts() {},
      async registerContentScripts(scripts) { registered = scripts; }
    },
    tabs: { onActivated: event(), onUpdated: event() },
    commands: { onCommand: event() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
  };
  vm.runInNewContext(backgroundSource, { chrome, URL, Promise });
  await installListener({ reason: 'update' });

  assert.equal(registered.length, 2);
  assert.deepEqual(Array.from(registered[0].matches), ['<all_urls>']);
  assert.deepEqual(Array.from(registered[0].excludeMatches), ['*://example.com/*']);
  assert.deepEqual(Array.from(registered[1].excludeMatches), ['*://example.com/*']);
  assert.equal(registered[0].world, 'ISOLATED');
  assert.equal(registered[1].world, 'MAIN');
});

test('global off registers only explicitly enabled site overrides', async () => {
  let installListener;
  let registered = [];
  const storedConfig = {
    settingsVersion: 3,
    globalEnabled: false,
    mode: 'balanced',
    customSettings: {},
    siteOverrides: {
      'enabled.example': { enabled: true },
      'disabled.example': { enabled: false }
    }
  };
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: {
      onInstalled: { addListener(listener) { installListener = listener; } },
      onMessage: event(), onStartup: event(), lastError: undefined
    },
    storage: {
      local: { async get() { return { smoothBoostConfig: storedConfig }; }, async set() {} },
      onChanged: event()
    },
    scripting: {
      async getRegisteredContentScripts() { return []; },
      async unregisterContentScripts() {},
      async registerContentScripts(scripts) { registered = scripts; }
    },
    tabs: { onActivated: event(), onUpdated: event() },
    commands: { onCommand: event() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
  };
  vm.runInNewContext(backgroundSource, { chrome, URL, Promise });
  await installListener({ reason: 'update' });

  assert.deepEqual(Array.from(registered[0].matches), ['*://enabled.example/*']);
  assert.equal(registered[0].excludeMatches, undefined);
});

test('keyboard toggle consumes the expected missing-receiver error', async () => {
  let commandListener;
  let storedConfig = {
    settingsVersion: 3,
    globalEnabled: true,
    mode: 'ultra',
    customSettings: {},
    siteOverrides: {}
  };
  const event = (listener) => ({ addListener(value) { if (listener) listener(value); } });
  const chrome = {
    runtime: {
      onInstalled: event(),
      onMessage: event(),
      onStartup: event(),
      lastError: undefined
    },
    storage: {
      local: {
        async get() { return { smoothBoostConfig: storedConfig }; },
        async set(value) { storedConfig = value.smoothBoostConfig; }
      },
      onChanged: event()
    },
    tabs: {
      onActivated: event(),
      onUpdated: event(),
      async query() { return [{ id: 7, url: 'https://example.com/' }]; },
      sendMessage(_tabId, _message, _options, callback) {
        chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        callback(undefined);
        chrome.runtime.lastError = undefined;
        return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
      }
    },
    commands: { onCommand: { addListener(listener) { commandListener = listener; } } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
  };
  vm.runInNewContext(backgroundSource, { chrome, URL, Promise });

  await assert.doesNotReject(() => commandListener('toggle-speed-boost'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storedConfig.siteOverrides['example.com'].enabled, false);
});
