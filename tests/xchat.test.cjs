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
