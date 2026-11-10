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
   * Only triggers an account switch when the DOM identity in this tab actually changes,
   * completely preventing false triggers or overrides of user selections.
   */
  async checkAccountSwitch() {
    const discovered = this.extractActiveAccountFromDOM();
    if (!discovered || !discovered.handle) return this.currentUser;

    const newHandle = discovered.handle.toLowerCase().trim();

    // If this tab already detected this handle in its DOM and matches currentUser, no action needed
    if (this.lastDetectedDomHandle === newHandle && this.currentUser === newHandle) {
      return this.currentUser;
    }

    // Only trigger switch if DOM identity in this tab genuinely transitioned, or initial detection
    if (this.lastDetectedDomHandle !== newHandle || !this.currentUser) {
      const previousUser = this.currentUser;
      this.lastDetectedDomHandle = newHandle;
      this.currentUser = newHandle;
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
      await window.bondStorage.switchAccount(handle, {
        displayName: fromDOM.displayName,
        avatarUrl: fromDOM.avatarUrl
      });
      if (previous && previous !== handle && window.bondUI) {
        await window.bondUI.handleAccountSwitched(handle, previous);
      }
      return handle;
    }

    // Check stored user if DOM elements haven't rendered yet
    if (!this.currentUser) {
      const stored = await window.bondStorage.getCurrentUser();
      if (stored) {
        this.currentUser = stored;
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
    });

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
    await window.bondStorage.removeInteraction(author.handle, tweetId, 'like');

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
    });

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
      });

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
      let avatarUrl = '';
      const avatarImg = tweetEl.querySelector('img[src*="profile_images"]');
      if (avatarImg) {
        avatarUrl = avatarImg.getAttribute('src');
      }

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
          isMutual: isReplyToMe,
          isThread,
          direction: 'inbound'
        });

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
          isMutual: type === 'reply_received',
          direction: 'inbound'
        });

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
      const dmHeaderLinks = conversationContainer.querySelectorAll('[data-testid="conversation-header"] a[href^="/"], [data-testid="DmRecipientName"] a[href^="/"], a[href^="/"]');
      
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

      // 3. Fallback: Check any handle text inside the active DM drawer/window
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

      if (targetHandle && targetHandle !== this.currentUser) {
        console.log(`[BondScore CRM] Direct Message sent to @${targetHandle}! Incrementing relationship score...`);
        
        // Optimistic boost
        if (window.bondUI) {
          window.bondUI.optimisticBoost(targetHandle, 10);
        }

        const composer = el.closest('[role="textbox"]') || conversationContainer.querySelector('[data-testid="dmComposerTextInput"]') || el;
        const textSnippet = composer && composer.innerText ? composer.innerText.slice(0, 140) : 'Direct Message sent';

        await window.bondStorage.recordInteraction(targetHandle, {
          type: 'dm_sent',
          timestamp: Date.now(),
          tweetId: `dm_${Date.now()}`,
          textSnippet,
          displayName,
          avatarUrl,
          isMutual: true
        });

        if (window.bondUI) {
          window.bondUI.refreshBadgesForUser(targetHandle, true);
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
        });

        const user = await window.bondStorage.getUser(targetHandle);
        if (user) {
          user.signals = user.signals || {};
          user.signals.youFollowThem = !isUnfollow;
          user.signals.isMutual = !!(user.signals.theyFollowYou && user.signals.youFollowThem);
          await window.bondStorage.saveUser(targetHandle, user);
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
      const avatarEl = document.querySelector('img[src*="profile_images"]');
      const avatarUrl = avatarEl ? avatarEl.src : '';

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
}

window.interactionDetector = new InteractionDetector();
