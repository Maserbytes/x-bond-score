const test = require('node:test');
const assert = require('node:assert/strict');

const { BondPlatforms, BOND_PLATFORM_DEFAULTS } = require('../core/platforms.js');
const { BondScoring, GroupEnergyLevels } = require('../core/scoring.js');
const { BondStorage, DEFAULT_SETTINGS } = require('../core/storage.js');

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

test('Platform defaults: X on, Threads and Bluesky off, sub-toggles on', () => {
  const config = BondPlatforms.getConfig({});
  assert.equal(config.x.enabled, true);
  assert.equal(config.threads.enabled, false);
  assert.equal(config.bluesky.enabled, false);
  for (const id of ['x', 'threads', 'bluesky']) {
    assert.equal(config[id].timeline, true, `${id} timeline default`);
    assert.equal(config[id].dms, true, `${id} dms default`);
  }

  const storedDefaults = DEFAULT_SETTINGS.platforms;
  assert.deepEqual(storedDefaults, BOND_PLATFORM_DEFAULTS);
});

test('Platform gating: master switch gates timeline and DM sub-toggles', () => {
  // Defaults: Threads off, so both features are gated even though sub-toggles are on.
  assert.equal(BondPlatforms.isEnabled({}, 'threads'), false);
  assert.equal(BondPlatforms.isFeatureEnabled({}, 'threads', 'timeline'), false);
  assert.equal(BondPlatforms.isFeatureEnabled({}, 'threads', 'dms'), false);

  const enabled = BondPlatforms.patchSettings({}, 'threads', { enabled: true });
  assert.equal(BondPlatforms.isFeatureEnabled(enabled, 'threads', 'timeline'), true);
  assert.equal(BondPlatforms.isFeatureEnabled(enabled, 'threads', 'dms'), true);

  const timelineOnly = BondPlatforms.patchSettings(enabled, 'threads', { dms: false });
  assert.equal(BondPlatforms.isFeatureEnabled(timelineOnly, 'threads', 'timeline'), true);
  assert.equal(BondPlatforms.isFeatureEnabled(timelineOnly, 'threads', 'dms'), false);

  const allOff = BondPlatforms.patchSettings(timelineOnly, 'threads', { enabled: false });
  assert.equal(BondPlatforms.isFeatureEnabled(allOff, 'threads', 'timeline'), false);
  assert.equal(BondPlatforms.isFeatureEnabled(allOff, 'threads', 'dms'), false);

  // X stays enabled throughout and sibling platforms are preserved.
  assert.equal(BondPlatforms.isEnabled(allOff, 'x'), true);
  assert.equal(BondPlatforms.describe(allOff, 'threads'), 'Off');
  assert.equal(BondPlatforms.describe(allOff, 'x'), 'On · Timeline + DMs');
});

test('Platform detection and handle normalisation', () => {
  assert.equal(BondPlatforms.detect('x.com').id, 'x');
  assert.equal(BondPlatforms.detect('twitter.com').id, 'x');
  assert.equal(BondPlatforms.detect('www.threads.net').id, 'threads');
  assert.equal(BondPlatforms.detect('threads.net').id, 'threads');
  assert.equal(BondPlatforms.detect('bsky.app').id, 'bluesky');
  assert.equal(BondPlatforms.detect('example.com').id, 'x');

  assert.equal(BondPlatforms.normalizeHandle('@Alice'), 'alice');
  assert.equal(BondPlatforms.normalizeHandle('https://bsky.app/profile/Alice.BSKY.social'), 'alice.bsky.social');
  assert.equal(BondPlatforms.profileUrl('threads', '@alice'), 'https://www.threads.net/@alice');
  assert.equal(BondPlatforms.profileUrl('bluesky', 'alice.bsky.social'), 'https://bsky.app/profile/alice.bsky.social');
  assert.equal(BondPlatforms.profileUrl('x', '@alice'), 'https://x.com/alice');
});

test('Storage isolates platform records for the same handle and account', async () => {
  const store = installChromeMock();
  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('tester');

  storage.setActivePlatform('x');
  await storage.saveUser('alice', { currentScore: 10, note: 'X record' });

  storage.setActivePlatform('threads');
  await storage.saveUser('alice', { currentScore: 90, note: 'Threads record' });

  // Legacy X key layout is preserved; non-X gets the p:<platform>: segment.
  assert.ok(store['acc:tester:user:alice']);
  assert.ok(store['acc:tester:p:threads:user:alice']);

  const xUser = await storage.getUser('alice', true, null, 'x');
  const threadUser = await storage.getUser('alice', true, null, 'threads');
  assert.equal(xUser.currentScore, 10);
  assert.equal(xUser.platform, 'x');
  assert.equal(threadUser.currentScore, 90);
  assert.equal(threadUser.platform, 'threads');

  // Filtered listings never bleed across platforms.
  const xOnly = await storage.getAllUsers('tester', 'x');
  const threadsOnly = await storage.getAllUsers('tester', 'threads');
  assert.deepEqual(xOnly.map((u) => u.handle), ['alice']);
  assert.deepEqual(threadsOnly.map((u) => u.handle), ['alice']);
  assert.equal(xOnly[0].currentScore, 10);
  assert.equal(threadsOnly[0].currentScore, 90);
});

test('DM ledger stores metadata only and never message bodies', async () => {
  const store = installChromeMock();
  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('tester');
  storage.setActivePlatform('x');

  const secret = 'SUPER_SECRET_DM_BODY_42';
  await storage.recordDmMessage('123-alice', {
    direction: 'inbound',
    senderHandle: 'alice',
    recipientHandle: 'tester',
    textSnippet: secret,
    timestamp: Date.now() - 60000
  });

  // Give the fire-and-forget CRM event write time to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const conv = await storage.getDmConversation('123-alice', true, null, 'x');
  assert.equal(conv.receivedCount, 1);
  assert.equal(conv.platform, 'x');
  assert.equal(conv.textSnippet, undefined);

  const persisted = JSON.stringify(store);
  assert.equal(persisted.includes(secret), false, 'message body must never be persisted');
});

test('DM conversations are platform-scoped and isolated', async () => {
  const store = installChromeMock();
  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('tester');

  storage.setActivePlatform('x');
  await storage.recordDmMessage('42-alice', {
    direction: 'inbound',
    senderHandle: 'alice',
    recipientHandle: 'tester',
    timestamp: Date.now() - 120000
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  storage.setActivePlatform('threads');
  await storage.recordDmMessage('42-alice', {
    direction: 'outbound',
    senderHandle: 'tester',
    recipientHandle: 'alice',
    timestamp: Date.now() - 60000
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(store['acc:tester:dm:42-alice']);
  assert.ok(store['acc:tester:p:threads:dm:42-alice']);

  const xConv = await storage.getDmConversation('42-alice', true, null, 'x');
  const threadConv = await storage.getDmConversation('42-alice', true, null, 'threads');
  assert.equal(xConv.platform, 'x');
  assert.equal(xConv.receivedCount, 1);
  assert.equal(xConv.sentCount, 0);
  assert.equal(threadConv.platform, 'threads');
  assert.equal(threadConv.sentCount, 1);
  assert.equal(threadConv.receivedCount, 0);

  const xDms = await storage.getAllDmConversations('tester', 'x');
  const threadDms = await storage.getAllDmConversations('tester', 'threads');
  assert.equal(xDms.length, 1);
  assert.equal(threadDms.length, 1);
  assert.equal(xDms[0].receivedCount, 1);
  assert.equal(threadDms[0].sentCount, 1);
});

test('Group energy taxonomy matches v1.4.0 thresholds', () => {
  assert.equal(GroupEnergyLevels.ENERGETIC.minScore, 80);
  assert.equal(GroupEnergyLevels.ACTIVE.minScore, 60);
  assert.equal(GroupEnergyLevels.STEADY.minScore, 40);
  assert.equal(GroupEnergyLevels.CHILL.minScore, 20);
  assert.equal(GroupEnergyLevels.DYING.minScore, 0);

  assert.equal(BondScoring.getGroupEnergyLevel(95).id, 'energetic');
  assert.equal(BondScoring.getGroupEnergyLevel(80).id, 'energetic');
  assert.equal(BondScoring.getGroupEnergyLevel(79).id, 'active');
  assert.equal(BondScoring.getGroupEnergyLevel(60).id, 'active');
  assert.equal(BondScoring.getGroupEnergyLevel(59).id, 'steady');
  assert.equal(BondScoring.getGroupEnergyLevel(40).id, 'steady');
  assert.equal(BondScoring.getGroupEnergyLevel(39).id, 'chill');
  assert.equal(BondScoring.getGroupEnergyLevel(20).id, 'chill');
  assert.equal(BondScoring.getGroupEnergyLevel(19).id, 'dying');
  assert.equal(BondScoring.getGroupEnergyLevel(0).id, 'dying');
});

test('classifyRelationship covers supporter, outbound, balanced and dormant bonds', () => {
  const now = Date.now();
  const day = 86400000;

  assert.equal(BondScoring.classifyRelationship(0, 0, 0, 0).id, 'new');
  assert.equal(BondScoring.classifyRelationship(1, 1, 1, now).id, 'new');

  const supporter = BondScoring.classifyRelationship(60, 5, 40, now - day);
  assert.equal(supporter.id, 'top_supporter');
  assert.equal(supporter.emoji, '🌟');

  const outbound = BondScoring.classifyRelationship(60, 40, 5, now - day);
  assert.equal(outbound.id, 'outbound_focus');
  assert.equal(outbound.emoji, '🎯');

  const balanced = BondScoring.classifyRelationship(60, 20, 25, now - day);
  assert.equal(balanced.id, 'balanced');
  assert.equal(balanced.emoji, '⚖️');

  const dormant = BondScoring.classifyRelationship(60, 20, 20, now - 20 * day);
  assert.equal(dormant.id, 'dormant');
  assert.equal(dormant.emoji, '❄️');
  assert.ok(dormant.subLabel.includes('20d'));
});
