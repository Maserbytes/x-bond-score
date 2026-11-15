/**
 * BondScore for X - Scoring, Streak & Time-Decay Engine (v1.1.3)
 * Computes relationship scores, streaks, reciprocity balance, and 30-day historical trends.
 */

const BondTiers = {
  SOULMATES: {
    id: 'soulmates',
    name: 'Besties (Core Bond)',
    shortName: 'Bestie',
    crmStatus: 'Besties',
    minScore: 75,
    emoji: '💖',
    color: '#F91880', // Hot pink / emerald
    bg: 'rgba(249, 24, 128, 0.15)'
  },
  CLOSE_FRIENDS: {
    id: 'close_friends',
    name: 'Mutual Circle',
    shortName: 'Mutual',
    crmStatus: 'Mutuals',
    minScore: 45,
    emoji: '🔥',
    color: '#00BA7C', // Emerald
    bg: 'rgba(0, 186, 124, 0.15)'
  },
  CONVERSANT: {
    id: 'conversant',
    name: 'Active Acquaintance',
    shortName: 'Acquaintance',
    crmStatus: 'Acquaintance',
    minScore: 20,
    emoji: '🤝',
    color: '#1D9BF0', // Twitter blue
    bg: 'rgba(29, 155, 240, 0.15)'
  },
  ACQUAINTANCE: {
    id: 'acquaintance',
    name: 'Occasional Contact',
    shortName: 'Casual',
    crmStatus: 'Casual',
    minScore: 5,
    emoji: '👋',
    color: '#FFD400', // Twitter yellow
    bg: 'rgba(255, 212, 0, 0.15)'
  },
  DORMANT: {
    id: 'dormant',
    name: 'Stranger / Cold',
    shortName: 'Stranger',
    crmStatus: 'Stranger',
    minScore: 0,
    emoji: '👤',
    color: '#71767B', // Twitter gray
    bg: 'rgba(113, 118, 123, 0.12)'
  }
};

/**
 * 1:1 Direct Message Relationship Ranks
 * Progressive ranks: Acquaintance -> Friend -> Close Friend -> Bestie -> Ride or Die
 */
const DmRanks = {
  RIDE_OR_DIE: {
    id: 'ride_or_die',
    level: 5,
    name: 'Ride or Die',
    shortLabel: 'Ride or Die',
    emoji: '👑',
    minScore: 91,
    maxScore: 100,
    color: '#A855F7', // Royal purple / electric violet
    bg: 'rgba(168, 85, 247, 0.16)',
    border: 'rgba(168, 85, 247, 0.40)',
    glow: '0 0 12px rgba(168, 85, 247, 0.35)',
    description: 'Unbreakable bond. Constant conversations, instant replies, peak loyalty.'
  },
  BESTIE: {
    id: 'bestie',
    level: 4,
    name: 'Bestie',
    shortLabel: 'Bestie',
    emoji: '💖',
    minScore: 76,
    maxScore: 90,
    color: '#F91880', // Hot pink
    bg: 'rgba(249, 24, 128, 0.16)',
    border: 'rgba(249, 24, 128, 0.40)',
    glow: '0 0 10px rgba(249, 24, 128, 0.30)',
    description: 'Deep trusted friend. Frequent daily chats and balanced two-way exchanges.'
  },
  CLOSE_FRIEND: {
    id: 'close_friend',
    level: 3,
    name: 'Close Friend',
    shortLabel: 'Close Friend',
    emoji: '🔥',
    minScore: 51,
    maxScore: 75,
    color: '#F59E0B', // Amber flame
    bg: 'rgba(245, 158, 11, 0.16)',
    border: 'rgba(245, 158, 11, 0.40)',
    glow: '0 0 8px rgba(245, 158, 11, 0.25)',
    description: 'Strong connection with active message streaks and mutual dialogue.'
  },
  FRIEND: {
    id: 'friend',
    level: 2,
    name: 'Friend',
    shortLabel: 'Friend',
    emoji: '🤝',
    minScore: 26,
    maxScore: 50,
    color: '#38BDF8', // Sky blue
    bg: 'rgba(56, 189, 248, 0.16)',
    border: 'rgba(56, 189, 248, 0.35)',
    glow: 'none',
    description: 'Solid casual banter and regular comfortable replies.'
  },
  ACQUAINTANCE: {
    id: 'acquaintance',
    level: 1,
    name: 'Acquaintance',
    shortLabel: 'Acquaintance',
    emoji: '👋',
    minScore: 0,
    maxScore: 25,
    color: '#94A3B8', // Slate gray
    bg: 'rgba(148, 163, 184, 0.14)',
    border: 'rgba(148, 163, 184, 0.25)',
    glow: 'none',
    description: 'Occasional light DMs. Just getting to know each other.'
  }
};

/**
 * Group Chat Energy Levels
 * Measures vitality, activity rate, and member participation health
 */
const GroupEnergyLevels = {
  BUZZING: {
    id: 'buzzing',
    name: 'Buzzing',
    emoji: '⚡',
    minScore: 80,
    color: '#10B981', // Vibrant emerald
    bg: 'rgba(16, 185, 129, 0.16)',
    border: 'rgba(16, 185, 129, 0.40)',
    description: 'Chat is on fire! Messages flying and high participation.'
  },
  ACTIVE: {
    id: 'active',
    name: 'Active',
    emoji: '🔥',
    minScore: 55,
    color: '#3B82F6', // Electric blue
    bg: 'rgba(59, 130, 246, 0.16)',
    border: 'rgba(59, 130, 246, 0.35)',
    description: 'Regular energetic discussions and steady flow.'
  },
  CHILL: {
    id: 'chill',
    name: 'Chill',
    emoji: '☕',
    minScore: 30,
    color: '#F59E0B', // Warm amber
    bg: 'rgba(245, 158, 11, 0.16)',
    border: 'rgba(245, 158, 11, 0.35)',
    description: 'Casual banter at a relaxed and comfortable pace.'
  },
  COOLING: {
    id: 'cooling',
    name: 'Cooling',
    emoji: '🍂',
    minScore: 15,
    color: '#F97316', // Rust orange
    bg: 'rgba(249, 115, 22, 0.16)',
    border: 'rgba(249, 115, 22, 0.35)',
    description: 'Activity is slowing down. Has not had much chatter lately.'
  },
  INACTIVE: {
    id: 'inactive',
    name: 'Dying / Inactive',
    emoji: '❄️',
    minScore: 0,
    color: '#64748B', // Faded slate
    bg: 'rgba(100, 116, 139, 0.14)',
    border: 'rgba(100, 116, 139, 0.25)',
    description: 'Quiet group chat. Danger of becoming dormant.'
  }
};

class BondScoring {
  /**
   * Returns tier metadata for a given score (0-100).
   */
  static getTier(score) {
    const s = Math.max(0, Math.min(100, score || 0));
    if (s >= BondTiers.SOULMATES.minScore) return BondTiers.SOULMATES;
    if (s >= BondTiers.CLOSE_FRIENDS.minScore) return BondTiers.CLOSE_FRIENDS;
    if (s >= BondTiers.CONVERSANT.minScore) return BondTiers.CONVERSANT;
    if (s >= BondTiers.ACQUAINTANCE.minScore) return BondTiers.ACQUAINTANCE;
    return BondTiers.DORMANT;
  }

  /**
   * Returns 1:1 DM relationship rank for a given score (0-100).
   */
  static getDmRank(score) {
    const s = Math.max(0, Math.min(100, Math.round(score || 0)));
    if (s >= DmRanks.RIDE_OR_DIE.minScore) return DmRanks.RIDE_OR_DIE;
    if (s >= DmRanks.BESTIE.minScore) return DmRanks.BESTIE;
    if (s >= DmRanks.CLOSE_FRIEND.minScore) return DmRanks.CLOSE_FRIEND;
    if (s >= DmRanks.FRIEND.minScore) return DmRanks.FRIEND;
    return DmRanks.ACQUAINTANCE;
  }

  /**
   * Returns Group Chat energy level for a given energy score (0-100).
   */
  static getGroupEnergyLevel(score) {
    const s = Math.max(0, Math.min(100, Math.round(score || 0)));
    if (s >= GroupEnergyLevels.BUZZING.minScore) return GroupEnergyLevels.BUZZING;
    if (s >= GroupEnergyLevels.ACTIVE.minScore) return GroupEnergyLevels.ACTIVE;
    if (s >= GroupEnergyLevels.CHILL.minScore) return GroupEnergyLevels.CHILL;
    if (s >= GroupEnergyLevels.COOLING.minScore) return GroupEnergyLevels.COOLING;
    return GroupEnergyLevels.INACTIVE;
  }

  /**
   * Formats duration in milliseconds into compact, glanceable text (e.g. 5m, 2h 15m, 3d).
   */
  static formatDuration(ms) {
    if (!ms || ms <= 0) return '0m';
    const totalMinutes = Math.floor(ms / 60000);
    if (totalMinutes < 1) return 'Just now';
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    if (days < 7) return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
    const weeks = Math.floor(days / 7);
    return `${weeks}w`;
  }

  /**
   * Computes comprehensive analytics & bond score for a 1:1 Direct Message conversation.
   * Considers frequency, two-way balance, recency decay, reply speed, and streaks.
   */
  static calculateDmMetrics(dmData = {}, settings = {}) {
    const sentCount = dmData.sentCount || 0;
    const receivedCount = dmData.receivedCount || 0;
    const totalCount = sentCount + receivedCount;
    const now = Date.now();
    const msInDay = 86400000;
    const fadingThresholdDays = settings.fadingThresholdDays ?? 3;

    const lastSent = dmData.lastSentTimestamp || 0;
    const lastReceived = dmData.lastReceivedTimestamp || 0;
    const lastMessage = dmData.lastMessageTimestamp || Math.max(lastSent, lastReceived);

    // 1. Median Reply Time & Formatting
    const replyTimes = Array.isArray(dmData.replyTimes) ? dmData.replyTimes.filter(t => typeof t === 'number' && t > 0) : [];
    let medianReplyTimeMs = 0;
    if (replyTimes.length > 0) {
      const sorted = [...replyTimes].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianReplyTimeMs = sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    } else if (dmData.medianReplyTimeMs) {
      medianReplyTimeMs = dmData.medianReplyTimeMs;
    }

    // 2. Reply Speed Multiplier Factor
    let speedFactor = 1.0;
    if (medianReplyTimeMs > 0) {
      const hours = medianReplyTimeMs / 3600000;
      if (hours <= 0.25) speedFactor = 1.15;       // Fast (< 15 mins)
      else if (hours <= 1.0) speedFactor = 1.08;   // Prompt (< 1 hour)
      else if (hours <= 6.0) speedFactor = 1.0;    // Standard (< 6 hours)
      else if (hours <= 24.0) speedFactor = 0.92;  // Casual (< 24 hours)
      else if (hours <= 48.0) speedFactor = 0.85;  // Slow (< 48 hours)
      else speedFactor = 0.75;                     // Very slow
    }

    // 3. Balance Ratio & Reciprocity
    let sentPercent = 50;
    let receivedPercent = 50;
    let balanceRatio = 1.0;
    let balanceMultiplier = 1.0;

    if (totalCount > 0) {
      sentPercent = Math.round((sentCount / totalCount) * 100);
      receivedPercent = 100 - sentPercent;
      const minC = Math.min(sentCount, receivedCount);
      const maxC = Math.max(sentCount, receivedCount);
      balanceRatio = maxC > 0 ? (minC / maxC) : 0;
      balanceMultiplier = 0.45 + (0.55 * balanceRatio);
    }

    // 4. Reply Rate % (inbound messages answered by user)
    let replyRate = 100;
    if (receivedCount > 0) {
      replyRate = Math.min(100, Math.round((sentCount / receivedCount) * 100));
    }

    // 5. Waiting For Your Reply State
    const waitingForUserReply = lastReceived > lastSent && totalCount > 0;
    const waitingSinceTimestamp = waitingForUserReply ? lastReceived : null;
    const waitingDurationMs = waitingForUserReply ? Math.max(0, now - lastReceived) : 0;

    // 6. Recency Factor & Grace Period (Never drops to 0 after 1-3 days)
    let recencyFactor = 1.0;
    const daysSinceLast = lastMessage 
      ? Math.max(0, (now - lastMessage) / msInDay) 
      : (dmData.firstSeenTimestamp ? Math.max(0, (now - dmData.firstSeenTimestamp) / msInDay) : 0);

    // 3-day grace period: full 1.0 strength before gentle decay starts
    if (daysSinceLast <= 3) {
      recencyFactor = 1.0;
    } else if (daysSinceLast <= 7) {
      recencyFactor = 0.90;
    } else if (daysSinceLast <= 14) {
      recencyFactor = 0.75;
    } else if (daysSinceLast <= 30) {
      recencyFactor = 0.60;
    } else {
      const halfLife = settings.decayHalfLifeDays || 14;
      const lambda = Math.LN2 / halfLife;
      recencyFactor = 0.60 * Math.exp(-lambda * (daysSinceLast - 30));
    }

    // 7. Volume Factor (asymptotic scaling with lifetime memory support)
    const effectiveVolume = Math.max(totalCount, dmData.lifetimeTotal || 0);
    const volumeFactor = effectiveVolume > 0 ? (1 - Math.exp(-effectiveVolume / 32)) : 0;

    // 8. Streak Bonus & Historical Record
    const dailyStreak = dmData.dailyStreak || 0;
    const allTimeLongestStreak = Math.max(dmData.allTimeLongestStreak || 0, dailyStreak);
    const streakBonus = Math.min(15, dailyStreak * 1.5);

    // 9. Final Bond Score & Never-Zero Memory Baseline
    let rawScore = (volumeFactor * balanceMultiplier * recencyFactor * speedFactor * 85) + streakBonus;
    if (totalCount === 0 && effectiveVolume === 0) {
      rawScore = 0;
    } else if (effectiveVolume >= 10 && rawScore < 15) {
      // Historical memory protection: a high exchange history keeps minimum connection score
      rawScore = 15;
    } else if (effectiveVolume >= 1 && rawScore < 5) {
      rawScore = 5;
    }
    const bondScore = Math.min(100, Math.max(0, Math.round(rawScore * 10) / 10));
    const rank = BondScoring.getDmRank(bondScore);

    // 10. Progress to Next Rank
    let nextRank = null;
    let pointsToNext = 0;
    let progressToNextPct = 100;

    if (rank.id === 'acquaintance') {
      nextRank = DmRanks.FRIEND;
      pointsToNext = Math.max(0, Math.round((nextRank.minScore - bondScore) * 10) / 10);
      progressToNextPct = Math.min(100, Math.round((bondScore / nextRank.minScore) * 100));
    } else if (rank.id === 'friend') {
      nextRank = DmRanks.CLOSE_FRIEND;
      pointsToNext = Math.max(0, Math.round((nextRank.minScore - bondScore) * 10) / 10);
      progressToNextPct = Math.min(100, Math.round(((bondScore - DmRanks.FRIEND.minScore) / (nextRank.minScore - DmRanks.FRIEND.minScore)) * 100));
    } else if (rank.id === 'close_friend') {
      nextRank = DmRanks.BESTIE;
      pointsToNext = Math.max(0, Math.round((nextRank.minScore - bondScore) * 10) / 10);
      progressToNextPct = Math.min(100, Math.round(((bondScore - DmRanks.CLOSE_FRIEND.minScore) / (nextRank.minScore - DmRanks.CLOSE_FRIEND.minScore)) * 100));
    } else if (rank.id === 'bestie') {
      nextRank = DmRanks.RIDE_OR_DIE;
      pointsToNext = Math.max(0, Math.round((nextRank.minScore - bondScore) * 10) / 10);
      progressToNextPct = Math.min(100, Math.round(((bondScore - DmRanks.BESTIE.minScore) / (nextRank.minScore - DmRanks.BESTIE.minScore)) * 100));
    }

    // 11. Fading Alert (soft warning if high bond conversation is going cold)
    const isFading = bondScore >= 40 && daysSinceLast >= fadingThresholdDays;
    const isCoolingCandidate = bondScore >= 35 && daysSinceLast >= 3 && daysSinceLast <= 28;

    return {
      bondScore,
      rank,
      nextRank,
      pointsToNext,
      progressToNextPct,
      sentCount,
      receivedCount,
      totalCount,
      sentPercent,
      receivedPercent,
      balanceRatio: Math.round(balanceRatio * 100) / 100,
      replyRate,
      medianReplyTimeMs,
      formattedMedianReply: medianReplyTimeMs > 0 ? this.formatDuration(medianReplyTimeMs) : 'Instant / None',
      waitingForUserReply,
      waitingSinceTimestamp,
      waitingDurationMs,
      formattedWaitingDuration: waitingForUserReply ? this.formatDuration(waitingDurationMs) : null,
      dailyStreak,
      daysSinceLast: Math.floor(daysSinceLast),
      isFading,
      isCoolingCandidate,
      speedFactor: Math.round(speedFactor * 100) / 100,
      balanceMultiplier: Math.round(balanceMultiplier * 100) / 100,
      recencyFactor: Math.round(recencyFactor * 100) / 100
    };
  }

  /**
   * Computes energy score, activity status, and active member roster for a Group Chat.
   */
  static calculateGroupEnergy(groupData = {}) {
    const totalMessages = groupData.totalMessages || 0;
    const recent3d = groupData.recentMessages3d || 0;
    const recent7d = groupData.recentMessages7d || (recent3d * 2);
    const lastMessage = groupData.lastMessageTimestamp || Date.now();
    const now = Date.now();
    const msInDay = 86400000;
    const daysSince = Math.max(0, (now - lastMessage) / msInDay);

    // 1. Member Participation Roster
    const memberCounts = groupData.memberMessageCounts || {};
    const memberEntries = Object.entries(memberCounts);
    let memberSum = 0;
    memberEntries.forEach(([, count]) => { memberSum += count; });
    const effectiveTotal = Math.max(totalMessages, memberSum);

    const activeMembers = memberEntries.map(([handle, count]) => {
      const share = effectiveTotal > 0 ? Math.round((count / effectiveTotal) * 100) : 0;
      return { handle, count, share };
    }).sort((a, b) => b.count - a.count);

    // 2. Diversity Score (0 to 20 pts)
    const distinctMembers = activeMembers.length;
    let diversityScore = 5;
    if (distinctMembers >= 5) diversityScore = 20;
    else if (distinctMembers >= 3) diversityScore = 15;
    else if (distinctMembers >= 2) diversityScore = 10;

    // 3. Message Volume Score (0 to 50 pts)
    const activeVol = recent7d + Math.min(20, totalMessages * 0.2);
    const volumeScore = Math.min(50, Math.round(50 * (1 - Math.exp(-activeVol / 25))));

    // 4. Recency Score (0 to 30 pts)
    let recencyScore = 30;
    if (daysSince <= 1) recencyScore = 30;
    else if (daysSince <= 3) recencyScore = 22;
    else if (daysSince <= 7) recencyScore = 14;
    else if (daysSince <= 14) recencyScore = 6;
    else recencyScore = 0;

    // 5. Final Group Energy Score
    let energyScore = volumeScore + recencyScore + diversityScore;
    if (totalMessages === 0) energyScore = 0;
    energyScore = Math.min(100, Math.max(0, energyScore));

    const energyLevel = BondScoring.getGroupEnergyLevel(energyScore);
    const isDying = energyScore < 18 || daysSince >= 14;

    return {
      energyScore,
      energyLevel,
      isDying,
      daysSinceLast: Math.floor(daysSince),
      totalMessages,
      recent7d,
      activeMembers,
      distinctMembers
    };
  }

  /**
   * Calculates overall combined relationship strength:
   * Public Timeline interactions + Private Direct Message health.
   */
  static calculateCombinedRelationship(publicUser = null, dmConv = null, settings = {}) {
    const pubScore = publicUser ? (publicUser.currentScore || 0) : 0;
    const dmScore = dmConv ? (dmConv.bondScore || 0) : 0;
    const hasDm = !!(dmConv && dmConv.totalCount > 0);

    if (!hasDm) {
      return {
        combinedScore: pubScore,
        publicScore: pubScore,
        dmScore: 0,
        hasDm: false,
        synergy: false,
        rank: BondScoring.getTier(pubScore),
        dmRank: null,
        label: 'Public Only'
      };
    }

    const dmWeight = Math.max(0.1, Math.min(0.9, (settings.dmScoreWeightPercent ?? 50) / 100));
    const pubWeight = 1 - dmWeight;

    // Synergy bonus (+6 to +10 pts) if user is active BOTH publicly and privately
    const hasSynergy = pubScore >= 30 && dmScore >= 35;
    const synergyBonus = hasSynergy ? 8 : 0;

    const baseScore = (pubScore * pubWeight) + (dmScore * dmWeight);
    const combinedScore = Math.min(100, Math.max(0, Math.round(baseScore + synergyBonus)));

    const publicTier = BondScoring.getTier(pubScore);
    const dmRank = BondScoring.getDmRank(dmScore);
    const combinedTier = BondScoring.getTier(combinedScore);

    return {
      combinedScore,
      publicScore: pubScore,
      dmScore,
      hasDm: true,
      synergy: hasSynergy,
      publicTier,
      dmRank,
      combinedTier,
      label: `${publicTier.shortName} • ${dmRank.shortLabel}`
    };
  }

  /**
   * Calculates score for a user given their interaction history and settings.
   */
  static calculateUserScore(events = [], settings = {}, previousScore = 0, minBoost = 0) {
    if (!events || events.length === 0) {
      return {
        score: 0,
        tier: BondTiers.DORMANT,
        trend: 'steady',
        streakDays: 0,
        reciprocity: { ratio: 50, label: 'No Data', balance: 'balanced' },
        sparklinePoints: '',
        decayWarning: false,
        rawScore: 0
      };
    }

    const now = Date.now();
    const halfLifeDays = settings.decayHalfLifeDays || 14;
    const gracePeriodDays = settings.gracePeriodDays ?? 5;
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

    let accumulatedRaw = 0;
    let sentCount = 0;
    let receivedCount = 0;
    let likeCount = 0;
    let threadReplyCount = 0;
    let regularReplyCount = 0;
    let maxRecencyBoost = 1.0;

    const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);

    for (const evt of sorted) {
      let baseWeight = 0;
      const isInbound = evt.direction === 'inbound' || evt.type.includes('received') || evt.type === 'signal_follow_back' || evt.type === 'deep_sync';

      switch (evt.type) {
        case 'signal_follow_back':
        case 'signal_mutual_follow':
          baseWeight = 16;
          sentCount++;
          receivedCount++;
          break;
        case 'signal_you_followed':
          baseWeight = 5;
          sentCount++;
          break;
        case 'signal_unfollowed':
        case 'signal_blocked':
        case 'signal_you_unfollowed':
          baseWeight = 0;
          break;
        case 'dm_mutual':
          // Highest intimacy: direct bidirectional private messages
          baseWeight = weights.dmMutual || 22;
          sentCount++;
          receivedCount++;
          break;
        case 'dm_sent':
          baseWeight = weights.dmSent || 12;
          sentCount++;
          break;
        case 'dm_received':
          // Bonus for inbound DM effort: they reached out to message you
          baseWeight = weights.dmReceived || 15;
          receivedCount++;
          break;
        case 'reply_mutual':
          // High quality: mutual conversation replies
          baseWeight = weights.mutualReply || 18;
          sentCount++;
          receivedCount++;
          regularReplyCount++;
          break;
        case 'reply_thread':
          // Replies in threads > random likes: Substantive dialogue inside an active tweet thread
          baseWeight = 16;
          if (isInbound) { receivedCount++; } else { sentCount++; }
          threadReplyCount++;
          break;
        case 'reply_sent':
          baseWeight = weights.replySent || 8;
          if (isInbound) receivedCount++; else sentCount++;
          regularReplyCount++;
          break;
        case 'reply_received':
          // Inbound reply appreciation: they took the time to answer you (+25% value)
          baseWeight = (weights.replyReceived || 8) * 1.25;
          if (isInbound) receivedCount++; else sentCount++;
          regularReplyCount++;
          break;
        case 'quote':
          baseWeight = weights.quote || 6;
          if (isInbound) receivedCount++; else sentCount++;
          break;
        case 'mention':
          baseWeight = weights.mention || 5;
          if (isInbound) receivedCount++; else sentCount++;
          break;
        case 'like':
          likeCount++;
          // Replies > likes: Diminishing returns on random likes.
          // The first 3 likes give full value (2 pts). Additional likes diminish so 50 likes
          // without speaking cannot fabricate a soulmate bond.
          if (likeCount <= 3) {
            baseWeight = weights.like || 2;
          } else {
            baseWeight = Math.max(0.4, (weights.like || 2) / Math.sqrt(likeCount - 2));
          }
          if (isInbound) { receivedCount++; } else { sentCount++; }
          break;
        case 'deep_sync':
          baseWeight = weights.deepSyncExchange || 10;
          receivedCount++;
          break;
        default:
          baseWeight = evt.weight || 2;
          if (isInbound) { receivedCount++; } else { sentCount++; }
          break;
      }

      // 1. Thread Depth Multiplier: Replies inside threads carry extra conversational weight
      if (evt.isThread || evt.type === 'reply_thread') {
        baseWeight *= 1.35; // 35% thread dialogue bonus
      }

      // 2. Individual Mutual Flag Multiplier
      if (evt.isMutual) {
        baseWeight *= 1.30;
      }

      // 3. Recent interactions weighted higher than old ones (Recency Velocity)
      const ageMs = Math.max(0, now - evt.timestamp);
      const ageDays = ageMs / msInDay;
      let recencyBoost = 1.0;
      if (ageDays <= 1) {
        recencyBoost = 1.50; // Active within 24 hours: 50% recency momentum boost
      } else if (ageDays <= 3) {
        recencyBoost = 1.30; // Active within 3 days: 30% recency boost
      } else if (ageDays <= 7) {
        recencyBoost = 1.15; // Active this week: 15% recency boost
      }
      if (recencyBoost > maxRecencyBoost) maxRecencyBoost = recencyBoost;

      // 4. Exponential Half-Life Decay for older interactions
      const decayableDays = Math.max(0, ageDays - gracePeriodDays);
      const decayFactor = Math.exp(-lambda * decayableDays);

      accumulatedRaw += baseWeight * recencyBoost * decayFactor;
    }

    // 5. Bonus if they also engage back with you (Two-Way Mutual Engagement Multiplier)
    let twoWayMultiplier = 1.0;
    if (sentCount > 0 && receivedCount > 0) {
      const minE = Math.min(sentCount, receivedCount);
      const maxE = Math.max(sentCount, receivedCount);
      const reciprocityBalance = minE / maxE; // 0.0 to 1.0

      // Escalating bonus from +30% up to +60% when they actively engage back
      twoWayMultiplier = 1.30 + (0.30 * reciprocityBalance);
      accumulatedRaw *= twoWayMultiplier;
    } else if (sentCount >= 4 && receivedCount === 0) {
      // One-sided protection: If you engage repeatedly but they NEVER engage back with you,
      // cap the raw score so one-sided fan accounts never exceed Acquaintance (~32-35).
      accumulatedRaw = Math.min(accumulatedRaw, 16);
    }

    const K = 45;
    const normalized = 100 * (1 - Math.exp(-accumulatedRaw / K));
    let finalScore = Math.round(Math.min(100, Math.max(0, normalized)) * 10) / 10;

    // The event ledger is the durable memory. Do not floor this score at the
    // previous value: doing so prevents inactivity decay from ever taking effect.

    // Trend analysis
    let trend = 'steady';
    if (previousScore > 0) {
      const diff = finalScore - previousScore;
      if (diff >= 0.5) trend = 'rising';
      else if (diff <= -0.5) trend = 'decaying';
    } else if (finalScore > 0) {
      trend = 'rising';
    }

    // Streak Calculation
    const streakDays = this.calculateStreak(sorted);

    // Reciprocity Radar
    const reciprocity = this.calculateReciprocity(sentCount, receivedCount);

    // CRM Relationship Status (Besties / Mutuals / One-sided / Stranger)
    const crmStatus = this.calculateCRMStatus(finalScore, sentCount, receivedCount, streakDays);

    // 30-Day Trend Sparkline
    const sparkline = this.generate30DaySparkline(sorted, settings, K);

    // Decay Warning (if score is substantial and no interaction in 7+ days)
    const lastEventTime = sorted[0] ? sorted[0].timestamp : 0;
    const daysSinceLast = lastEventTime ? (now - lastEventTime) / msInDay : 999;
    const decayWarning = finalScore >= 40 && daysSinceLast >= gracePeriodDays;

    const tier = this.getTier(finalScore);

    return {
      score: finalScore,
      tier,
      crmStatus,
      trend,
      streakDays,
      reciprocity,
      recencyBoost: maxRecencyBoost,
      twoWayMultiplier: Math.round(twoWayMultiplier * 100) / 100,
      qualityMetrics: {
        threadReplies: threadReplyCount,
        regularReplies: regularReplyCount,
        likes: likeCount,
        sentCount,
        receivedCount
      },
      sparklinePoints: sparkline.points,
      sparklineHistory: sparkline.history,
      decayWarning,
      daysSinceLast: Math.floor(daysSinceLast),
      rawScore: Math.round(accumulatedRaw * 10) / 10
    };
  }

  /**
   * Computes consecutive calendar day reply streaks
   */
  static calculateStreak(sortedEvents) {
    if (!sortedEvents || sortedEvents.length === 0) return 0;
    const activeDays = new Set();
    const msInDay = 86400000;
    const todayDayIndex = Math.floor(Date.now() / msInDay);

    for (const e of sortedEvents) {
      const dayIndex = Math.floor(e.timestamp / msInDay);
      activeDays.add(dayIndex);
    }

    // Check if streak is active today or yesterday
    let streak = 0;
    let checkDay = todayDayIndex;
    if (!activeDays.has(checkDay)) {
      checkDay = todayDayIndex - 1; // allow 1 day grace
    }

    while (activeDays.has(checkDay)) {
      streak++;
      checkDay--;
    }

    return streak;
  }

  /**
   * Computes relationship status CRM classification:
   * "Besties", "Mutuals", "One-sided (You lead)", "One-sided (They lead)", or "Stranger"
   */
  static calculateCRMStatus(score, sentCount, receivedCount, streakDays = 0) {
    const total = sentCount + receivedCount;
    const finalScore = Math.round(score || 0);

    if (total === 0 || finalScore < 3) {
      return {
        id: 'stranger',
        label: 'Stranger',
        emoji: '👤',
        desc: 'No meaningful interaction history yet',
        color: '#71767B',
        badgeBg: 'rgba(113, 118, 123, 0.15)'
      };
    }

    // Besties: High score (>=65) with balanced reciprocal exchanges or active streaks
    if (finalScore >= 65 && sentCount > 0 && receivedCount > 0) {
      return {
        id: 'besties',
        label: 'Besties',
        emoji: '💖',
        desc: 'Deep two-way bond with active exchanges',
        color: '#F91880',
        badgeBg: 'rgba(249, 24, 128, 0.18)'
      };
    }

    const sentRatio = total > 0 ? (sentCount / total) * 100 : 50;

    // One-sided (You lead): You send a lot, but they rarely or never engage back
    if (sentCount >= 2 && sentRatio >= 75) {
      return {
        id: 'one_sided',
        label: 'One-sided',
        subLabel: 'You lead',
        emoji: '➡️',
        desc: 'You send likes/replies, low engagement back',
        color: '#FF7A00',
        badgeBg: 'rgba(255, 122, 0, 0.18)'
      };
    }

    // One-sided (They lead): They engage with you frequently, you rarely reply
    if (receivedCount >= 2 && sentRatio <= 25) {
      return {
        id: 'one_sided_them',
        label: 'One-sided',
        subLabel: 'They lead',
        emoji: '⬅️',
        desc: 'They engage frequently, you reply rarely',
        color: '#1D9BF0',
        badgeBg: 'rgba(29, 155, 240, 0.18)'
      };
    }

    // If score is decent with both sides active: Mutuals
    if (sentCount > 0 && receivedCount > 0) {
      return {
        id: 'mutuals',
        label: 'Mutuals',
        emoji: '🤝',
        desc: 'Two-way balanced conversation',
        color: '#00BA7C',
        badgeBg: 'rgba(0, 186, 124, 0.18)'
      };
    }

    // If score >= 20 but only 1 side so far
    if (finalScore >= 20) {
      return {
        id: 'one_sided',
        label: 'One-sided',
        subLabel: 'You lead',
        emoji: '➡️',
        desc: 'Active from your side',
        color: '#FF7A00',
        badgeBg: 'rgba(255, 122, 0, 0.18)'
      };
    }

    return {
      id: 'casual',
      label: 'Acquaintance',
      emoji: '👋',
      desc: 'Occasional light interactions',
      color: '#FFD400',
      badgeBg: 'rgba(255, 212, 0, 0.18)'
    };
  }

  /**
   * Computes reciprocity balance ratio and label
   */
  static calculateReciprocity(sent, received) {
    const total = sent + received;
    if (total === 0) {
      return { ratio: 50, label: 'Balanced (New)', balance: 'balanced' };
    }
    const ratio = Math.round((sent / total) * 100);
    let label = 'Balanced (Two-Way)';
    let balance = 'balanced';

    if (ratio > 70) {
      label = 'You Lead (Low Reciprocity)';
      balance = 'you_lead';
    } else if (ratio < 30) {
      label = 'They Lead (High Interest)';
      balance = 'they_lead';
    } else {
      label = '50/50 Balanced Dialogue';
      balance = 'balanced';
    }

    return { ratio, label, balance, sent, received };
  }

  /**
   * Generates SVG polyline coordinates for the past 30 days with exact score parity
   */
  static generate30DaySparkline(sortedEvents, settings, K = 45) {
    const points = [];
    const history = [];
    const now = Date.now();
    const msInDay = 86400000;
    const halfLifeDays = settings.decayHalfLifeDays || 14;
    const gracePeriodDays = settings.gracePeriodDays ?? 5;
    const lambda = Math.LN2 / halfLifeDays;
    const weights = Object.assign({
      mutualReply: 15,
      replySent: 8,
      replyReceived: 8,
      quote: 6,
      mention: 5,
      like: 2,
      deepSyncExchange: 10
    }, settings.weights || {});

    for (let i = 29; i >= 0; i--) {
      const pointTime = now - (i * msInDay);
      let dayRaw = 0;
      let sentCount = 0;
      let receivedCount = 0;

      for (const e of sortedEvents) {
        if (e.timestamp <= pointTime) {
          let baseWeight = 0;
          switch (e.type) {
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
              baseWeight = e.weight || 2;
              break;
          }

          if (e.isMutual) {
            baseWeight *= 1.35;
          }

          const ageDays = (pointTime - e.timestamp) / msInDay;
          const decayableDays = Math.max(0, ageDays - gracePeriodDays);
          const decayFactor = Math.exp(-lambda * decayableDays);
          dayRaw += baseWeight * decayFactor;
        }
      }

      if (sentCount > 0 && receivedCount > 0) {
        dayRaw *= 1.25;
      }

      const dayScore = Math.round(100 * (1 - Math.exp(-dayRaw / K)) * 10) / 10;
      history.push({ day: 30 - i, score: dayScore });

      // SVG graph coordinate space: width 240, height 50
      const x = Math.round(((29 - i) / 29) * 240);
      const y = Math.round(50 - (dayScore / 100) * 44);
      points.push(`${x},${y}`);
    }

    return { points: points.join(' '), history };
  }

  static formatTimeAgo(timestamp) {
    if (!timestamp) return 'Never';
    const elapsed = Date.now() - timestamp;
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  /**
   * Analyzes local engagement memory across all tracked users:
   * - Who engages with you (Supporters) vs who you engage with (Outbound)
   * - Global reciprocity balance
   * - Balanced mutuals
   * - Dormant / fading contacts
   */
  static analyzeEngagementMemory(users = []) {
    let totalSent = 0;
    let totalReceived = 0;
    const now = Date.now();
    const msInDay = 86400000;

    const enriched = users.map(u => {
      const stats = u.stats || {};
      const sent = (stats.repliesSent || 0) + (stats.dmsSent || 0) + (stats.likesSent ?? stats.likes ?? 0) + (stats.quotesSent || 0) + (stats.mentionsSent || 0);
      const received = (stats.repliesReceived || 0) + (stats.dmsReceived || 0) + (stats.likesReceived || 0) + (stats.quotesReceived || 0) + (stats.mentionsReceived || 0);
      const total = sent + received;
      const sentRatio = total > 0 ? Math.round((sent / total) * 100) : 50;
      const lastTime = u.lastInteraction || u.lastUpdated || (now - 30 * msInDay);
      const daysSince = Math.floor((now - lastTime) / msInDay);

      totalSent += sent;
      totalReceived += received;

      // Classify engagement role
      let role = 'casual';
      if (received >= 2 && sentRatio <= 40) {
        role = 'supporter'; // They engage with you more
      } else if (sent >= 2 && sentRatio >= 60) {
        role = 'supported_by_you'; // You engage with them more
      } else if (sent > 0 && received > 0 && sentRatio >= 40 && sentRatio <= 60) {
        role = 'balanced'; // Balanced dialogue
      }

      const isDormant = daysSince >= 14 && ((u.currentScore || 0) > 5 || total > 0);

      return {
        ...u,
        sent,
        received,
        total,
        sentRatio,
        daysSince,
        role,
        isDormant
      };
    });

    // Global balance calculation
    const globalTotal = totalSent + totalReceived;
    const globalSentRatio = globalTotal > 0 ? Math.round((totalSent / globalTotal) * 100) : 50;
    const globalRecvRatio = 100 - globalSentRatio;

    let balanceLabel = 'Balanced ⚖️';
    let balanceDesc = 'Your outbound engagement matches your inbound responses closely.';
    if (globalSentRatio >= 65) {
      balanceLabel = 'Outbound Heavy 📤';
      balanceDesc = 'You actively initiate more likes, replies, and DMs than you receive back.';
    } else if (globalSentRatio <= 35) {
      balanceLabel = 'High Inbound Support 📥';
      balanceDesc = 'Your community actively reaches out and replies to you frequently.';
    }

    // Supporters: People who engage with you the most (received > 0, sorted by received desc)
    const supporters = [...enriched]
      .filter(u => u.received > 0)
      .sort((a, b) => b.received - a.received);

    // You engage with most: sorted by sent desc
    const topEngagedByYou = [...enriched]
      .filter(u => u.sent > 0)
      .sort((a, b) => b.sent - a.sent);

    // Balanced true mutuals
    const balancedMutuals = [...enriched]
      .filter(u => u.role === 'balanced' && u.total >= 2)
      .sort((a, b) => (b.currentScore || 0) - (a.currentScore || 0));

    // Dormant people: no interaction in 14+ days
    const dormantPeople = [...enriched]
      .filter(u => u.isDormant)
      .sort((a, b) => b.daysSince - a.daysSince);

    return {
      totalSent,
      totalReceived,
      globalSentRatio,
      globalRecvRatio,
      balanceLabel,
      balanceDesc,
      supporters,
      topEngagedByYou,
      balancedMutuals,
      dormantPeople,
      trackedCount: enriched.length
    };
  }

  /**
   * Calculates follow relationship badge status for profile headers:
   * - Mutual: You follow each other (🤝 Mutual)
   * - One-Way Follow: You follow them, but they don't follow back (➡️ One-Way Follow)
   * - Just a Follower: They follow you, but you don't follow back (📥 Just a Follower)
   * - Blocked: Possible block detected (🚫 Blocked)
   */
  static getFollowRelationship(signals = {}) {
    if (!signals) return null;
    if (signals.isBlocked) {
      return {
        id: 'blocked',
        label: 'Blocked',
        badgeText: '🚫 Blocked',
        emoji: '🚫',
        className: 'bond-follow-blocked',
        color: '#f4212e',
        bg: 'rgba(244, 33, 46, 0.15)',
        desc: 'Possible block detected on profile'
      };
    }

    const theyFollow = signals.theyFollowYou === true;
    const youFollow = signals.youFollowThem === true;

    // 1. Mutual Follow: Both follow each other
    if (signals.isMutual || (theyFollow && youFollow)) {
      return {
        id: 'mutual',
        label: 'Mutual',
        badgeText: '🤝 Mutual',
        emoji: '🤝',
        className: 'bond-follow-mutual',
        color: '#00ba7c',
        bg: 'rgba(0, 186, 124, 0.15)',
        desc: 'Mutual follow: You follow each other'
      };
    }

    // 2. One-Way Follow: You follow them, but they don't follow back
    if (youFollow && !theyFollow) {
      return {
        id: 'oneway',
        label: 'One-Way Follow',
        badgeText: '➡️ One-Way Follow',
        emoji: '➡️',
        className: 'bond-follow-oneway',
        color: '#f59e0b',
        bg: 'rgba(245, 158, 11, 0.15)',
        desc: "One-way follow: You follow them, but they don't follow you back"
      };
    }

    // 3. Just a Follower: They follow you, but you don't follow back
    if (theyFollow && !youFollow) {
      return {
        id: 'just_follower',
        label: 'Just a Follower',
        badgeText: '📥 Just a Follower',
        emoji: '📥',
        className: 'bond-follow-just-follower',
        color: '#1d9bf0',
        bg: 'rgba(29, 155, 240, 0.15)',
        desc: "Just a follower: Follows you, but you don't follow back"
      };
    }

    return null;
  }
}

if (typeof window !== 'undefined') {
  window.BondScoring = BondScoring;
  window.BondTiers = BondTiers;
  window.DmRanks = DmRanks;
  window.GroupEnergyLevels = GroupEnergyLevels;
}

if (typeof globalThis !== 'undefined') {
  globalThis.BondScoring = BondScoring;
  globalThis.BondTiers = BondTiers;
  globalThis.DmRanks = DmRanks;
  globalThis.GroupEnergyLevels = GroupEnergyLevels;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BondScoring,
    BondTiers,
    DmRanks,
    GroupEnergyLevels
  };
}
