/**
 * BondScore for X - Local Storage Layer (v1.1.0)
 * Manages interactions, user records, cached scores, notes, streaks, and settings using chrome.storage.local.
 * Completely private, zero-backend, and offline-first.
 */

const DEFAULT_SETTINGS = {
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
  badgeStyle: 'subtle', // 'subtle' | 'pill' | 'minimal'
  minScoreToShowBadge: 1
};

class BondStorage {
  constructor() {
    this.memoryCache = new Map();
    this.eventsCache = new Map();
    this.settingsCache = null;
    this.currentUser = null;
    this.isInitialized = false;
    this._setupStorageSync();
  }

  _setupStorageSync() {
    if (this._hasChromeStorage() && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        for (const [key, change] of Object.entries(changes)) {
          if (key.startsWith('user:')) {
            const handle = key.replace('user:', '');
            if (change.newValue) {
              this.memoryCache.set(handle, change.newValue);
            } else {
              this.memoryCache.delete(handle);
            }
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('bondscore:updated', {
                detail: { handle, user: change.newValue, score: change.newValue ? change.newValue.currentScore : 0 }
              }));
            }
          } else if (key.startsWith('events:')) {
            const handle = key.replace('events:', '');
            if (change.newValue) {
              this.eventsCache.set(handle, change.newValue);
            } else {
              this.eventsCache.delete(handle);
            }
          } else if (key === 'currentUser') {
            this.currentUser = change.newValue || null;
          } else if (key === 'settings') {
            this.settingsCache = Object.assign({}, DEFAULT_SETTINGS, change.newValue || {});
          }
        }
      });
    }
  }

  async init() {
    if (this.isInitialized) return;
    try {
      const data = await this._getRaw(['currentUser', 'settings']);
      this.currentUser = data.currentUser || null;
      this.settingsCache = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
      this.isInitialized = true;
    } catch (err) {
      console.warn('[BondScore] Storage init error:', err);
      this.settingsCache = Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  _hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && !!chrome.storage.local;
  }

  _getRaw(keys) {
    return new Promise((resolve, reject) => {
      if (this._hasChromeStorage()) {
        chrome.storage.local.get(keys, (res) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(res || {});
          }
        });
      } else {
        const res = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        keyList.forEach(k => {
          try {
            const val = localStorage.getItem(`bond_${k}`);
            if (val !== null) res[k] = JSON.parse(val);
          } catch (e) {}
        });
        resolve(res);
      }
    });
  }

  _setRaw(items) {
    return new Promise((resolve, reject) => {
      if (this._hasChromeStorage()) {
        chrome.storage.local.set(items, () => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve();
          }
        });
      } else {
        for (const [k, v] of Object.entries(items)) {
          try {
            localStorage.setItem(`bond_${k}`, JSON.stringify(v));
          } catch (e) {}
        }
        resolve();
      }
    });
  }

  async getCurrentUser() {
    if (!this.currentUser) {
      const res = await this._getRaw(['currentUser']);
      this.currentUser = res.currentUser || null;
    }
    return this.currentUser;
  }

  async setCurrentUser(handle) {
    if (!handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    if (this.currentUser !== cleanHandle) {
      this.currentUser = cleanHandle;
      await this._setRaw({ currentUser: cleanHandle });
    }
  }

  async getSettings() {
    if (!this.settingsCache) {
      const res = await this._getRaw(['settings']);
      this.settingsCache = Object.assign({}, DEFAULT_SETTINGS, res.settings || {});
    }
    return this.settingsCache;
  }

  async updateSettings(newSettings) {
    this.settingsCache = Object.assign({}, this.settingsCache || DEFAULT_SETTINGS, newSettings);
    await this._setRaw({ settings: this.settingsCache });
    return this.settingsCache;
  }

  _userKey(handle) {
    return `user:${handle.toLowerCase().trim()}`;
  }

  _eventsKey(handle) {
    return `events:${handle.toLowerCase().trim()}`;
  }

  async getUser(handle, forceRefresh = false) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    if (!forceRefresh && this.memoryCache.has(cleanHandle)) {
      return this.memoryCache.get(cleanHandle);
    }

    const key = this._userKey(cleanHandle);
    const res = await this._getRaw([key]);
    const user = res[key] || null;
    if (user) {
      this.memoryCache.set(cleanHandle, user);
    }
    return user;
  }

  async saveUser(handle, userData) {
    if (!handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const key = this._userKey(cleanHandle);
    const existing = (await this.getUser(cleanHandle)) || {
      handle: cleanHandle,
      displayName: cleanHandle,
      avatarUrl: '',
      currentScore: 0,
      tier: 'dormant',
      streakDays: 0,
      isPinned: false,
      note: '',
      lastInteraction: Date.now(),
      lastCalculated: Date.now(),
      trend: 'steady',
      stats: {
        repliesSent: 0,
        repliesReceived: 0,
        mutualExchanges: 0,
        likes: 0,
        quotes: 0,
        deepScans: 0
      }
    };

    const updated = {
      ...existing,
      ...userData,
      handle: cleanHandle,
      lastUpdated: Date.now()
    };

    this.memoryCache.set(cleanHandle, updated);
    await this._setRaw({ [key]: updated });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bondscore:updated', {
        detail: { handle: cleanHandle, user: updated, score: updated.currentScore }
      }));
    }
    return updated;
  }

  async getEvents(handle) {
    if (!handle) return [];
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    if (this.eventsCache.has(cleanHandle)) {
      return this.eventsCache.get(cleanHandle);
    }

    const key = this._eventsKey(cleanHandle);
    const res = await this._getRaw([key]);
    const events = res[key] || [];
    this.eventsCache.set(cleanHandle, events);
    return events;
  }

  async saveEvents(handle, events) {
    if (!handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const key = this._eventsKey(cleanHandle);
    this.eventsCache.set(cleanHandle, events);
    await this._setRaw({ [key]: events });
  }

  /**
   * Records a new interaction event, deduplicating by event ID or tweet ID.
   */
  async recordInteraction(handle, eventData) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    if ((this.currentUser && cleanHandle === this.currentUser) || cleanHandle === 'masersuspended' || cleanHandle === 'maserbyte') {
      return null; // Don't track self
    }

    const events = await this.getEvents(cleanHandle);
    const eventId = eventData.id || `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Check duplicate by tweetId if provided
    if (eventData.tweetId) {
      const exists = events.some(e => e.tweetId === eventData.tweetId && e.type === eventData.type);
      if (exists) {
        return await this.getUser(cleanHandle);
      }
    }

    const newEvent = {
      id: eventId,
      timestamp: eventData.timestamp || Date.now(),
      type: eventData.type || 'reply_sent',
      tweetId: eventData.tweetId || null,
      textSnippet: eventData.textSnippet ? eventData.textSnippet.slice(0, 140) : null,
      isMutual: !!eventData.isMutual,
      weight: eventData.weight || null
    };

    events.push(newEvent);
    // Keep last 500 events per user to maintain high performance
    if (events.length > 500) {
      events.sort((a, b) => b.timestamp - a.timestamp);
      events.length = 500;
    }
    await this.saveEvents(cleanHandle, events);

    // Update user summary stats
    const user = (await this.getUser(cleanHandle)) || {
      handle: cleanHandle,
      displayName: eventData.displayName || cleanHandle,
      avatarUrl: eventData.avatarUrl || '',
      currentScore: 0,
      tier: 'dormant',
      streakDays: 0,
      isPinned: false,
      note: '',
      stats: {
        repliesSent: 0,
        repliesReceived: 0,
        mutualExchanges: 0,
        likes: 0,
        quotes: 0,
        deepScans: 0
      }
    };

    if (eventData.displayName) user.displayName = eventData.displayName;
    if (eventData.avatarUrl) user.avatarUrl = eventData.avatarUrl;

    if (newEvent.type === 'reply_sent') user.stats.repliesSent = (user.stats.repliesSent || 0) + 1;
    if (newEvent.type === 'reply_received') user.stats.repliesReceived = (user.stats.repliesReceived || 0) + 1;
    if (newEvent.type === 'like') user.stats.likes = (user.stats.likes || 0) + 1;
    if (newEvent.type === 'quote') user.stats.quotes = (user.stats.quotes || 0) + 1;
    if (newEvent.isMutual) user.stats.mutualExchanges = (user.stats.mutualExchanges || 0) + 1;

    user.lastInteraction = Math.max(user.lastInteraction || 0, newEvent.timestamp);

    // Recalculate score & streaks with guaranteed upward continuation
    if (typeof BondScoring !== 'undefined') {
      const settings = await this.getSettings();
      let minBoost = 0;
      switch (newEvent.type) {
        case 'reply_mutual': minBoost = 12; break;
        case 'reply_sent': minBoost = newEvent.isMutual ? 12 : 8; break;
        case 'reply_received': minBoost = 8; break;
        case 'quote': minBoost = 6; break;
        case 'like': minBoost = 3; break;
        case 'deep_sync': minBoost = 10; break;
        default: minBoost = 2; break;
      }
      const previousScore = user.currentScore || 0;
      const { score, tier, trend, streakDays, reciprocity } = BondScoring.calculateUserScore(events, settings, previousScore, minBoost);
      user.currentScore = score;
      user.tier = tier.id;
      user.trend = trend;
      user.streakDays = streakDays;
      user.reciprocity = reciprocity;
      user.lastCalculated = Date.now();
    }

    await this.saveUser(cleanHandle, user);
    return user;
  }

  /**
   * Removes an interaction (e.g. unliking a tweet) and recalculates score in real time.
   */
  async removeInteraction(handle, tweetId, type = 'like') {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const events = await this.getEvents(cleanHandle);

    let idx = -1;
    if (tweetId) {
      idx = events.findIndex(e => e.tweetId === tweetId && e.type === type);
    }
    if (idx === -1) {
      // Find the most recent event of this type
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === type) {
          idx = i;
          break;
        }
      }
    }

    if (idx !== -1) {
      events.splice(idx, 1);
      await this.saveEvents(cleanHandle, events);

      const user = await this.getUser(cleanHandle);
      if (user) {
        if (type === 'like' && user.stats.likes > 0) user.stats.likes--;
        if (typeof BondScoring !== 'undefined') {
          const settings = await this.getSettings();
          const { score, tier, trend, streakDays, reciprocity } = BondScoring.calculateUserScore(events, settings, user.currentScore);
          user.currentScore = score;
          user.tier = tier.id;
          user.trend = trend;
          user.streakDays = streakDays;
          user.reciprocity = reciprocity;
          user.lastCalculated = Date.now();
        }
        await this.saveUser(cleanHandle, user);
        return user;
      }
    }
    return null;
  }

  /**
   * Retrieves all tracked users sorted by score descending (pinned first).
   */
  async getAllUsers() {
    return new Promise((resolve) => {
      if (this._hasChromeStorage()) {
        chrome.storage.local.get(null, (allData) => {
          if (chrome.runtime.lastError || !allData) {
            resolve([]);
            return;
          }
          const users = [];
          const myHandle = (this.currentUser || '').toLowerCase().trim();
          for (const [key, value] of Object.entries(allData)) {
            if (key.startsWith('user:') && value && value.handle) {
              const h = value.handle.toLowerCase().trim();
              if (h && h !== myHandle && h !== 'masersuspended' && h !== 'maserbyte') {
                users.push(value);
              }
            }
          }
          users.sort((a, b) => {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
            return (b.currentScore || 0) - (a.currentScore || 0);
          });
          resolve(users);
        });
      } else {
        const users = [];
        const myHandle = (this.currentUser || '').toLowerCase().trim();
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith('bond_user:')) {
            try {
              const u = JSON.parse(localStorage.getItem(k));
              if (u && u.handle) {
                const h = u.handle.toLowerCase().trim();
                if (h && h !== myHandle && h !== 'masersuspended' && h !== 'maserbyte') {
                  users.push(u);
                }
              }
            } catch (e) {}
          }
        }
        users.sort((a, b) => {
          if (a.isPinned && !b.isPinned) return -1;
          if (!a.isPinned && b.isPinned) return 1;
          return (b.currentScore || 0) - (a.currentScore || 0);
        });
        resolve(users);
      }
    });
  }

  async togglePin(handle) {
    const user = await this.getUser(handle);
    if (!user) return false;
    user.isPinned = !user.isPinned;
    await this.saveUser(handle, user);
    return user.isPinned;
  }

  async saveNote(handle, note) {
    const user = await this.getUser(handle);
    if (!user) return false;
    user.note = note ? note.slice(0, 200) : '';
    await this.saveUser(handle, user);
    return true;
  }

  /**
   * Exports entire local database to clean JSON.
   */
  async exportData() {
    return new Promise((resolve) => {
      if (this._hasChromeStorage()) {
        chrome.storage.local.get(null, (items) => {
          resolve({
            app: 'BondScore for X',
            version: '1.1.0',
            exportedAt: new Date().toISOString(),
            data: items || {}
          });
        });
      } else {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith('bond_')) {
            try {
              items[k.replace('bond_', '')] = JSON.parse(localStorage.getItem(k));
            } catch (e) {}
          }
        }
        resolve({
          app: 'BondScore for X',
          version: '1.1.0',
          exportedAt: new Date().toISOString(),
          data: items
        });
      }
    });
  }

  /**
   * Imports valid backup JSON into local storage.
   */
  async importData(importedJson) {
    if (!importedJson || typeof importedJson !== 'object') {
      throw new Error('Invalid JSON format');
    }
    const dataToSet = importedJson.data || importedJson;
    await this._setRaw(dataToSet);
    this.memoryCache.clear();
    this.eventsCache.clear();
    this.settingsCache = null;
    await this.init();
    return true;
  }

  async clearAll() {
    return new Promise((resolve) => {
      if (this._hasChromeStorage()) {
        chrome.storage.local.clear(() => {
          this.memoryCache.clear();
          this.eventsCache.clear();
          this.settingsCache = null;
          resolve();
        });
      } else {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith('bond_')) keysToRemove.push(k);
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        this.memoryCache.clear();
        this.eventsCache.clear();
        this.settingsCache = null;
        resolve();
      }
    });
  }
}

// Global instance attached to window for content script and popup usage
window.bondStorage = new BondStorage();
