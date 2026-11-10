/**
 * BondScore for X - Content Script Coordinator
 * Observes timeline DOM mutations, coordinates badge injection, and handles SPA navigation.
 */

(async function () {
  console.log('[BondScore] Extension loaded on X (Twitter).');

  // Initialize storage
  await window.bondStorage.init();
  await window.interactionDetector.init();

  let scanScheduled = false;
  let lastUrl = location.href;

  /**
   * Scans visible DOM for tweets and profile headers to inject BondScore badges
   */
  async function scanDom() {
    scanScheduled = false;

    // Detect / refresh current user if not yet discovered
    if (!window.interactionDetector.currentUser) {
      await window.interactionDetector.detectCurrentUser();
    }

    const currentUser = window.interactionDetector.currentUser;

    // 1. Process Timeline Tweets (Badge Injection & Incoming Engagement Detection)
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    for (const tweet of tweets) {
      try {
        // Detect incoming reply to currentUser or mention
        await window.interactionDetector.detectIncomingTweet(tweet);

        const userNameContainer = tweet.querySelector('[data-testid="User-Name"]');
        if (!userNameContainer) continue;

        // Skip if already has badge
        if (userNameContainer.querySelector('.bond-badge')) continue;

        const author = window.interactionDetector.extractTweetAuthor(tweet);
        if (!author || !author.handle) continue;

        // Skip if current user's own tweet
        if (currentUser && author.handle === currentUser) continue;

        // Inject badge
        await window.bondUI.injectBadge(userNameContainer, author.handle, false);
      } catch (err) {
        // silently continue
      }
    }

    // 2. Process Notifications (Passive Incoming Engagement)
    if (location.pathname.startsWith('/notifications')) {
      const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
      for (const cell of cells) {
        try {
          await window.interactionDetector.detectNotificationCell(cell);
        } catch (e) {}
      }
    }

    // 3. Process Profile Page Header & Relationship Signals
    const profileMatch = location.pathname.match(/^\/([A-Za-z0-9_]+)$/);
    if (profileMatch && profileMatch[1]) {
      const profileHandle = profileMatch[1].toLowerCase();
      const nonUserPaths = ['home', 'explore', 'notifications', 'messages', 'settings', 'i', 'compose', 'search'];
      if (!nonUserPaths.includes(profileHandle) && (!currentUser || profileHandle !== currentUser)) {
        const profileHeader = document.querySelector('div[data-testid="UserName"]');
        if (profileHeader && !profileHeader.querySelector('.bond-badge')) {
          await window.bondUI.injectBadge(profileHeader, profileHandle, true);
        }
        // Observe relationship signals (mutuals, follow-back, unfollow, blocks)
        await window.interactionDetector.observeProfileSignals(profileHandle);
      }
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      setTimeout(scanDom, 120);
    });
  }

  // Set up MutationObserver to monitor timeline feeds
  const observer = new MutationObserver((mutations) => {
    let hasRelevantNodes = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        hasRelevantNodes = true;
        break;
      }
    }
    if (hasRelevantNodes) {
      scheduleScan();
    }
  });

  const root = document.getElementById('react-root') || document.body;
  if (root) {
    observer.observe(root, { childList: true, subtree: true });
  }

  // SPA URL change detection
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleScan();
    }
  }, 500);

  // Initial scan
  setTimeout(scanDom, 600);
})();
