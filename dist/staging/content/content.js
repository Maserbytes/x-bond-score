/**
 * BondScore for X - Content Script Coordinator
 * Observes timeline DOM mutations, coordinates badge injection, and handles SPA navigation.
 */

(async function () {
  // Prevent duplicate script execution
  if (window.__bondScoreContentScriptLoaded) return;
  window.__bondScoreContentScriptLoaded = true;

  console.log('[BondScore] Extension loaded on X (Twitter).');

  // Initialize storage
  await window.bondStorage.init();
  window.bondStorage.setActivePlatform('x');

  // v1.4.0 granular platform controls: X has a master switch plus independent
  // Timeline and DM sub-switches. Nothing is observed when a switch is off.
  const bootSettings = await window.bondStorage.getSettings();
  const platformApi = window.BondPlatforms;
  let platformOn = !platformApi || platformApi.isEnabled(bootSettings, 'x');
  if (!platformOn) {
    console.log('[BondScore] X tracking is disabled in settings.');
    return;
  }
  let timelineOn = !platformApi || platformApi.isFeatureEnabled(bootSettings, 'x', 'timeline');
  let dmsOn = !platformApi || platformApi.isFeatureEnabled(bootSettings, 'x', 'dms');

  // React to popup toggle changes without requiring a page reload.
  const refreshGates = (settings = {}) => {
    if (!platformApi) return;
    platformOn = platformApi.isEnabled(settings, 'x');
    timelineOn = platformApi.isFeatureEnabled(settings, 'x', 'timeline');
    dmsOn = platformApi.isFeatureEnabled(settings, 'x', 'dms');
    if (window.bondXChat) window.bondXChat.setEnabled(platformOn && dmsOn);
  };
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.settings) {
        refreshGates(changes.settings.newValue || {});
      }
    });
  }

  await window.interactionDetector.init();

  // XChat (the current X DM surface at /i/chat) renders inside an open shadow
  // root, which the light-DOM detectors above cannot see. Start the dedicated
  // adapter whenever X + the DM sub-switch are on.
  if (window.bondXChat) {
    window.bondXChat.setEnabled(platformOn && dmsOn);
  }

  let scanScheduled = false;
  let isScanning = false;
  let lastUrl = location.href;
  const historyBackfillScheduled = new Set();

  async function scheduleRecentHistoryBackfill(handle, currentUser) {
    const cleanHandle = (handle || '').replace(/^@/, '').toLowerCase().trim();
    if (!cleanHandle || !currentUser || historyBackfillScheduled.has(cleanHandle)) return;

    await window.bondStorage.rebuildDirectionalStats(cleanHandle).catch(() => {});
    const user = await window.bondStorage.getUser(cleanHandle);
    if (user && user.historyBackfillAt) return;
    if (user && Date.now() - (user.historyBackfillAttemptAt || 0) < 24 * 60 * 60 * 1000) return;

    historyBackfillScheduled.add(cleanHandle);
    await window.bondStorage.saveUser(cleanHandle, { historyBackfillAttemptAt: Date.now() });
    // One bounded seven-day scan per profile, then passive DOM tracking takes over.
    setTimeout(() => {
      window.deepAnalyzer.runAnalysis(currentUser, cleanHandle, () => {}, { windowDays: 7 })
        .catch(() => {})
        .finally(() => historyBackfillScheduled.delete(cleanHandle));
    }, 250);
  }

  /**
   * Scans visible DOM for tweets and profile headers to inject BondScore badges.
   * Completely immune to async race duplication.
   */
  async function scanDom() {
    scanScheduled = false;
    if (isScanning) return;
    if (!platformOn) return;
    isScanning = true;

    try {
      // Check if account has been switched
      await window.interactionDetector.checkAccountSwitch();

      const currentUser = window.interactionDetector.currentUser;

      // 1. Process Timeline Tweets (Badge Injection & Incoming Engagement Detection)
      if (timelineOn) {
        const tweets = document.querySelectorAll('article[data-testid="tweet"]');
        for (const tweet of tweets) {
          try {
            // Detect incoming reply to currentUser or mention
            await window.interactionDetector.detectIncomingTweet(tweet);

          const userNameContainer = tweet.querySelector('[data-testid="User-Name"]');
          if (!userNameContainer) continue;

          // Deduplicate immediately: if badge already exists, keep only 1 and skip
          const existingBadges = userNameContainer.querySelectorAll('.bond-badge');
          if (existingBadges.length > 0) {
            for (let i = 1; i < existingBadges.length; i++) {
              existingBadges[i].remove();
            }
            continue;
          }

          // Skip if injection already pending or completed
          if (userNameContainer.getAttribute('data-bond-injected')) continue;

          const author = window.interactionDetector.extractTweetAuthor(tweet);
          if (!author || !author.handle) continue;

          // Skip if current user's own tweet
          if (currentUser && author.handle === currentUser) continue;

          // Synchronous lock attribute
          userNameContainer.setAttribute('data-bond-injected', 'true');

          // Inject badge
          await window.bondUI.injectBadge(userNameContainer, author.handle, false);
        } catch (err) {
          // silently continue
        }
      }

      // 2. Process Notifications (Passive Incoming Engagement)
      if (location.pathname.startsWith('/notifications')) {
        const cells = document.querySelectorAll('[data-testid="cellInnerDiv"], [data-testid="notification"], [role="listitem"]');
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
          if (profileHeader) {
            const existingHeaderBadges = profileHeader.querySelectorAll('.bond-badge');
            if (existingHeaderBadges.length > 0) {
              for (let i = 1; i < existingHeaderBadges.length; i++) {
                existingHeaderBadges[i].remove();
              }
            } else if (!profileHeader.getAttribute('data-bond-injected')) {
              profileHeader.setAttribute('data-bond-injected', 'true');
              await window.bondUI.injectBadge(profileHeader, profileHandle, true);
            }
          }
          // Observe relationship signals (mutuals, follow-back, unfollow, blocks)
          await window.interactionDetector.observeProfileSignals(profileHandle);
          scheduleRecentHistoryBackfill(profileHandle, currentUser).catch(() => {});
        }
      }

      }

      // 4. Process Direct Messages (Conversation row badges & open thread header pill)
      if (dmsOn && (location.pathname.startsWith('/messages') || location.pathname.startsWith('/i/chat') || document.querySelector('[data-testid="DMDrawer"]'))) {
        await window.interactionDetector.scanDmInbox();
        await window.interactionDetector.scanActiveDmThread();
      }
    } finally {
      isScanning = false;
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

  // Listen for popup inquiries for active tab account & avatar batch resolution
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'bondscore:get_active_account') {
        const info = window.interactionDetector.extractActiveAccountFromDOM();
        sendResponse({
          handle: window.interactionDetector.currentUser,
          metadata: info || null
        });
        return true;
      }
      if (msg && msg.type === 'bondscore:resolve_missing_avatars') {
        if (window.interactionDetector && window.interactionDetector.resolveMissingAvatars) {
          window.interactionDetector.resolveMissingAvatars(msg.handles).then((results) => {
            sendResponse({ results });
          }).catch(() => {
            sendResponse({ results: {} });
          });
          return true;
        }
      }
    });
  }

  // SPA URL change detection & active account switch check
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      window.interactionDetector.checkAccountSwitch();
      scheduleScan();
    }
  }, 500);

  // Periodic active account verification
  setInterval(() => {
    window.interactionDetector.checkAccountSwitch();
  }, 2000);

  // Dedicated active inbox poller on /messages and /i/chat to inject badges immediately on list load
  setInterval(() => {
    if (dmsOn && (location.pathname.startsWith('/messages') || location.pathname.startsWith('/i/chat') || document.querySelector('[data-testid="DMDrawer"]'))) {
      if (window.interactionDetector) {
        window.interactionDetector.scanDmInbox().catch(() => {});
        window.interactionDetector.scanActiveDmThread().catch(() => {});
      }
      if (window.bondXChat && window.bondXChat.enabled) {
        window.bondXChat.scan().catch(() => {});
      }
    }
  }, 1000);

  // Initial scan
  setTimeout(scanDom, 600);
})();
