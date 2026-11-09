/**
 * BondScore for X - Interaction & Identity Detector
 * Identifies the logged-in user and captures real-time interactions (replies, likes, quotes).
 */

class InteractionDetector {
  constructor() {
    this.currentUser = null;
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
   * Identifies current user's Twitter handle from navigation or profile elements.
   */
  async detectCurrentUser() {
    if (this.currentUser) return this.currentUser;

    // Check stored user first
    const stored = await window.bondStorage.getCurrentUser();
    if (stored) {
      this.currentUser = stored;
      return stored;
    }

    // 1. Look for bottom/sidebar profile link
    const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (profileLink) {
      const href = profileLink.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9_]+)$/);
      if (match && match[1] && match[1].toLowerCase() !== 'explore') {
        const handle = match[1].toLowerCase();
        this.currentUser = handle;
        await window.bondStorage.setCurrentUser(handle);
        return handle;
      }
    }

    // 2. Look for account switcher button
    const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (accountSwitcher) {
      const text = accountSwitcher.innerText || '';
      const match = text.match(/@([A-Za-z0-9_]+)/);
      if (match && match[1]) {
        const handle = match[1].toLowerCase();
        this.currentUser = handle;
        await window.bondStorage.setCurrentUser(handle);
        return handle;
      }
    }

    // 3. Look for avatar with profile link
    const avatarLinks = document.querySelectorAll('header a[role="link"][href^="/"]');
    for (const a of avatarLinks) {
      const href = a.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9_]+)$/);
      if (match && match[1] && !['home', 'explore', 'notifications', 'messages', 'settings', 'i'].includes(match[1].toLowerCase())) {
        const handle = match[1].toLowerCase();
        this.currentUser = handle;
        await window.bondStorage.setCurrentUser(handle);
        return handle;
      }
    }

    return null;
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

    // Keyboard shortcut (Ctrl+Enter / Cmd+Enter) to submit comments
    document.addEventListener('keydown', (e) => {
      try {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          const composer = e.target.closest('[data-testid*="tweetTextarea"], [role="textbox"], [contenteditable="true"]');
          if (composer) {
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
      // Check if there is already a dialogue/reciprocal history with this user
      const existingUser = await window.bondStorage.getUser(targetHandle);
      const isMutual = !!(existingUser && (existingUser.stats.repliesReceived > 0 || existingUser.stats.mutualExchanges > 0));

      const pointBoost = isMutual ? 15 : 8;
      if (window.bondUI) {
        window.bondUI.optimisticBoost(targetHandle, pointBoost);
      }

      await window.bondStorage.recordInteraction(targetHandle, {
        type: 'reply_sent',
        timestamp: Date.now(),
        tweetId: `reply_${Date.now()}`,
        isMutual
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
        const type = isReplyToMe ? 'reply_received' : 'mention';

        await window.bondStorage.recordInteraction(author.handle, {
          type,
          tweetId,
          displayName: author.displayName,
          avatarUrl: author.avatarUrl,
          textSnippet: text.slice(0, 140),
          isMutual: isReplyToMe
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
          isMutual: type === 'reply_received'
        });

        if (window.bondUI) {
          window.bondUI.refreshBadgesForUser(handle, true);
        }
      }
    } catch (e) {
      // ignore
    }
  }
}

window.interactionDetector = new InteractionDetector();
