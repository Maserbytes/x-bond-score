/**
 * BondScore for X - Service Worker (Background)
 * Manages daily time-decay recalculations and extension lifecycle.
 */

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[BondScore] Extension installed/updated:', details.reason);

  // Set default settings if not already present
  chrome.storage.local.get(['settings'], (res) => {
    if (!res.settings) {
      chrome.storage.local.set({
        settings: {
          decayHalfLifeDays: 14,
          gracePeriodDays: 2,
          weights: {
            mutualReply: 15,
            replySent: 8,
            replyReceived: 8,
            quote: 6,
            mention: 5,
            like: 2,
            deepSyncExchange: 10
          },
          showBadgesOnTimeline: true,
          showBadgesOnProfiles: true,
          showBadgesOnReplies: true,
          showStreaks: true,
          badgeStyle: 'subtle',
          minScoreToShowBadge: 1
        }
      });
    }
  });

  // Schedule periodic decay check every 12 hours
  if (chrome.alarms) {
    chrome.alarms.create('bondscore-decay-check', {
      periodInMinutes: 720
    });
  }
});

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'bondscore-decay-check') {
      await performDecayRecalculation();
    }
  });
}

/**
 * Recalculates time-decay for all tracked users using exact scoring parity with BondScoring
 */
async function performDecayRecalculation() {
  chrome.storage.local.get(null, async (allData) => {
    if (!allData) return;

    const settings = allData.settings || {};
    const halfLifeDays = settings.decayHalfLifeDays || 14;
    const gracePeriodDays = settings.gracePeriodDays || 2;
    const weights = Object.assign({
      mutualReply: 15,
      replySent: 8,
      replyReceived: 8,
      quote: 6,
      mention: 5,
      like: 2,
      deepSyncExchange: 10
    }, settings.weights || {});

    const lambda = Math.LN2 / halfLifeDays;
    const msInDay = 86400000;
    const now = Date.now();
    const updates = {};

    for (const [key, user] of Object.entries(allData)) {
      let isUserRecord = false;
      let eventsKey = '';

      if (key.startsWith('user:') && user && user.handle) {
        isUserRecord = true;
        eventsKey = `events:${user.handle}`;
      } else if (key.startsWith('acc:') && key.includes(':user:') && user && user.handle) {
        // Multi-account scoped keys: acc:<account>:user:<handle> -> acc:<account>:events:<handle>
        isUserRecord = true;
        eventsKey = key.replace(':user:', ':events:');
      }

      if (!isUserRecord) continue;
      const events = allData[eventsKey] || [];
      if (events.length === 0) continue;

        let accumulatedRaw = 0;
        let sentCount = 0;
        let receivedCount = 0;

        for (const evt of events) {
          let baseWeight = 0;
          switch (evt.type) {
            case 'reply_mutual':
              baseWeight = weights.mutualReply;
              sentCount++;
              receivedCount++;
              break;
            case 'reply_sent':
              baseWeight = weights.replySent;
              sentCount++;
              break;
            case 'reply_received':
              baseWeight = weights.replyReceived;
              receivedCount++;
              break;
            case 'quote':
              baseWeight = weights.quote;
              sentCount++;
              break;
            case 'mention':
              baseWeight = weights.mention;
              break;
            case 'like':
              baseWeight = weights.like;
              break;
            case 'deep_sync':
              baseWeight = weights.deepSyncExchange;
              receivedCount++;
              break;
            default:
              baseWeight = evt.weight || 2;
              break;
          }

          if (evt.isMutual) {
            baseWeight *= 1.35;
          }

          const ageMs = Math.max(0, now - evt.timestamp);
          const ageDays = ageMs / msInDay;
          const decayableDays = Math.max(0, ageDays - gracePeriodDays);
          const decayFactor = Math.exp(-lambda * decayableDays);

          accumulatedRaw += baseWeight * decayFactor;
        }

        if (sentCount > 0 && receivedCount > 0) {
          accumulatedRaw *= 1.25;
        }

        const K = 45;
        const normalized = 100 * (1 - Math.exp(-accumulatedRaw / K));
        // Preserve minimum memory floor of 1.0 so tracked mutuals are never forgotten
        const newScore = Math.round(Math.min(100, Math.max(1.0, normalized)) * 10) / 10;

        if (Math.abs(newScore - (user.currentScore || 0)) >= 0.5) {
          user.trend = newScore > user.currentScore ? 'rising' : (newScore < user.currentScore ? 'decaying' : 'steady');
          user.currentScore = newScore;
          if (newScore >= 90) user.tier = 'soulmates';
          else if (newScore >= 70) user.tier = 'close_friends';
          else if (newScore >= 40) user.tier = 'conversant';
          else if (newScore >= 15) user.tier = 'acquaintance';
          else user.tier = 'dormant';

          user.lastCalculated = now;
          updates[key] = user;
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
      console.log(`[BondScore] Periodic decay check updated ${Object.keys(updates).length} accounts.`);
    }
  });
}
