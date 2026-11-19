const test = require('node:test');
const assert = require('node:assert/strict');

const { BondStorage } = require('../core/storage.js');
require('../core/scoring.js');

// Minimal chrome.storage.local shim, same shape as the other suites.
function installChromeMock() {
  const store = {};
  global.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          if (!keys) return cb(Object.assign({}, store));
          const res = {};
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((k) => { if (store[k] !== undefined) res[k] = store[k]; });
          cb(res);
        },
        set(items, cb) {
          Object.assign(store, items);
          if (cb) cb();
        },
        remove(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((k) => { delete store[k]; });
          if (cb) cb();
        }
      },
      onChanged: { addListener() {} }
    },
    runtime: { lastError: null }
  };
  return store;
}

test('XChat conversation ids canonicalise both URL and inbox forms', () => {
  // The adapter is a plain browser script; give it just enough globals.
  global.window = global;
  global.chrome = global.chrome || {};
  require('../content/xchat-adapter.js');

  const { canonicalConversationId, conversationUrlId } = global.window.BondXChat;
  assert.equal(canonicalConversationId('1834259027947311104-2114698745178886144'), '1834259027947311104:2114698745178886144');
  assert.equal(canonicalConversationId('g2106100588903542916'), 'g2106100588903542916');
  assert.equal(conversationUrlId('1834259027947311104:2114698745178886144'), '1834259027947311104-2114698745178886144');
  assert.equal(conversationUrlId('g2106100588903542916'), 'g2106100588903542916');
});

test('XChat group ingestion computes real energy and member diversity', async () => {
  installChromeMock();
  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('tester');
  storage.setActivePlatform('x');

  const now = Date.now();
  await storage.saveDmConversation('g2106100588903542916', {
    isGroup: true,
    title: 'Homies',
    participants: [],
    surface: 'xchat'
  }, 'tester');

  await storage.ingestMessageEntries('g2106100588903542916', [
    { fingerprint: 'xchat_g_in_1', direction: 'inbound', senderHandle: 'alice', timestamp: now - 5000, index: 0 },
    { fingerprint: 'xchat_g_out_1', direction: 'outbound', senderHandle: null, timestamp: now - 3000, index: 1 },
    { fingerprint: 'xchat_g_in_2', direction: 'inbound', senderHandle: 'bob', timestamp: now - 1000, index: 2 }
  ], 'tester');

  const conv = await storage.getDmConversation('g2106100588903542916', true, 'tester', 'x');
  assert.equal(conv.isGroup, true);
  assert.equal(conv.sentCount, 1);
  assert.equal(conv.receivedCount, 2);
  assert.equal(conv.totalCount, 3);
  assert.equal(conv.totalMessages, 3);
  assert.equal(conv.surface, 'xchat');
  assert.deepEqual(Object.keys(conv.memberMessageCounts).sort(), ['alice', 'bob']);
  assert.ok(conv.groupEnergyScore > 0, 'group energy should not be zero');
  assert.ok(conv.groupEnergyLevel && conv.groupEnergyLevel.id, 'energy level should resolve');
});

test('XChat 1:1 ingestion scores messages and stays metadata-only', async () => {
  const store = installChromeMock();
  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('tester');
  storage.setActivePlatform('x');

  const secret = 'PRIVATE_XCHAT_BODY_MUST_NOT_PERSIST';
  const now = Date.now();
  await storage.saveDmConversation('1834259027947311104:2114698745178886144', {
    isGroup: false,
    title: '@alice',
    participants: ['alice'],
    surface: 'xchat'
  }, 'tester');

  await storage.ingestMessageEntries('1834259027947311104:2114698745178886144', [
    { fingerprint: 'xchat_dm_in_1', direction: 'inbound', senderHandle: 'alice', timestamp: now - 60000, index: 0, text: secret },
    { fingerprint: 'xchat_dm_out_1', direction: 'outbound', senderHandle: null, timestamp: now - 30000, index: 1, text: secret }
  ], 'tester');

  const conv = await storage.getDmConversation('1834259027947311104:2114698745178886144', true, 'tester', 'x');
  assert.equal(conv.isGroup, false);
  assert.equal(conv.sentCount, 1);
  assert.equal(conv.receivedCount, 1);
  assert.equal(conv.totalCount, 2);
  assert.ok(conv.bondScore > 0, '1:1 DM should produce a bond score');
  assert.equal(JSON.stringify(store).includes(secret), false, 'message body must never be persisted');
});

test('Storage backfills missing avatars from DM participant details during getAllUsers', async () => {
  installChromeMock();
  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('tester');
  storage.setActivePlatform('x');

  // 1. Create a user with empty avatar (e.g. from an initial GC membership)
  await storage.saveUser('shadowborn', {
    handle: 'shadowborn',
    displayName: 'Shadowborn',
    avatarUrl: '',
    currentScore: 45
  }, 'tester', 'x');

  // 2. Save a DM conversation that contains Shadowborn's avatar in participantDetails
  await storage.saveDmConversation('g2119410785122472214', {
    isGroup: true,
    title: 'Shadowborn GC',
    participants: ['shadowborn'],
    participantDetails: {
      shadowborn: {
        handle: 'shadowborn',
        displayName: 'Shadowborn The Fake Leaker',
        avatarUrl: 'https://pbs.twimg.com/profile_images/shadowborn_test.jpg'
      }
    }
  }, 'tester');

  // 3. Call getAllUsers and verify avatarUrl is automatically backfilled
  const users = await storage.getAllUsers('tester', 'x');
  const shadow = users.find((u) => u.handle === 'shadowborn');
  assert.ok(shadow, 'shadowborn should be in users list');
  assert.equal(shadow.avatarUrl, 'https://pbs.twimg.com/profile_images/shadowborn_test.jpg');
});

test('updateUserAvatarIfMissing updates avatar and display name when previously empty', async () => {
  installChromeMock();
  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('tester');
  storage.setActivePlatform('x');

  await storage.saveUser('friendofbeako', {
    handle: 'friendofbeako',
    displayName: 'friendofbeako',
    avatarUrl: '',
    currentScore: 30
  }, 'tester', 'x');

  const updated = await storage.updateUserAvatarIfMissing(
    'friendofbeako',
    'https://pbs.twimg.com/profile_images/beako.jpg',
    'Beako Best Girl',
    'x'
  );
  assert.equal(updated, true);

  const user = await storage.getUser('friendofbeako', false, 'tester', 'x');
  assert.equal(user.avatarUrl, 'https://pbs.twimg.com/profile_images/beako.jpg');
  assert.equal(user.displayName, 'Beako Best Girl');
});

test('XChat _scanInbox injects badges and registers conversations on first load without user click', async () => {
  installChromeMock();
  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('tester');
  global.window.bondStorage = storage;

  let injectedBadgeConvId = null;
  global.window.bondUI = {
    injectDmRowBadge: async (row, convId, participantHandle, isGroup, metadata) => {
      injectedBadgeConvId = convId;
    }
  };

  const adapter = global.window.bondXChat;
  adapter.enabled = true;

  // Mock shadow root with an unclicked conversation row
  const mockRow = {
    getAttribute(name) {
      if (name === 'data-testid') return 'dm-conversation-item-g2119410785122472214';
      return null;
    },
    querySelector(selector) {
      if (selector === 'img') return { src: 'https://pbs.twimg.com/profile_images/gc.jpg', alt: 'Kurisu Rats' };
      if (selector.includes('span')) return { innerText: 'kurisu experiment rats' };
      return null;
    },
    innerText: 'kurisu experiment rats\nTanhero: Sent a GIF'
  };

  adapter.shadow = {
    querySelectorAll(selector) {
      if (selector.includes('dm-conversation-item-')) return [mockRow];
      return [];
    }
  };
  adapter.lastInboxScan = 0;

  await adapter._scanInbox('tester');

  assert.equal(injectedBadgeConvId, 'g2119410785122472214', 'Row badge should be injected without waiting for a click');

  const savedConv = await storage.getDmConversation('g2119410785122472214', false, 'tester', 'x');
  assert.ok(savedConv, 'Conversation should be automatically registered in storage');
  assert.equal(savedConv.isGroup, true);
});
