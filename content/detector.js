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
        const isDM = !!composer.closest('[data-testid="DMDrawer"], [data-testid="DMConversation"], [data-testid="dmComposerTextInput"], [aria-label*="Direct message" i]');
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

    // 0. Check for DM Send Button
    const dmSendBtn = target.closest('[data-testid="dmComposerSendButton"]');
    if (dmSendBtn) {
      this._handleDMSubmit(dmSendBtn);
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

      // Notification cells contain several links (post, media, profile). Only
      // single-segment /handle links identify the people who engaged with us.
      const handles = [];
      for (const link of cellEl.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
        if (!match || !match[1]) continue;
        const handle = match[1].toLowerCase();
        if (handle === this.currentUser) continue;
        if (!handles.includes(handle)) handles.push(handle);
      }
      if (!handles.length) return;

      let type = null;
      if (/liked your (post|reply|tweet)/i.test(text)) {
        type = 'like';
      } else if (/repl(y|ied|ying)|mentioned you/i.test(text)) {
        type = 'reply_received';
      } else if (/reposted your/i.test(text)) {
        type = 'quote';
      }
      if (!type) return;
      // Stable dedupe: the same notification keeps the same key even when the
      // "and N others" count changes.
      for (const handle of handles.slice(0, 4)) {
        const cellId = `notif_${this.id || 'x'}_${type}_${handle}`;
        if (this.processedTweetIds.has(cellId)) continue;
        this.processedTweetIds.add(cellId);

        await window.bondStorage.recordInteraction(handle, {
          type,
          tweetId: cellId,
          // Never store notification/reply text - metadata only.
          textSnippet: null,
          isMutual: true,
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
   * Captures outgoing DMs sent to another account in direct messages
   */
  async _handleDMSubmit(el) {
    try {
      let targetHandle = null;
      let displayName = '';
      let avatarUrl = '';

      // 1. Look for DM header profile link or conversation header
      const conversationContainer = el.closest('[data-testid="DMDrawer"], [data-testid="DMConversation"], [role="main"]') || document.body;
      const dmHeaderLinks = conversationContainer.querySelectorAll('[data-testid="conversation-header"] a[href^="/"], [data-testid="DmRecipientName"] a[href^="/"], header a[href^="/"]');
      
      for (const link of dmHeaderLinks) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/^\/([A-Za-z0-9_]+)$/);
        if (match && match[1] && !['messages', 'home', 'explore', 'notifications', 'i'].includes(match[1].toLowerCase())) {
          const h = match[1].toLowerCase();
          if (!this.currentUser || h !== this.currentUser) {
            targetHandle = h;
            displayName = link.innerText.trim() || h;
            break;
          }
        }
      }

      // 2. Check current URL if it has /messages/<id>-<handle>
      if (!targetHandle && location.pathname.startsWith('/messages/')) {
        const urlMatch = location.pathname.match(/\/messages\/\d+-([A-Za-z0-9_]+)/i);
        if (urlMatch && urlMatch[1]) {
          targetHandle = urlMatch[1].toLowerCase();
        }
      }

      // 3. Fallback: read the participant from the DM header only. Never read the
      // conversation body; message contents are out of scope by design.
      if (!targetHandle) {
        const headerEl = conversationContainer.querySelector('[data-testid="conversation-header"], [data-testid="DmRecipientName"], header');
        const headerText = headerEl ? (headerEl.innerText || '') : '';
        const handleMatch = headerText.match(/@([A-Za-z0-9_]{1,15})/);
        if (handleMatch && handleMatch[1]) {
          const h = handleMatch[1].toLowerCase();
          if (!this.currentUser || h !== this.currentUser) {
            targetHandle = h;
          }
        }
      }

      if (targetHandle && targetHandle !== this.currentUser) {
        console.log(`[BondScore CRM] Direct Message sent to @${targetHandle}! Incrementing relationship score...`);
        
        // Optimistic boost
        if (window.bondUI) {
          window.bondUI.optimisticBoost(targetHandle, 10);
        }

        // Strict privacy: message contents are never read, parsed, or stored.
        // Only direction, participant, and timestamp metadata is recorded.
        await window.bondStorage.recordInteraction(targetHandle, {
          type: 'dm_sent',
          timestamp: Date.now(),
          tweetId: `dm_${Date.now()}`,
          textSnippet: null,
          displayName,
          avatarUrl,
          isMutual: true
        }, this.currentUser);

        // Record in DM conversation store
        let convId = targetHandle;
        const urlMatch = location.pathname.match(/\/messages\/([A-Za-z0-9_-]+)/i);
        if (urlMatch && urlMatch[1]) {
          convId = urlMatch[1].toLowerCase();
        }
        if (window.bondStorage && window.bondStorage.recordDmMessage) {
          await window.bondStorage.recordDmMessage(convId, {
            direction: 'outbound',
            senderHandle: this.currentUser,
            recipientHandle: targetHandle,
            timestamp: Date.now(),
            displayName,
            avatarUrl,
            isGroup: false
          }, this.currentUser).catch(() => {});
        }

        if (window.bondUI) {
          window.bondUI.refreshBadgesForUser(targetHandle, true);
          if (window.bondUI.refreshDmHeaderPill) {
            window.bondUI.refreshDmHeaderPill(convId);
          }
        }
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
   * Extracts participant handles, unread state, and triggers UI badge injection.
   */
  async scanDmInbox() {
    try {
      const settings = window.bondStorage && window.bondStorage.settingsCache;
      if (settings && settings.trackDirectMessages === false) return;

      const convElements = document.querySelectorAll('[data-testid="conversation"]');
      if (!convElements || convElements.length === 0) return;

      for (const el of convElements) {
        try {
          const link = el.querySelector('a[href^="/messages/"]') || el.closest('a[href^="/messages/"]');
          const href = link ? link.getAttribute('href') : '';
          const match = href.match(/\/messages\/([A-Za-z0-9_-]+)/);
          const convId = match ? match[1].toLowerCase() : null;
          if (!convId) continue;

          // Check if group (numeric ID or multiple members)
          const isGroup = /^\d+$/.test(convId);

          // Privacy: the inbox row preview can contain message text, so it is
          // never read. The conversation id already encodes the participant.
          let participantHandle = null;
          if (!isGroup && convId.includes('-')) {
            participantHandle = convId.split('-')[1].toLowerCase();
          }

          const img = el.querySelector('img[src*="profile_images"], img');
          const avatarUrl = img ? (img.currentSrc || img.src || '') : '';
          const nameEl = el.querySelector('div[dir="ltr"] span, span');
          const displayName = nameEl ? nameEl.innerText.trim() : (participantHandle || convId);

          const hasUnread = !!el.querySelector('[data-testid="unread-badge"], [aria-label*="unread" i]');

          // Auto-register conversation in storage if not already present so it never shows 0 on refresh
          if (window.bondStorage) {
            const existing = await window.bondStorage.getDmConversation(convId, false, this.currentUser);
            if (!existing) {
              await window.bondStorage.saveDmConversation(convId, {
                convId,
                isGroup,
                title: displayName || (participantHandle ? `@${participantHandle}` : convId),
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
            } else if (displayName || avatarUrl || hasUnread !== existing.waitingForUserReply) {
              let changed = false;
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
            await window.bondUI.injectDmRowBadge(el, convId, participantHandle, isGroup, { displayName, avatarUrl, hasUnread });
          }
        } catch (err) {
          // continue
        }
      }
    } catch (e) {
      // ignore
    }
  }

  /**
   * Scans the active open DM thread to track inbound/outbound messages and waiting state.
   */
  async scanActiveDmThread() {
    try {
      const settings = window.bondStorage && window.bondStorage.settingsCache;
      if (settings && settings.trackDirectMessages === false) return;

      const container = document.querySelector('[data-testid="DMConversation"], [data-testid="DMDrawer"]');
      if (!container) return;

      const header = container.querySelector('[data-testid="conversation-header"]');
      if (!header) return;

      let convId = null;
      let targetHandle = null;
      const urlMatch = location.pathname.match(/\/messages\/([A-Za-z0-9_-]+)/i);
      if (urlMatch && urlMatch[1]) {
        convId = urlMatch[1].toLowerCase();
        if (convId.includes('-')) {
          targetHandle = convId.split('-')[1].toLowerCase();
        }
      }

      const isGroup = convId ? /^\d+$/.test(convId) : false;

      if (!targetHandle && !isGroup) {
        const headerLinks = header.querySelectorAll('a[href^="/"]');
        for (const l of headerLinks) {
          const m = (l.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]+)$/);
          if (m && m[1] && !['messages', 'home', 'explore', 'notifications', 'i'].includes(m[1].toLowerCase())) {
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

      // Ingest all message entries visible in active thread into conversation memory ledger
      const messageEntries = container.querySelectorAll('[data-testid="messageEntry"]');
      if (messageEntries.length > 0) {
        const parsedEntries = [];
        for (let idx = 0; idx < messageEntries.length; idx++) {
          const entry = messageEntries[idx];
          const hasAvatar = !!entry.querySelector('img[src*="profile_images"]');
          const isOutbound = !hasAvatar && (
            !!entry.querySelector('[class*="r-18u37iz"], [style*="background-color: rgb(29, 155, 240)"]') ||
            !!entry.querySelector('div[style*="align-items: flex-end"]') ||
            entry.closest('div[style*="align-items: flex-end"]') !== null
          );

          // Privacy: message text is never read. Only timestamp and direction
          // are needed for conversation analytics.
          const timeEl = entry.querySelector('time');
          const timeStr = timeEl ? (timeEl.getAttribute('datetime') || '') : '';
          let timestamp = timeStr ? Date.parse(timeStr) : 0;
          if (isNaN(timestamp) || timestamp <= 0) {
            timestamp = Date.now() - ((messageEntries.length - idx) * 30000);
          }

          // Metadata-only fingerprint (no message body, not even a hash of it).
          const fp = `${convId}_${isOutbound ? 'out' : 'in'}_${timestamp}_${idx}`;

          parsedEntries.push({
            fingerprint: fp,
            direction: isOutbound ? 'outbound' : 'inbound',
            timestamp,
            index: idx
          });
        }

        if (window.bondStorage && window.bondStorage.ingestMessageEntries) {
          await window.bondStorage.ingestMessageEntries(convId, parsedEntries, this.currentUser);
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
