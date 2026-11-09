/**
 * BondScore for X - Scoring, Streak & Time-Decay Engine (v1.1.0)
 * Computes relationship scores, streaks, reciprocity balance, and 30-day historical trends.
 */

const BondTiers = {
  SOULMATES: {
    id: 'soulmates',
    name: 'Core Bond',
    minScore: 90,
    emoji: '💎',
    color: '#00BA7C', // Twitter emerald
    bg: 'rgba(0, 186, 124, 0.15)'
  },
  CLOSE_FRIENDS: {
    id: 'close_friends',
    name: 'Inner Circle',
    minScore: 70,
    emoji: '🔥',
    color: '#F91880', // Twitter hot pink
    bg: 'rgba(249, 24, 128, 0.15)'
  },
  CONVERSANT: {
    id: 'conversant',
    name: 'Mutual Conversant',
    minScore: 40,
    emoji: '🤝',
    color: '#1D9BF0', // Twitter blue
    bg: 'rgba(29, 155, 240, 0.15)'
  },
  ACQUAINTANCE: {
    id: 'acquaintance',
    name: 'Acquaintance',
    minScore: 15,
    emoji: '👋',
    color: '#FFD400', // Twitter yellow
    bg: 'rgba(255, 212, 0, 0.15)'
  },
  DORMANT: {
    id: 'dormant',
    name: 'Dormant',
    minScore: 0,
    emoji: '❄️',
    color: '#71767B', // Twitter gray
    bg: 'rgba(113, 118, 123, 0.12)'
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

    let accumulatedRaw = 0;
    let sentCount = 0;
    let receivedCount = 0;

    const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);

    for (const evt of sorted) {
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
        baseWeight *= 1.35; // 35% reciprocity bonus
      }

      const ageMs = Math.max(0, now - evt.timestamp);
      const ageDays = ageMs / msInDay;
      const decayableDays = Math.max(0, ageDays - gracePeriodDays);
      const decayFactor = Math.exp(-lambda * decayableDays);

      accumulatedRaw += baseWeight * decayFactor;
    }

    // Mutual conversation bonus
    if (sentCount > 0 && receivedCount > 0) {
      accumulatedRaw *= 1.25;
    }

    const K = 45;
    const normalized = 100 * (1 - Math.exp(-accumulatedRaw / K));
    let finalScore = Math.round(Math.min(100, Math.max(0, normalized)) * 10) / 10;

    // Memory guarantee: When actively interacting (minBoost > 0) or continuing a bond,
    // the score always builds upon previousScore and never regresses below it.
    if (previousScore > 0) {
      const floorScore = minBoost > 0 ? previousScore + minBoost : previousScore;
      finalScore = Math.min(100, Math.max(finalScore, floorScore));
      finalScore = Math.round(finalScore * 10) / 10;
    } else if (minBoost > 0) {
      finalScore = Math.min(100, Math.max(finalScore, minBoost));
      finalScore = Math.round(finalScore * 10) / 10;
    }

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

    // 30-Day Trend Sparkline
    const sparkline = this.generate30DaySparkline(sorted, settings, K);

    // Decay Warning (if score is substantial and no interaction in 7+ days)
    const lastEventTime = sorted[0] ? sorted[0].timestamp : 0;
    const daysSinceLast = lastEventTime ? (now - lastEventTime) / msInDay : 999;
    const decayWarning = finalScore >= 40 && daysSinceLast >= 7;

    const tier = this.getTier(finalScore);

    return {
      score: finalScore,
      tier,
      trend,
      streakDays,
      reciprocity,
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
    const gracePeriodDays = settings.gracePeriodDays || 2;
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
}

window.BondScoring = BondScoring;
window.BondTiers = BondTiers;
