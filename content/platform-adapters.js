/**
 * BondScore - Threads & Bluesky Platform Adapters (v1.4.0)
 *
 * Passive, metadata-only observers for the non-X networks. Each adapter:
 *   - identifies the signed-in account from authenticated navigation only
 *   - injects inline bond badges next to handles in feeds and profiles
 *   - records likes, reposts and replies as relationship events
 *   - reads DM *metadata* (participants, direction, timestamps) and never text
 *
 * The X adapter still lives in content.js/detector.js and is completely
 * untouched by this file.
 */

(function () {
  if (window.__bondAdaptersLoaded) return;
  window.__bondAdaptersLoaded = true;

  const RESERVED = new Set([
    'home', 'explore', 'search', 'notifications', 'messages', 'settings', 'login',
    'signup', 'activity', 'search', 'feeds', 'profile', 'hashtag', 'about', 'privacy'
  ]);

  function cleanText(el) {
    return el ? String(el.innerText || el.textContent || '').trim() : '';
  }

  function normalizeHandle(raw) {
    return String(raw || '')
      .trim()
      .replace(/^@+/, '')
      .replace(/^https?:\/\/[^/]+\/(?:@|profile\/)?/i, '')
      .split(/[/?#]/)[0]
      .toLowerCase();
  }

  function platformSettings() {
    return (window.bondStorage && window.bondStorage.settingsCache) || {};
  }

  class BasePlatformAdapter {
    constructor(id) {
      this.id = id;
      this.currentUser = null;
      this.observer = null;
      this.scanTimer = null;
      this.pollTimer = null;
      this.lastScanUrl = '';
      this.inFlight = false;
      this.attached = false;
      this.settingsWatcher = false;
      this.trackedContainers = new WeakSet();
    }

    get descriptor() {
      return (window.BondPlatforms && window.BondPlatforms.get(this.id)) || { id: this.id, name: this.id };
    }

    async boot() {
      if (!window.bondStorage) return;
      this.watchSettings();
      await window.bondStorage.init();
      window.bondStorage.setActivePlatform(this.id);
      const settings = await window.bondStorage.getSettings();
      if (!window.BondPlatforms || !window.BondPlatforms.isEnabled(settings, this.id)) {
        console.log(`[BondScore] ${this.id} tracking is disabled in settings.`);
        return false;
      }
      await this.refreshIdentity();
      this.attach();
      this.startObserver();
      setTimeout(() => this.scan(), 700);
      return true;
    }

    /** Start or stop observation as the popup toggles are changed. */
    watchSettings() {
      if (this.settingsWatcher) return;
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
      this.settingsWatcher = true;
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes.settings) return;
        const settings = changes.settings.newValue || {};
        const enabled = !window.BondPlatforms || window.BondPlatforms.isEnabled(settings, this.id);
        if (enabled && !this.observer) {
          this.boot().catch(() => {});
        } else if (!enabled) {
          this.stopObservation();
        }
      });
    }

    stopObservation() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.scanTimer) {
        clearTimeout(this.scanTimer);
        this.scanTimer = null;
      }
    }

    async refreshIdentity() {
      let identity = null;
      try {
        identity = this.detectIdentity();
      } catch (e) {
        identity = null;
      }
      const stored = (await window.bondStorage.getCurrentUser()) || null;
      const detectedHandle = identity && identity.handle ? normalizeHandle(identity.handle) : null;
      const handle = detectedHandle || stored;
      if (!handle) return null;
      this.currentUser = normalizeHandle(handle);
      if (detectedHandle && detectedHandle !== stored) {
        // Keep the CRM account-scoped: a different signed-in handle on this
        // platform must not inherit or leak another account's records.
        await window.bondStorage.switchAccount(detectedHandle, identity || {}).catch(() => {});
      } else if (!stored) {
        window.bondStorage.currentUser = this.currentUser;
      }
      return this.currentUser;
    }

    startObserver() {
      if (this.observer) return;
      const root = document.body || document.documentElement;
      if (!root) return;
      this.observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.addedNodes && m.addedNodes.length > 0) {
            this.scheduleScan();
            return;
          }
        }
      });
      this.observer.observe(root, { childList: true, subtree: true });
      this.pollTimer = setInterval(() => {
        if (location.href !== this.lastScanUrl) {
          this.lastScanUrl = location.href;
          this.scan();
        }
      }, 900);
    }

    scheduleScan() {
      if (this.scanTimer) return;
      this.scanTimer = setTimeout(() => {
        this.scanTimer = null;
        this.scan();
      }, 260);
    }

    async scan() {
      if (this.inFlight) return;
      this.inFlight = true;
      try {
        if (!window.BondPlatforms || !window.BondPlatforms.isEnabled(platformSettings(), this.id)) return;
        await this.refreshIdentity();
        const settings = platformSettings();
        if (settings.showBadgesOnTimeline === false) {
          // feed badges disabled, DM metadata may still run
        } else {
          await this.scanFeed();
        }
        await this.scanProfile();
        await this.scanNotifications();
        if (window.BondPlatforms.isFeatureEnabled(settings, this.id, 'dms')) await this.scanDms();
      } catch (err) {
        console.warn(`[BondScore] ${this.id} scan error:`, err && err.message);
      } finally {
        this.inFlight = false;
      }
    }

    // ---- overridable platform hooks ---------------------------------------
    detectIdentity() { return null; }
    async scanFeed() {}
    async scanProfile() {}
    async scanDms() {}

    /**
     * Notifications are where other people's likes and replies show up. Without
     * this, only the user's own actions are recorded and every bond looks
     * one-sided. Only handles, action type and a post id are read - never the
     * notification message body.
     */
    async scanNotifications() {
      if (!/\/activity|notifications|interactions/.test(location.pathname)) return;
      const rows = document.querySelectorAll('[role="listitem"], article, [data-testid*="notification" i]');
      for (const row of rows) {
        try {
          const links = Array.from(row.querySelectorAll('a[href^="/@"], a[href*="threads.net/@"], a[href*="threads.com/@"], a[href*="bsky.app/profile/"]'));
          const handles = [];
          for (const link of links) {
            const href = link.getAttribute('href') || '';
            const m = href.match(/(?:^|\/)(?:@|profile\/)([A-Za-z0-9._-]{1,40})/);
            if (!m) continue;
            const handle = normalizeHandle(m[1]);
            if (handle && handle !== this.currentUser && !RESERVED.has(handle) && !handles.includes(handle)) handles.push(handle);
          }
          if (!handles.length) continue;

          // The heading is the notification metadata ("X liked your post").
          // Reply text lives in a separate element and is deliberately ignored.
          const heading = row.querySelector('[role="heading"], h1, h2, h3');
          const labelText = heading ? cleanText(heading).slice(0, 120) : '';
          const attrText = Array.from(row.querySelectorAll('[aria-label], [title]'))
            .map((el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`)
            .join(' ')
            .slice(0, 200);
          const text = `${labelText} ${attrText}`.toLowerCase();

          let type = null;
          if (/repl|respond/.test(text)) type = 'reply_received';
          else if (/repost|reblog/.test(text)) type = 'quote';
          else if (/mention/.test(text)) type = 'mention';
          else if (/like|favourite|favorite/.test(text)) type = 'like';
          if (!type) continue;

          const postLink = Array.from(row.querySelectorAll('a[href]'))
            .map((a) => a.getAttribute('href') || '')
            .find((href) => /\/post\/|\/profile\/[A-Za-z0-9._-]+\/post\//.test(href)) || '';
          const noticeKey = `${this.id}_notice_${type}_${postLink || handles[0]}`;
          for (const handle of handles) {
            await this.record(handle, type, { direction: 'inbound', tweetId: noticeKey, isMutual: true });
          }
        } catch (err) {
          // Keep scanning the remaining notifications.
        }
      }
    }
    attach() {}

    // ---- shared helpers ----------------------------------------------------
    async injectInto(container, handle) {
      if (!container || !handle) return;
      if (this.currentUser && normalizeHandle(handle) === this.currentUser) return;
      if (container.querySelector && container.querySelector('.bond-badge')) return;
      try {
        await window.bondUI.injectBadge(container, normalizeHandle(handle), false);
      } catch (e) {}
    }

    async record(handle, type, extra = {}) {
      const target = normalizeHandle(handle);
      if (!target || (this.currentUser && target === this.currentUser)) return null;
      if (window.BondPlatforms && !window.BondPlatforms.isFeatureEnabled(platformSettings(), this.id, 'timeline')) {
        return null;
      }
      return window.bondStorage.recordInteraction(target, {
        type,
        direction: type.includes('received') ? 'inbound' : 'outbound',
        ...extra
      }, this.currentUser);
    }

    attachGenericClickCapture() {
      if (this.attached) return;
      this.attached = true;
      document.addEventListener('click', (e) => {
        try {
          if (window.BondPlatforms) {
            const settings = platformSettings();
            if (!window.BondPlatforms.isEnabled(settings, this.id)) return;
            if (!window.BondPlatforms.isFeatureEnabled(settings, this.id, 'timeline')) return;
          }
          this.onClick(e);
        } catch (err) {}
      }, true);
    }

    onClick() {}

    bindProfileSignal(handle, signals) {
      if (!handle || !window.bondStorage) return;
      return window.bondStorage.recordRelationshipSignal(handle, signals).catch(() => {});
    }

    /** Parses a follow-state pair from visible header text. */
    readFollowState(root) {
      if (!root) return { theyFollowYou: null, youFollowThem: null, isBlocked: false };
      const body = cleanText(root);
      const isBlocked = /blocked|restricted/i.test(body);
      const theyFollowYou = /follows you/i.test(body);
      const followingBtn = Array.from(root.querySelectorAll('button, [role="button"]')).find((b) => {
        const t = cleanText(b).toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        return t === 'following' || aria.includes('following') || t === 'unfollow';
      });
      const followBtn = Array.from(root.querySelectorAll('button, [role="button"]')).find((b) => {
        const t = cleanText(b).toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        return t === 'follow' || aria === 'follow' || t === 'follow back';
      });
      let youFollowThem = null;
      if (followingBtn) youFollowThem = true;
      else if (followBtn) youFollowThem = false;
      return { theyFollowYou: theyFollowYou ? true : null, youFollowThem, isBlocked };
    }

    /** Reads only direction + timestamp from a rendered DM bubble. */
    readBubbleMeta(bubble) {
      const style = window.getComputedStyle ? window.getComputedStyle(bubble) : null;
      const align = style ? (style.alignSelf || style.justifyContent || '') : '';
      const own = /flex-end|right|end/i.test(align) ||
        (bubble.getAttribute('data-outbound') === 'true') ||
        !!bubble.closest('[data-outbound="true"]');
      const timeEl = bubble.querySelector('time[datetime], time');
      const stamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || '') : '';
      let ts = stamp ? Date.parse(stamp) : 0;
      if (isNaN(ts) || ts <= 0) ts = 0;
      return { direction: own ? 'outbound' : 'inbound', timestamp: ts };
    }
  }

  /* ======================================================================
     Threads
     ====================================================================== */
  class ThreadsAdapter extends BasePlatformAdapter {
    constructor() {
      super('threads');
      this.profileLinks = 'a[href^="/@"], a[href*="threads.net/@"]';
    }

    detectIdentity() {
      // Threads renders the signed-in avatar/profile as the last item of the
      // primary navigation. Only authenticated chrome exposes this link.
      const navLinks = Array.from(document.querySelectorAll('a[href^="/@"]'));
      for (const link of navLinks) {
        const aria = (link.getAttribute('aria-label') || '').toLowerCase();
        const svgTitle = cleanText(link.querySelector('svg title')).toLowerCase();
        const isProfileNav = aria.includes('profile') || svgTitle.includes('profile');
        if (!isProfileNav) continue;
        const handle = normalizeHandle((link.getAttribute('href') || '').replace(/^\/@/, ''));
        if (!handle || RESERVED.has(handle)) continue;
        const img = link.querySelector('img');
        return { handle, displayName: handle, avatarUrl: img ? img.src : '' };
      }

      // Fallback: the own-profile page has an edit-profile control.
      const editBtn = document.querySelector('a[href*="/edit"], [aria-label*="Edit profile" i], button[aria-label*="Edit profile" i]');
      if (editBtn && location.pathname.startsWith('/@')) {
        const handle = normalizeHandle(location.pathname.replace(/^\/@/, ''));
        if (handle && !RESERVED.has(handle)) {
          const img = (document.querySelector('header img') || {}).src || '';
          return { handle, displayName: handle, avatarUrl: img };
        }
      }
      return null;
    }

    postContainers() {
      const set = new Set();
      document.querySelectorAll('article, div[data-pressable-container="true"]').forEach((el) => {
        if (el.querySelector('a[href^="/@"]') && !el.querySelector('article')) set.add(el);
      });
      // Threads also renders compact posts as divs with a time element.
      document.querySelectorAll('div').forEach((el) => {
        if (el.children.length > 6) return;
        if (el.querySelector('a[href^="/@"]') && el.querySelector('time')) {
          const parent = el.parentElement;
          if (parent && !parent.querySelector('article')) set.add(el);
        }
      });
      return Array.from(set).slice(0, 60);
    }

    authorFor(post) {
      const links = post.querySelectorAll('a[href^="/@"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const handle = normalizeHandle(href.replace(/^\/@/, ''));
        if (handle && !RESERVED.has(handle) && !href.includes('/post/')) {
          return { handle, displayName: cleanText(link) || handle, avatarUrl: (link.querySelector('img') || {}).src || '' };
        }
      }
      return null;
    }

    async scanFeed() {
      const settings = platformSettings();
      if (settings.showBadgesOnTimeline === false) return;
      for (const post of this.postContainers()) {
        const author = this.authorFor(post);
        if (!author) continue;
        if (this.currentUser && author.handle === this.currentUser) continue;

        const container = post.querySelector('a[href^="/@"]')?.parentElement;
        if (!container) continue;
        const nameRow = container.querySelector('[data-testid="User-Name"]') ||
          container.closest('[data-pressable-container="true"]')?.querySelector('a[href^="/@"]')?.parentElement ||
          container;
        await this.injectInto(nameRow, author.handle);

        const avatar = author.avatarUrl;
        if (avatar) {
          const user = await window.bondStorage.getUser(author.handle);
          if (!user || !user.avatarUrl) {
            await window.bondStorage.saveUser(author.handle, { avatarUrl: avatar, displayName: author.displayName });
          }
        }
      }
    }

    async scanProfile() {
      const match = location.pathname.match(/^\/@([A-Za-z0-9._]{1,40})\/?$/);
      if (!match) return;
      const handle = normalizeHandle(match[1]);
      if (!handle || (this.currentUser && handle === this.currentUser)) return;

      const header = document.querySelector('header') || document.querySelector('main');
      if (!header) return;

      const titleEl = header.querySelector('h1, h2');
      const avatarImg = header.querySelector('img[src*="/t51."], header img');
      const signals = this.readFollowState(header);
      if (signals.isBlocked || signals.theyFollowYou !== null || signals.youFollowThem !== null) {
        await this.bindProfileSignal(handle, { ...signals, displayName: cleanText(titleEl) || handle, avatarUrl: avatarImg ? avatarImg.src : '' });
      }

      const nameRow = titleEl ? titleEl.parentElement : header;
      if (nameRow) await window.bondUI.injectBadge(nameRow, handle, true);
      const stored = await window.bondStorage.getUser(handle);
      if (window.bondUI && window.bondUI.updateProfileFollowBadge) {
        await window.bondUI.updateProfileFollowBadge(handle, stored ? stored.signals : signals);
      }
    }

    onClick(e) {
      const target = e.target;
      if (!target || !target.closest) return;
      const post = target.closest('article, div[data-pressable-container="true"]') || this.findPostAncestor(target);
      if (!post) return;
      const author = this.authorFor(post);
      if (!author) return;

      const aria = (target.closest('[aria-label]')?.getAttribute('aria-label') || '').toLowerCase();
      const label = aria || cleanText(target.closest('[role="button"], button')).toLowerCase();

      if (/\blike\b|\bliked\b/.test(label)) {
        const active = (target.closest('[aria-pressed]')?.getAttribute('aria-pressed') === 'true') || /unlike|liked/.test(label);
        if (!active) {
          if (window.bondUI) window.bondUI.optimisticBoost(author.handle, 3);
          this.record(author.handle, 'like', { tweetId: this.postKey(post), isMutual: false });
        }
      } else if (/\brepost\b|\breposted\b/.test(label)) {
        this.record(author.handle, 'quote', { tweetId: this.postKey(post), isMutual: false });
      }
    }

    findPostAncestor(node) {
      let el = node;
      for (let i = 0; i < 8 && el; i++) {
        if (el.querySelector && el.querySelector('a[href^="/@"]') && el.querySelector('time')) return el;
        el = el.parentElement;
      }
      return null;
    }

    postKey(post) {
      const time = post.querySelector('time[datetime]');
      return `threads_${normalizeHandle((post.querySelector('a[href^="/@"]') || {}).getAttribute?.('href') || '')}_${time ? time.getAttribute('datetime') : ''}`;
    }

    async scanDms() {
      if (!location.pathname.startsWith('/messages') && !location.pathname.startsWith('/direct')) return;
      await this.scanDmInbox();
      await this.scanActiveThread();
    }

    async scanDmInbox() {
      const rows = document.querySelectorAll('a[href^="/messages/"], div[role="listitem"] a[href*="/messages/"]');
      for (const link of rows) {
        const href = link.getAttribute('href') || '';
        const convId = normalizeHandle(href.split('/messages/')[1] || '');
        if (!convId) continue;
        const row = link.closest('div[role="listitem"], div') || link;
        // Metadata only: participant comes from the profile link, never from the
        // inbox preview text (which may contain private message contents).
        const profileLink = row.querySelector('a[href^="/@"]');
        const participant = profileLink
          ? normalizeHandle((profileLink.getAttribute('href') || '').replace(/^\/@/, '').split('/')[0]) || null
          : null;
        const unread = !!row.querySelector('[aria-label*="unread" i], [class*="unread" i]');
        const existing = await window.bondStorage.getDmConversation(convId);
        if (!existing) {
          await window.bondStorage.saveDmConversation(convId, {
            convId,
            isGroup: false,
            title: participant ? `@${participant}` : convId,
            participants: participant ? [participant] : [],
            sentCount: 0,
            receivedCount: 0,
            totalCount: 0,
            waitingForUserReply: unread,
            firstSeenTimestamp: Date.now()
          });
        }
        if (window.bondUI && window.bondUI.injectDmRowBadge) {
          await window.bondUI.injectDmRowBadge(row, convId, participant, false, { hasUnread: unread });
        }
      }
    }

    async scanActiveThread() {
      const match = location.pathname.match(/\/messages\/([A-Za-z0-9_-]+)/);
      if (!match) return;
      const convId = normalizeHandle(match[1]);
      const container = document.querySelector('main') || document.body;
      const header = container.querySelector('header');
      const handleMatch = cleanText(header).match(/@([A-Za-z0-9._]{1,40})/);
      const targetHandle = handleMatch ? normalizeHandle(handleMatch[1]) : null;

      const bubbles = Array.from(container.querySelectorAll('[data-testid*="message" i], div[dir="auto"]'))
        .filter((el) => el.children.length <= 4)
        .slice(-80);
      if (bubbles.length > 0) {
        const entries = bubbles.map((bubble, idx) => {
          const meta = this.readBubbleMeta(bubble);
          const timeEl = bubble.querySelector('time[datetime]');
          return {
            fingerprint: `${meta.direction}_${meta.timestamp || timeEl?.getAttribute('datetime') || idx}_${idx}`,
            direction: meta.direction,
            timestamp: meta.timestamp || Date.now() - (bubbles.length - idx) * 60000,
            index: idx
          };
        });
        await window.bondStorage.ingestMessageEntries(convId, entries);
      }
      if (window.bondUI && window.bondUI.injectDmHeaderPill && header) {
        await window.bondUI.injectDmHeaderPill(header, convId, targetHandle, false);
      }
    }
  }

  /* ======================================================================
     Bluesky
     ====================================================================== */
  class BlueskyAdapter extends BasePlatformAdapter {
    constructor() {
      super('bluesky');
    }

    detectIdentity() {
      // The Bluesky web client exposes the signed-in account through the
      // "Profile" navigation item. On a profile page the own account also has
      // an edit-profile affordance.
      const candidates = Array.from(document.querySelectorAll('a[href^="/profile/"]'));
      for (const link of candidates) {
        const aria = (link.getAttribute('aria-label') || '').toLowerCase();
        const testid = (link.getAttribute('data-testid') || '').toLowerCase();
        const text = cleanText(link).toLowerCase();
        const isNav = aria === 'profile' || aria.includes('profile') && aria.includes('nav') ||
          testid.includes('profile') && (testid.includes('tab') || testid.includes('nav')) ||
          text === 'profile' || text === 'my profile';
        if (!isNav) continue;
        const handle = normalizeHandle((link.getAttribute('href') || '').replace('/profile/', ''));
        if (handle) {
          const img = link.querySelector('img');
          return { handle, displayName: handle, avatarUrl: img ? img.src : '' };
        }
      }

      const edit = document.querySelector('[data-testid="editProfileButton"], [aria-label*="Edit profile" i], button[aria-label*="Edit Profile" i]');
      const m = location.pathname.match(/^\/profile\/([^/]+)/);
      if (edit && m && m[1]) {
        const handle = normalizeHandle(decodeURIComponent(m[1]));
        return { handle, displayName: handle, avatarUrl: '' };
      }
      return null;
    }

    postContainers() {
      const nodes = document.querySelectorAll(
        '[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"], [data-testid^="feedItem-"], article'
      );
      return Array.from(nodes).filter((n) => n.querySelector('a[href^="/profile/"]')).slice(0, 60);
    }

    authorFor(post) {
      const testid = post.getAttribute('data-testid') || '';
      const byMatch = testid.match(/-by-([A-Za-z0-9._:-]+)$/);
      if (byMatch && byMatch[1]) {
        const handle = normalizeHandle(byMatch[1]);
        if (handle) {
          return { handle, displayName: handle, avatarUrl: (post.querySelector('img') || {}).src || '' };
        }
      }
      const link = post.querySelector('a[href^="/profile/"]');
      if (link) {
        const handle = normalizeHandle((link.getAttribute('href') || '').replace('/profile/', ''));
        if (handle) return { handle, displayName: cleanText(link) || handle, avatarUrl: (link.querySelector('img') || {}).src || '' };
      }
      return null;
    }

    async scanFeed() {
      const settings = platformSettings();
      if (settings.showBadgesOnTimeline === false) return;
      for (const post of this.postContainers()) {
        const author = this.authorFor(post);
        if (!author) continue;
        if (this.currentUser && author.handle === this.currentUser) continue;
        const link = post.querySelector('a[href^="/profile/"]');
        const container = link ? (link.parentElement?.parentElement || link.parentElement) : post;
        await this.injectInto(container, author.handle);

        if (author.avatarUrl) {
          const user = await window.bondStorage.getUser(author.handle);
          if (!user || !user.avatarUrl) {
            await window.bondStorage.saveUser(author.handle, { avatarUrl: author.avatarUrl, displayName: author.displayName });
          }
        }
      }
    }

    async scanProfile() {
      const match = location.pathname.match(/^\/profile\/([^/]+)/);
      if (!match) return;
      const handle = normalizeHandle(decodeURIComponent(match[1]));
      if (!handle || (this.currentUser && handle === this.currentUser)) return;

      const main = document.querySelector('main') || document.body;
      const header = main.querySelector('[data-testid="profileScreen"]') || main;
      const signals = this.readFollowState(header);

      // Bluesky labels its relationship explicitly: "Follows you".
      if (signals.isBlocked || signals.theyFollowYou !== null || signals.youFollowThem !== null) {
        await this.bindProfileSignal(handle, {
          ...signals,
          displayName: handle,
          avatarUrl: (header.querySelector('img') || {}).src || ''
        });
      }

      const nameEl = header.querySelector('h1, h2, [data-testid="profileHeaderDisplayName"]');
      const container = nameEl ? nameEl.parentElement : header;
      if (container) await window.bondUI.injectBadge(container, handle, true);
      const stored = await window.bondStorage.getUser(handle);
      if (window.bondUI && window.bondUI.updateProfileFollowBadge) {
        await window.bondUI.updateProfileFollowBadge(handle, stored ? stored.signals : signals);
      }
    }

    onClick(e) {
      const target = e.target;
      if (!target || !target.closest) return;
      const post = target.closest('[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"], [data-testid^="feedItem-"]') ||
        this.findPostAncestor(target);
      if (!post) return;
      const author = this.authorFor(post);
      if (!author) return;

      const btn = target.closest('[data-testid], [aria-label]');
      const id = (btn && (btn.getAttribute('data-testid') || btn.getAttribute('aria-label')) || '').toLowerCase();

      if (id.includes('like')) {
        const pressed = btn.getAttribute('aria-pressed') === 'true';
        if (!pressed) {
          if (window.bondUI) window.bondUI.optimisticBoost(author.handle, 3);
          this.record(author.handle, 'like', { tweetId: this.postKey(post), isMutual: false });
        }
      } else if (id.includes('repost')) {
        this.record(author.handle, 'quote', { tweetId: this.postKey(post), isMutual: false });
      }
    }

    findPostAncestor(node) {
      let el = node;
      for (let i = 0; i < 10 && el; i++) {
        const tid = el.getAttribute && (el.getAttribute('data-testid') || '');
        if (tid.startsWith('feedItem') || tid.startsWith('postThreadItem')) return el;
        el = el.parentElement;
      }
      return null;
    }

    postKey(post) {
      const uri = post.getAttribute('data-uri') || '';
      const testid = post.getAttribute('data-testid') || '';
      const time = post.querySelector('time[datetime]');
      return `bsky_${uri || testid}_${time ? time.getAttribute('datetime') : ''}`;
    }

    async scanDms() {
      if (!location.pathname.startsWith('/messages')) return;
      await this.scanDmInbox();
      await this.scanActiveThread();
    }

    async scanDmInbox() {
      const links = document.querySelectorAll('a[href^="/messages/"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const convId = normalizeHandle(href.split('/messages/')[1] || '');
        if (!convId) continue;
        const row = link.closest('[role="listitem"], div') || link;
        // Metadata only: resolve the participant from profile links instead of
        // reading the inbox preview (which can include private message text).
        const profileLink = row.querySelector('a[href^="/profile/"]');
        const participant = profileLink
          ? normalizeHandle(decodeURIComponent((profileLink.getAttribute('href') || '').replace('/profile/', '').split('/')[0])) || null
          : null;
        const unread = !!row.querySelector('[aria-label*="unread" i]');
        const existing = await window.bondStorage.getDmConversation(convId);
        if (!existing) {
          await window.bondStorage.saveDmConversation(convId, {
            convId,
            isGroup: false,
            title: participant ? `@${participant}` : convId,
            participants: participant ? [participant] : [],
            totalCount: 0,
            waitingForUserReply: unread,
            firstSeenTimestamp: Date.now()
          });
        }
        if (window.bondUI && window.bondUI.injectDmRowBadge) {
          await window.bondUI.injectDmRowBadge(row, convId, participant, false, { hasUnread: unread });
        }
      }
    }

    async scanActiveThread() {
      const match = location.pathname.match(/\/messages\/([^/?#]+)/);
      if (!match) return;
      const convId = normalizeHandle(decodeURIComponent(match[1]));
      const container = document.querySelector('main') || document.body;
      const header = container.querySelector('header') || container;
      const text = cleanText(header);
      const handleMatch = text.match(/@([A-Za-z0-9._:-]{1,80})/);
      const targetHandle = handleMatch ? normalizeHandle(handleMatch[1]) : null;

      const bubbles = Array.from(container.querySelectorAll('[data-testid*="message" i], div[dir="auto"]'))
        .filter((el) => el.children.length <= 4)
        .slice(-80);
      if (bubbles.length > 0) {
        const entries = bubbles.map((bubble, idx) => {
          const meta = this.readBubbleMeta(bubble);
          return {
            fingerprint: `${meta.direction}_${meta.timestamp || idx}_${idx}`,
            direction: meta.direction,
            timestamp: meta.timestamp || Date.now() - (bubbles.length - idx) * 60000,
            index: idx
          };
        });
        await window.bondStorage.ingestMessageEntries(convId, entries);
      }
      if (window.bondUI && window.bondUI.injectDmHeaderPill && header) {
        await window.bondUI.injectDmHeaderPill(header, convId, targetHandle, false);
      }
    }
  }

  const adapters = {
    threads: new ThreadsAdapter(),
    bluesky: new BlueskyAdapter()
  };
  adapters.threads.attachGenericClickCapture();
  adapters.bluesky.attachGenericClickCapture();

  window.BondAdapters = adapters;

  /** Boot the adapter for the current host, or no-op when the platform is off. */
  window.bondBootPlatformAdapter = async function () {
    const platform = window.BondPlatforms ? window.BondPlatforms.current() : { id: 'x' };
    if (platform.id === 'x') return false;
    const adapter = adapters[platform.id];
    if (!adapter) return false;
    return adapter.boot();
  };

  // Answer the popup's active-account probe on non-X hosts as well.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'bondscore:get_active_account') {
        const platform = window.BondPlatforms ? window.BondPlatforms.current() : { id: 'x' };
        const adapter = adapters[platform.id];
        sendResponse({
          handle: (adapter && adapter.currentUser) || (window.bondStorage && window.bondStorage.currentUser) || null,
          platform: platform.id,
          metadata: null
        });
        return true;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.bondBootPlatformAdapter().catch(() => {});
    }, { once: true });
  } else {
    window.bondBootPlatformAdapter().catch(() => {});
  }
})();
