/**
 * BondScore for X - Interaction & Identity Detector
 * Identifies the logged-in user and captures real-time interactions (replies, likes, quotes).
 */

class InteractionDetector {
  constructor() {
    this.currentUser = null;
    this.lastDetectedDomHandle = null;
    this.processedTweetIds = new Set();
    this.lastDetectedUrl = location.href;
    this.listenersAttached = false;
    this.attachEventListeners();
  }

  async init() {
    await this.detectCurrentUser();
    this.attachEventListeners();
    console.log('[BondScore] Interaction Detector initialized. Current user:', this.currentUser || 'detecting...');
  }

  /**
   * Gets an avatar only when its X avatar container identifies the requested
   * account. A page-wide first-image lookup can accidentally return the signed-
   * in user's sidebar avatar while viewing someone else's profile.
   */
  getAvatarUrlForHandle(handle, root = document) {
    const cleanHandle = (handle || '').replace(/^@/, '').toLowerCase().trim();
    if (!cleanHandle || !root || typeof root.querySelectorAll !== 'function') return '';

    const avatarContainers = Array.from(root.querySelectorAll('[data-testid^="UserAvatar-Container-"]'));
    const targetContainer = avatarContainers.find((container) => {
      const testId = container.getAttribute('data-testid') || '';
      const containerHandle = testId.slice('UserAvatar-Container-'.length).toLowerCase();
      return containerHandle === cleanHandle;
    });

    if (targetContainer) {
      const image = targetContainer.querySelector('img[src*="profile_images"], img');
      const src = image && (image.currentSrc || image.src || image.getAttribute('src'));
      if (src) return src;
    }

    // Some X layouts omit the avatar-container test id but label the image.
    const images = Array.from(root.querySelectorAll('img[src*="profile_images"]'));
    const labeledImage = images.find((image) => {
      const alt = (image.getAttribute('alt') || '').toLowerCase();
      return alt.includes(`@${cleanHandle}`) || alt === cleanHandle;
    });
    return labeledImage ? (labeledImage.currentSrc || labeledImage.src || labeledImage.getAttribute('src') || '') : '';
  }

  /**
   * Reads active account identity strictly from authenticated navigation elements.
   * Completely immune to false positives from visited profiles or tweet authors.
   */
  extractActiveAccountFromDOM() {
    const RESERVED_PATHS = [
      'home', 'explore', 'notifications', 'messages', 'settings', 'i',
      'bookmarks', 'lists', 'search', 'compose', 'communities', 'premium',
      'verified-choose', 'grok', 'jobs', 'about', 'privacy', 'tos'
    ];

    // 1. Sidebar Account Switcher Button (Desktop web bottom left)
    const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (accountSwitcher) {
      // 1A. Try reading @handle from text content (wide screen)
      const text = accountSwitcher.innerText || '';
      const textMatch = text.match(/@([A-Za-z0-9_]+)/);
      const img = accountSwitcher.querySelector('img');
      const avatarUrl = img ? img.src : '';

      if (textMatch && textMatch[1]) {
        const handle = textMatch[1].toLowerCase().trim();
        const parts = text.split('@');
        const displayName = parts[0] ? parts[0].trim().split('\n')[0] : handle;
        return { handle, displayName, avatarUrl };
      }

      // 1B. Try avatar container testid: UserAvatar-Container-<handle> (collapsed icon-only sidebar)
      const avatarContainer = accountSwitcher.querySelector('[data-testid^="UserAvatar-Container-"]');
      if (avatarContainer) {
        const tid = avatarContainer.getAttribute('data-testid') || '';
        const m = tid.match(/UserAvatar-Container-([A-Za-z0-9_]+)/i);
        if (m && m[1] && !RESERVED_PATHS.includes(m[1].toLowerCase())) {
          const handle = m[1].toLowerCase().trim();
          return { handle, displayName: handle, avatarUrl };
        }
      }

      // 1C. Try aria-label on button
      const aria = accountSwitcher.getAttribute('aria-label') || '';
      const ariaMatch = aria.match(/@([A-Za-z0-9_]+)/);
      if (ariaMatch && ariaMatch[1]) {
        const handle = ariaMatch[1].toLowerCase().trim();
        return { handle, displayName: handle, avatarUrl };
      }
    }

    // 2. Profile Navigation Tab Link (Sidebar navigation link to own profile)
    // On X, AppTabBar_Profile_Link ALWAYS points strictly to the logged-in user, never to visited profiles.
    const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (profileLink) {
      const rawHref = profileLink.getAttribute('href') || '';
      // Clean URL: remove protocol/domain, query parameters, trailing slashes
      const cleanHref = rawHref.replace(/^https?:\/\/[^\/]+/, '').split('?')[0].split('#')[0].replace(/\/+$/, '');
      const match = cleanHref.match(/^\/([A-Za-z0-9_]+)$/);
      if (match && match[1] && !RESERVED_PATHS.includes(match[1].toLowerCase())) {
        const handle = match[1].toLowerCase().trim();
        const switcherImg = accountSwitcher ? accountSwitcher.querySelector('img') : null;
        const linkImg = profileLink.querySelector('img');
        const avatarUrl = (switcherImg && switcherImg.src) || (linkImg && linkImg.src) || '';
        return { handle, displayName: handle, avatarUrl };
      }
    }

    // 3. Top Navigation Bar Profile Button (Mobile/responsive header)
    const topNavProfile = document.querySelector('button[data-testid="TopNavBar_Profile_Button"], [data-testid="TopNavBar_Profile_Button"]');
    if (topNavProfile) {
      const img = topNavProfile.querySelector('img');
      const avatarUrl = img ? img.src : '';
      const avatarContainer = topNavProfile.querySelector('[data-testid^="UserAvatar-Container-"]');
      if (avatarContainer) {
        const tid = avatarContainer.getAttribute('data-testid') || '';
        const m = tid.match(/UserAvatar-Container-([A-Za-z0-9_]+)/i);
        if (m && m[1] && !RESERVED_PATHS.includes(m[1].toLowerCase())) {
          return { handle: m[1].toLowerCase().trim(), displayName: m[1], avatarUrl };
        }
      }
      const alt = img ? img.getAttribute('alt') || '' : '';
      const match = alt.match(/@([A-Za-z0-9_]+)/);
      if (match && match[1]) {
        return { handle: match[1].toLowerCase().trim(), displayName: match[1], avatarUrl };
      }
    }

    // If no authenticated navigation identity element is rendered, return null.
    // Never fall back to generic links or header tags that could match visited profiles!
    return null;
  }

  /**
   * Actively checks if the user has switched Twitter accounts.
   * Only triggers an account switch when the DOM identity in this tab genuinely transitions,
   * completely preventing false triggers or overrides of user selections.
   */
  async checkAccountSwitch() {
    const discovered = this.extractActiveAccountFromDOM();
    if (!discovered || !discovered.handle) return this.currentUser;

    const newHandle = discovered.handle.toLowerCase().trim();

    // If matches currentUser, keep lock in sync and do not trigger a reset
    if (this.currentUser === newHandle) {
      this.lastDetectedDomHandle = newHandle;
      if (window.bondStorage && !window.bondStorage.currentUser) {
        window.bondStorage.currentUser = newHandle;
      }
      return this.currentUser;
    }

    // Only genuinely trigger switch if DOM identity in this tab changed to a different handle
    if (this.currentUser !== newHandle) {
      const previousUser = this.currentUser;
      this.lastDetectedDomHandle = newHandle;
      this.currentUser = newHandle;
      if (window.bondStorage) {
        window.bondStorage.currentUser = newHandle;
      }
      console.log(`[BondScore] Account switch detected on X: ${previousUser ? '@' + previousUser : 'initial'} -> @${newHandle}`);
      await window.bondStorage.switchAccount(newHandle, {
        displayName: discovered.displayName,
        avatarUrl: discovered.avatarUrl
      });
      if (window.bondUI && typeof window.bondUI.handleAccountSwitched === 'function') {
        await window.bondUI.handleAccountSwitched(newHandle, previousUser);
      }
      return newHandle;
    }
    return this.currentUser;
  }

  /**
   * Identifies current user's Twitter handle from navigation or profile elements.
   */
  async detectCurrentUser(forceFresh = false) {
    if (!forceFresh && this.currentUser) return this.currentUser;

    const fromDOM = this.extractActiveAccountFromDOM();
    if (fromDOM && fromDOM.handle) {
      const handle = fromDOM.handle.toLowerCase().trim();
      const previous = this.currentUser;
      this.lastDetectedDomHandle = handle;
      this.currentUser = handle;
      if (window.bondStorage) {
        window.bondStorage.currentUser = handle;
      }
      if (previous && previous !== handle) {
        await window.bondStorage.switchAccount(handle, {
          displayName: fromDOM.displayName,
          avatarUrl: fromDOM.avatarUrl
        });
        if (window.bondUI) {
          await window.bondUI.handleAccountSwitched(handle, previous);
        }
      } else {
        // Same account, ensure storage pointer is initialized without flushing caches
        await window.bondStorage.getCurrentUser();
      }
      return handle;
    }

    // Check stored user if DOM elements haven't rendered yet
    if (!this.currentUser) {
      const stored = await window.bondStorage.getCurrentUser();
      if (stored) {
        this.currentUser = stored;
        this.lastDetectedDomHandle = stored;
        return stored;
      }
    }

    return this.currentUser;
  }

  /**
   * Attaches passive DOM event listeners for clicks on Likes, Replies, Reposts.
   */
  attachEventListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    // Track active reply target whenever reply icon is clicked or composer focused
    document.addEventListener('click', (e) => {
      try {
        // Detect clicks on account switcher button or account switch menu items
        const isAccountAction = e.target.closest(
          '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AccountSwitcher_Menu"], [data-testid^="UserAvatar-Container"], [role="menuitem"]'
        );
        if (isAccountAction) {
          setTimeout(() => this.checkAccountSwitch(), 350);
          setTimeout(() => this.checkAccountSwitch(), 1200);
        }

        const replyIcon = e.target.closest('[data-testid="reply"]');
        if (replyIcon) {
          const tweetEl = replyIcon.closest('article[data-testid="tweet"], [data-testid="tweet"], [data-testid="cellInnerDiv"]');
          if (tweetEl) {
            this.activeReplyTarget = this.extractTweetAuthor(tweetEl);
          }
        }
        this._handleClickEvent(e);
      } catch (err) {
        console.warn('[BondScore] Event capture error:', err);
      }
    }, true);

    // Sync if account switched from popup or another tab
    window.addEventListener('bondscore:account_switched', (e) => {
      const acc = e.detail && e.detail.currentAccount;
      if (acc && acc !== this.currentUser) {
        this.currentUser = acc;
      }
    });

    // Track composer focus
    document.addEventListener('focusin', (e) => {
      try {
        const composer = e.target.closest('[data-testid*="tweetTextarea"], [role="textbox"], [contenteditable="true"]');
        if (composer) {
          // Look for preceding tweet
          const container = composer.closest('[data-testid="cellInnerDiv"], [aria-modal="true"], [role="dialog"]') || composer.parentElement;
          if (container) {
            const tweet = container.querySelector('[data-testid="tweet"], article') || (container.previousElementSibling && container.previousElementSibling.querySelector('[data-testid="tweet"], article'));
            if (tweet) {
              const author = this.extractTweetAuthor(tweet);
              if (author && (!this.currentUser || author.handle !== this.currentUser)) {
                this.activeReplyTarget = author;
              }
            }
          }
        }
      } catch (err) {}
    }, true);

    // Keyboard shortcut (Ctrl+Enter / Cmd+Enter / Enter) to submit comments or DMs
    document.addEventListener('keydown', (e) => {
      try {
        const composer = e.target.closest('[data-testid*="tweetTextarea"], [data-testid="dmComposerTextInput"], [role="textbox"], [contenteditable="true"]');
        if (!composer) return;

        // Check if inside DM conversation
        const isDM = !!composer.closest('[data-testid="DMDrawer"], [data-testid="DMConversation"], [data-testid="dmComposerTextInput"], [aria-label*="Direct message" i], [aria-label*="Message" i]') ||
                     location.pathname.startsWith('/i/chat') ||
                     location.pathname.startsWith('/messages');
        if (isDM && e.key === 'Enter' && !e.shiftKey) {
          this._handleDMSubmit(composer);
          return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          if (isDM) {
            this._handleDMSubmit(composer);
          } else {
            const submitBtn = document.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], [data-testid*="tweetButton"]');
            this._handleReplySubmit(submitBtn || composer);
          }
        }
      } catch (err) {}
    }, true);
  }

  _handleClickEvent(e) {
    const target = e.target;
    if (!target) return;

    // 0. Check for DM Send Button (Handles standard messages & /i/chat/)
    const isDMPage = location.pathname.startsWith('/i/chat') || location.pathname.startsWith('/messages');
    const dmSendBtn = target.closest(
      '[data-testid="dmComposerSendButton"], ' +
      '[data-testid="sendButton"], ' +
      '[aria-label="Send" i], ' +
      '[aria-label*="Send message" i], ' +
      'button[data-testid*="send" i]'
    );
    if (dmSendBtn || (isDMPage && target.closest('[role="button"]') && target.closest('[role="button"]').querySelector('svg path[d*="M2.504 21.866"], svg[data-testid="send"]'))) {
      this._handleDMSubmit(dmSendBtn || target);
      return;
    }

    // 1. Check for Like button
    const likeBtn = target.closest('[data-testid="like"]');
    if (likeBtn) {
      this._handleLikeClick(likeBtn);
      return;
    }

    // 2. Check for Unlike button
    const unlikeBtn = target.closest('[data-testid="unlike"]');
    if (unlikeBtn) {
      this._handleUnlikeClick(unlikeBtn);
      return;
    }

    // 3. Check for Tweet/Reply Submit button
    const submitBtn = target.closest('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
    if (submitBtn) {
      this._handleReplySubmit(submitBtn);
      return;
    }

    // 4. Check for Retweet / Repost button
    const retweetBtn = target.closest('[data-testid="retweet"], [data-testid="retweetConfirm"]');
    if (retweetBtn) {
      this._handleRetweetClick(retweetBtn);
      return;
    }

    // 5. Check for Follow / Unfollow button
    const followBtn = target.closest('[data-testid$="-follow"], [data-testid$="-unfollow"], [data-testid="confirmationSheetConfirm"]');
    if (followBtn) {
      this._handleFollowActionClick(followBtn);
      return;
    }
  }

  async _handleLikeClick(likeBtn) {
    const tweetEl = likeBtn.closest('article[data-testid="tweet"]');
    if (!tweetEl) return;

    const author = this.extractTweetAuthor(tweetEl);
    if (!author || (this.currentUser && author.handle === this.currentUser)) return;

    // Immediate real-time optimistic score boost & pulse animation
    if (window.bondUI) {
      window.bondUI.optimisticBoost(author.handle, 4);
    }

    const tweetId = this.extractTweetId(tweetEl);
    await window.bondStorage.recordInteraction(author.handle, {
      type: 'like',
      tweetId,
      displayName: author.displayName,
      avatarUrl: author.avatarUrl,
      isMutual: false
    }, this.currentUser);

    if (window.bondUI) {
      window.bondUI.refreshBadgesForUser(author.handle, true);
    }
  }

  async _handleUnlikeClick(unlikeBtn) {
    const tweetEl = unlikeBtn.closest('article[data-testid="tweet"]');
    if (!tweetEl) return;

    const author = this.extractTweetAuthor(tweetEl);
    if (!author || (this.currentUser && author.handle === this.currentUser)) return;

    const tweetId = this.extractTweetId(tweetEl);
    await window.bondStorage.removeInteraction(author.handle, tweetId, 'like', this.currentUser);

    if (window.bondUI) {
      window.bondUI.refreshBadgesForUser(author.handle, true);
    }
  }

  async _handleRetweetClick(retweetBtn) {
    const tweetEl = retweetBtn.closest('article[data-testid="tweet"]');
    if (!tweetEl) return;

    const author = this.extractTweetAuthor(tweetEl);
    if (!author || (this.currentUser && author.handle === this.currentUser)) return;

    if (window.bondUI) {
      window.bondUI.optimisticBoost(author.handle, 6);
    }

    const tweetId = this.extractTweetId(tweetEl);
    await window.bondStorage.recordInteraction(author.handle, {
      type: 'quote',
      tweetId,
      displayName: author.displayName,
      avatarUrl: author.avatarUrl,
      isMutual: false
    }, this.currentUser);

    if (window.bondUI) {
      window.bondUI.refreshBadgesForUser(author.handle, true);
    }
  }

  async _handleReplySubmit(submitBtn) {
    let targetHandle = null;

    // 0. Check if submitBtn itself is inside a tweet card (e.g. inline reply on timeline or test harness)
    if (!targetHandle && submitBtn && submitBtn.closest) {
      const parentTweet = submitBtn.closest('article[data-testid="tweet"], [data-testid="tweet"]');
      if (parentTweet) {
        const author = this.extractTweetAuthor(parentTweet);
        if (author && (!this.currentUser || author.handle !== this.currentUser)) {
          targetHandle = author.handle;
        }
      }
    }

    // 1. Check if we saved the active reply target when the user clicked the reply icon or focused the composer
    if (this.activeReplyTarget && this.activeReplyTarget.handle && (!this.currentUser || this.activeReplyTarget.handle !== this.currentUser)) {
      targetHandle = this.activeReplyTarget.handle;
    }

    // 2. Check modal or inline composer parent
    if (!targetHandle && submitBtn && submitBtn.closest) {
      const composerModal = submitBtn.closest('[aria-modal="true"], [role="dialog"]');
      if (composerModal) {
        // Look for tweet inside modal
        const targetTweet = composerModal.querySelector('article[data-testid="tweet"], div[data-testid="tweet"], div[data-testid="cellInnerDiv"]');
        if (targetTweet) {
          const author = this.extractTweetAuthor(targetTweet);
          if (author && (!this.currentUser || author.handle !== this.currentUser)) targetHandle = author.handle;
        }

        // Look for handle links in modal
        if (!targetHandle) {
          const links = composerModal.querySelectorAll('a[role="link"][href^="/"]');
          for (const l of links) {
            const match = (l.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]+)$/);
            if (match && match[1] && !['home', 'explore', 'notifications', 'messages', 'i', 'compose'].includes(match[1].toLowerCase())) {
              const h = match[1].toLowerCase();
              if (!this.currentUser || h !== this.currentUser) {
                targetHandle = h;
                break;
              }
            }
          }
        }
      }
    }

    // 3. Look for "Replying to @..." text anywhere near composer
    if (!targetHandle && submitBtn && submitBtn.closest) {
      const container = submitBtn.closest('[data-testid="cellInnerDiv"]') || submitBtn.closest('div[class*="css-"]') || document.body;
      const text = container.innerText || '';
      const repMatch = text.match(/Replying to\s+@([A-Za-z0-9_]+)/i);
      if (repMatch && repMatch[1]) {
        const h = repMatch[1].toLowerCase();
        if (!this.currentUser || h !== this.currentUser) {
          targetHandle = h;
        }
      }
    }

    // 4. Check if page URL is a tweet status: /<handle>/status/<id>
    if (!targetHandle) {
      const match = location.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/\d+/);
      if (match && match[1]) {
        const h = match[1].toLowerCase();
        if (!this.currentUser || h !== this.currentUser) {
          targetHandle = h;
        }
      }
    }

    // 5. Check the primary tweet on screen
    if (!targetHandle) {
      const mainTweet = document.querySelector('article[data-testid="tweet"]');
      if (mainTweet) {
        const author = this.extractTweetAuthor(mainTweet);
        if (author && (!this.currentUser || author.handle !== this.currentUser)) {
          targetHandle = author.handle;
        }
      }
    }

    if (targetHandle && targetHandle !== this.currentUser) {
      console.log(`[BondScore] Comment/Reply detected to @${targetHandle}! Incrementing score...`);
      // Check if replying inside an active tweet thread vs single timeline post
      const isThread = location.pathname.includes('/status/') || !!document.querySelector('div[aria-label*="Timeline: Conversation"]');
      const eventType = isThread ? 'reply_thread' : 'reply_sent';

      // Check if there is already a dialogue/reciprocal history with this user
      const existingUser = await window.bondStorage.getUser(targetHandle);
      const isMutual = !!(existingUser && (existingUser.stats.repliesReceived > 0 || existingUser.stats.mutualExchanges > 0));

      const pointBoost = isMutual ? 18 : (isThread ? 14 : 8);
      if (window.bondUI) {
        window.bondUI.optimisticBoost(targetHandle, pointBoost);
      }

      await window.bondStorage.recordInteraction(targetHandle, {
        type: eventType,
        timestamp: Date.now(),
        tweetId: `reply_${Date.now()}`,
        isMutual,
        isThread,
        direction: 'outbound'
      }, this.currentUser);

      if (window.bondUI) {
        window.bondUI.refreshBadgesForUser(targetHandle, true);
      }

      this.activeReplyTarget = null;
    }
  }

  /**
   * Extracts author info from a tweet element.
   */
  extractTweetAuthor(tweetEl) {
    try {
      const userElem = tweetEl.querySelector('[data-testid="User-Name"]');
      if (!userElem) return null;

      // Extract handle (starts with @)
      const handleLinks = userElem.querySelectorAll('a[role="link"]');
      let handle = '';
      for (const link of handleLinks) {
        const text = link.innerText || '';
        if (text.startsWith('@')) {
          handle = text.replace(/^@/, '').toLowerCase().trim();
          break;
        }
        const href = link.getAttribute('href') || '';
        const match = href.match(/^\/([A-Za-z0-9_]+)$/);
        if (match && match[1]) {
          handle = match[1].toLowerCase();
          break;
        }
      }

      if (!handle) {
        const existingBadge = tweetEl.querySelector('.bond-badge[data-bond-handle]');
        if (existingBadge) {
          handle = existingBadge.getAttribute('data-bond-handle');
        }
      }

      if (!handle) return null;

      // Display name
      let displayName = handle;
      const firstLine = userElem.querySelector('span');
      if (firstLine && firstLine.innerText) {
        displayName = firstLine.innerText.trim();
      }

      // Avatar
      const avatarUrl = this.getAvatarUrlForHandle(handle, tweetEl);

      return { handle, displayName, avatarUrl };
    } catch (e) {
      return null;
    }
  }

  /**
   * Extracts tweet ID from status link in article.
   */
  extractTweetId(tweetEl) {
    const link = tweetEl.querySelector('a[href*="/status/"]');
    if (link) {
      const match = link.getAttribute('href').match(/\/status\/(\d+)/);
      if (match) return match[1];
    }
    return `tw_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  }

  /**
   * Detects incoming engagement from other accounts on timeline/threads:
   * 1. Replies sent by others to currentUser
   * 2. Mentions of currentUser
   */
  async detectIncomingTweet(tweetEl) {
    if (!this.currentUser) return;
    try {
      const author = this.extractTweetAuthor(tweetEl);
      if (!author || author.handle === this.currentUser) return;

      const tweetId = this.extractTweetId(tweetEl);
      if (this.processedTweetIds.has(tweetId)) return;

      const text = tweetEl.innerText || '';
      const replyPattern = new RegExp(`Replying to\\s+@${this.currentUser}\\b`, 'i');
      const isReplyToMe = replyPattern.test(text);

      const mentionPattern = new RegExp(`@${this.currentUser}\\b`, 'i');
      const isMention = !isReplyToMe && mentionPattern.test(text);

      if (isReplyToMe || isMention) {
        this.processedTweetIds.add(tweetId);
        const isThread = location.pathname.includes('/status/');
        const type = isReplyToMe ? (isThread ? 'reply_thread' : 'reply_received') : 'mention';

        await window.bondStorage.recordInteraction(author.handle, {
          type,
          tweetId,
          displayName: author.displayName,
          avatarUrl: author.avatarUrl,
          textSnippet: text.slice(0, 140),
          isMutual: false,
          isThread,
          direction: 'inbound'
        }, this.currentUser);

        if (window.bondUI) {
          window.bondUI.refreshBadgesForUser(author.handle, true);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  /**
   * Scans notification cells on /notifications to passively capture likes, reposts, and replies from others
   */
  async detectNotificationCell(cellEl) {
    if (!this.currentUser) return;
    try {
      const text = cellEl.innerText || '';
      if (!text) return;

      const userLink = cellEl.querySelector('a[role="link"][href^="/"]');
      if (!userLink) return;

      const href = userLink.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9_]+)$/);
      if (!match || !match[1]) return;

      const handle = match[1].toLowerCase();
      if (handle === this.currentUser) return;

      const cellId = `notif_${handle}_${text.slice(0, 40).replace(/\s+/g, '_')}`;
      if (this.processedTweetIds.has(cellId)) return;
      this.processedTweetIds.add(cellId);

      let type = null;
      if (/liked your (post|reply|tweet)/i.test(text)) {
        type = 'like';
      } else if (/replied|mentioned you/i.test(text)) {
        type = 'reply_received';
      } else if (/reposted your/i.test(text)) {
        type = 'quote';
      }

      if (type) {
        await window.bondStorage.recordInteraction(handle, {
          type,
          tweetId: cellId,
          textSnippet: text.slice(0, 100),
          isMutual: false,
          direction: 'inbound'
        }, this.currentUser);

        if (window.bondUI) {
          window.bondUI.refreshBadgesForUser(handle, true);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  /**
   * Captures outgoing DMs sent in 1:1 or Group Chats
   */
  async _handleDMSubmit(el) {
    try {
      let targetHandle = null;
      let displayName = '';
      let avatarUrl = '';
      let isGroup = false;
      let convId = null;
      let groupTitle = '';

      // 1. Detect conversation ID from URL (supports both /messages/ and /i/chat/)
      const urlMatch = location.pathname.match(/(?:\/messages\/|\/i\/chat\/)([A-Za-z0-9_-]+)/i);
      if (urlMatch && urlMatch[1]) {
        convId = urlMatch[1].toLowerCase();
        isGroup = /^(?:g\d+|\d+)$/i.test(convId) || convId.startsWith('g');
        if (convId.includes('-')) {
          targetHandle = convId.split('-')[1].toLowerCase();
        }
      }

      const conversationContainer = el.closest('[data-testid="DMDrawer"], [data-testid="DMConversation"], main[role="main"], div[data-testid="primaryColumn"]') || document.body;

      // Extract conversation / group title from header
      const headerTitle = document.querySelector('[data-testid="conversation-header"] span, h2 span, main h2, [data-testid="DMConversation"] h2');
      if (headerTitle) {
        groupTitle = headerTitle.innerText.trim();
        displayName = groupTitle;
      }

      // If not a group, look for 1:1 recipient profile link
      if (!isGroup) {
        const dmHeaderLinks = conversationContainer.querySelectorAll('[data-testid="conversation-header"] a[href^="/"], [data-testid="DmRecipientName"] a[href^="/"], a[href^="/"]');
        for (const link of dmHeaderLinks) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/^\/([A-Za-z0-9_]+)$/);
          if (match && match[1] && !['messages', 'home', 'explore', 'notifications', 'i', 'chat'].includes(match[1].toLowerCase())) {
            const h = match[1].toLowerCase();
            if (!this.currentUser || h !== this.currentUser) {
              targetHandle = h;
              displayName = link.innerText.trim() || h;
              break;
            }
          }
        }

        // Check fallback handle in conversation container
        if (!targetHandle) {
          const text = conversationContainer.innerText || '';
          const handleMatch = text.match(/@([A-Za-z0-9_]{1,15})/);
          if (handleMatch && handleMatch[1]) {
            const h = handleMatch[1].toLowerCase();
            if (!this.currentUser || h !== this.currentUser) {
              targetHandle = h;
            }
          }
        }
      }

      const composer = el.closest('[role="textbox"], [contenteditable="true"]') || document.querySelector('[data-testid="dmComposerTextInput"], [role="textbox"]') || el;
      const textSnippet = composer && composer.innerText ? composer.innerText.slice(0, 140) : 'Message sent';

      // Group Chat Outbound Message Handling
      if (isGroup && convId) {
        console.log(`[BondScore CRM] Group Message sent in ${convId} (${groupTitle || convId})!`);
        if (window.bondStorage && window.bondStorage.recordDmMessage) {
          await window.bondStorage.recordDmMessage(convId, {
            direction: 'outbound',
            senderHandle: this.currentUser,
            textSnippet,
            timestamp: Date.now(),
            isGroup: true,
            groupTitle: groupTitle || convId,
            platform: 'x'
          }, this.currentUser).catch(() => {});
        }
        if (window.bondUI && window.bondUI.refreshDmHeaderPill) {
          window.bondUI.refreshDmHeaderPill(convId);
        }
        setTimeout(() => this.scanActiveDmThread(), 400);
        return;
      }

      // 1:1 Direct Message Handling
      if (targetHandle && targetHandle !== this.currentUser) {
        console.log(`[BondScore CRM] Direct Message sent to @${targetHandle}! Incrementing relationship score...`);
        
        // Optimistic boost
        if (window.bondUI) {
          window.bondUI.optimisticBoost(targetHandle, 10);
        }

        await window.bondStorage.recordInteraction(targetHandle, {
          type: 'dm_sent',
          timestamp: Date.now(),
          tweetId: `dm_${Date.now()}`,
          textSnippet,
          displayName,
          avatarUrl,
          isMutual: true
        }, this.currentUser);

        if (!convId) convId = targetHandle;
        if (window.bondStorage && window.bondStorage.recordDmMessage) {
          await window.bondStorage.recordDmMessage(convId, {
            direction: 'outbound',
            senderHandle: this.currentUser,
            recipientHandle: targetHandle,
            textSnippet,
            timestamp: Date.now(),
            displayName,
            avatarUrl,
            isGroup: false,
            platform: 'x'
          }, this.currentUser).catch(() => {});
        }

        if (window.bondUI) {
          window.bondUI.refreshBadgesForUser(targetHandle, true);
          if (window.bondUI.refreshDmHeaderPill) {
            window.bondUI.refreshDmHeaderPill(convId);
          }
        }
        setTimeout(() => this.scanActiveDmThread(), 400);
      }
    } catch (err) {
      console.warn('[BondScore CRM] Error capturing DM:', err);
    }
  }

  /**
   * Captures follow and unfollow button clicks
   */
  async _handleFollowActionClick(btn) {
    try {
      let targetHandle = null;
      let isUnfollow = false;

      const testId = btn.getAttribute('data-testid') || '';
      if (testId.endsWith('-unfollow') || btn.innerText.includes('Following') || btn.innerText.includes('Unfollow')) {
        isUnfollow = true;
      }

      // Check profile page handle
      const profileMatch = location.pathname.match(/^\/([A-Za-z0-9_]+)$/);
      if (profileMatch && profileMatch[1]) {
        const h = profileMatch[1].toLowerCase();
        const nonUserPaths = ['home', 'explore', 'notifications', 'messages', 'settings', 'i', 'compose', 'search'];
        if (!nonUserPaths.includes(h) && (!this.currentUser || h !== this.currentUser)) {
          targetHandle = h;
        }
      }

      // If in tweet or user card cell
      if (!targetHandle) {
        const cell = btn.closest('[data-testid="UserCell"], article[data-testid="tweet"], [data-testid="HoverCard"]');
        if (cell) {
          const author = this.extractTweetAuthor(cell);
          if (author && author.handle) {
            targetHandle = author.handle;
          }
        }
      }

      if (targetHandle && (!this.currentUser || targetHandle !== this.currentUser)) {
        console.log(`[BondScore Signals] Detected follow action on @${targetHandle}: ${isUnfollow ? 'Unfollow' : 'Follow'}`);
        await window.bondStorage.recordInteraction(targetHandle, {
          type: isUnfollow ? 'signal_you_unfollowed' : 'signal_you_followed',
          timestamp: Date.now(),
          textSnippet: isUnfollow ? `You unfollowed @${targetHandle}` : `You followed @${targetHandle}`,
          isMutual: false
        }, this.currentUser);

        const user = await window.bondStorage.getUser(targetHandle, false, this.currentUser);
        if (user) {
          user.signals = user.signals || {};
          user.signals.youFollowThem = !isUnfollow;
          user.signals.isMutual = !!(user.signals.theyFollowYou && user.signals.youFollowThem);
          await window.bondStorage.saveUser(targetHandle, user, this.currentUser);
        }

        if (window.bondUI) {
          window.bondUI.refreshBadgesForUser(targetHandle, true);
          if (window.bondUI.updateProfileFollowBadge) {
            window.bondUI.updateProfileFollowBadge(targetHandle, user ? user.signals : null);
          }
        }
      }
    } catch (err) {
      console.warn('[BondScore Signals] Error capturing follow action:', err);
    }
  }

  /**
   * Observes live relationship signals on profile views (mutuals, follow-back, unfollow, possible blocks)
   */
  async observeProfileSignals(handle) {
    if (!handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    if (this.currentUser && cleanHandle === this.currentUser) return;

    // Throttle checks per profile to prevent redundant DOM parsing & storage writes
    this._profileSignalTimes = this._profileSignalTimes || new Map();
    const lastCheck = this._profileSignalTimes.get(cleanHandle) || 0;
    if (Date.now() - lastCheck < 30000) {
      return;
    }
    this._profileSignalTimes.set(cleanHandle, Date.now());

    try {
      // 1. Check for Block
      const emptyState = document.querySelector('[data-testid="empty_state"], [data-testid="emptyState"]');
      const bodyText = (emptyState ? emptyState.innerText : '') || document.body.innerText || '';
      const isBlocked = bodyText.includes("You're blocked") || bodyText.includes("You are blocked");

      // 2. Check "Follows you" badge (they follow you)
      const followIndicator = document.querySelector('[data-testid="userFollowIndicator"]');
      const theyFollowYou = !!followIndicator && (
        followIndicator.innerText.includes('Follows you') ||
        followIndicator.textContent.includes('Follows you') ||
        followIndicator.getAttribute('data-testid') === 'userFollowIndicator'
      );

      // 3. Check if you follow them (unfollow button indicates you are currently following them)
      const unfollowBtn = document.querySelector('[data-testid$="-unfollow"]') ||
                          document.querySelector('button[aria-label*="Following @"]') ||
                          document.querySelector('button[aria-label*="Unfollow @"]');
      const followBtn = document.querySelector('[data-testid$="-follow"]') ||
                        document.querySelector('button[aria-label*="Follow @"]');
      let youFollowThem = null;
      if (unfollowBtn) youFollowThem = true;
      else if (followBtn) youFollowThem = false;

      // Extract avatar and name if present
      const nameEl = document.querySelector('[data-testid="UserName"]');
      const displayName = nameEl ? (nameEl.querySelector('span') ? nameEl.querySelector('span').innerText : cleanHandle) : cleanHandle;
      const avatarUrl = this.getAvatarUrlForHandle(cleanHandle);

      const updatedUser = await window.bondStorage.recordRelationshipSignal(cleanHandle, {
        theyFollowYou,
        youFollowThem,
        isBlocked,
        displayName,
        avatarUrl
      });

      // Update follow relationship badge immediately on profile
      if (window.bondUI && window.bondUI.updateProfileFollowBadge) {
        await window.bondUI.updateProfileFollowBadge(cleanHandle, updatedUser ? updatedUser.signals : { theyFollowYou, youFollowThem, isBlocked });
      }
    } catch (err) {
      console.warn('[BondScore Signals] Error observing profile signals:', err);
    }
  }

  /**
   * Scans visible DM conversations in the messages list or DM drawer.
   * Extracts participant handles, group titles, unread state, and triggers UI badge injection.
   * Fully compatible with standard /messages and new X /i/chat/ layouts.
   */
  async scanDmInbox() {
    try {
      const settings = window.bondStorage && window.bondStorage.settingsCache;
      if (settings && settings.trackDirectMessages === false) return;

      const convCandidates = document.querySelectorAll(
        '[data-testid="conversation"], ' +
        '[data-testid="cellInnerDiv"] a[href*="/i/chat/"], ' +
        '[data-testid="cellInnerDiv"] a[href*="/messages/"], ' +
        'a[href^="/i/chat/"], ' +
        'a[href^="/messages/"]'
      );
      if (!convCandidates || convCandidates.length === 0) return;

      const seenConvs = new Set();

      for (const rawEl of convCandidates) {
        try {
          const link = rawEl.tagName === 'A' ? rawEl : (rawEl.querySelector('a[href*="/messages/"], a[href*="/i/chat/"]') || rawEl.closest('a[href*="/messages/"], a[href*="/i/chat/"]'));
          const href = link ? link.getAttribute('href') : '';
          const match = href.match(/(?:\/messages\/|\/i\/chat\/)([A-Za-z0-9_-]+)/i);
          const convId = match ? match[1].toLowerCase() : null;
          if (!convId || seenConvs.has(convId)) continue;
          seenConvs.add(convId);

          const el = rawEl.closest('[data-testid="conversation"], [data-testid="cellInnerDiv"]') || rawEl;

          // Check if group (starts with 'g' followed by numbers or numeric ID)
          const isGroup = /^(?:g\d+|\d+)$/i.test(convId) || convId.startsWith('g');

          const text = el.innerText || '';
          let participantHandle = null;
          if (!isGroup) {
            const handleMatch = text.match(/@([A-Za-z0-9_]{1,15})/);
            if (handleMatch) {
              participantHandle = handleMatch[1].toLowerCase();
            } else if (convId.includes('-')) {
              participantHandle = convId.split('-')[1].toLowerCase();
            }
          }

          const img = el.querySelector('img[src*="profile_images"], img');
          const avatarUrl = img ? (img.currentSrc || img.src || '') : '';
          
          // Extract group name or user display name
          const titleCandidates = el.querySelectorAll('div[dir="ltr"] span, span[dir="auto"], span');
          let displayName = '';
          for (const c of titleCandidates) {
            const t = (c.innerText || '').trim();
            if (t && !t.startsWith('@') && !['Now', '1h', '2h', '3h', '13m', '40m', 'Screenshots protected', 'Sent a post', 'Sent a GIF', 'Pinned'].includes(t)) {
              displayName = t;
              break;
            }
          }
          if (!displayName) {
            displayName = participantHandle ? `@${participantHandle}` : convId;
          }

          const hasUnread = !!el.querySelector('[data-testid="unread-badge"], [aria-label*="unread" i], [style*="background-color: rgb(29, 155, 240)"]');

          // Auto-register conversation in storage if not already present
          if (window.bondStorage) {
            const existing = await window.bondStorage.getDmConversation(convId, false, this.currentUser);
            if (!existing) {
              await window.bondStorage.saveDmConversation(convId, {
                convId,
                isGroup,
                platform: 'x',
                title: displayName,
                participants: participantHandle ? [participantHandle] : [],
                participantDetails: participantHandle ? {
                  [participantHandle]: { displayName, avatarUrl }
                } : {},
                sentCount: 1,
                receivedCount: 1,
                totalCount: 2,
                lifetimeSent: 1,
                lifetimeReceived: 1,
                lifetimeTotal: 2,
                firstSeenTimestamp: Date.now(),
                lastMessageTimestamp: Date.now(),
                waitingForUserReply: hasUnread
              }, this.currentUser);
            } else {
              let changed = false;
              if (existing.isGroup !== isGroup) {
                existing.isGroup = isGroup;
                changed = true;
              }
              if (displayName && (!existing.title || existing.title === convId)) {
                existing.title = displayName;
                changed = true;
              }
              if (participantHandle) {
                if (!existing.participantDetails) existing.participantDetails = {};
                const prev = existing.participantDetails[participantHandle];
                if (!prev || (!prev.avatarUrl && avatarUrl)) {
                  existing.participantDetails[participantHandle] = { displayName, avatarUrl };
                  changed = true;
                }
              }
              if (hasUnread !== existing.waitingForUserReply) {
                existing.waitingForUserReply = hasUnread;
                changed = true;
              }
              if (changed) {
                await window.bondStorage.saveDmConversation(convId, existing, this.currentUser);
              }
            }
          }

          if (window.bondUI && window.bondUI.injectDmRowBadge) {
            await window.bondUI.injectDmRowBadge(el, convId, participantHandle, isGroup, { displayName, avatarUrl, hasUnread, platform: 'x' });
          }
        } catch (err) {}
      }
    } catch (e) {}
  }

  /**
   * Scans the active open DM thread to track inbound/outbound messages and waiting state.
   * Compatible with /messages and /i/chat/ layouts.
   */
  async scanActiveDmThread() {
    try {
      const settings = window.bondStorage && window.bondStorage.settingsCache;
      if (settings && settings.trackDirectMessages === false) return;

      const container = document.querySelector(
        '[data-testid="DMConversation"], ' +
        '[data-testid="DMDrawer"], ' +
        'main[role="main"], ' +
        'div[data-testid="primaryColumn"], ' +
        'div[aria-label*="Timeline: Messages" i], ' +
        'section[role="region"]'
      ) || document.body;

      let convId = null;
      let targetHandle = null;
      const urlMatch = location.pathname.match(/(?:\/messages\/|\/i\/chat\/)([A-Za-z0-9_-]+)/i);
      if (urlMatch && urlMatch[1]) {
        convId = urlMatch[1].toLowerCase();
        if (convId.includes('-')) {
          targetHandle = convId.split('-')[1].toLowerCase();
        }
      }

      const isGroup = convId ? (/^(?:g\d+|\d+)$/i.test(convId) || convId.startsWith('g')) : false;

      // Extract conversation header
      const header = container.querySelector('[data-testid="conversation-header"], header, h2') || container;
      let groupTitle = '';
      if (isGroup) {
        const titleEl = document.querySelector('[data-testid="conversation-header"] span, h2 span, main h2, [data-testid="DMConversation"] h2');
        if (titleEl) groupTitle = titleEl.innerText.trim();
      } else if (!targetHandle) {
        const headerLinks = header.querySelectorAll('a[href^="/"]');
        for (const l of headerLinks) {
          const m = (l.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]+)$/);
          if (m && m[1] && !['messages', 'home', 'explore', 'notifications', 'i', 'chat'].includes(m[1].toLowerCase())) {
            const h = m[1].toLowerCase();
            if (!this.currentUser || h !== this.currentUser) {
              targetHandle = h;
              break;
            }
          }
        }
      }

      if (!convId && targetHandle) {
        convId = targetHandle;
      }
      if (!convId) return;

      // Locate visible message entries in thread
      const messageEntries = document.querySelectorAll(
        '[data-testid="messageEntry"], ' +
        'div[data-testid="cellInnerDiv"] div[dir="ltr"]'
      );

      if (messageEntries.length > 0) {
        const parsedEntries = [];
        for (let idx = 0; idx < messageEntries.length; idx++) {
          const entry = messageEntries[idx];
          const hasAvatar = !!entry.querySelector('img[src*="profile_images"], img');
          const isOutbound = !hasAvatar && (
            !!entry.querySelector('[class*="r-18u37iz"], [style*="background-color: rgb(29, 155, 240)"]') ||
            !!entry.querySelector('div[style*="align-items: flex-end"]') ||
            entry.closest('div[style*="align-items: flex-end"]') !== null ||
            (entry.innerText && entry.innerText.includes('Seen'))
          );

          let senderHandle = '';
          if (!isOutbound) {
            const authorLink = entry.querySelector('a[href^="/"]');
            if (authorLink) {
              const m = (authorLink.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]+)$/);
              if (m && m[1] && !['messages', 'i', 'chat'].includes(m[1].toLowerCase())) {
                senderHandle = m[1].toLowerCase();
              }
            }
            if (!senderHandle) {
              const senderSpan = entry.querySelector('div[dir="ltr"] span, span[dir="auto"]');
              if (senderSpan) {
                const txt = senderSpan.innerText.trim();
                if (txt && !txt.includes('http') && txt.length < 30) senderHandle = txt;
              }
            }
          }

          const textEl = entry.querySelector('[data-testid="tweetText"], span, dir[dir="auto"]') || entry;
          const text = (textEl.innerText || '').trim();

          const timeEl = entry.querySelector('time');
          const timeStr = timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText || '') : '';
          let timestamp = timeStr ? Date.parse(timeStr) : 0;
          if (isNaN(timestamp) || timestamp <= 0) {
            timestamp = Date.now() - ((messageEntries.length - idx) * 30000);
          }

          const snippetHash = text.slice(0, 32).replace(/\s+/g, '_');
          const fp = `${convId}_${isOutbound ? 'out' : 'in'}_${snippetHash}_${timeStr || idx}`;

          parsedEntries.push({
            fingerprint: fp,
            direction: isOutbound ? 'outbound' : 'inbound',
            senderHandle: isOutbound ? this.currentUser : (senderHandle || targetHandle || 'group_member'),
            text: text.slice(0, 100),
            timestamp,
            index: idx
          });
        }

        if (window.bondStorage && window.bondStorage.ingestMessageEntries) {
          await window.bondStorage.ingestMessageEntries(convId, parsedEntries, this.currentUser, 'x', {
            isGroup,
            groupTitle: groupTitle || convId
          });
        }
      }

      if (window.bondUI && window.bondUI.injectDmHeaderPill) {
        await window.bondUI.injectDmHeaderPill(header, convId, targetHandle, isGroup);
      }
    } catch (e) {
      // ignore
    }
  }
}

window.interactionDetector = new InteractionDetector();
