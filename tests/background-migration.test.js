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

  assert.equal(migrated.settingsVersion, 2);
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

  assert.equal(installed.settingsVersion, 2);
  assert.equal(installed.customSettings.killAnimations, false);
  assert.equal(installed.customSettings.killScrollHijack, false);
  assert.equal(installed.customSettings.pauseBackgroundMedia, false);
});
