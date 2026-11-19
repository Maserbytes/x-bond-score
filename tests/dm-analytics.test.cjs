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
    recentMessages20h: 55,
    recentMessages1h: 4,
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

  assert.equal(energy.energyLevel.id, 'energetic');
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
  assert.equal(deadEnergy.energyLevel.id, 'dying');

  // Strict activity gates: 21+ in 20h = active, 50+ = energetic, 99+ in 1h = hyperactive.
  const base = { totalMessages: 150, lastMessageTimestamp: now, memberMessageCounts: { a: 5 } };
  assert.equal(BondScoring.calculateGroupEnergy(Object.assign({}, base, { recentMessages20h: 20, recentMessages1h: 2 })).energyLevel.id, 'dying');
  const lowActive = BondScoring.calculateGroupEnergy(Object.assign({}, base, { recentMessages20h: 21, recentMessages1h: 2 }));
  const highActive = BondScoring.calculateGroupEnergy(Object.assign({}, base, { recentMessages20h: 49, recentMessages1h: 2 }));
  assert.equal(lowActive.energyLevel.id, 'active');
  assert.ok(highActive.energyScore > lowActive.energyScore, 'more messages in the same tier should raise the score');
  assert.equal(BondScoring.calculateGroupEnergy(Object.assign({}, base, { recentMessages20h: 50, recentMessages1h: 5 })).energyLevel.id, 'energetic');
  assert.equal(BondScoring.calculateGroupEnergy(Object.assign({}, base, { recentMessages20h: 60, recentMessages1h: 99 })).energyLevel.id, 'hyperactive');

  // Active group chats with different message counts must have distinct scores scaling with volume sent
  const group25Msgs = BondScoring.calculateGroupEnergy({
    totalMessages: 25,
    recentMessages20h: 21,
    recentMessages1h: 0,
    lastMessageTimestamp: now - 1000 * 60 * 120, // 2h ago
    memberMessageCounts: { a: 15, b: 10 }
  });
  const group150Msgs = BondScoring.calculateGroupEnergy({
    totalMessages: 150,
    recentMessages20h: 28,
    recentMessages1h: 3,
    lastMessageTimestamp: now - 1000 * 60 * 20, // 20m ago
    memberMessageCounts: { a: 70, b: 50, c: 30 }
  });
  const group600Msgs = BondScoring.calculateGroupEnergy({
    totalMessages: 600,
    recentMessages20h: 42,
    recentMessages1h: 6,
    lastMessageTimestamp: now - 1000 * 60 * 5, // 5m ago
    memberMessageCounts: { a: 300, b: 200, c: 100 }
  });

  assert.equal(group25Msgs.energyLevel.id, 'active');
  assert.equal(group150Msgs.energyLevel.id, 'active');
  assert.equal(group600Msgs.energyLevel.id, 'active');
  assert.ok(group25Msgs.energyScore >= 60 && group25Msgs.energyScore < group150Msgs.energyScore, 'higher message volume must raise active GC score');
  assert.ok(group150Msgs.energyScore < group600Msgs.energyScore, 'higher message volume and velocity must scale GC score higher');
  assert.ok(new Set([group25Msgs.energyScore, group150Msgs.energyScore, group600Msgs.energyScore]).size === 3, 'all active group chats must have distinct scores');

  // Thresholds are configurable through settings.
  const custom = BondScoring.calculateGroupEnergy(
    Object.assign({}, base, { recentMessages20h: 12, recentMessages1h: 1 }),
    { groupActivity: { activeMin: 10, energeticMin: 20, hyperactiveMin: 50 } }
  );
  assert.equal(custom.energyLevel.id, 'active');
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

test('Inbound notification likes and replies count as received engagement', () => {
  const now = Date.now();
  const events = [
    { type: 'like', direction: 'inbound', timestamp: now - 1000, tweetId: 'notif_a', isMutual: true },
    { type: 'reply_received', direction: 'inbound', timestamp: now - 2000, tweetId: 'notif_b', isMutual: true },
    { type: 'like', direction: 'outbound', timestamp: now - 3000, tweetId: 'out_a' }
  ];
  const scored = BondScoring.calculateUserScore(events, DEFAULT_SETTINGS, 0, 0);
  assert.equal(scored.crmStatus.id, 'mutuals');
  assert.ok(scored.score > 10);

  const outboundOnly = BondScoring.calculateUserScore([
    { type: 'like', direction: 'outbound', timestamp: now - 1000, tweetId: 'out_b' },
    { type: 'like', direction: 'outbound', timestamp: now - 2000, tweetId: 'out_c' }
  ], DEFAULT_SETTINGS, 0, 0);
  assert.equal(outboundOnly.crmStatus.id, 'one_sided');

  // Even when you engage much more, two inbound replies still make it mutual.
  const skewed = [];
  for (let i = 0; i < 10; i++) skewed.push({ type: 'like', direction: 'outbound', timestamp: now - i * 1000, tweetId: `out_${i}` });
  skewed.push({ type: 'like', direction: 'inbound', timestamp: now, tweetId: 'in_a', isMutual: true });
  skewed.push({ type: 'reply_received', direction: 'inbound', timestamp: now, tweetId: 'in_b', isMutual: true });
  assert.ok(['mutuals', 'besties'].includes(BondScoring.calculateUserScore(skewed, DEFAULT_SETTINGS, 0, 0).crmStatus.id));
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

test('DM conversation mutual resolution: auto-repairs numeric conversation IDs and preview snippets, purges self from participants', async () => {
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

  // 1. Seed known mutual user in storage
  await storage.saveUser('greyratclips', {
    handle: 'greyratclips',
    displayName: 'Greyrat',
    avatarUrl: 'https://pbs.twimg.com/profile_images/greyrat.jpg'
  }, 'masersuspended');

  // 2. Save a corrupted conversation where title is a raw numeric snowflake ID and participants includes masersuspended
  await storage.saveDmConversation('1834259027947311104-1884130058983378944', {
    title: '1834259027947311104-1884130058983378944',
    participants: ['masersuspended', 'greyratclips'],
    participantDetails: {
      masersuspended: { handle: 'masersuspended', displayName: 'Maser', avatarUrl: 'https://pbs.twimg.com/maser.jpg' },
      greyratclips: { handle: 'greyratclips', displayName: 'Greyrat', avatarUrl: 'https://pbs.twimg.com/profile_images/greyrat.jpg' }
    },
    sentCount: 2,
    receivedCount: 2,
    totalCount: 4,
    bondScore: 35
  }, 'masersuspended');

  // 3. Save a conversation where title is a reaction snippet like 'You reacted 😲 to "I know i mess...'
  await storage.saveDmConversation('tozoconv', {
    title: 'You reacted 😲 to "I know i mess...',
    participants: ['masersuspended', 'tozo'],
    participantDetails: {
      tozo: { handle: 'tozo', displayName: 'Tozo The Dev', avatarUrl: 'https://pbs.twimg.com/tozo.jpg' }
    },
    sentCount: 1,
    receivedCount: 1,
    totalCount: 2,
    bondScore: 20
  }, 'masersuspended');

  // 4. Retrieve all DM conversations: getAllDmConversations must auto-repair both
  const allConvs = await storage.getAllDmConversations('masersuspended');
  assert.equal(allConvs.length, 2);

  const conv1 = allConvs.find(c => c.convId === '1834259027947311104-1884130058983378944');
  assert.ok(conv1);
  assert.notEqual(conv1.title, '1834259027947311104-1884130058983378944', 'Raw numeric title must be repaired');
  assert.equal(conv1.title, 'Greyrat', 'Title must resolve to mutual display name');
  assert.ok(!conv1.participants.includes('masersuspended'), 'Signed-in user must be purged from 1:1 participants');
  assert.deepEqual(conv1.participants, ['greyratclips']);

  const conv2 = allConvs.find(c => c.convId === 'tozoconv');
  assert.ok(conv2);
  assert.notEqual(conv2.title, 'You reacted 😲 to "I know i mess...', 'Reaction preview snippet must be repaired');
  assert.equal(conv2.title, 'Tozo The Dev', 'Title must resolve to mutual name');
  assert.deepEqual(conv2.participants, ['tozo']);
});

test('Strict non-follower classification: non-followers (theyFollowYou === false) are NEVER tagged as Mutuals or Besties even with high engagement', () => {
  const now = Date.now();
  // Case A: High score (>=65) and 2-way engagement with a non-follower
  const highEvents = [
    { type: 'reply_received', direction: 'inbound', timestamp: now - 1000, tweetId: 'in_1' },
    { type: 'reply_sent', direction: 'outbound', timestamp: now - 2000, tweetId: 'out_1' },
    { type: 'reply_received', direction: 'inbound', timestamp: now - 3000, tweetId: 'in_2' },
    { type: 'reply_sent', direction: 'outbound', timestamp: now - 4000, tweetId: 'out_2' },
    { type: 'dm_received', direction: 'inbound', timestamp: now - 5000, tweetId: 'dm_in_1' },
    { type: 'dm_sent', direction: 'outbound', timestamp: now - 6000, tweetId: 'dm_out_1' }
  ];

  // With confirmed mutual signals -> Besties
  const mutualScore = BondScoring.calculateUserScore(highEvents, DEFAULT_SETTINGS, 0, 0, { theyFollowYou: true, youFollowThem: true, isMutual: true });
  assert.equal(mutualScore.crmStatus.id, 'besties');

  // With non-follower signal -> MUST BE Conversant, NEVER Mutuals or Besties
  const nonFollowerScore = BondScoring.calculateUserScore(highEvents, DEFAULT_SETTINGS, 0, 0, { theyFollowYou: false, youFollowThem: true });
  assert.equal(nonFollowerScore.crmStatus.id, 'conversant');
  assert.notEqual(nonFollowerScore.crmStatus.id, 'mutuals');
  assert.notEqual(nonFollowerScore.crmStatus.id, 'besties');

  // Case B: Inbound replies only from a non-follower
  const inboundOnly = [
    { type: 'reply_received', direction: 'inbound', timestamp: now - 1000, tweetId: 'in_3' },
    { type: 'like', direction: 'inbound', timestamp: now - 2000, tweetId: 'in_4' }
  ];
  const supporterScore = BondScoring.calculateUserScore(inboundOnly, DEFAULT_SETTINGS, 0, 0, { theyFollowYou: false });
  assert.equal(supporterScore.crmStatus.id, 'supporter');
  assert.notEqual(supporterScore.crmStatus.id, 'mutuals');
});

test('Notification interactions: distinct likes, replies, and reposts from /notifications center consistently increment scores and stats without collision', async () => {
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

  // 1. First like from notification center for @bob on tweet 1001
  const bob1 = await storage.recordInteraction('bob', {
    type: 'like',
    direction: 'inbound',
    tweetId: 'notif_x_like_bob_1001',
    timestamp: now - 10000,
    isMutual: false
  }, 'masertest');

  assert.ok(bob1);
  const score1 = bob1.currentScore;
  assert.ok(score1 > 0, `Initial score should be > 0, got ${score1}`);
  assert.equal(bob1.stats.likesReceived, 1);

  // 2. Second like from notification center for @bob on tweet 1002 (must NOT be dropped!)
  const bob2 = await storage.recordInteraction('bob', {
    type: 'like',
    direction: 'inbound',
    tweetId: 'notif_x_like_bob_1002',
    timestamp: now - 5000,
    isMutual: false
  }, 'masertest');

  assert.ok(bob2.currentScore > score1, `Second notification like must increment score from ${score1}, got ${bob2.currentScore}`);
  assert.equal(bob2.stats.likesReceived, 2, 'likesReceived must increment to 2');

  // 3. A reply from @bob on tweet 1003
  const bob3 = await storage.recordInteraction('bob', {
    type: 'reply_received',
    direction: 'inbound',
    tweetId: 'notif_x_reply_received_bob_1003',
    timestamp: now - 1000,
    isMutual: false
  }, 'masertest');

  assert.ok(bob3.currentScore > bob2.currentScore, `Reply notification must further increment score from ${bob2.currentScore}, got ${bob3.currentScore}`);
  assert.equal(bob3.stats.repliesReceived, 1);

  // 4. A repost from @bob on tweet 1004
  const bob4 = await storage.recordInteraction('bob', {
    type: 'repost',
    direction: 'inbound',
    tweetId: 'notif_x_repost_bob_1004',
    timestamp: now,
    isMutual: false
  }, 'masertest');

  assert.ok(bob4.currentScore > bob3.currentScore, `Repost notification must further increment score from ${bob3.currentScore}, got ${bob4.currentScore}`);
  assert.equal(bob4.stats.repostsReceived, 1);
});
