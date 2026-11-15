const test = require('node:test');
const assert = require('node:assert/strict');

const { BondScoring, BondTiers, DmRanks, GroupEnergyLevels } = require('../core/scoring.js');
const { BondStorage, DEFAULT_SETTINGS } = require('../core/storage.js');

test('DmRanks correctly classifies 1:1 DM scores into progressive relationship levels', () => {
  assert.equal(BondScoring.getDmRank(10).id, 'acquaintance');
  assert.equal(BondScoring.getDmRank(25).id, 'acquaintance');
  assert.equal(BondScoring.getDmRank(26).id, 'friend');
  assert.equal(BondScoring.getDmRank(50).id, 'friend');
  assert.equal(BondScoring.getDmRank(51).id, 'close_friend');
  assert.equal(BondScoring.getDmRank(75).id, 'close_friend');
  assert.equal(BondScoring.getDmRank(76).id, 'bestie');
  assert.equal(BondScoring.getDmRank(90).id, 'bestie');
  assert.equal(BondScoring.getDmRank(91).id, 'ride_or_die');
  assert.equal(BondScoring.getDmRank(100).id, 'ride_or_die');
});

test('calculateDmMetrics calculates volume, balance, speed factor, and ranks', () => {
  const now = Date.now();
  const balancedConv = {
    sentCount: 30,
    receivedCount: 30,
    lastSentTimestamp: now - 1000 * 60 * 10, // 10 mins ago
    lastReceivedTimestamp: now - 1000 * 60 * 30, // 30 mins ago
    lastMessageTimestamp: now - 1000 * 60 * 10,
    replyTimes: [1000 * 60 * 5, 1000 * 60 * 8, 1000 * 60 * 12], // ~8 mins median
    dailyStreak: 5
  };

  const metrics = BondScoring.calculateDmMetrics(balancedConv, { fadingThresholdDays: 3 });

  assert.equal(metrics.totalCount, 60);
  assert.equal(metrics.sentPercent, 50);
  assert.equal(metrics.receivedPercent, 50);
  assert.equal(metrics.balanceRatio, 1.0);
  assert.equal(metrics.waitingForUserReply, false);
  assert.ok(metrics.speedFactor >= 1.08, 'Fast median reply should have speed bonus');
  assert.ok(metrics.bondScore >= 75, `Expected high bond score for balanced active streak chat, got ${metrics.bondScore}`);
  assert.ok(['bestie', 'ride_or_die'].includes(metrics.rank.id));
  assert.equal(metrics.isFading, false);
});

test('calculateDmMetrics flags inbound messages waiting for user reply', () => {
  const now = Date.now();
  const waitingConv = {
    sentCount: 10,
    receivedCount: 15,
    lastSentTimestamp: now - 1000 * 60 * 60 * 5, // 5 hours ago
    lastReceivedTimestamp: now - 1000 * 60 * 45, // 45 mins ago
    lastMessageTimestamp: now - 1000 * 60 * 45,
    replyTimes: [1000 * 60 * 20]
  };

  const metrics = BondScoring.calculateDmMetrics(waitingConv);

  assert.equal(metrics.waitingForUserReply, true);
  assert.ok(metrics.waitingDurationMs >= 1000 * 60 * 44);
  assert.ok(metrics.formattedWaitingDuration.includes('m') || metrics.formattedWaitingDuration.includes('h'));
});

test('calculateDmMetrics triggers fading warning when high bond chat goes quiet', () => {
  const now = Date.now();
  const msInDay = 86400000;
  const quietConv = {
    sentCount: 40,
    receivedCount: 40,
    lastSentTimestamp: now - 6 * msInDay, // 6 days ago
    lastReceivedTimestamp: now - 6 * msInDay,
    lastMessageTimestamp: now - 6 * msInDay,
    replyTimes: [1000 * 60 * 10],
    dailyStreak: 0
  };

  const metrics = BondScoring.calculateDmMetrics(quietConv, { fadingThresholdDays: 3 });

  assert.ok(metrics.daysSinceLast >= 5);
  assert.equal(metrics.isFading, true, 'Should trigger isFading after 6 days of silence on high bond chat');
  assert.equal(metrics.isCoolingCandidate, true);
});

test('GroupEnergyLevels and calculateGroupEnergy measure group chat vitality', () => {
  const now = Date.now();
  const activeGroup = {
    totalMessages: 150,
    recentMessages3d: 45,
    recentMessages7d: 80,
    lastMessageTimestamp: now - 1000 * 60 * 15, // 15 mins ago
    memberMessageCounts: {
      userA: 40,
      userB: 35,
      userC: 30,
      userD: 25,
      userE: 20
    }
  };

  const energy = BondScoring.calculateGroupEnergy(activeGroup);

  assert.ok(energy.energyScore >= 75, `Expected high energy score for buzzing group, got ${energy.energyScore}`);
  assert.ok(['buzzing', 'active'].includes(energy.energyLevel.id));
  assert.equal(energy.isDying, false);
  assert.equal(energy.activeMembers.length, 5);
  assert.equal(energy.activeMembers[0].handle, 'userA');

  // Inactive group
  const msInDay = 86400000;
  const deadGroup = {
    totalMessages: 10,
    recentMessages3d: 0,
    recentMessages7d: 0,
    lastMessageTimestamp: now - 25 * msInDay,
    memberMessageCounts: { userA: 10 }
  };

  const deadEnergy = BondScoring.calculateGroupEnergy(deadGroup);
  assert.ok(deadEnergy.energyScore <= 20);
  assert.equal(deadEnergy.isDying, true);
  assert.equal(deadEnergy.energyLevel.id, 'inactive');
});

test('calculateCombinedRelationship combines public and DM bond scores with synergy', () => {
  const publicUser = { currentScore: 70 };
  const dmConv = { bondScore: 80, totalCount: 40 };

  const combined = BondScoring.calculateCombinedRelationship(publicUser, dmConv, { dmScoreWeightPercent: 50 });

  assert.equal(combined.hasDm, true);
  assert.equal(combined.synergy, true);
  // (70 * 0.5) + (80 * 0.5) = 75 + 8 synergy = 83
  assert.equal(combined.combinedScore, 83);
  assert.ok(combined.label.includes('Mutual') || combined.label.includes('Bestie'));

  // Public only (no DMs)
  const publicOnly = BondScoring.calculateCombinedRelationship(publicUser, null);
  assert.equal(publicOnly.hasDm, false);
  assert.equal(publicOnly.combinedScore, 70);
});

test('BondStorage handles DM conversation storage, recording, and querying', async () => {
  // Set up mock chrome.storage.local
  const mockStore = {};
  global.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          if (!keys) return cb(Object.assign({}, mockStore));
          const res = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach(k => {
            if (mockStore[k] !== undefined) res[k] = mockStore[k];
          });
          cb(res);
        },
        set(items, cb) {
          Object.assign(mockStore, items);
          if (cb) cb();
        }
      },
      onChanged: {
        addListener() {}
      }
    },
    runtime: {
      lastError: null
    }
  };

  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('masertest');

  const now = Date.now();

  // 1. Record inbound DM from alice
  await storage.recordDmMessage('123-alice', {
    direction: 'inbound',
    senderHandle: 'alice',
    recipientHandle: 'masertest',
    textSnippet: 'Hey Maser! How is the new release?',
    timestamp: now - 1000 * 60 * 30, // 30 mins ago
    displayName: 'Alice Cooper',
    avatarUrl: 'https://example.com/alice.jpg'
  });

  let conv = await storage.getDmConversation('123-alice');
  assert.ok(conv);
  assert.equal(conv.receivedCount, 1);
  assert.equal(conv.sentCount, 0);
  assert.equal(conv.waitingForUserReply, true);

  // 2. User replies (outbound)
  await storage.recordDmMessage('123-alice', {
    direction: 'outbound',
    senderHandle: 'masertest',
    recipientHandle: 'alice',
    textSnippet: 'It is amazing! Shipping DMs today!',
    timestamp: now - 1000 * 60 * 10 // 10 mins ago
  });

  conv = await storage.getDmConversation('123-alice');
  assert.equal(conv.sentCount, 1);
  assert.equal(conv.receivedCount, 1);
  assert.equal(conv.waitingForUserReply, false);
  assert.ok(conv.replyTimes.length === 1);
  assert.equal(conv.replyTimes[0], 1000 * 60 * 20); // 20 mins turnaround

  // 3. Waiting for reply list
  // Record another inbound message from bob
  await storage.recordDmMessage('456-bob', {
    direction: 'inbound',
    senderHandle: 'bob',
    recipientHandle: 'masertest',
    textSnippet: 'Yo, check this out',
    timestamp: now - 1000 * 60 * 15
  });

  const waitingList = await storage.getWaitingForReply();
  assert.equal(waitingList.length, 1);
  assert.equal(waitingList[0].convId, '456-bob');

  // 4. Closest friends & group chats
  const closest = await storage.getTopClosestFriends();
  assert.ok(closest.length >= 1);
});

test('Chat Memories & Lifetime History: retains permanent memories and never resets to 0 after restart or 2-day gap', async () => {
  const mockStore = {};
  global.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          if (!keys) return cb(Object.assign({}, mockStore));
          const res = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach(k => { if (mockStore[k] !== undefined) res[k] = mockStore[k]; });
          cb(res);
        },
        set(obj, cb) {
          Object.assign(mockStore, obj);
          if (cb) cb();
        }
      }
    }
  };

  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('masertest');

  const now = Date.now();
  const msInDay = 86400000;

  // 1. Ingest batch messages for alice
  const entries = [
    { fingerprint: 'alice_msg_1', direction: 'inbound', text: 'Hey there!', timestamp: now - 2 * msInDay },
    { fingerprint: 'alice_msg_2', direction: 'outbound', text: 'Hello Alice! How are you?', timestamp: now - 2 * msInDay + 60000 },
    { fingerprint: 'alice_msg_3', direction: 'inbound', text: 'Working on code!', timestamp: now - msInDay },
    { fingerprint: 'alice_msg_4', direction: 'outbound', text: 'Same here, building BondScore!', timestamp: now - msInDay + 120000 }
  ];

  await storage.ingestMessageEntries('alice', entries);

  let conv = await storage.getDmConversation('alice');
  assert.ok(conv, 'Conversation should exist');
  assert.equal(conv.lifetimeTotal, 4);
  assert.equal(conv.lifetimeSent, 2);
  assert.equal(conv.lifetimeReceived, 2);
  assert.ok(conv.bondScore > 0, `Expected bondScore > 0, got ${conv.bondScore}`);
  assert.ok(conv.memories.length >= 1, 'Should have initial first_seen memory');

  // 2. Simulate page refresh / new session: re-instantiate BondStorage
  const freshStorage = new BondStorage();
  await freshStorage.init();
  await freshStorage.switchAccount('masertest');

  // Verify conversation is NOT 0 after refresh / restart
  const reloadedConv = await freshStorage.getDmConversation('alice');
  assert.ok(reloadedConv, 'Should find conversation after refresh');
  assert.equal(reloadedConv.lifetimeTotal, 4, 'Lifetime total must not reset to 0');
  assert.equal(reloadedConv.lifetimeSent, 2);
  assert.equal(reloadedConv.lifetimeReceived, 2);
  assert.ok(reloadedConv.bondScore > 0, 'Bond score must not drop to 0');

  // 3. Ingest same entries again (simulating re-reading same DOM thread)
  await freshStorage.ingestMessageEntries('alice', entries);
  const deduplicatedConv = await freshStorage.getDmConversation('alice');
  assert.equal(deduplicatedConv.lifetimeTotal, 4, 'Deduplication must prevent double-counting same messages');

  // 4. Ingest enough messages to cross volume milestone (10 messages)
  const moreEntries = [];
  for (let i = 5; i <= 12; i++) {
    moreEntries.push({
      fingerprint: `alice_msg_${i}`,
      direction: i % 2 === 0 ? 'outbound' : 'inbound',
      text: `Exchange number ${i}`,
      timestamp: now - 1000 * 60 * (15 - i)
    });
  }
  await freshStorage.ingestMessageEntries('alice', moreEntries);

  const milestoneConv = await freshStorage.getDmConversation('alice');
  assert.equal(milestoneConv.lifetimeTotal, 12);
  assert.ok(milestoneConv.memories.some(m => m.type === 'volume' && m.milestoneValue === 10), 'Should have 10-message milestone');

  // 5. Test Chat Memories query
  const memories = await freshStorage.getChatMemories('alice');
  assert.ok(memories);
  assert.equal(memories.lifetimeTotal, 12);
  assert.ok(memories.memories.length >= 2);

  // 6. Test 2-day gap: score must not be 0 due to 3-day grace period
  const metricsAfter2Days = BondScoring.calculateDmMetrics({
    ...milestoneConv,
    lastMessageTimestamp: now - (2 * msInDay) // 2 days ago
  });
  assert.ok(metricsAfter2Days.bondScore >= 20, `Score after 2 days should remain strong, got ${metricsAfter2Days.bondScore}`);
  assert.notEqual(metricsAfter2Days.rank.id, null);
});

test('X Group Chat Registration & Energy Tracking (/i/chat/g... layout)', async () => {
  const mockStore = {};
  global.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          if (!keys) return cb(Object.assign({}, mockStore));
          const res = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach(k => { if (mockStore[k] !== undefined) res[k] = mockStore[k]; });
          cb(res);
        },
        set(obj, cb) {
          Object.assign(mockStore, obj);
          if (cb) cb();
        }
      }
    }
  };

  const storage = new BondStorage();
  await storage.init();
  await storage.switchAccount('masersuspended');

  const now = Date.now();
  const gcId = 'g2119410785122472214';
  const groupTitle = "kurisu's experiment rats";

  // 1. Ingest thread messages from group chat
  const entries = [
    { fingerprint: `${gcId}_1`, direction: 'inbound', senderHandle: 'kurisu', text: 'Took some vintage art', timestamp: now - 300000 },
    { fingerprint: `${gcId}_2`, direction: 'inbound', senderHandle: 'tozo', text: 'looks awesome!', timestamp: now - 200000 },
    { fingerprint: `${gcId}_3`, direction: 'outbound', text: 'sure?', timestamp: now - 100000 },
    { fingerprint: `${gcId}_4`, direction: 'inbound', senderHandle: 'tanhero', text: 'Will post than see', timestamp: now - 50000 }
  ];

  await storage.ingestMessageEntries(gcId, entries, 'masersuspended', 'x', {
    isGroup: true,
    groupTitle
  });

  // Verify conversation is registered as a group chat with proper title and participants
  const conv = await storage.getDmConversation(gcId, false, 'masersuspended');
  assert.ok(conv, 'Group conversation must be registered');
  assert.equal(conv.convId, gcId);
  assert.equal(conv.isGroup, true, 'isGroup must be true for g-prefixed group ID');
  assert.equal(conv.title, groupTitle);
  assert.equal(conv.totalCount, 4);
  assert.equal(conv.sentCount, 1);
  assert.equal(conv.receivedCount, 3);
  assert.ok(conv.participants.includes('kurisu'));
  assert.ok(conv.participants.includes('tozo'));
  assert.ok(conv.participants.includes('tanhero'));

  // 2. Outgoing group message via recordDmMessage
  await storage.recordDmMessage(gcId, {
    direction: 'outbound',
    senderHandle: 'masersuspended',
    textSnippet: 'Let us go!',
    timestamp: now,
    isGroup: true,
    groupTitle,
    platform: 'x'
  }, 'masersuspended');

  const updatedConv = await storage.getDmConversation(gcId, false, 'masersuspended');
  assert.equal(updatedConv.sentCount, 2);
  assert.equal(updatedConv.totalCount, 5);

  // 3. Test getGroupChats query
  const groups = await storage.getGroupChats('masersuspended');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].convId, gcId);
  assert.equal(groups[0].title, groupTitle);
  assert.ok(groups[0].groupEnergyScore > 0, `Expected group energy score > 0, got ${groups[0].groupEnergyScore}`);
  assert.ok(groups[0].groupEnergyLevel, 'Group energy level must be populated');

  // 4. Test getAllDmConversations returns the group
  const allDms = await storage.getAllDmConversations('masersuspended');
  assert.equal(allDms.length, 1);
  assert.equal(allDms[0].isGroup, true);
});

