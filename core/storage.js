/**
 * BondScore - Multi-Platform Local Storage Layer (v1.4.0)
 * Manages interactions, user records, cached scores, notes, streaks, and settings using chrome.storage.local.
 * Completely private, zero-backend, and offline-first.
 */

const DEFAULT_SETTINGS = {
  theme: 'system', // 'system' | 'dark' | 'light'
  platforms: {
    x: { enabled: true, timeline: true, dms: true },
    threads: { enabled: false, timeline: true, dms: true },
    bluesky: { enabled: false, timeline: true, dms: true }
  },
  decayHalfLifeDays: 14,
  gracePeriodDays: 5,
  trackDirectMessages: true, // 100% private, on-device DM analytics toggle
  fadingThresholdDays: 3,    // Soft fading alert threshold (days inactive)
  dmScoreWeightPercent: 50,  // Weight % for DM score in combined bond
  showBadgesInDMs: true,     // Render badges and header pills inside X DM conversations
  groupActivity: {           // Group chat badge thresholds (all local, editable)
    windowHours: 20,
    activeMin: 21,
    energeticMin: 50,
    hyperactiveWindowHours: 1,
    hyperactiveMin: 99
  },
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
    this.activePlatform = 'x';
    this.knownAccounts = [];
    this.accountsMetadata = {};
    this.isInitialized = false;
    this._setupStorageSync();
  }

  /**
   * The platform that owns this execution context. X is the default so every
   * pre-v1.4.0 code path keeps its legacy key layout and cache behaviour.
   */
  get activePlatformId() {
    if (this.activePlatform && this.activePlatform !== 'auto') return this.activePlatform;
    if (typeof window !== 'undefined' && window.BondPlatforms) {
      return window.BondPlatforms.current().id;
    }
    return 'x';
  }

  setActivePlatform(id) {
    const next = id || 'x';
    if (next === this.activePlatform) return;
    this.activePlatform = next;
    this.memoryCache.clear();
    this.eventsCache.clear();
    this.dmCache.clear();
  }

  _platformFor(platform = null) {
    return (platform || this.activePlatformId || 'x').toLowerCase();
  }

  /** Non-X platforms get an explicit `p:<platform>:` segment after the account. */
  _platformSegment(platform = null) {
    const id = this._platformFor(platform);
    return id === 'x' ? '' : `p:${id}:`;
  }

  _cacheKey(key, platform = null) {
    return `${this._platformFor(platform)}:${key}`;
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
            this.settingsCache = this._normalizeSettings(change.newValue || {});
          } else {
            // Handle updates isolated to current active account
            const accPrefix = this.currentUser ? `acc:${this.currentUser}:` : '';
            const belongsToActive = (accPrefix && key.startsWith(accPrefix)) ||
              (!this.currentUser && !key.startsWith('acc:') && !key.startsWith('bond_'));

            if (belongsToActive) {
              const keyPlatform = this._platformFromKey(key);
              const userMatch = key.match(/:user:([^:]+)$/);
              const eventsMatch = key.match(/:events:([^:]+)$/);
              const dmMatch = key.match(/:dm:([^:]+)$/);

              if (userMatch) {
                const handle = userMatch[1];
                if (change.newValue) {
                  this.memoryCache.set(this._cacheKey(handle, keyPlatform), change.newValue);
                } else {
                  this.memoryCache.delete(this._cacheKey(handle, keyPlatform));
                }
                if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('bondscore:updated', {
                    detail: { handle, platform: keyPlatform, user: change.newValue, score: change.newValue ? change.newValue.currentScore : 0 }
                  }));
                }
              } else if (eventsMatch) {
                const handle = eventsMatch[1];
                if (change.newValue) {
                  this.eventsCache.set(this._cacheKey(handle, keyPlatform), change.newValue);
                } else {
                  this.eventsCache.delete(this._cacheKey(handle, keyPlatform));
                }
              } else if (dmMatch) {
                const convId = dmMatch[1];
                if (change.newValue) {
                  this.dmCache.set(this._cacheKey(convId, keyPlatform), change.newValue);
                } else {
                  this.dmCache.delete(this._cacheKey(convId, keyPlatform));
                }
                if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('bondscore:dm_updated', {
                    detail: { convId, platform: keyPlatform, conversation: change.newValue }
                  }));
                }
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
      if (typeof window !== 'undefined' && window.BondPlatforms) {
        this.activePlatform = window.BondPlatforms.current().id;
      }
      const data = await this._getRaw(['currentUser', 'knownAccounts', 'accountsMetadata', 'settings']);
      this.currentUser = (data.currentUser || '').toLowerCase().trim() || null;
      this.knownAccounts = Array.isArray(data.knownAccounts) ? data.knownAccounts : [];
      if (this.currentUser && !this.knownAccounts.includes(this.currentUser)) {
        this.knownAccounts.push(this.currentUser);
      }
      this.accountsMetadata = data.accountsMetadata || {};
      this.settingsCache = this._normalizeSettings(data.settings || {});
      if (data.settings && (!data.settings.platforms || data.settings.gracePeriodDays === 2)) {
        await this._setRaw({ settings: this.settingsCache });
      }
      this.isInitialized = true;

      // Automatically migrate legacy non-namespaced keys into current account if known
      if (this.currentUser) {
        await this._migrateLegacyDataIfNeeded(this.currentUser);
      }
      await this._purgeBogusFeedEventsIfNeeded();
    } catch (err) {
      console.warn('[BondScore] Storage init error:', err);
      this.settingsCache = Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  /**
   * One-time cleanup of the fake quote events created by an earlier build that
   * misread Threads' "Repost" button title as an active state. Those events
   * gave every feed author a score of 18.
   */
  async _purgeBogusFeedEventsIfNeeded() {
    if (!this._hasChromeStorage()) return;
    try {
      const flag = await this._getRaw(['bondscoreFeedPurgeDone']);
      if (flag.bondscoreFeedPurgeDone) return;
      const all = await this._getAllRaw();
      for (const [key, value] of Object.entries(all)) {
        if (!key.includes(':events:') || !Array.isArray(value)) continue;
        const platform = this._platformFromKey(key);
        if (platform !== 'threads' && platform !== 'bluesky') continue;
        const filtered = value.filter((evt) => !(
          evt && evt.type === 'quote' && evt.direction === 'outbound' &&
          typeof evt.tweetId === 'string' && /^(threads_|bsky_)/.test(evt.tweetId)
        ));
        if (filtered.length === value.length) continue;
        await this._setRaw({ [key]: filtered });
        const handle = key.split(':events:')[1];
        const user = handle ? await this.getUser(handle, true, null, platform) : null;
        if (user) await this._recomputeUserFromEvents(handle, filtered, user, null, platform);
      }
      await this._setRaw({ bondscoreFeedPurgeDone: true });
    } catch (err) {
      // Never block startup for cleanup.
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
    this.dmCache.clear();

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

  _normalizeSettings(raw = {}) {
    const merged = Object.assign({}, DEFAULT_SETTINGS, raw);
    merged.weights = Object.assign({}, DEFAULT_SETTINGS.weights, raw.weights || {});
    merged.groupActivity = Object.assign({}, DEFAULT_SETTINGS.groupActivity, raw.groupActivity || {});
    merged.platforms = {};
    for (const id of Object.keys(DEFAULT_SETTINGS.platforms)) {
      const base = DEFAULT_SETTINGS.platforms[id];
      const value = (raw.platforms && raw.platforms[id]) || {};
      merged.platforms[id] = {
        enabled: value.enabled !== undefined ? !!value.enabled : base.enabled,
        timeline: value.timeline !== undefined ? !!value.timeline : base.timeline,
        dms: value.dms !== undefined ? !!value.dms : base.dms
      };
    }
    if (merged.gracePeriodDays === 2) merged.gracePeriodDays = 5;
    return merged;
  }

  async getSettings() {
    if (!this.settingsCache) {
      const res = await this._getRaw(['settings']);
      this.settingsCache = this._normalizeSettings(res.settings || {});
    }
    return this.settingsCache;
  }

  async updateSettings(newSettings) {
    const next = Object.assign({}, this.settingsCache || DEFAULT_SETTINGS, newSettings || {});
    this.settingsCache = this._normalizeSettings(next);
    await this._setRaw({ settings: this.settingsCache });
    return this.settingsCache;
  }

  _userKey(handle, account = null, platform = null) {
    const h = (handle || '').replace(/^@/, '').toLowerCase().trim();
    const acc = this._resolveActiveAccount(account);
    const seg = this._platformSegment(platform);
    return acc ? `acc:${acc}:${seg}user:${h}` : `${seg}user:${h}`;
  }

  _eventsKey(handle, account = null, platform = null) {
    const h = (handle || '').replace(/^@/, '').toLowerCase().trim();
    const acc = this._resolveActiveAccount(account);
    const seg = this._platformSegment(platform);
    return acc ? `acc:${acc}:${seg}events:${h}` : `${seg}events:${h}`;
  }

  _dmKey(convId, account = null, platform = null) {
    const id = (convId || '').toLowerCase().trim();
    const acc = this._resolveActiveAccount(account);
    const seg = this._platformSegment(platform);
    return acc ? `acc:${acc}:${seg}dm:${id}` : `${seg}dm:${id}`;
  }

  async getUser(handle, forceRefresh = false, account = null, platform = null) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const platformId = this._platformFor(platform);
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const isCurrentAcc = !activeAccount || activeAccount === (this.currentUser || '');
    const cacheKey = this._cacheKey(cleanHandle, platformId);

    if (!forceRefresh && isCurrentAcc && this.memoryCache.has(cacheKey)) {
      return this.memoryCache.get(cacheKey);
    }

    // 1. Primary lookup under active account + platform
    const key = this._userKey(cleanHandle, activeAccount, platformId);
    const res = await this._getRaw([key]);
    let user = res[key] || null;

    // 2. Fallback to legacy un-scoped key (X only, for pre-1.4.0 installs)
    if (!user && platformId === 'x') {
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
          const keyPlatform = this._platformFromKey(k);
          if (keyPlatform === platformId) {
            user = v;
            break;
          }
        }
      }
    }

    if (user) {
      user.platform = user.platform || platformId;
      if (isCurrentAcc) this.memoryCache.set(cacheKey, user);
    }
    return user;
  }

  _platformFromKey(key = '') {
    const m = String(key).match(/^(?:acc:[^:]+:|bond_acc:[^:]+:)?p:([^:]+):/);
    return m && m[1] ? m[1].toLowerCase() : 'x';
  }

  async saveUser(handle, userData, account = null, platform = null) {
    if (!handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const platformId = this._platformFor(platform);
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const key = this._userKey(cleanHandle, activeAccount, platformId);
    const cacheKey = this._cacheKey(cleanHandle, platformId);

    const existing = (await this.getUser(cleanHandle, false, activeAccount, platformId)) || {
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
      platform: platformId,
      lastUpdated: Date.now()
    };

    if (!activeAccount || activeAccount === (this.currentUser || '')) {
      this.memoryCache.set(cacheKey, updated);
    }
    await this._setRaw({ [key]: updated });

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bondscore:updated', {
        detail: { handle: cleanHandle, platform: platformId, user: updated, score: updated.currentScore, account: activeAccount }
      }));
    }
    return updated;
  }

  async getEvents(handle, account = null, platform = null) {
    if (!handle) return [];
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const platformId = this._platformFor(platform);
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const isCurrentAcc = !activeAccount || activeAccount === (this.currentUser || '');
    const cacheKey = this._cacheKey(cleanHandle, platformId);

    if (isCurrentAcc && this.eventsCache.has(cacheKey)) {
      return this.eventsCache.get(cacheKey);
    }

    // 1. Primary lookup
    const key = this._eventsKey(cleanHandle, activeAccount, platformId);
    const res = await this._getRaw([key]);
    let events = res[key] || [];

    // 2. Fallback to legacy un-scoped key (X only)
    if ((!events || events.length === 0) && platformId === 'x') {
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
          if (this._platformFromKey(k) !== platformId) continue;
          events = v;
          break;
        }
      }
    }

    if (isCurrentAcc) {
      this.eventsCache.set(cacheKey, events);
    }
    return events;
  }

  async saveEvents(handle, events, account = null, platform = null) {
    if (!handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const platformId = this._platformFor(platform);
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const key = this._eventsKey(cleanHandle, activeAccount, platformId);

    if (!activeAccount || activeAccount === (this.currentUser || '')) {
      this.eventsCache.set(this._cacheKey(cleanHandle, platformId), events);
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

  /** Recomputes score/CRM from the event ledger, used on new and repeat events. */
  async _recomputeUserFromEvents(handle, events, user, account, platform, latestTimestamp = 0) {
    const scoringEngine = this._getScoringEngine();
    if (!scoringEngine) return user;

    user.stats = this._buildDirectionalStats(events, user.stats || {});
    if (latestTimestamp) user.lastInteraction = Math.max(user.lastInteraction || 0, latestTimestamp);

    const settings = await this.getSettings();
    const previousScore = user.currentScore || 0;
    const { score, tier, crmStatus, trend, streakDays, reciprocity, recencyBoost, twoWayMultiplier, qualityMetrics } =
      scoringEngine.calculateUserScore(events, settings, previousScore);
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

    const sSent = (user.stats && ((user.stats.repliesSent || 0) + (user.stats.dmsSent || 0) + (user.stats.likesSent || 0) + (user.stats.quotesSent || 0) + (user.stats.mentionsSent || 0))) || 0;
    const sRecv = (user.stats && ((user.stats.repliesReceived || 0) + (user.stats.dmsReceived || 0) + (user.stats.likesReceived || 0) + (user.stats.quotesReceived || 0) + (user.stats.mentionsReceived || 0))) || 0;
    if (typeof scoringEngine.classifyRelationship === 'function') {
      user.relationshipClass = scoringEngine.classifyRelationship(score, sSent, sRecv, user.lastInteraction);
    }

    await this.saveUser(handle, user, account, platform);
    return user;
  }

  /**
   * Records a new interaction event, deduplicating by event ID or tweet ID.
   * Isolated to the active account.
   */
  async recordInteraction(handle, eventData, account = null, platform = null) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const platformId = this._platformFor(platform);
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

    const type = eventData.type || 'reply_sent';
    // Privacy guarantee: DM and group-chat bodies are never parsed or stored.
    const isDmEvent = type.startsWith('dm_');
    const events = await this.getEvents(cleanHandle, activeAccount, platformId);
    const eventId = eventData.id || `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Check duplicate by tweetId if provided
    if (eventData.tweetId) {
      const exists = events.some(e => e.tweetId === eventData.tweetId);
      if (exists) {
        // Still recompute: scoring rules may have been improved since this
        // event was first recorded (e.g. inbound notifications now count).
        const user = await this.getUser(cleanHandle, false, activeAccount, platformId);
        if (user) return await this._recomputeUserFromEvents(cleanHandle, events, user, activeAccount, platformId);
        return user;
      }
    }

    const newEvent = {
      id: eventId,
      timestamp: eventData.timestamp || Date.now(),
      type,
      tweetId: eventData.tweetId || null,
      // Metadata only: never persist the contents of a private conversation.
      textSnippet: isDmEvent ? null : (eventData.textSnippet ? eventData.textSnippet.slice(0, 140) : null),
      isMutual: !!eventData.isMutual,
      isThread: !!eventData.isThread,
      channel: isDmEvent ? 'dm' : 'public',
      direction: eventData.direction || (
        ['reply_received', 'dm_received', 'mention'].includes(type) ||
        type === 'signal_follow_back'
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
    await this.saveEvents(cleanHandle, events, activeAccount, platformId);

    // Update user summary stats
    const user = (await this.getUser(cleanHandle, false, activeAccount, platformId)) || {
      handle: cleanHandle,
      platform: platformId,
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

    return await this._recomputeUserFromEvents(
      cleanHandle, events, user, activeAccount, platformId, newEvent.timestamp
    );
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
  async getAllUsers(account = this.currentUser, platform = null) {
    const wantPlatform = platform ? this._platformFor(platform) : null;
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
              const m = k.match(/^acc:([^:]+):/);
              if (m && m[1]) {
                targetAccount = m[1].toLowerCase().trim();
                break;
              }
            }
          }

          const users = [];
          const seen = new Set();
          for (const [key, value] of Object.entries(allData)) {
            let isMatch = false;
            if (targetAccount) {
              isMatch = key.startsWith(`acc:${targetAccount}:user:`) ||
                        key.startsWith(`acc:${targetAccount}:p:`);
            } else {
              isMatch = (key.startsWith('user:') || key.startsWith('p:')) && !key.startsWith('acc:');
            }
            if (!isMatch || !key.includes(':user:')) continue;

            const keyPlatform = this._platformFromKey(key);
            if (wantPlatform && keyPlatform !== wantPlatform) continue;

            if (value && value.handle) {
              const h = value.handle.toLowerCase().trim();
              const identity = `${keyPlatform}:${h}`;
              if (h && (!targetAccount || h !== targetAccount) && !seen.has(identity)) {
                seen.add(identity);
                value.platform = value.platform || keyPlatform;
                if (!value.crmStatusData && typeof BondScoring !== 'undefined') {
                  const sSent = (value.stats && ((value.stats.repliesSent || 0) + (value.stats.dmsSent || 0) + (value.stats.likesSent ?? value.stats.likes ?? 0) + (value.stats.quotesSent || 0) + (value.stats.mentionsSent || 0))) || 0;
                  const sRecv = (value.stats && ((value.stats.repliesReceived || 0) + (value.stats.dmsReceived || 0) + (value.stats.likesReceived || 0) + (value.stats.quotesReceived || 0) + (value.stats.mentionsReceived || 0))) || 0;
                  value.crmStatusData = BondScoring.calculateCRMStatus(value.currentScore || 0, sSent, sRecv, value.streakDays || 0);
                  value.crmStatus = value.crmStatusData.label;
                  value.crmStatusId = value.crmStatusData.id;
                }
                if (!value.relationshipClass && typeof BondScoring !== 'undefined' && BondScoring.classifyRelationship) {
                  const sSent = (value.stats && ((value.stats.repliesSent || 0) + (value.stats.dmsSent || 0) + (value.stats.likesSent || 0) + (value.stats.quotesSent || 0) + (value.stats.mentionsSent || 0))) || 0;
                  const sRecv = (value.stats && ((value.stats.repliesReceived || 0) + (value.stats.dmsReceived || 0) + (value.stats.likesReceived || 0) + (value.stats.quotesReceived || 0) + (value.stats.mentionsReceived || 0))) || 0;
                  value.relationshipClass = BondScoring.classifyRelationship(value.currentScore || 0, sSent, sRecv, value.lastInteraction);
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
            const m = localStorage.key(i).match(/^bond_acc:([^:]+):/);
            if (m && m[1]) {
              targetAccount = m[1].toLowerCase().trim();
              break;
            }
          }
        }

        const users = [];
        const seen = new Set();
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          let isMatch = false;
          if (targetAccount) {
            isMatch = k.startsWith(`bond_acc:${targetAccount}:user:`) ||
                      k.startsWith(`bond_acc:${targetAccount}:p:`);
          } else {
            isMatch = (k.startsWith('bond_user:') || k.startsWith('bond_p:')) && !k.startsWith('bond_acc:');
          }
          if (!isMatch || !k.includes(':user:')) continue;

          const keyPlatform = this._platformFromKey(k);
          if (wantPlatform && keyPlatform !== wantPlatform) continue;

          try {
            const u = JSON.parse(localStorage.getItem(k));
            if (u && u.handle) {
              const h = u.handle.toLowerCase().trim();
              const identity = `${keyPlatform}:${h}`;
              if (h && (!targetAccount || h !== targetAccount) && !seen.has(identity)) {
                seen.add(identity);
                u.platform = u.platform || keyPlatform;
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
  async getDmConversation(convId, forceRefresh = false, account = null, platform = null) {
    if (!convId) return null;
    const cleanId = convId.toLowerCase().trim();
    const platformId = this._platformFor(platform);
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const isCurrentAcc = !activeAccount || activeAccount === (this.currentUser || '');
    const cacheKey = this._cacheKey(cleanId, platformId);

    if (!forceRefresh && isCurrentAcc && this.dmCache.has(cacheKey)) {
      return this._withFreshGroupEnergy(this.dmCache.get(cacheKey));
    }

    const key = this._dmKey(cleanId, activeAccount, platformId);
    const res = await this._getRaw([key]);
    let conv = res[key] || null;

    // Fallback 1: check legacy un-scoped key (X only)
    if (!conv && platformId === 'x') {
      const legacyKey = `dm:${cleanId}`;
      const legacyRes = await this._getRaw([legacyKey]);
      if (legacyRes[legacyKey]) {
        conv = legacyRes[legacyKey];
        if (activeAccount) {
          await this._setRaw({ [key]: conv });
        }
      }
    }

    // Fallback 2: search across accounts ONLY when no active account is resolved.
    // This prevents metadata from another account leaking into this account.
    if (!conv && !activeAccount && this._hasChromeStorage()) {
      const allData = await this._getAllRaw();
      for (const [k, v] of Object.entries(allData)) {
        if (k.endsWith(`:dm:${cleanId}`) && v && v.convId) {
          if (this._platformFromKey(k) !== platformId) continue;
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
      const allDms = await this.getAllDmConversations(activeAccount, platformId);
      conv = allDms.find(d => {
        if (!d.isGroup && d.participants && d.participants.includes(cleanId.replace(/^@/, ''))) return true;
        if (d.convId && d.convId.toLowerCase().includes(cleanId)) return true;
        return false;
      }) || null;
    }

    if (conv) {
      conv = await this._withFreshGroupEnergy(conv);
      conv.platform = conv.platform || platformId;
      if (isCurrentAcc) this.dmCache.set(cacheKey, conv);
    }
    return conv;
  }

  /** Recomputes group energy on read so stored badge data can never go stale. */
  async _withFreshGroupEnergy(conv) {
    if (!conv || !conv.isGroup) return conv;
    const engine = this._getScoringEngine();
    if (!engine || typeof engine.calculateGroupEnergy !== 'function') return conv;
    try {
      const settings = await this.getSettings();
      const energy = engine.calculateGroupEnergy(conv, settings);
      return Object.assign({}, conv, {
        groupEnergyScore: energy.energyScore,
        groupEnergyLevel: energy.energyLevel,
        isDying: energy.isDying,
        energyMetrics: energy,
        waitingForUserReply: false,
        waitingSinceTimestamp: null
      });
    } catch (e) {
      return conv;
    }
  }

  /**
   * Saves or updates a DM conversation record.
   */
  async saveDmConversation(convId, convData, account = null, platform = null) {
    if (!convId) return null;
    const cleanId = convId.toLowerCase().trim();
    const platformId = this._platformFor(platform);
    let activeAccount = this._resolveActiveAccount(account);
    if (!activeAccount) {
      activeAccount = (await this.getCurrentUser()) || '';
    }
    const key = this._dmKey(cleanId, activeAccount, platformId);
    const cacheKey = this._cacheKey(cleanId, platformId);

    const existing = (await this.getDmConversation(cleanId, false, activeAccount, platformId)) || {
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
      platform: platformId,
      firstSeenTimestamp: existing.firstSeenTimestamp || convData.firstSeenTimestamp || Date.now(),
      lifetimeSent: Math.max(existing.lifetimeSent || 0, convData.sentCount || existing.sentCount || 0, convData.lifetimeSent || 0),
      lifetimeReceived: Math.max(existing.lifetimeReceived || 0, convData.receivedCount || existing.receivedCount || 0, convData.lifetimeReceived || 0),
      allTimeLongestStreak: Math.max(existing.allTimeLongestStreak || 0, convData.dailyStreak || existing.dailyStreak || 0, convData.allTimeLongestStreak || 0),
      memories: Array.isArray(convData.memories) ? convData.memories : (existing.memories || []),
      recordedMessageIds: Array.isArray(convData.recordedMessageIds) ? convData.recordedMessageIds : (existing.recordedMessageIds || []),
      lastUpdated: Date.now()
    };
    updated.lifetimeTotal = updated.lifetimeSent + updated.lifetimeReceived;

    // Group chats never get a "waiting on you" state - that signal only makes
    // sense for a 1:1 conversation.
    if (updated.isGroup) {
      updated.waitingForUserReply = false;
      updated.waitingSinceTimestamp = null;
    }

    // Group energy reads totalMessages + recent windows. Keep both derived from
    // metadata-only timestamps so group chats produce a real score.
    const timeline = Array.isArray(updated.messageTimeline) ? updated.messageTimeline : [];
    const nowTs = Date.now();
    updated.totalMessages = Math.max(updated.lifetimeTotal || 0, updated.totalCount || 0, timeline.length);
    updated.recentMessages3d = timeline.filter((t) => nowTs - t <= 3 * 86400000).length;
    updated.recentMessages7d = timeline.filter((t) => nowTs - t <= 7 * 86400000).length;
    const settings = await this.getSettings();
    const groupCfg = settings.groupActivity || {};
    const windowMs = (groupCfg.windowHours || 20) * 3600000;
    const hyperMs = (groupCfg.hyperactiveWindowHours || 1) * 3600000;
    updated.recentMessages20h = timeline.filter((t) => nowTs - t <= windowMs).length;
    updated.recentMessages1h = timeline.filter((t) => nowTs - t <= hyperMs).length;

    // Calculate metrics using scoring engine
    const scoringEngine = this._getScoringEngine();
    if (scoringEngine) {
      if (updated.isGroup) {
        const energy = scoringEngine.calculateGroupEnergy(updated, settings);
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
      this.dmCache.set(cacheKey, updated);
    }
    await this._setRaw({ [key]: updated });

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bondscore:dm_updated', {
        detail: { convId: cleanId, platform: platformId, conversation: updated, account: activeAccount }
      }));
    }
    return updated;
  }

  /**
   * Retrieves all DM conversations for the specified account (or active account).
   */
  async getAllDmConversations(account = this.currentUser, platform = null) {
    const wantPlatform = platform ? this._platformFor(platform) : null;
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
              isMatch = key.startsWith(`acc:${targetAccount}:dm:`) ||
                        key.startsWith(`acc:${targetAccount}:p:`);
            } else {
              isMatch = (key.startsWith('dm:') || key.startsWith('p:')) && !key.startsWith('acc:');
            }
            if (!isMatch || !key.includes(':dm:') || !value || !value.convId) continue;

            const keyPlatform = this._platformFromKey(key);
            if (wantPlatform && keyPlatform !== wantPlatform) continue;

            const cleanConvId = value.convId.toLowerCase().trim();
            const identity = `${keyPlatform}:${cleanConvId}`;
            if (seenConvIds.has(identity)) continue;
            seenConvIds.add(identity);
            value.platform = value.platform || keyPlatform;
            convs.push(value);
          }

          // Pass 2: Fallback check for un-scoped dm: keys if nothing matched
          if (convs.length === 0) {
            for (const [key, value] of Object.entries(allData)) {
              if (!value || !value.convId || !key.endsWith(`:dm:${value.convId}`)) continue;
              const keyPlatform = this._platformFromKey(key);
              if (wantPlatform && keyPlatform !== wantPlatform) continue;
              const cleanConvId = value.convId.toLowerCase().trim();
              const identity = `${keyPlatform}:${cleanConvId}`;
              if (seenConvIds.has(identity)) continue;
              seenConvIds.add(identity);
              value.platform = value.platform || keyPlatform;
              convs.push(value);
            }
          }

          // Recalculate metrics on retrieved items
          for (const value of convs) {
            if (scoringEngine) {
              if (value.isGroup) {
                const energy = scoringEngine.calculateGroupEnergy(value, settings);
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
            isMatch = k.startsWith(`bond_acc:${targetAccount}:dm:`) ||
                      k.startsWith(`bond_acc:${targetAccount}:p:`);
          } else {
            isMatch = (k.startsWith('bond_dm:') || k.startsWith('bond_p:')) && !k.startsWith('bond_acc:');
          }
          if (!isMatch || !k.includes(':dm:')) continue;
          const keyPlatform = this._platformFromKey(k);
          if (wantPlatform && keyPlatform !== wantPlatform) continue;
          try {
            const val = JSON.parse(localStorage.getItem(k));
            const identity = `${keyPlatform}:${val && val.convId}`;
            if (val && val.convId && !seen.has(identity)) {
              seen.add(identity);
              val.platform = val.platform || keyPlatform;
              convs.push(val);
            }
          } catch (e) {}
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
      isGroup: cleanConvId.startsWith('g') || /^\d+$/.test(cleanConvId),
      title: cleanConvId,
      participants: [cleanConvId],
      participantDetails: {},
      sentCount: 0,
      receivedCount: 0,
      totalCount: 0,
      lifetimeSent: 0,
      lifetimeReceived: 0,
      lifetimeTotal: 0,
      totalMessages: 0,
      recentMessages3d: 0,
      recentMessages7d: 0,
      recentMessages20h: 0,
      recentMessages1h: 0,
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
      memberMessageCounts: {},
      messageTimeline: [],
      memories: [],
      recordedMessageIds: []
    };

    if (!Array.isArray(conv.recordedMessageIds)) conv.recordedMessageIds = [];
    if (!Array.isArray(conv.memories)) conv.memories = [];
    if (!Array.isArray(conv.messageTimeline)) conv.messageTimeline = [];
    if (!conv.memberMessageCounts || typeof conv.memberMessageCounts !== 'object') conv.memberMessageCounts = {};

    const recordedSet = new Set(conv.recordedMessageIds);
    let newInboundCount = 0;
    let newOutboundCount = 0;
    let latestTimestamp = conv.lastMessageTimestamp || 0;
    let latestDirection = null;

    for (const entry of entries) {
      // Fingerprints are intentionally metadata-only: no message text, no hash of
      // message text. Direction + time + position is enough to dedupe a DOM re-render.
      const fp = entry.fingerprint ||
        `${entry.direction || 'inbound'}_${entry.timestamp || ''}_${entry.index !== undefined ? entry.index : ''}`;
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

      // Metadata-only activity log for recency / group energy. Never text.
      conv.messageTimeline.push(msgTime);

      if (conv.isGroup && entry.senderHandle && entry.senderHandle !== activeAccount) {
        const sender = entry.senderHandle.toLowerCase();
        conv.memberMessageCounts[sender] = (conv.memberMessageCounts[sender] || 0) + 1;
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
    if (conv.messageTimeline.length > 1000) {
      conv.messageTimeline = conv.messageTimeline.slice(-800);
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
      messageTimeline: [],
      memories: [],
      recordedMessageIds: []
    };

    const now = msgData.timestamp || Date.now();
    if (!Array.isArray(conv.messageTimeline)) conv.messageTimeline = [];
    conv.messageTimeline.push(now);
    if (conv.messageTimeline.length > 1000) {
      conv.messageTimeline = conv.messageTimeline.slice(-800);
    }
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
          // Metadata only: private message contents are never persisted.
          textSnippet: null,
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
            app: 'BondScore',
            version: '1.4.0',
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
          app: 'BondScore',
          version: '1.4.0',
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
