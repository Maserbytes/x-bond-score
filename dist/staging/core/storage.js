/**
 * BondScore for X - Local Storage Layer (v1.1.3)
 * Manages interactions, user records, cached scores, notes, streaks, and settings using chrome.storage.local.
 * Completely private, zero-backend, and offline-first.
 */

const DEFAULT_SETTINGS = {
  theme: 'system', // 'system' | 'dark' | 'light'
  decayHalfLifeDays: 14,
  gracePeriodDays: 5,
  trackDirectMessages: true, // 100% private, on-device DM analytics toggle
  fadingThresholdDays: 3,    // Soft fading alert threshold (days inactive)
  dmScoreWeightPercent: 50,  // Weight % for DM score in combined bond
  showBadgesInDMs: true,     // Render badges and header pills inside X DM conversations
  weights: {
    mutualReply: 15,
    dmMutual: 20,
    dmSent: 12,
    dmReceived: 12,
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
    this.dmCache = new Map();
    this.settingsCache = null;
    this.currentUser = null;
    this.knownAccounts = [];
    this.accountsMetadata = {};
    this.isInitialized = false;
    this._setupStorageSync();
  }

  _setupStorageSync() {
    if (this._hasChromeStorage() && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        for (const [key, change] of Object.entries(changes)) {
          // 1. Account switched across tabs or from popup
          if (key === 'currentUser' && change.newValue) {
            const newAcc = (change.newValue || '').toLowerCase().trim();
            if (newAcc && newAcc !== this.currentUser) {
              const prev = this.currentUser;
              this.currentUser = newAcc;
              this.memoryCache.clear();
              this.eventsCache.clear();
              this.dmCache.clear();
              if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
                window.dispatchEvent(new CustomEvent('bondscore:account_switched', {
                  detail: { previousAccount: prev, currentAccount: newAcc }
                }));
              }
            }
          } else if (key === 'knownAccounts') {
            this.knownAccounts = Array.isArray(change.newValue) ? change.newValue : [];
          } else if (key === 'accountsMetadata') {
            this.accountsMetadata = change.newValue || {};
          } else if (key === 'settings') {
            this.settingsCache = Object.assign({}, DEFAULT_SETTINGS, change.newValue || {});
          } else {
            // Handle updates isolated to current active account
            const accPrefix = this.currentUser ? `acc:${this.currentUser}:` : '';
            if (accPrefix && key.startsWith(accPrefix)) {
              const subKey = key.slice(accPrefix.length);
              if (subKey.startsWith('user:')) {
                const handle = subKey.replace('user:', '');
                if (change.newValue) {
                  this.memoryCache.set(handle, change.newValue);
                } else {
                  this.memoryCache.delete(handle);
                }
                if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('bondscore:updated', {
                    detail: { handle, user: change.newValue, score: change.newValue ? change.newValue.currentScore : 0 }
                  }));
                }
              } else if (subKey.startsWith('events:')) {
                const handle = subKey.replace('events:', '');
                if (change.newValue) {
                  this.eventsCache.set(handle, change.newValue);
                } else {
                  this.eventsCache.delete(handle);
                }
              } else if (subKey.startsWith('dm:')) {
                const convId = subKey.replace('dm:', '');
                if (change.newValue) {
                  this.dmCache.set(convId, change.newValue);
                } else {
                  this.dmCache.delete(convId);
                }
                if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('bondscore:dm_updated', {
                    detail: { convId, conversation: change.newValue }
                  }));
                }
              }
            } else if (!this.currentUser && key.startsWith('user:')) {
              // Legacy non-prefixed fallback
              const handle = key.replace('user:', '');
              if (change.newValue) {
                this.memoryCache.set(handle, change.newValue);
              } else {
                this.memoryCache.delete(handle);
              }
              if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
                window.dispatchEvent(new CustomEvent('bondscore:updated', {
                  detail: { handle, user: change.newValue, score: change.newValue ? change.newValue.currentScore : 0 }
                }));
              }
            } else if (!this.currentUser && key.startsWith('dm:')) {
              const convId = key.replace('dm:', '');
              if (change.newValue) {
                this.dmCache.set(convId, change.newValue);
              } else {
                this.dmCache.delete(convId);
              }
              if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
                window.dispatchEvent(new CustomEvent('bondscore:dm_updated', {
                  detail: { convId, conversation: change.newValue }
                }));
              }
            }
          }
        }
      });
    }
  }

  async init() {
    if (this.isInitialized) return;
    try {
      const data = await this._getRaw(['currentUser', 'knownAccounts', 'accountsMetadata', 'settings']);
      this.currentUser = (data.currentUser || '').toLowerCase().trim() || null;
      this.knownAccounts = Array.isArray(data.knownAccounts) ? data.knownAccounts : [];
      if (this.currentUser && !this.knownAccounts.includes(this.currentUser)) {
        this.knownAccounts.push(this.currentUser);
      }
      this.accountsMetadata = data.accountsMetadata || {};
      this.settingsCache = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
      if (this.settingsCache.gracePeriodDays === 2) {
        this.settingsCache.gracePeriodDays = 5;
        await this._setRaw({ settings: this.settingsCache });
      }
      this.isInitialized = true;

      // Automatically migrate legacy non-namespaced keys into current account if known
      if (this.currentUser) {
        await this._migrateLegacyDataIfNeeded(this.currentUser);
      }
    } catch (err) {
      console.warn('[BondScore] Storage init error:', err);
      this.settingsCache = Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  _resolveActiveAccount(account = null) {
    if (account && account.toLowerCase().trim() !== 'you') {
      return account.replace(/^@/, '').toLowerCase().trim();
    }
    if (this.currentUser && this.currentUser.toLowerCase().trim() !== 'you') {
      return this.currentUser.replace(/^@/, '').toLowerCase().trim();
    }
    if (typeof window !== 'undefined' && window.interactionDetector && window.interactionDetector.currentUser) {
      const detected = window.interactionDetector.currentUser.replace(/^@/, '').toLowerCase().trim();
      if (detected && detected !== 'you') {
        this.currentUser = detected;
        return this.currentUser;
      }
    }
    return '';
  }

  _getScoringEngine() {
    if (typeof BondScoring !== 'undefined') return BondScoring;
    if (typeof window !== 'undefined' && window.BondScoring) return window.BondScoring;
    if (typeof globalThis !== 'undefined' && globalThis.BondScoring) return globalThis.BondScoring;
    return null;
  }

  /**
   * Seamlessly migrates legacy un-scoped user: and events: keys into acc:<currentUser>:
   * Ensures zero data loss and safely merges without deleting uncommitted data.
   */
  async _migrateLegacyDataIfNeeded(account) {
    if (!account) return;
    const cleanAccount = account.toLowerCase().trim();
    return new Promise((resolve) => {
      if (this._hasChromeStorage()) {
        chrome.storage.local.get(null, async (allData) => {
          if (!allData) return resolve();
          const toSet = {};
          for (const [key, val] of Object.entries(allData)) {
            if (!key.startsWith('acc:') && (key.startsWith('user:') || key.startsWith('events:'))) {
              const newKey = `acc:${cleanAccount}:${key}`;
              if (key.startsWith('events:') && Array.isArray(val)) {
                const existingEvents = allData[newKey] || [];
                const merged = [...existingEvents];
                for (const e of val) {
                  if (!merged.some(m => m.id === e.id || (m.tweetId && m.tweetId === e.tweetId))) {
                    merged.push(e);
                  }
                }
                toSet[newKey] = merged;
              } else if (!allData[newKey]) {
                toSet[newKey] = val;
              }
            }
          }
          if (Object.keys(toSet).length > 0) {
            await this._setRaw(toSet);
          }
          resolve();
        });
      } else {
        const toSet = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith('bond_user:') || k.startsWith('bond_events:')) {
            const rawKey = k.replace('bond_', '');
            if (!rawKey.startsWith('acc:')) {
              try {
                const val = JSON.parse(localStorage.getItem(k));
                toSet[`acc:${cleanAccount}:${rawKey}`] = val;
              } catch (e) {}
            }
          }
        }
        for (const [k, v] of Object.entries(toSet)) {
          localStorage.setItem(`bond_${k}`, JSON.stringify(v));
        }
        resolve();
      }
    });
  }

  _hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && !!chrome.storage.local;
  }

  _getRaw(keys) {
    return new Promise((resolve, reject) => {
      if (this._hasChromeStorage()) {
        chrome.storage.local.get(keys, (res) => {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(res || {});
          }
        });
      } else {
        const res = {};
        if (keys === null) {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith('bond_')) {
              const cleanK = k.replace(/^bond_/, '');
              try {
                res[cleanK] = JSON.parse(localStorage.getItem(k));
              } catch (e) {}
            }
          }
          resolve(res);
          return;
        }
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

  _getAllRaw() {
    return this._getRaw(null);
  }

  _setRaw(items) {
    return new Promise((resolve, reject) => {
      if (this._hasChromeStorage()) {
        chrome.storage.local.set(items, () => {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
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

  async getCurrentUser(forceRefresh = false) {
    if (!this.currentUser || forceRefresh) {
      const res = await this._getRaw(['currentUser']);
      this.currentUser = (res.currentUser || '').toLowerCase().trim() || null;
    }
    return this.currentUser;
  }

  /**
   * Switches active account, isolating caches and storage queries.
   */
  async switchAccount(handle, metadata = null) {
    if (!handle) return false;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    if (!cleanHandle) return false;

    const previousUser = this.currentUser;
    this.currentUser = cleanHandle;

    if (!Array.isArray(this.knownAccounts)) this.knownAccounts = [];
    if (!this.knownAccounts.includes(cleanHandle)) {
      this.knownAccounts.push(cleanHandle);
    }

    if (!this.accountsMetadata) this.accountsMetadata = {};
    if (metadata || !this.accountsMetadata[cleanHandle]) {
      this.accountsMetadata[cleanHandle] = {
        handle: cleanHandle,
        displayName: (metadata && metadata.displayName) || (this.accountsMetadata[cleanHandle] && this.accountsMetadata[cleanHandle].displayName) || cleanHandle,
        avatarUrl: (metadata && metadata.avatarUrl) || (this.accountsMetadata[cleanHandle] && this.accountsMetadata[cleanHandle].avatarUrl) || '',
        lastActive: Date.now()
      };
    } else {
      this.accountsMetadata[cleanHandle].lastActive = Date.now();
    }

    // Flush in-memory caches to prevent any cross-account data leakage
    this.memoryCache.clear();
    this.eventsCache.clear();

    await this._setRaw({
      currentUser: cleanHandle,
      knownAccounts: this.knownAccounts,
      accountsMetadata: this.accountsMetadata
    });

    // Check if legacy un-scoped data exists that belongs to this account
    await this._migrateLegacyDataIfNeeded(cleanHandle);

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bondscore:account_switched', {
        detail: { previousAccount: previousUser, currentAccount: cleanHandle }
      }));
    }

    console.log(`[BondScore Storage] Active account switched: @${cleanHandle}`);
    return true;
  }

  async setCurrentUser(handle, metadata = null) {
    return this.switchAccount(handle, metadata);
  }

  /**
   * Returns list of all known accounts with metadata and active state.
   */
  async getKnownAccounts(forceRefresh = false) {
    if (!this.knownAccounts || this.knownAccounts.length === 0 || forceRefresh) {
      const data = await this._getRaw(['knownAccounts', 'accountsMetadata', 'currentUser']);
      this.knownAccounts = Array.isArray(data.knownAccounts) ? data.knownAccounts : [];
      this.accountsMetadata = data.accountsMetadata || {};
      if (data.currentUser) {
        this.currentUser = (data.currentUser || '').toLowerCase().trim();
        if (!this.knownAccounts.includes(this.currentUser)) {
          this.knownAccounts.push(this.currentUser);
        }
      }
    }
    const cur = (this.currentUser || '').toLowerCase().trim();
    return {
      activeAccount: cur,
      accounts: this.knownAccounts.map(h => ({
        handle: h,
        displayName: (this.accountsMetadata[h] && this.accountsMetadata[h].displayName) || h,
        avatarUrl: (this.accountsMetadata[h] && this.accountsMetadata[h].avatarUrl) || '',
        lastActive: (this.accountsMetadata[h] && this.accountsMetadata[h].lastActive) || 0,
        isActive: h === cur
      }))
    };
  }

  async getSettings() {
    if (!this.settingsCache) {
      const res = await this._getRaw(['settings']);
      this.settingsCache = Object.assign({}, DEFAULT_SETTINGS, res.settings || {});
      if (this.settingsCache.gracePeriodDays === 2) {
        this.settingsCache.gracePeriodDays = 5;
        await this._setRaw({ settings: this.settingsCache });
      }
    }
    return this.settingsCache;
  }

  async updateSettings(newSettings) {
    this.settingsCache = Object.assign({}, this.settingsCache || DEFAULT_SETTINGS, newSettings);
    await this._setRaw({ settings: this.settingsCache });
    return this.settingsCache;
  }

  _userKey(handle, account = null) {
    const h = (handle || '').replace(/^@/, '').toLowerCase().trim();
    const acc = this._resolveActiveAccount(account);
    return acc ? `acc:${acc}:user:${h}` : `user:${h}`;
  }

  _eventsKey(handle, account = null) {
    const h = (handle || '').replace(/^@/, '').toLowerCase().trim();
    const acc = this._resolveActiveAccount(account);
    return acc ? `acc:${acc}:events:${h}` : `events:${h}`;
  }

  _dmKey(convId, account = null) {
    const id = (convId || '').toLowerCase().trim();
    const acc = this._resolveActiveAccount(account);
    return acc ? `acc:${acc}:dm:${id}` : `dm:${id}`;
  }

  async getUser(handle, forceRefresh = false, account = null) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const isCurrentAcc = !activeAccount || activeAccount === (this.currentUser || '');

    if (!forceRefresh && isCurrentAcc && this.memoryCache.has(cleanHandle)) {
      return this.memoryCache.get(cleanHandle);
    }

    // 1. Primary lookup under active account
    const key = this._userKey(cleanHandle, activeAccount);
    const res = await this._getRaw([key]);
    let user = res[key] || null;

    // 2. Fallback to legacy un-scoped key
    if (!user) {
      const legacyKey = `user:${cleanHandle}`;
      const legacyRes = await this._getRaw([legacyKey]);
      if (legacyRes[legacyKey]) {
        user = legacyRes[legacyKey];
        if (activeAccount) {
          await this._setRaw({ [key]: user });
        }
      }
    }

    // 3. Fallback to search across storage ONLY if no active account is resolved yet
    if (!user && !activeAccount && this._hasChromeStorage()) {
      const allData = await new Promise((resolve) => {
        chrome.storage.local.get(null, (d) => resolve(d || {}));
      });
      for (const [k, v] of Object.entries(allData)) {
        if (k.endsWith(`:user:${cleanHandle}`) && v && v.handle) {
          user = v;
          break;
        }
      }
    }

    if (user && isCurrentAcc) {
      this.memoryCache.set(cleanHandle, user);
    }
    return user;
  }

  async saveUser(handle, userData, account = null) {
    if (!handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const key = this._userKey(cleanHandle, activeAccount);

    const existing = (await this.getUser(cleanHandle, false, activeAccount)) || {
      handle: cleanHandle,
      displayName: cleanHandle,
      avatarUrl: '',
      currentScore: 0,
      tier: 'dormant',
      crmStatus: 'Stranger',
      crmStatusId: 'stranger',
      streakDays: 0,
      isPinned: false,
      note: '',
      lastInteraction: Date.now(),
      lastCalculated: Date.now(),
      trend: 'steady',
      stats: {
        repliesSent: 0,
        repliesReceived: 0,
        dmsSent: 0,
        dmsReceived: 0,
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

    if (!activeAccount || activeAccount === (this.currentUser || '')) {
      this.memoryCache.set(cleanHandle, updated);
    }
    await this._setRaw({ [key]: updated });

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bondscore:updated', {
        detail: { handle: cleanHandle, user: updated, score: updated.currentScore, account: activeAccount }
      }));
    }
    return updated;
  }

  async getEvents(handle, account = null) {
    if (!handle) return [];
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const isCurrentAcc = !activeAccount || activeAccount === (this.currentUser || '');

    if (isCurrentAcc && this.eventsCache.has(cleanHandle)) {
      return this.eventsCache.get(cleanHandle);
    }

    // 1. Primary lookup
    const key = this._eventsKey(cleanHandle, activeAccount);
    const res = await this._getRaw([key]);
    let events = res[key] || [];

    // 2. Fallback to legacy un-scoped key
    if ((!events || events.length === 0)) {
      const legacyKey = `events:${cleanHandle}`;
      const legacyRes = await this._getRaw([legacyKey]);
      if (legacyRes[legacyKey] && legacyRes[legacyKey].length > 0) {
        events = legacyRes[legacyKey];
        if (activeAccount) {
          await this._setRaw({ [key]: events });
        }
      }
    }

    // 3. Fallback across all accounts ONLY if no active account is resolved yet
    if ((!events || events.length === 0) && !activeAccount && this._hasChromeStorage()) {
      const allData = await new Promise((resolve) => {
        chrome.storage.local.get(null, (d) => resolve(d || {}));
      });
      for (const [k, v] of Object.entries(allData)) {
        if (k.endsWith(`:events:${cleanHandle}`) && Array.isArray(v) && v.length > 0) {
          events = v;
          break;
        }
      }
    }

    if (isCurrentAcc) {
      this.eventsCache.set(cleanHandle, events);
    }
    return events;
  }

  async saveEvents(handle, events, account = null) {
    if (!handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const key = this._eventsKey(cleanHandle, activeAccount);

    if (!activeAccount || activeAccount === (this.currentUser || '')) {
      this.eventsCache.set(cleanHandle, events);
    }
    await this._setRaw({ [key]: events });
  }

  _buildDirectionalStats(events, existingStats = {}) {
    const stats = {
      ...existingStats,
      repliesSent: 0, repliesReceived: 0,
      dmsSent: 0, dmsReceived: 0,
      likes: 0, likesSent: 0, likesReceived: 0,
      quotes: 0, quotesSent: 0, quotesReceived: 0,
      mentionsSent: 0, mentionsReceived: 0, mutualExchanges: 0
    };
    for (const evt of events || []) {
      const inbound = evt.direction === 'inbound' || ['reply_received', 'dm_received', 'mention'].includes(evt.type);
      if (evt.type === 'reply_mutual' || evt.type === 'dm_mutual') {
        if (evt.type === 'reply_mutual') { stats.repliesSent++; stats.repliesReceived++; }
        if (evt.type === 'dm_mutual') { stats.dmsSent++; stats.dmsReceived++; }
      } else if (['reply_sent', 'reply_received', 'reply_thread'].includes(evt.type)) {
        stats[inbound ? 'repliesReceived' : 'repliesSent']++;
      } else if (['dm_sent', 'dm_received'].includes(evt.type)) {
        stats[inbound ? 'dmsReceived' : 'dmsSent']++;
      } else if (evt.type === 'like') {
        stats.likes++;
        stats[inbound ? 'likesReceived' : 'likesSent']++;
      } else if (evt.type === 'quote') {
        stats.quotes++;
        stats[inbound ? 'quotesReceived' : 'quotesSent']++;
      } else if (evt.type === 'mention') {
        stats[inbound ? 'mentionsReceived' : 'mentionsSent']++;
      }
      if (evt.isMutual || evt.type === 'reply_mutual' || evt.type === 'dm_mutual' || evt.type === 'signal_mutual_follow' || evt.type === 'signal_follow_back') {
        stats.mutualExchanges++;
      }
    }
    return stats;
  }

  async rebuildDirectionalStats(handle, account = null) {
    const user = await this.getUser(handle, false, account);
    if (!user) return null;
    user.stats = this._buildDirectionalStats(await this.getEvents(handle, account), user.stats || {});
    return await this.saveUser(handle, user, account);
  }

  /**
   * Records a new interaction event, deduplicating by event ID or tweet ID.
   * Isolated to the active account.
   */
  async recordInteraction(handle, eventData, account = null) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }

    // Prevent tracking self interactions
    if (activeAccount && cleanHandle === activeAccount) {
      return null;
    }
    if (cleanHandle === 'masersuspended' || cleanHandle === 'maserbyte') {
      // Don't track system handles unless user is testing with them
    }

    const events = await this.getEvents(cleanHandle, activeAccount);
    const eventId = eventData.id || `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Check duplicate by tweetId if provided
    if (eventData.tweetId) {
      const exists = events.some(e => e.tweetId === eventData.tweetId);
      if (exists) {
        return await this.getUser(cleanHandle, false, activeAccount);
      }
    }

    const newEvent = {
      id: eventId,
      timestamp: eventData.timestamp || Date.now(),
      type: eventData.type || 'reply_sent',
      tweetId: eventData.tweetId || null,
      textSnippet: eventData.textSnippet ? eventData.textSnippet.slice(0, 140) : null,
      isMutual: !!eventData.isMutual,
      isThread: !!eventData.isThread,
      direction: eventData.direction || (
        ['reply_received', 'dm_received', 'mention'].includes(eventData.type) ||
        eventData.type === 'signal_follow_back'
          ? 'inbound'
          : 'outbound'
      ),
      weight: eventData.weight || null
    };

    events.push(newEvent);
    // Keep last 500 events per user to maintain high performance
    if (events.length > 500) {
      events.sort((a, b) => b.timestamp - a.timestamp);
      events.length = 500;
    }
    await this.saveEvents(cleanHandle, events, activeAccount);

    // Update user summary stats
    const user = (await this.getUser(cleanHandle, false, activeAccount)) || {
      handle: cleanHandle,
      displayName: eventData.displayName || cleanHandle,
      avatarUrl: eventData.avatarUrl || '',
      currentScore: 0,
      tier: 'dormant',
      crmStatus: 'Stranger',
      crmStatusId: 'stranger',
      streakDays: 0,
      isPinned: false,
      note: '',
      stats: {
        repliesSent: 0,
        repliesReceived: 0,
        dmsSent: 0,
        dmsReceived: 0,
        mutualExchanges: 0,
        likes: 0,
        quotes: 0,
        deepScans: 0
      }
    };

    if (eventData.displayName) user.displayName = eventData.displayName;
    if (eventData.avatarUrl) user.avatarUrl = eventData.avatarUrl;
    if (!user.stats) user.stats = {};

    // Rebuild counters from the ledger, including for existing installations.
    user.stats = this._buildDirectionalStats(events, user.stats);

    user.lastInteraction = Math.max(user.lastInteraction || 0, newEvent.timestamp);

    // Recalculate from the event ledger so recent activity raises the score and inactivity can decay it.
    const scoringEngine = this._getScoringEngine();
    if (scoringEngine) {
      const settings = await this.getSettings();
      const previousScore = user.currentScore || 0;
      const { score, tier, crmStatus, trend, streakDays, reciprocity, recencyBoost, twoWayMultiplier, qualityMetrics } = scoringEngine.calculateUserScore(events, settings, previousScore);
      user.currentScore = score;
      user.tier = tier.id;
      user.crmStatus = crmStatus ? crmStatus.label : tier.crmStatus || 'Stranger';
      user.crmStatusId = crmStatus ? crmStatus.id : 'stranger';
      user.crmStatusData = crmStatus || null;
      user.trend = trend;
      user.streakDays = streakDays;
      user.reciprocity = reciprocity;
      user.recencyBoost = recencyBoost;
      user.twoWayMultiplier = twoWayMultiplier;
      user.qualityMetrics = qualityMetrics;
      user.lastCalculated = Date.now();
    }

    await this.saveUser(cleanHandle, user, activeAccount);
    return user;
  }

  /**
   * Observes and logs relationship signals for the active account:
   * - Mutual follow changes
   * - Follow-backs
   * - Unfollows
   * - Possible blocks
   */
  async recordRelationshipSignal(handle, data = {}, account = this.currentUser) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    let activeAccount = (account || this.currentUser || '').toLowerCase().trim();
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const user = (await this.getUser(cleanHandle, false, activeAccount)) || {
      handle: cleanHandle,
      displayName: cleanHandle,
      avatarUrl: '',
      currentScore: 0,
      tier: 'dormant',
      crmStatus: 'Stranger',
      crmStatusId: 'stranger',
      streakDays: 0,
      isPinned: false,
      note: '',
      signals: {},
      stats: { repliesSent: 0, repliesReceived: 0, dmsSent: 0, dmsReceived: 0, mutualExchanges: 0, likes: 0, quotes: 0, deepScans: 0 }
    };

    const prevSignals = user.signals || {};
    let signalLogged = false;

    // 1. Possible Block Detected
    if (data.isBlocked && !prevSignals.isBlocked) {
      await this.recordInteraction(cleanHandle, {
        type: 'signal_blocked',
        timestamp: Date.now(),
        textSnippet: '🚫 Possible block detected from @' + cleanHandle,
        isMutual: false
      }, activeAccount);
      signalLogged = true;
    }

    // 2. Follow-back Detected (They previously didn't follow you, now they do)
    if (data.theyFollowYou === true && prevSignals.theyFollowYou === false) {
      await this.recordInteraction(cleanHandle, {
        type: 'signal_follow_back',
        timestamp: Date.now(),
        textSnippet: '🎉 @' + cleanHandle + ' followed you back!',
        isMutual: true
      }, activeAccount);
      signalLogged = true;
    }

    // 3. Unfollowed Detected (They previously followed you, now they don't)
    if (data.theyFollowYou === false && prevSignals.theyFollowYou === true) {
      await this.recordInteraction(cleanHandle, {
        type: 'signal_unfollowed',
        timestamp: Date.now(),
        textSnippet: '⚠️ @' + cleanHandle + ' is no longer following you',
        isMutual: false
      }, activeAccount);
      signalLogged = true;
    }

    // 4. Mutual Follow Established
    const resolvedTheyFollow = data.theyFollowYou !== null && data.theyFollowYou !== undefined ? data.theyFollowYou : !!prevSignals.theyFollowYou;
    const resolvedYouFollow = data.youFollowThem !== null && data.youFollowThem !== undefined ? data.youFollowThem : !!prevSignals.youFollowThem;
    const isNowMutual = !!(resolvedTheyFollow && resolvedYouFollow);
    if (isNowMutual && !prevSignals.isMutual) {
      if (!signalLogged) {
        await this.recordInteraction(cleanHandle, {
          type: 'signal_mutual_follow',
          timestamp: Date.now(),
          textSnippet: '🤝 Mutual follow active with @' + cleanHandle,
          isMutual: true
        }, activeAccount);
        signalLogged = true;
      }
    }

    // Only persist if signals actually changed or a new signal event was logged
    const prevSignalsObj = user.signals || {};
    const signalsUnchanged = (
      prevSignalsObj.theyFollowYou === resolvedTheyFollow &&
      prevSignalsObj.youFollowThem === resolvedYouFollow &&
      prevSignalsObj.isMutual === isNowMutual &&
      prevSignalsObj.isBlocked === !!data.isBlocked
    );

    const metadataChanged = (!!data.displayName && data.displayName !== user.displayName) ||
      (!!data.avatarUrl && data.avatarUrl !== user.avatarUrl);

    if (signalsUnchanged && !signalLogged && !metadataChanged) {
      return user;
    }

    // Update signal metadata on user record
    user.signals = {
      theyFollowYou: resolvedTheyFollow,
      youFollowThem: resolvedYouFollow,
      isMutual: isNowMutual,
      isBlocked: !!data.isBlocked,
      lastCheckedAt: Date.now()
    };

    if (data.displayName) user.displayName = data.displayName;
    if (data.avatarUrl) user.avatarUrl = data.avatarUrl;

    await this.saveUser(cleanHandle, user, activeAccount);
    return user;
  }

  /**
   * Removes an interaction (e.g. unliking a tweet) and recalculates score in real time.
   */
  async removeInteraction(handle, tweetId, type = 'like', account = this.currentUser) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    let activeAccount = (account || this.currentUser || '').toLowerCase().trim();
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const events = await this.getEvents(cleanHandle, activeAccount);

    let idx = -1;
    if (tweetId) {
      idx = events.findIndex(e => e.tweetId === tweetId && e.type === type);
    }
    if (idx === -1) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === type) {
          idx = i;
          break;
        }
      }
    }

    if (idx !== -1) {
      events.splice(idx, 1);
      await this.saveEvents(cleanHandle, events, activeAccount);

      const user = await this.getUser(cleanHandle, false, activeAccount);
      if (user) {
        if (type === 'like' && user.stats.likes > 0) user.stats.likes--;
        const scoringEngine = this._getScoringEngine();
        if (scoringEngine) {
          const settings = await this.getSettings();
          const { score, tier, trend, streakDays, reciprocity } = scoringEngine.calculateUserScore(events, settings, user.currentScore);
          user.currentScore = score;
          user.tier = tier.id;
          user.trend = trend;
          user.streakDays = streakDays;
          user.reciprocity = reciprocity;
          user.lastCalculated = Date.now();
        }
        await this.saveUser(cleanHandle, user, activeAccount);
        return user;
      }
    }
    return null;
  }

  /**
   * Retrieves all tracked users for the given account (or active account),
   * sorted by score descending (pinned first).
   */
  async getAllUsers(account = this.currentUser) {
    return new Promise((resolve) => {
      let targetAccount = (account || this.currentUser || '').toLowerCase().trim();

      if (this._hasChromeStorage()) {
        chrome.storage.local.get(null, (allData) => {
          if ((typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) || !allData) {
            resolve([]);
            return;
          }

          // If targetAccount was unpopulated, resolve from storage data
          if (!targetAccount && allData.currentUser) {
            targetAccount = (allData.currentUser || '').toLowerCase().trim();
          }
          if (!targetAccount && Array.isArray(allData.knownAccounts) && allData.knownAccounts.length > 0) {
            targetAccount = allData.knownAccounts[0].toLowerCase().trim();
          }
          if (!targetAccount) {
            for (const k of Object.keys(allData)) {
              const m = k.match(/^acc:([^:]+):user:/);
              if (m && m[1]) {
                targetAccount = m[1].toLowerCase().trim();
                break;
              }
            }
          }

          const users = [];
          for (const [key, value] of Object.entries(allData)) {
            let isMatch = false;
            if (targetAccount) {
              isMatch = key.startsWith(`acc:${targetAccount}:user:`);
            } else {
              isMatch = key.startsWith('user:') && !key.startsWith('acc:');
            }

            if (isMatch && value && value.handle) {
              const h = value.handle.toLowerCase().trim();
              if (h && (!targetAccount || h !== targetAccount)) {
                if (!value.crmStatusData && typeof BondScoring !== 'undefined') {
                  const sSent = (value.stats && ((value.stats.repliesSent || 0) + (value.stats.dmsSent || 0) + (value.stats.likesSent ?? value.stats.likes ?? 0) + (value.stats.quotesSent || 0) + (value.stats.mentionsSent || 0))) || 0;
                  const sRecv = (value.stats && ((value.stats.repliesReceived || 0) + (value.stats.dmsReceived || 0) + (value.stats.likesReceived || 0) + (value.stats.quotesReceived || 0) + (value.stats.mentionsReceived || 0))) || 0;
                  value.crmStatusData = BondScoring.calculateCRMStatus(value.currentScore || 0, sSent, sRecv, value.streakDays || 0);
                  value.crmStatus = value.crmStatusData.label;
                  value.crmStatusId = value.crmStatusData.id;
                }
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
        if (!targetAccount) {
          try {
            const raw = localStorage.getItem('bond_currentUser');
            if (raw) targetAccount = JSON.parse(raw).toLowerCase().trim();
          } catch (e) {}
        }
        if (!targetAccount) {
          for (let i = 0; i < localStorage.length; i++) {
            const m = localStorage.key(i).match(/^bond_acc:([^:]+):user:/);
            if (m && m[1]) {
              targetAccount = m[1].toLowerCase().trim();
              break;
            }
          }
        }

        const users = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          let isMatch = false;
          if (targetAccount) {
            isMatch = k.startsWith(`bond_acc:${targetAccount}:user:`);
          } else {
            isMatch = k.startsWith('bond_user:') && !k.startsWith('bond_acc:');
          }
          if (isMatch) {
            try {
              const u = JSON.parse(localStorage.getItem(k));
              if (u && u.handle) {
                const h = u.handle.toLowerCase().trim();
                if (h && (!targetAccount || h !== targetAccount)) {
                  if (!u.crmStatusData && typeof BondScoring !== 'undefined') {
                    const sSent = (u.stats && ((u.stats.repliesSent || 0) + (u.stats.dmsSent || 0) + (u.stats.likesSent ?? u.stats.likes ?? 0) + (u.stats.quotesSent || 0) + (u.stats.mentionsSent || 0))) || 0;
                    const sRecv = (u.stats && ((u.stats.repliesReceived || 0) + (u.stats.dmsReceived || 0) + (u.stats.likesReceived || 0) + (u.stats.quotesReceived || 0) + (u.stats.mentionsReceived || 0))) || 0;
                    u.crmStatusData = BondScoring.calculateCRMStatus(u.currentScore || 0, sSent, sRecv, u.streakDays || 0);
                    u.crmStatus = u.crmStatusData.label;
                    u.crmStatusId = u.crmStatusData.id;
                  }
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

  async togglePin(handle, account = this.currentUser) {
    const user = await this.getUser(handle, false, account);
    if (!user) return false;
    user.isPinned = !user.isPinned;
    await this.saveUser(handle, user, account);
    return user.isPinned;
  }

  async saveNote(handle, note, account = this.currentUser) {
    const user = await this.getUser(handle, false, account);
    if (!user) return false;
    user.note = note ? note.slice(0, 200) : '';
    await this.saveUser(handle, user, account);
    return true;
  }

  /**
   * Evaluates and records key relationship milestones into the conversation's memory ledger.
   */
  _evaluateChatMilestones(conv, prevRankName = null) {
    if (!conv) return;
    if (!Array.isArray(conv.memories)) conv.memories = [];
    const now = Date.now();
    const lifetime = conv.lifetimeTotal || conv.totalCount || 0;
    const streak = conv.dailyStreak || 0;
    const rank = conv.rank ? conv.rank.name : null;

    // 1. Initial Connection Milestone
    if (!conv.memories.some(m => m.type === 'first_seen')) {
      conv.memories.push({
        id: `mem_first_${conv.convId}`,
        type: 'first_seen',
        title: 'Chat Memory Established',
        description: `BondScore began remembering chats with ${conv.title || conv.convId}.`,
        timestamp: conv.firstSeenTimestamp || now,
        badge: '🌱'
      });
    }

    // 2. Volume Milestones
    const volumeCheckpoints = [10, 25, 50, 100, 250, 500, 1000];
    for (const cp of volumeCheckpoints) {
      if (lifetime >= cp && !conv.memories.some(m => m.type === 'volume' && m.milestoneValue === cp)) {
        conv.memories.push({
          id: `mem_vol_${cp}_${conv.convId}`,
          type: 'volume',
          milestoneValue: cp,
          title: `${cp} Messages Exchanged!`,
          description: `Passed the ${cp} total message milestone across all conversations.`,
          timestamp: now,
          badge: '💬'
        });
      }
    }

    // 3. Streak Milestones
    const streakCheckpoints = [3, 7, 14, 30, 60, 100];
    for (const scp of streakCheckpoints) {
      if (streak >= scp && !conv.memories.some(m => m.type === 'streak' && m.milestoneValue === scp)) {
        conv.memories.push({
          id: `mem_streak_${scp}_${conv.convId}`,
          type: 'streak',
          milestoneValue: scp,
          title: `🔥 ${scp}-Day Chat Streak!`,
          description: `Maintained consecutive daily messaging for ${scp} full days!`,
          timestamp: now,
          badge: '🔥'
        });
      }
    }

    // 4. Rank Promotion Milestones
    if (rank && prevRankName && rank !== prevRankName) {
      const rankBadge = conv.rank ? conv.rank.emoji : '⭐';
      conv.memories.push({
        id: `mem_rank_${conv.rank.id || 'tier'}_${now}`,
        type: 'rank_upgrade',
        title: `Promoted to ${rank}!`,
        description: `Relationship evolved to ${rank} (${Math.round(conv.bondScore || 0)} Bond Score).`,
        timestamp: now,
        badge: rankBadge
      });
    }

    // Cap memories array at 50 to preserve local storage budget
    if (conv.memories.length > 50) {
      conv.memories = conv.memories.slice(-50);
    }
  }

  /**
   * Retrieves a DM conversation record by conversation ID or recipient handle.
   */
  async getDmConversation(convId, forceRefresh = false, account = null) {
    if (!convId) return null;
    const cleanId = convId.toLowerCase().trim();
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const isCurrentAcc = !activeAccount || activeAccount === (this.currentUser || '');

    if (!forceRefresh && isCurrentAcc && this.dmCache.has(cleanId)) {
      return this.dmCache.get(cleanId);
    }

    const key = this._dmKey(cleanId, activeAccount);
    const res = await this._getRaw([key]);
    let conv = res[key] || null;

    // Fallback 1: check legacy un-scoped key
    if (!conv) {
      const legacyKey = `dm:${cleanId}`;
      const legacyRes = await this._getRaw([legacyKey]);
      if (legacyRes[legacyKey]) {
        conv = legacyRes[legacyKey];
        if (activeAccount) {
          await this._setRaw({ [key]: conv });
        }
      }
    }

    // Fallback 2: search across any account if not found
    if (!conv && this._hasChromeStorage()) {
      const allData = await this._getAllRaw();
      for (const [k, v] of Object.entries(allData)) {
        if (k.endsWith(`:dm:${cleanId}`) && v && v.convId) {
          conv = v;
          if (activeAccount) {
            await this._setRaw({ [key]: conv });
          }
          break;
        }
      }
    }

    // Fallback 3: search by participant handle if convId is handle
    if (!conv) {
      const allDms = await this.getAllDmConversations(activeAccount);
      conv = allDms.find(d => {
        if (!d.isGroup && d.participants && d.participants.includes(cleanId.replace(/^@/, ''))) return true;
        if (d.convId && d.convId.toLowerCase().includes(cleanId)) return true;
        return false;
      }) || null;
    }

    if (conv && isCurrentAcc) {
      this.dmCache.set(cleanId, conv);
    }
    return conv;
  }

  /**
   * Saves or updates a DM conversation record.
   */
  async saveDmConversation(convId, convData, account = null) {
    if (!convId) return null;
    const cleanId = convId.toLowerCase().trim();
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const key = this._dmKey(cleanId, activeAccount);

    const existing = (await this.getDmConversation(cleanId, false, activeAccount)) || {
      convId: cleanId,
      isGroup: false,
      title: cleanId,
      participants: [],
      participantDetails: {},
      sentCount: 0,
      receivedCount: 0,
      totalCount: 0,
      lifetimeSent: 0,
      lifetimeReceived: 0,
      lifetimeTotal: 0,
      firstSeenTimestamp: Date.now(),
      lastSentTimestamp: 0,
      lastReceivedTimestamp: 0,
      lastMessageTimestamp: Date.now(),
      lastSenderHandle: '',
      waitingForUserReply: false,
      waitingSinceTimestamp: null,
      replyTimes: [],
      medianReplyTimeMs: 0,
      replyRate: 100,
      dailyStreak: 0,
      allTimeLongestStreak: 0,
      highestRankAchieved: null,
      bondScore: 0,
      rank: null,
      isFading: false,
      memberMessageCounts: {},
      groupEnergyScore: 0,
      groupEnergyLevel: null,
      isDying: false,
      memories: [],
      recordedMessageIds: []
    };

    const prevRankName = existing.rank ? existing.rank.name : null;

    const updated = {
      ...existing,
      ...convData,
      convId: cleanId,
      firstSeenTimestamp: existing.firstSeenTimestamp || convData.firstSeenTimestamp || Date.now(),
      lifetimeSent: Math.max(existing.lifetimeSent || 0, convData.sentCount || existing.sentCount || 0, convData.lifetimeSent || 0),
      lifetimeReceived: Math.max(existing.lifetimeReceived || 0, convData.receivedCount || existing.receivedCount || 0, convData.lifetimeReceived || 0),
      allTimeLongestStreak: Math.max(existing.allTimeLongestStreak || 0, convData.dailyStreak || existing.dailyStreak || 0, convData.allTimeLongestStreak || 0),
      memories: Array.isArray(convData.memories) ? convData.memories : (existing.memories || []),
      recordedMessageIds: Array.isArray(convData.recordedMessageIds) ? convData.recordedMessageIds : (existing.recordedMessageIds || []),
      lastUpdated: Date.now()
    };
    updated.lifetimeTotal = updated.lifetimeSent + updated.lifetimeReceived;

    // Calculate metrics using scoring engine
    const scoringEngine = this._getScoringEngine();
    if (scoringEngine) {
      const settings = await this.getSettings();
      if (updated.isGroup) {
        const energy = scoringEngine.calculateGroupEnergy(updated);
        updated.groupEnergyScore = energy.energyScore;
        updated.groupEnergyLevel = energy.energyLevel;
        updated.isDying = energy.isDying;
        updated.energyMetrics = energy;
      } else {
        const metrics = scoringEngine.calculateDmMetrics(updated, settings);
        updated.bondScore = metrics.bondScore;
        updated.rank = metrics.rank;
        updated.nextRank = metrics.nextRank;
        updated.pointsToNext = metrics.pointsToNext;
        updated.progressToNextPct = metrics.progressToNextPct;
        updated.sentPercent = metrics.sentPercent;
        updated.receivedPercent = metrics.receivedPercent;
        updated.balanceRatio = metrics.balanceRatio;
        updated.replyRate = metrics.replyRate;
        updated.medianReplyTimeMs = metrics.medianReplyTimeMs;
        updated.formattedMedianReply = metrics.formattedMedianReply;
        updated.waitingForUserReply = metrics.waitingForUserReply;
        updated.waitingSinceTimestamp = metrics.waitingSinceTimestamp;
        updated.waitingDurationMs = metrics.waitingDurationMs;
        updated.formattedWaitingDuration = metrics.formattedWaitingDuration;
        updated.isFading = metrics.isFading;
        updated.isCoolingCandidate = metrics.isCoolingCandidate;
        updated.dmMetrics = metrics;

        // Track highest rank ever achieved
        if (updated.rank) {
          if (!updated.highestRankAchieved || (updated.rank.level > (updated.highestRankAchieved.level || 0))) {
            updated.highestRankAchieved = updated.rank;
          }
        }
      }
    }

    // Evaluate milestones & memories
    this._evaluateChatMilestones(updated, prevRankName);

    if (!activeAccount || activeAccount === (this.currentUser || '')) {
      this.dmCache.set(cleanId, updated);
    }
    await this._setRaw({ [key]: updated });

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bondscore:dm_updated', {
        detail: { convId: cleanId, conversation: updated, account: activeAccount }
      }));
    }
    return updated;
  }

  /**
   * Retrieves all DM conversations for the specified account (or active account).
   */
  async getAllDmConversations(account = this.currentUser) {
    return new Promise((resolve) => {
      let targetAccount = this._resolveActiveAccount(account);

      if (this._hasChromeStorage()) {
        chrome.storage.local.get(null, async (allData) => {
          if ((typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) || !allData) {
            resolve([]);
            return;
          }

          if (!targetAccount && allData.currentUser && allData.currentUser !== 'you') {
            targetAccount = (allData.currentUser || '').toLowerCase().trim();
          }

          const convs = [];
          const seenConvIds = new Set();
          const scoringEngine = this._getScoringEngine();
          const settings = await this.getSettings().catch(() => DEFAULT_SETTINGS);

          // Pass 1: find explicitly matching account conversations
          for (const [key, value] of Object.entries(allData)) {
            let isMatch = false;
            if (targetAccount) {
              isMatch = key.startsWith(`acc:${targetAccount}:dm:`);
            } else {
              isMatch = key.startsWith('dm:') && !key.startsWith('acc:');
            }

            if (isMatch && value && value.convId) {
              const cleanConvId = value.convId.toLowerCase().trim();
              seenConvIds.add(cleanConvId);
              convs.push(value);
            }
          }

          // Pass 2: Fallback check for un-scoped dm: keys or other accounts if empty
          for (const [key, value] of Object.entries(allData)) {
            if (value && value.convId) {
              const cleanConvId = value.convId.toLowerCase().trim();
              if (!seenConvIds.has(cleanConvId) && (key.startsWith('dm:') || convs.length === 0 && key.includes(':dm:'))) {
                seenConvIds.add(cleanConvId);
                convs.push(value);
              }
            }
          }

          // Recalculate metrics on retrieved items
          for (const value of convs) {
            if (scoringEngine) {
              if (value.isGroup) {
                const energy = scoringEngine.calculateGroupEnergy(value);
                value.groupEnergyScore = energy.energyScore;
                value.groupEnergyLevel = energy.energyLevel;
                value.isDying = energy.isDying;
                value.energyMetrics = energy;
              } else {
                const metrics = scoringEngine.calculateDmMetrics(value, settings);
                value.bondScore = metrics.bondScore;
                value.rank = metrics.rank;
                value.nextRank = metrics.nextRank;
                value.pointsToNext = metrics.pointsToNext;
                value.progressToNextPct = metrics.progressToNextPct;
                value.sentPercent = metrics.sentPercent;
                value.receivedPercent = metrics.receivedPercent;
                value.balanceRatio = metrics.balanceRatio;
                value.replyRate = metrics.replyRate;
                value.medianReplyTimeMs = metrics.medianReplyTimeMs;
                value.formattedMedianReply = metrics.formattedMedianReply;
                value.waitingForUserReply = metrics.waitingForUserReply;
                value.waitingSinceTimestamp = metrics.waitingSinceTimestamp;
                value.waitingDurationMs = metrics.waitingDurationMs;
                value.formattedWaitingDuration = metrics.formattedWaitingDuration;
                value.isFading = metrics.isFading;
                value.isCoolingCandidate = metrics.isCoolingCandidate;
                value.dmMetrics = metrics;
              }
            }
          }

          convs.sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0));
          resolve(convs);
        });
      } else {
        const convs = [];
        const seen = new Set();
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          let isMatch = false;
          if (targetAccount) {
            isMatch = k.startsWith(`bond_acc:${targetAccount}:dm:`);
          } else {
            isMatch = k.startsWith('bond_dm:') && !k.startsWith('bond_acc:');
          }
          if (isMatch) {
            try {
              const val = JSON.parse(localStorage.getItem(k));
              if (val && val.convId && !seen.has(val.convId)) {
                seen.add(val.convId);
                convs.push(val);
              }
            } catch (e) {}
          }
        }
        convs.sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0));
        resolve(convs);
      }
    });
  }

  /**
   * Ingests a batch of parsed message entries from an active DM conversation thread.
   * Deduplicates messages against recordedMessageIds, updates lifetime counts, streaks, and memories.
   */
  async ingestMessageEntries(convId, entries = [], account = null) {
    if (!convId || !Array.isArray(entries) || entries.length === 0) return null;
    const cleanConvId = convId.toLowerCase().trim();
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) activeAccount = (await this.getCurrentUser()) || '';

    const settings = await this.getSettings();
    if (settings.trackDirectMessages === false) return null;

    const existing = await this.getDmConversation(cleanConvId, false, activeAccount);
    const conv = existing || {
      convId: cleanConvId,
      isGroup: /^\d+$/.test(cleanConvId),
      title: cleanConvId,
      participants: [cleanConvId],
      participantDetails: {},
      sentCount: 0,
      receivedCount: 0,
      totalCount: 0,
      lifetimeSent: 0,
      lifetimeReceived: 0,
      lifetimeTotal: 0,
      firstSeenTimestamp: Date.now(),
      lastSentTimestamp: 0,
      lastReceivedTimestamp: 0,
      lastMessageTimestamp: Date.now(),
      lastSenderHandle: '',
      waitingForUserReply: false,
      waitingSinceTimestamp: null,
      replyTimes: [],
      medianReplyTimeMs: 0,
      replyRate: 100,
      dailyStreak: 0,
      allTimeLongestStreak: 0,
      highestRankAchieved: null,
      memories: [],
      recordedMessageIds: []
    };

    if (!Array.isArray(conv.recordedMessageIds)) conv.recordedMessageIds = [];
    if (!Array.isArray(conv.memories)) conv.memories = [];

    const recordedSet = new Set(conv.recordedMessageIds);
    let newInboundCount = 0;
    let newOutboundCount = 0;
    let latestTimestamp = conv.lastMessageTimestamp || 0;
    let latestDirection = null;

    for (const entry of entries) {
      const fp = entry.fingerprint || `${entry.direction}_${(entry.text || '').slice(0, 32)}_${entry.timestamp || ''}`;
      if (recordedSet.has(fp)) continue; // Already ingested

      recordedSet.add(fp);
      conv.recordedMessageIds.push(fp);

      const isOutbound = entry.direction === 'outbound';
      const msgTime = entry.timestamp || Date.now();

      if (isOutbound) {
        newOutboundCount++;
        conv.lastSentTimestamp = Math.max(conv.lastSentTimestamp || 0, msgTime);
      } else {
        newInboundCount++;
        conv.lastReceivedTimestamp = Math.max(conv.lastReceivedTimestamp || 0, msgTime);
      }

      if (msgTime >= latestTimestamp) {
        latestTimestamp = msgTime;
        latestDirection = entry.direction;
      }
    }

    // Keep recordedMessageIds capped to 600
    if (conv.recordedMessageIds.length > 600) {
      conv.recordedMessageIds = conv.recordedMessageIds.slice(-500);
    }

    if (newInboundCount === 0 && newOutboundCount === 0) {
      return conv;
    }

    conv.sentCount = (conv.sentCount || 0) + newOutboundCount;
    conv.receivedCount = (conv.receivedCount || 0) + newInboundCount;
    conv.totalCount = conv.sentCount + conv.receivedCount;

    conv.lifetimeSent = Math.max(conv.lifetimeSent || 0, conv.sentCount);
    conv.lifetimeReceived = Math.max(conv.lifetimeReceived || 0, conv.receivedCount);
    conv.lifetimeTotal = conv.lifetimeSent + conv.lifetimeReceived;

    conv.lastMessageTimestamp = Math.max(conv.lastMessageTimestamp || 0, latestTimestamp || Date.now());

    // Update waiting state based on latest message
    if (latestDirection === 'inbound') {
      conv.waitingForUserReply = true;
      conv.waitingSinceTimestamp = conv.waitingSinceTimestamp || latestTimestamp;
    } else if (latestDirection === 'outbound') {
      conv.waitingForUserReply = false;
      conv.waitingSinceTimestamp = null;
    }

    // Update streak
    const now = Date.now();
    const msInDay = 86400000;
    const currentDay = Math.floor(now / msInDay);
    if (!conv.lastActiveDay) {
      conv.lastActiveDay = currentDay;
      conv.dailyStreak = 1;
    } else if (currentDay === conv.lastActiveDay + 1) {
      conv.dailyStreak = (conv.dailyStreak || 0) + 1;
      conv.lastActiveDay = currentDay;
    } else if (currentDay > conv.lastActiveDay + 1) {
      conv.dailyStreak = 1;
      conv.lastActiveDay = currentDay;
    }
    conv.allTimeLongestStreak = Math.max(conv.allTimeLongestStreak || 0, conv.dailyStreak || 0);

    return await this.saveDmConversation(cleanConvId, conv, activeAccount);
  }

  /**
   * Retrieves memories & milestone ledger for a specific conversation.
   */
  async getChatMemories(convId, account = null) {
    const conv = await this.getDmConversation(convId, false, account);
    if (!conv) return null;
    return {
      convId: conv.convId,
      title: conv.title,
      firstSeenTimestamp: conv.firstSeenTimestamp || conv.lastMessageTimestamp || Date.now(),
      lifetimeTotal: conv.lifetimeTotal || conv.totalCount || 0,
      lifetimeSent: conv.lifetimeSent || conv.sentCount || 0,
      lifetimeReceived: conv.lifetimeReceived || conv.receivedCount || 0,
      highestRankAchieved: conv.highestRankAchieved || conv.rank || null,
      allTimeLongestStreak: conv.allTimeLongestStreak || conv.dailyStreak || 0,
      memories: Array.isArray(conv.memories) ? conv.memories : []
    };
  }

  /**
   * Retrieves all chat milestones across all conversations (for popup dashboard).
   */
  async getAllChatMilestones(account = this.currentUser) {
    const all = await this.getAllDmConversations(account);
    const milestones = [];
    for (const c of all) {
      if (Array.isArray(c.memories)) {
        for (const m of c.memories) {
          milestones.push({
            ...m,
            convId: c.convId,
            convTitle: c.title || c.convId,
            isGroup: !!c.isGroup
          });
        }
      }
    }
    milestones.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return milestones.slice(0, 30);
  }

  /**
   * Records a single DM message (inbound or outbound) in the conversation ledger.
   * Completely private, 100% on-device metadata. Never transmits message text.
   */
  async recordDmMessage(convId, msgData = {}, account = null) {
    if (!convId) return null;
    const cleanConvId = convId.toLowerCase().trim();
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }

    const settings = await this.getSettings();
    if (settings.trackDirectMessages === false) {
      return null;
    }

    const existing = await this.getDmConversation(cleanConvId, false, activeAccount);
    const conv = existing || {
      convId: cleanConvId,
      isGroup: !!msgData.isGroup,
      title: msgData.groupTitle || (msgData.recipientHandle ? `@${msgData.recipientHandle}` : cleanConvId),
      participants: msgData.participants || (msgData.recipientHandle ? [msgData.recipientHandle.toLowerCase()] : []),
      participantDetails: {},
      sentCount: 0,
      receivedCount: 0,
      totalCount: 0,
      lifetimeSent: 0,
      lifetimeReceived: 0,
      lifetimeTotal: 0,
      firstSeenTimestamp: Date.now(),
      lastSentTimestamp: 0,
      lastReceivedTimestamp: 0,
      lastMessageTimestamp: 0,
      lastSenderHandle: '',
      waitingForUserReply: false,
      waitingSinceTimestamp: null,
      replyTimes: [],
      medianReplyTimeMs: 0,
      replyRate: 100,
      dailyStreak: 0,
      allTimeLongestStreak: 0,
      highestRankAchieved: null,
      memberMessageCounts: {},
      memories: [],
      recordedMessageIds: []
    };

    const now = msgData.timestamp || Date.now();
    const isOutbound = msgData.direction === 'outbound' || (msgData.senderHandle && activeAccount && msgData.senderHandle.toLowerCase() === activeAccount);
    const sender = (msgData.senderHandle || (isOutbound ? activeAccount : cleanConvId)).toLowerCase();

    // Update participants & avatars
    if (msgData.recipientHandle && !conv.participants.includes(msgData.recipientHandle.toLowerCase())) {
      conv.participants.push(msgData.recipientHandle.toLowerCase());
    }
    if (msgData.senderHandle && !isOutbound && !conv.participants.includes(msgData.senderHandle.toLowerCase())) {
      conv.participants.push(msgData.senderHandle.toLowerCase());
    }
    if (msgData.displayName || msgData.avatarUrl) {
      const handleToUpdate = isOutbound ? (msgData.recipientHandle || cleanConvId) : sender;
      if (!conv.participantDetails) conv.participantDetails = {};
      conv.participantDetails[handleToUpdate] = {
        displayName: msgData.displayName || (conv.participantDetails[handleToUpdate] && conv.participantDetails[handleToUpdate].displayName) || handleToUpdate,
        avatarUrl: msgData.avatarUrl || (conv.participantDetails[handleToUpdate] && conv.participantDetails[handleToUpdate].avatarUrl) || ''
      };
    }

    // Directional counts and response timing calculation
    if (isOutbound) {
      conv.sentCount = (conv.sentCount || 0) + 1;
      if (conv.lastReceivedTimestamp && conv.lastSentTimestamp < conv.lastReceivedTimestamp) {
        const latencyMs = now - conv.lastReceivedTimestamp;
        if (latencyMs > 0 && latencyMs < 7 * 86400000) {
          if (!Array.isArray(conv.replyTimes)) conv.replyTimes = [];
          conv.replyTimes.push(latencyMs);
          if (conv.replyTimes.length > 50) conv.replyTimes.shift();
        }
      }
      conv.lastSentTimestamp = now;
      conv.waitingForUserReply = false;
      conv.waitingSinceTimestamp = null;
    } else {
      conv.receivedCount = (conv.receivedCount || 0) + 1;
      conv.lastReceivedTimestamp = now;
      conv.waitingForUserReply = true;
      conv.waitingSinceTimestamp = now;
    }

    conv.totalCount = (conv.sentCount || 0) + (conv.receivedCount || 0);
    conv.lifetimeSent = Math.max(conv.lifetimeSent || 0, conv.sentCount);
    conv.lifetimeReceived = Math.max(conv.lifetimeReceived || 0, conv.receivedCount);
    conv.lifetimeTotal = conv.lifetimeSent + conv.lifetimeReceived;
    conv.lastMessageTimestamp = now;
    conv.lastSenderHandle = sender;

    // Track member breakdown for group chats
    if (conv.isGroup) {
      if (!conv.memberMessageCounts) conv.memberMessageCounts = {};
      conv.memberMessageCounts[sender] = (conv.memberMessageCounts[sender] || 0) + 1;
    }

    // Daily messaging streaks
    const msInDay = 86400000;
    const currentDay = Math.floor(now / msInDay);
    if (!conv.lastActiveDay) {
      conv.lastActiveDay = currentDay;
      conv.dailyStreak = 1;
    } else if (currentDay === conv.lastActiveDay + 1) {
      conv.dailyStreak = (conv.dailyStreak || 0) + 1;
      conv.lastActiveDay = currentDay;
    } else if (currentDay > conv.lastActiveDay + 1) {
      conv.dailyStreak = 1;
      conv.lastActiveDay = currentDay;
    }
    conv.allTimeLongestStreak = Math.max(conv.allTimeLongestStreak || 0, conv.dailyStreak || 0);

    // For 1:1 DMs, also log into the user's public CRM ledger to keep timeline scores aligned
    if (!conv.isGroup && conv.participants.length > 0) {
      const otherHandle = conv.participants[0];
      if (otherHandle && otherHandle !== activeAccount) {
        const details = conv.participantDetails && conv.participantDetails[otherHandle];
        await this.recordInteraction(otherHandle, {
          type: isOutbound ? 'dm_sent' : 'dm_received',
          timestamp: now,
          tweetId: `dm_${now}`,
          textSnippet: msgData.textSnippet ? msgData.textSnippet.slice(0, 100) : 'Direct Message',
          displayName: details ? details.displayName : otherHandle,
          avatarUrl: details ? details.avatarUrl : '',
          isMutual: true
        }, activeAccount).catch(() => {});
      }
    }

    return await this.saveDmConversation(cleanConvId, conv, activeAccount);
  }

  /**
   * Retrieves conversations waiting for the user's reply, sorted by longest waiting first.
   */
  async getWaitingForReply(account = this.currentUser) {
    const all = await this.getAllDmConversations(account);
    const waiting = all.filter(c => c.waitingForUserReply === true);
    waiting.sort((a, b) => (b.waitingDurationMs || 0) - (a.waitingDurationMs || 0));
    return waiting;
  }

  /**
   * Retrieves high-bond conversations going cold ("Who should I message?").
   */
  async getColdDMs(account = this.currentUser) {
    const all = await this.getAllDmConversations(account);
    const cold = all.filter(c => !c.isGroup && (c.isCoolingCandidate === true || c.isFading === true));
    cold.sort((a, b) => (b.bondScore || 0) - (a.bondScore || 0));
    return cold;
  }

  /**
   * Returns top closest friends ranked by 1:1 DM Bond Score.
   */
  async getTopClosestFriends(limit = 10, account = this.currentUser) {
    const all = await this.getAllDmConversations(account);
    const friends = all.filter(c => !c.isGroup && (c.bondScore || 0) > 0);
    friends.sort((a, b) => (b.bondScore || 0) - (a.bondScore || 0));
    return friends.slice(0, limit);
  }

  /**
   * Returns all tracked Group Chats with energy levels and active rosters.
   */
  async getGroupChats(account = this.currentUser) {
    const all = await this.getAllDmConversations(account);
    const groups = all.filter(c => c.isGroup === true);
    groups.sort((a, b) => (b.groupEnergyScore || 0) - (a.groupEnergyScore || 0));
    return groups;
  }

  /**
   * Calculates overall combined relationship score for a given handle:
   * Public Timeline interactions + Private DM bond.
   */
  async getCombinedRelationship(handle, account = this.currentUser) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const user = await this.getUser(cleanHandle, false, account);
    const dmConv = await this.getDmConversation(cleanHandle, false, account);
    const scoringEngine = this._getScoringEngine();
    const settings = await this.getSettings();

    if (!scoringEngine) return null;
    return scoringEngine.calculateCombinedRelationship(user, dmConv, settings);
  }

  /**
   * Clears all interactions and tracked data for a specific account, leaving other accounts intact.
   */
  async clearAccount(account = this.currentUser) {
    const cleanAccount = (account || this.currentUser || '').toLowerCase().trim();
    if (!cleanAccount) return;

    return new Promise((resolve) => {
      if (this._hasChromeStorage()) {
        chrome.storage.local.get(null, (allData) => {
          if (!allData) return resolve();
          const prefix = `acc:${cleanAccount}:`;
          const toRemove = Object.keys(allData).filter(k => k.startsWith(prefix));
          if (toRemove.length > 0) {
            chrome.storage.local.remove(toRemove, () => {
              if (cleanAccount === this.currentUser) {
                this.memoryCache.clear();
                this.eventsCache.clear();
                this.dmCache.clear();
              }
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else {
        const prefix = `bond_acc:${cleanAccount}:`;
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith(prefix)) toRemove.push(k);
        }
        toRemove.forEach(k => localStorage.removeItem(k));
        if (cleanAccount === this.currentUser) {
          this.memoryCache.clear();
          this.eventsCache.clear();
          this.dmCache.clear();
        }
        resolve();
      }
    });
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
            version: '1.1.3',
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
          version: '1.1.3',
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
if (typeof window !== 'undefined') {
  window.bondStorage = new BondStorage();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BondStorage, DEFAULT_SETTINGS };
}
