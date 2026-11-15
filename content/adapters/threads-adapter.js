/**
 * BondScore - Threads Platform Adapter
 * Handles Threads (threads.net) feed observation, user identification, profile badges, and interaction detection.
 * 100% private, local-first.
 */

class ThreadsPlatformAdapter {
  constructor() {
    this.platform = 'threads';
    this.name = 'Threads';
    this.icon = '🧵';
    this.currentUser = null;
    this.processedPostIds = new Set();
    this.listenersAttached = false;
  }

  isCurrentDomain() {
    return location.hostname.includes('threads.net');
  }

  async init() {
    this.currentUser = this.extractActiveAccountFromDOM();
    this.attachEventListeners();
    console.log('[BondScore] Threads adapter initialized. Current user:', this.currentUser ? `@${this.currentUser}` : 'detecting...');
  }

  setCurrentUser(user) {
    this.currentUser = user ? user.replace(/^@/, '').toLowerCase().trim() : null;
  }

  extractActiveAccountFromDOM() {
    // 1. Navigation bar profile icon / link: a[href^="/@"][aria-label="Profile"] or nav links
    const profileLinks = Array.from(document.querySelectorAll('a[href^="/@"]'));
    for (const link of profileLinks) {
      const aria = (link.getAttribute('aria-label') || '').toLowerCase();
      const href = link.getAttribute('href') || '';
      if (aria.includes('profile') || link.querySelector('img[alt*="profile" i]')) {
        const m = href.match(/^\/@([A-Za-z0-9._]+)/);
        if (m && m[1]) {
          const handle = m[1].toLowerCase().trim();
          const img = link.querySelector('img');
          const avatarUrl = img ? (img.currentSrc || img.src || '') : '';
          return { handle, displayName: handle, avatarUrl };
        }
      }
    }

    // 2. Bottom nav bar on desktop / mobile web
    const navAnchors = Array.from(document.querySelectorAll('nav a[href^="/@"], header a[href^="/@"]'));
    for (const a of navAnchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/@([A-Za-z0-9._]+)/);
      if (m && m[1]) {
        return { handle: m[1].toLowerCase().trim(), displayName: m[1], avatarUrl: '' };
      }
    }

    return null;
  }

  extractPostAuthor(postElement) {
    if (!postElement) return null;
    // Find the first author profile link inside the post header
    const authorLink = postElement.querySelector('a[href^="/@"]');
    if (!authorLink) return null;

    const href = authorLink.getAttribute('href') || '';
    const m = href.match(/^\/@([A-Za-z0-9._]+)/);
    if (!m || !m[1]) return null;

    const handle = m[1].toLowerCase().trim();
    const displayName = (authorLink.innerText || authorLink.textContent || handle).trim();
    const avatarImg = postElement.querySelector('img[alt*="profile" i], img[src*="cdninstagram"], img[src*="fbcdn"]');
    const avatarUrl = avatarImg ? (avatarImg.currentSrc || avatarImg.src || '') : '';

    return { handle, displayName, avatarUrl, element: authorLink };
  }

  async scanTimeline(currentUser) {
    if (!window.bondStorage || !window.bondStorage.isTimelineEnabled('threads')) return;

    // Threads posts containers: div[data-pressable-container="true"], article, or feed units
    const postCandidates = Array.from(document.querySelectorAll('div[data-pressable-container="true"], article, div[role="article"]'));
    
    for (const post of postCandidates) {
      try {
        const author = this.extractPostAuthor(post);
        if (!author || !author.handle) continue;
        if (currentUser && author.handle === currentUser) continue;

        // Locate post author text container
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
          await window.bondUI.injectBadge(headerRow, author.handle, false, 'threads');
        }
      } catch (err) {}
    }
  }

  async scanProfile(currentUser) {
    if (!window.bondStorage || !window.bondStorage.isTimelineEnabled('threads')) return;

    // Threads profile URL: threads.net/@handle
    const profileMatch = location.pathname.match(/^\/@([A-Za-z0-9._]+)/);
    if (!profileMatch || !profileMatch[1]) return;

    const profileHandle = profileMatch[1].toLowerCase().trim();
    if (currentUser && profileHandle === currentUser) return;

    // Header container with handle and display name
    const headerTitle = document.querySelector('header h1, header h2, div[data-pressable-container="false"] h1');
    const targetContainer = headerTitle ? headerTitle.parentElement : null;

    if (targetContainer) {
      const existing = targetContainer.querySelectorAll('.bond-badge');
      if (existing.length > 0) {
        for (let i = 1; i < existing.length; i++) existing[i].remove();
      } else if (!targetContainer.getAttribute('data-bond-injected')) {
        targetContainer.setAttribute('data-bond-injected', 'true');
        if (window.bondUI) {
          await window.bondUI.injectBadge(targetContainer, profileHandle, true, 'threads');
        }
      }
    }

    // Check for "Follows you" badge
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('Follows you') || document.querySelector('[aria-label*="Follows you" i]')) {
      if (window.bondStorage) {
        await window.bondStorage.recordRelationshipSignals(profileHandle, {
          theyFollowYou: true,
          isBlocked: false,
          platform: 'threads'
        }).catch(() => {});
      }
    }
  }

  async scanDms() {
    if (!window.bondStorage || !window.bondStorage.isDmsEnabled('threads')) return;
    // Threads messaging / chat metadata scanning if active
    if (location.pathname.includes('/messages') || location.pathname.includes('/direct')) {
      const convRows = Array.from(document.querySelectorAll('a[href*="/messages/"], a[href*="/direct/t/"]'));
      for (const row of convRows) {
        try {
          const author = this.extractPostAuthor(row) || { handle: (row.innerText || '').match(/@([a-zA-Z0-9._]+)/)?.[1] };
          if (author && author.handle && !row.getAttribute('data-bond-dm-injected')) {
            row.setAttribute('data-bond-dm-injected', 'true');
            if (window.bondUI) {
              await window.bondUI.injectDmRowBadge(row, author.handle, false, 'threads');
            }
          }
        } catch (e) {}
      }
    }
  }

  attachEventListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    document.addEventListener('click', async (e) => {
      if (!window.bondStorage || !window.bondStorage.isTimelineEnabled('threads')) return;
      const target = e.target;
      if (!target) return;

      // Detect Like button click
      const likeBtn = target.closest('div[role="button"][aria-label*="Like" i], button[aria-label*="Like" i], svg[aria-label*="Like" i]');
      if (likeBtn) {
        const post = likeBtn.closest('div[data-pressable-container="true"], article, div[role="article"]');
        const author = this.extractPostAuthor(post);
        if (author && author.handle) {
          const isUnlike = (likeBtn.getAttribute('aria-label') || '').toLowerCase().includes('unlike');
          if (!isUnlike) {
            await window.bondStorage.recordInteraction(author.handle, {
              type: 'like',
              platform: 'threads',
              displayName: author.displayName,
              avatarUrl: author.avatarUrl,
              timestamp: Date.now()
            }).catch(() => {});
          }
        }
      }

      // Detect Repost button click
      const repostBtn = target.closest('div[role="button"][aria-label*="Repost" i], button[aria-label*="Repost" i], svg[aria-label*="Repost" i]');
      if (repostBtn) {
        const post = repostBtn.closest('div[data-pressable-container="true"], article, div[role="article"]');
        const author = this.extractPostAuthor(post);
        if (author && author.handle) {
          await window.bondStorage.recordInteraction(author.handle, {
            type: 'quote',
            platform: 'threads',
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
  window.ThreadsPlatformAdapter = ThreadsPlatformAdapter;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ThreadsPlatformAdapter };
}
