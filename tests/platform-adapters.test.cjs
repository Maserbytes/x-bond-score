const test = require('node:test');
const assert = require('node:assert/strict');

const { BondStorage, DEFAULT_SETTINGS } = require('../core/storage.js');
const { XPlatformAdapter } = require('../content/adapters/x-adapter.js');
const { ThreadsPlatformAdapter } = require('../content/adapters/threads-adapter.js');
const { BskyPlatformAdapter } = require('../content/adapters/bsky-adapter.js');

function setupMockStorage() {
  const store = {};
  global.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          if (!keys) return cb(Object.assign({}, store));
          const res = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach(k => { if (store[k] !== undefined) res[k] = store[k]; });
          cb(res);
        },
        set(obj, cb) {
          Object.assign(store, obj);
          if (cb) cb();
        }
      }
    }
  };
  return store;
}

test('Default Platform Settings: X is ON, Threads and Bluesky are OFF by default', () => {
  const platforms = DEFAULT_SETTINGS.platforms;
  assert.ok(platforms, 'platforms config exists in DEFAULT_SETTINGS');

  // X (Twitter) — Core platform (ON by default)
  assert.equal(platforms.x.enabled, true, 'X master toggle must be ON');
  assert.equal(platforms.x.timeline, true, 'X timeline tracking must be ON');
  assert.equal(platforms.x.dms, true, 'X DMs tracking must be ON');

  // Threads — OFF by default
  assert.equal(platforms.threads.enabled, false, 'Threads master toggle must be OFF by default');
  assert.equal(platforms.threads.timeline, false, 'Threads timeline tracking must be OFF by default');
  assert.equal(platforms.threads.dms, false, 'Threads DMs tracking must be OFF by default');

  // Bluesky — OFF by default
  assert.equal(platforms.bsky.enabled, false, 'Bluesky master toggle must be OFF by default');
  assert.equal(platforms.bsky.timeline, false, 'Bluesky timeline tracking must be OFF by default');
  assert.equal(platforms.bsky.dms, false, 'Bluesky DMs tracking must be OFF by default');
});

test('BondStorage platform helper methods reflect and update platform settings', async () => {
  setupMockStorage();
  const storage = new BondStorage();
  await storage.init();

  // Initial checks
  assert.equal(storage.isPlatformEnabled('x'), true);
  assert.equal(storage.isTimelineEnabled('x'), true);
  assert.equal(storage.isDmsEnabled('x'), true);

  assert.equal(storage.isPlatformEnabled('threads'), false);
  assert.equal(storage.isTimelineEnabled('threads'), false);
  assert.equal(storage.isDmsEnabled('threads'), false);

  assert.equal(storage.isPlatformEnabled('bsky'), false);
  assert.equal(storage.isTimelineEnabled('bsky'), false);
  assert.equal(storage.isDmsEnabled('bsky'), false);

  // Enable Threads master and timeline
  await storage.updatePlatformSetting('threads', 'enabled', true);
  await storage.updatePlatformSetting('threads', 'timeline', true);

  assert.equal(storage.isPlatformEnabled('threads'), true);
  assert.equal(storage.isTimelineEnabled('threads'), true);
  assert.equal(storage.isDmsEnabled('threads'), false, 'DMs should remain false until enabled');

  // Enable Bluesky completely
  await storage.updatePlatformSetting('bsky', 'enabled', true);
  await storage.updatePlatformSetting('bsky', 'timeline', true);
  await storage.updatePlatformSetting('bsky', 'dms', true);

  assert.equal(storage.isPlatformEnabled('bsky'), true);
  assert.equal(storage.isTimelineEnabled('bsky'), true);
  assert.equal(storage.isDmsEnabled('bsky'), true);

  // Re-read settings from storage to verify persistence
  const settings = await storage.getSettings();
  assert.equal(settings.platforms.threads.enabled, true);
  assert.equal(settings.platforms.bsky.dms, true);
});

test('Multi-Platform User Tracking & Filtering in getAllUsers', async () => {
  setupMockStorage();
  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('masertest');

  // Save users across different platforms
  await storage.saveUser('alice_x', { displayName: 'Alice X', platform: 'x', currentScore: 50 });
  await storage.saveUser('bob_threads', { displayName: 'Bob Threads', platform: 'threads', currentScore: 70 });
  await storage.saveUser('charlie_bsky', { displayName: 'Charlie Bluesky', platform: 'bsky', currentScore: 85 });

  // Test getAllUsers with platform filter
  const allUsers = await storage.getAllUsers('masertest', 'all');
  assert.equal(allUsers.length, 3, 'All platforms should return 3 users');

  const xUsers = await storage.getAllUsers('masertest', 'x');
  assert.equal(xUsers.length, 1);
  assert.equal(xUsers[0].handle, 'alice_x');
  assert.equal(xUsers[0].platform, 'x');

  const threadsUsers = await storage.getAllUsers('masertest', 'threads');
  assert.equal(threadsUsers.length, 1);
  assert.equal(threadsUsers[0].handle, 'bob_threads');
  assert.equal(threadsUsers[0].platform, 'threads');

  const bskyUsers = await storage.getAllUsers('masertest', 'bsky');
  assert.equal(bskyUsers.length, 1);
  assert.equal(bskyUsers[0].handle, 'charlie_bsky');
  assert.equal(bskyUsers[0].platform, 'bsky');
});

test('Multi-Platform DM Conversation Tracking & Filtering', async () => {
  setupMockStorage();
  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('masertest');

  const now = Date.now();

  // Record DMs across platforms
  await storage.recordDmMessage('x-conv-1', {
    platform: 'x',
    direction: 'outbound',
    senderHandle: 'masertest',
    recipientHandle: 'x_partner',
    textSnippet: 'Hello on X',
    timestamp: now - 1000
  });

  await storage.recordDmMessage('threads-conv-2', {
    platform: 'threads',
    direction: 'outbound',
    senderHandle: 'masertest',
    recipientHandle: 'threads_partner',
    textSnippet: 'Hello on Threads',
    timestamp: now - 500
  });

  await storage.recordDmMessage('bsky-conv-3', {
    platform: 'bsky',
    direction: 'inbound',
    senderHandle: 'bsky_partner',
    recipientHandle: 'masertest',
    textSnippet: 'Hello on Bluesky',
    timestamp: now
  });

  // Verify conversation objects have platform tags
  const cX = await storage.getDmConversation('x-conv-1');
  assert.equal(cX.platform, 'x');

  const cThreads = await storage.getDmConversation('threads-conv-2');
  assert.equal(cThreads.platform, 'threads');

  const cBsky = await storage.getDmConversation('bsky-conv-3');
  assert.equal(cBsky.platform, 'bsky');

  // Verify getAllDmConversations filtering
  const allDms = await storage.getAllDmConversations('masertest', 'all');
  assert.equal(allDms.length, 3);

  const xDms = await storage.getAllDmConversations('masertest', 'x');
  assert.equal(xDms.length, 1);
  assert.equal(xDms[0].convId, 'x-conv-1');

  const threadsDms = await storage.getAllDmConversations('masertest', 'threads');
  assert.equal(threadsDms.length, 1);
  assert.equal(threadsDms[0].convId, 'threads-conv-2');

  const bskyDms = await storage.getAllDmConversations('masertest', 'bsky');
  assert.equal(bskyDms.length, 1);
  assert.equal(bskyDms[0].convId, 'bsky-conv-3');
});

test('Platform Adapter classes instantiate with correct platform metadata', () => {
  const x = new XPlatformAdapter();
  assert.equal(x.platform, 'x');
  assert.equal(x.name, 'X (Twitter)');
  assert.equal(x.icon, '𝕏');

  const threads = new ThreadsPlatformAdapter();
  assert.equal(threads.platform, 'threads');
  assert.equal(threads.name, 'Threads');
  assert.equal(threads.icon, '🧵');

  const bsky = new BskyPlatformAdapter();
  assert.equal(bsky.platform, 'bsky');
  assert.equal(bsky.name, 'Bluesky');
  assert.equal(bsky.icon, '🦋');
});
