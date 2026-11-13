const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadDetector() {
  const context = {
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    location: { href: 'https://x.com/home', pathname: '/home' },
    console: { log() {}, warn() {} },
    setTimeout,
    clearTimeout,
    Date,
    Map,
    Set
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'content/detector.js'), 'utf8'), context);
  return context.window.interactionDetector;
}

function loadPopupHelpers() {
  const context = {
    document: {
      addEventListener() {},
      documentElement: { getAttribute() { return null; } },
      getElementById() { return { innerText: '' }; },
      querySelector() { return null; }
    },
    window: {},
    console,
    setTimeout,
    clearTimeout,
    Date,
    Map
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8'), context);
  return context;
}

function mockAvatarContainer(handle, src) {
  return {
    getAttribute(name) {
      return name === 'data-testid' ? `UserAvatar-Container-${handle}` : null;
    },
    querySelector() {
      return {
        src,
        currentSrc: src,
        getAttribute(name) { return name === 'src' ? src : null; }
      };
    }
  };
}

test('profile avatar lookup selects the visited mutual, not the signed-in sidebar account', () => {
  const detector = loadDetector();
  const self = mockAvatarContainer('myaccount', 'https://pbs.twimg.com/profile_images/self.jpg');
  const mutual = mockAvatarContainer('mutual', 'https://pbs.twimg.com/profile_images/mutual.jpg');
  const page = { querySelectorAll() { return [self, mutual]; } };

  assert.equal(detector.getAvatarUrlForHandle('mutual', page), mutual.querySelector().src);
});

test('avatar lookup returns empty rather than borrowing another account image', () => {
  const detector = loadDetector();
  const self = mockAvatarContainer('myaccount', 'https://pbs.twimg.com/profile_images/self.jpg');
  const page = { querySelectorAll() { return [self]; } };

  assert.equal(detector.getAvatarUrlForHandle('mutual', page), '');
});

test('dashboard ignores unrelated and other-account storage writes', () => {
  const context = loadPopupHelpers();
  const shouldRefresh = context.shouldRefreshDashboardForStorageChanges;

  assert.equal(shouldRefresh({ settings: { newValue: {} } }, 'myaccount'), false);
  assert.equal(shouldRefresh({ 'acc:other:user:mutual': { newValue: {} } }, 'myaccount'), false);
  assert.equal(shouldRefresh({ 'acc:myaccount:events:mutual': { newValue: [] } }, 'myaccount'), true);
  assert.equal(shouldRefresh({ currentUser: { newValue: 'other' } }, 'myaccount'), true);
});

test('dashboard batches repeated refresh requests into one leaderboard reload', async () => {
  const context = loadPopupHelpers();
  let loads = 0;
  context.window.bondStorage = {
    async getAllUsers() {
      loads += 1;
      return [];
    }
  };
  context.applyFilterAndRender = () => {};

  context.queueDashboardRefresh();
  context.queueDashboardRefresh();
  await new Promise(resolve => setTimeout(resolve, 140));

  assert.equal(loads, 1);
});
