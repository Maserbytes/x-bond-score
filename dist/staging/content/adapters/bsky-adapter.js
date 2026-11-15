/**
 * BondScore - Bluesky Platform Adapter
 * Handles Bluesky (bsky.app) feed observation, user identification, profile badges, and direct messaging metadata.
 * 100% private, local-first.
 */

class BskyPlatformAdapter {
  constructor() {
    this.platform = 'bsky';
    this.name = 'Bluesky';
    this.icon = '🦋';
    this.currentUser = null;
    this.processedPostIds = new Set();
    this.listenersAttached = false;
  }

  isCurrentDomain() {
    return location.hostname.includes('bsky.app');
  }

  async init() {
    this.currentUser = this.extractActiveAccountFromDOM();
    this.attachEventListeners();
    console.log('[BondScore] Bluesky adapter initialized. Current user:', this.currentUser ? `@${this.currentUser}` : 'detecting...');
  }

  setCurrentUser(user) {
    this.currentUser = user ? user.replace(/^@/, '').toLowerCase().trim() : null;
  }

  extractActiveAccountFromDOM() {
    // 1. Sidebar / bottom navigation profile button
    const navProfileBtn = document.querySelector('a[data-testid="navProfileBtn"], a[href*="/profile/"][aria-label*="Profile" i]');
    if (navProfileBtn) {
      const href = navProfileBtn.getAttribute('href') || '';
      const m = href.match(/\/profile\/([A-Za-z0-9._-]+)/);
      if (m && m[1]) {
        const handle = m[1].toLowerCase().trim();
        const img = navProfileBtn.querySelector('img');
        const avatarUrl = img ? (img.currentSrc || img.src || '') : '';
        return { handle, displayName: handle, avatarUrl };
      }
    }

    // 2. Fallback: check profile links in navigation container
    const navAnchors = Array.from(document.querySelectorAll('nav a[href*="/profile/"]'));
    for (const a of navAnchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/profile\/([A-Za-z0-9._-]+)/);
      if (m && m[1]) {
        return { handle: m[1].toLowerCase().trim(), displayName: m[1], avatarUrl: '' };
      }
    }

    return null;
  }

  extractPostAuthor(postElement) {
    if (!postElement) return null;
    // Find author link inside the post header: a[href*="/profile/"]
    const authorLink = postElement.querySelector('a[href*="/profile/"]');
    if (!authorLink) return null;

    const href = authorLink.getAttribute('href') || '';
    const m = href.match(/\/profile\/([A-Za-z0-9._-]+)/);
    if (!m || !m[1]) return null;

    const handle = m[1].toLowerCase().trim();
    const displayName = (authorLink.innerText || authorLink.textContent || handle).trim().split('\n')[0];
    const avatarImg = postElement.querySelector('img[src*="avatar"], img[src*="cdn.bsky"]');
    const avatarUrl = avatarImg ? (avatarImg.currentSrc || avatarImg.src || '') : '';

    return { handle, displayName, avatarUrl, element: authorLink };
  }

  async scanTimeline(currentUser) {
    if (!window.bondStorage || !window.bondStorage.isTimelineEnabled('bsky')) return;

    // Bluesky post items: div[data-testid^="feedItem-"], div[data-testid="postContent"], or article
    const postCandidates = Array.from(document.querySelectorAll('div[data-testid^="feedItem-"], div[data-testid="postThreadItem"], div[data-testid="postContent"]'));

    for (const post of postCandidates) {
      try {
        const author = this.extractPostAuthor(post);
        if (!author || !author.handle) continue;
        if (currentUser && author.handle === currentUser) continue;

        const headerRow = author.element.parentElement;
        if (!headerRow) continue;

        const existing = headerRow.querySelectorAll('.bond-badge');
        if (existing.length > 0) {
          for (let i = 1; i < existing.length; i++) existing[i].remove();
          continue;
        }

        if (headerRow.getAttribute('data-bond-injected')) continue;
        headerRow.setAttribute('data-bond-injected', 'true');

        if (window.bondUI) {
          await window.bondUI.injectBadge(headerRow, author.handle, false, 'bsky');
        }
      } catch (err) {}
    }
  }

  async scanProfile(currentUser) {
    if (!window.bondStorage || !window.bondStorage.isTimelineEnabled('bsky')) return;

    // Bluesky profile URL: bsky.app/profile/handle
    const profileMatch = location.pathname.match(/\/profile\/([A-Za-z0-9._-]+)/);
    if (!profileMatch || !profileMatch[1]) return;

    const profileHandle = profileMatch[1].toLowerCase().trim();
    if (currentUser && profileHandle === currentUser) return;

    // Header container with handle and display name
    const profileHeader = document.querySelector('div[data-testid="profileHeader"], div[data-testid="profileHeaderDisplayName"]');
    if (profileHeader) {
      const existing = profileHeader.querySelectorAll('.bond-badge');
      if (existing.length > 0) {
        for (let i = 1; i < existing.length; i++) existing[i].remove();
      } else if (!profileHeader.getAttribute('data-bond-injected')) {
        profileHeader.setAttribute('data-bond-injected', 'true');
        if (window.bondUI) {
          await window.bondUI.injectBadge(profileHeader, profileHandle, true, 'bsky');
        }
      }
    }

    // Check relationship signals: "Follows you" badge
    const followsYouBadge = document.querySelector('div[data-testid="profileFollowsYouBadge"]') ||
      Array.from(document.querySelectorAll('div, span')).find(el => el.textContent === 'Follows you' && el.children.length === 0);

    if (followsYouBadge && window.bondStorage) {
      await window.bondStorage.recordRelationshipSignals(profileHandle, {
        theyFollowYou: true,
        isBlocked: false,
        platform: 'bsky'
      }).catch(() => {});
    }
  }

  async scanDms() {
    if (!window.bondStorage || !window.bondStorage.isDmsEnabled('bsky')) return;
    if (!location.pathname.startsWith('/messages')) return;

    // 1. Scan Bluesky messages conversation inbox list
    const convoRows = Array.from(document.querySelectorAll('a[href*="/messages/"]'));
    for (const row of convoRows) {
      try {
        const href = row.getAttribute('href') || '';
        const m = href.match(/\/messages\/([A-Za-z0-9._-]+)/);
        if (!m || !m[1]) continue;
        const convId = m[1].toLowerCase().trim();

        const handleMatch = (row.innerText || '').match(/@([a-zA-Z0-9._-]+)/);
        const handle = handleMatch ? handleMatch[1].toLowerCase().trim() : convId;

        if (!row.getAttribute('data-bond-dm-injected')) {
          row.setAttribute('data-bond-dm-injected', 'true');
          if (window.bondUI) {
            await window.bondUI.injectDmRowBadge(row, handle, false, 'bsky');
          }
        }
      } catch (e) {}
    }

    // 2. Scan active conversation thread message bubbles
    const messageRows = Array.from(document.querySelectorAll('[data-testid^="message-"]'));
    if (messageRows.length > 0) {
      const activeMatch = location.pathname.match(/\/messages\/([A-Za-z0-9._-]+)/);
      if (activeMatch && activeMatch[1]) {
        const convId = activeMatch[1].toLowerCase().trim();
        const entries = [];

        for (const row of messageRows) {
          try {
            const isUser = row.getAttribute('data-testid')?.includes('user') ||
              row.className.includes('align-end') ||
              row.parentElement?.className.includes('justify-end');
            const direction = isUser ? 'sent' : 'received';
            const id = row.getAttribute('data-testid') || `bskymsg_${Date.now()}`;
            entries.push({
              id,
              direction,
              timestamp: Date.now(),
              platform: 'bsky'
            });
          } catch (e) {}
        }

        if (entries.length > 0 && window.bondStorage) {
          await window.bondStorage.ingestMessageEntries(convId, entries, null, 'bsky').catch(() => {});
        }
      }
    }
  }

  attachEventListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    document.addEventListener('click', async (e) => {
      if (!window.bondStorage || !window.bondStorage.isTimelineEnabled('bsky')) return;
      const target = e.target;
      if (!target) return;

      // Like button: button[data-testid="likeBtn"]
      const likeBtn = target.closest('button[data-testid="likeBtn"]');
      if (likeBtn) {
        const post = likeBtn.closest('div[data-testid^="feedItem-"], div[data-testid="postThreadItem"], div[data-testid="postContent"]');
        const author = this.extractPostAuthor(post);
        if (author && author.handle) {
          await window.bondStorage.recordInteraction(author.handle, {
            type: 'like',
            platform: 'bsky',
            displayName: author.displayName,
            avatarUrl: author.avatarUrl,
            timestamp: Date.now()
          }).catch(() => {});
        }
      }

      // Repost button: button[data-testid="repostBtn"]
      const repostBtn = target.closest('button[data-testid="repostBtn"]');
      if (repostBtn) {
        const post = repostBtn.closest('div[data-testid^="feedItem-"], div[data-testid="postThreadItem"], div[data-testid="postContent"]');
        const author = this.extractPostAuthor(post);
        if (author && author.handle) {
          await window.bondStorage.recordInteraction(author.handle, {
            type: 'quote',
            platform: 'bsky',
            displayName: author.displayName,
            avatarUrl: author.avatarUrl,
            timestamp: Date.now()
          }).catch(() => {});
        }
      }
    }, true);
  }
}

if (typeof window !== 'undefined') {
  window.BskyPlatformAdapter = BskyPlatformAdapter;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BskyPlatformAdapter };
}
