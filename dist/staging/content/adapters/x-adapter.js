/**
 * BondScore - X (Twitter) Platform Adapter
 * Handles tweet timeline extraction, profile headers, DM inbox & active chat scanning.
 */

class XPlatformAdapter {
  constructor() {
    this.platform = 'x';
    this.name = 'X (Twitter)';
    this.icon = '𝕏';
    this.currentUser = null;
    this.detector = null;
  }

  isCurrentDomain() {
    return location.hostname.includes('x.com') || location.hostname.includes('twitter.com');
  }

  async init(detector) {
    this.detector = detector;
    this.currentUser = detector ? detector.currentUser : null;
  }

  setCurrentUser(user) {
    this.currentUser = user;
  }

  extractCurrentUser() {
    if (this.detector && typeof this.detector.extractActiveAccountFromDOM === 'function') {
      return this.detector.extractActiveAccountFromDOM();
    }
    return null;
  }

  async scanTimeline(currentUser) {
    if (!window.bondStorage || !window.bondStorage.isTimelineEnabled('x')) return;
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    for (const tweet of tweets) {
      try {
        if (this.detector && typeof this.detector.detectIncomingTweet === 'function') {
          await this.detector.detectIncomingTweet(tweet);
        }

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

        if (userNameContainer.getAttribute('data-bond-injected')) continue;

        const author = this.detector ? this.detector.extractTweetAuthor(tweet) : null;
        if (!author || !author.handle) continue;

        if (currentUser && author.handle === currentUser) continue;

        userNameContainer.setAttribute('data-bond-injected', 'true');
        if (window.bondUI) {
          await window.bondUI.injectBadge(userNameContainer, author.handle, false, 'x');
        }
      } catch (e) {}
    }
  }

  async scanProfile(currentUser) {
    if (!window.bondStorage || !window.bondStorage.isTimelineEnabled('x')) return;
    const profileMatch = location.pathname.match(/^\/([A-Za-z0-9_]+)$/);
    if (!profileMatch || !profileMatch[1]) return;

    const profileHandle = profileMatch[1].toLowerCase();
    const nonUserPaths = ['home', 'explore', 'notifications', 'messages', 'settings', 'i', 'compose', 'search'];
    if (nonUserPaths.includes(profileHandle) || (currentUser && profileHandle === currentUser)) return;

    const profileHeader = document.querySelector('div[data-testid="UserName"]');
    if (profileHeader) {
      const existingHeaderBadges = profileHeader.querySelectorAll('.bond-badge');
      if (existingHeaderBadges.length > 0) {
        for (let i = 1; i < existingHeaderBadges.length; i++) {
          existingHeaderBadges[i].remove();
        }
      } else if (!profileHeader.getAttribute('data-bond-injected')) {
        profileHeader.setAttribute('data-bond-injected', 'true');
        if (window.bondUI) {
          await window.bondUI.injectBadge(profileHeader, profileHandle, true, 'x');
        }
      }
    }

    if (this.detector && typeof this.detector.observeProfileSignals === 'function') {
      await this.detector.observeProfileSignals(profileHandle);
    }
  }

  async scanDms() {
    if (!window.bondStorage || !window.bondStorage.isDmsEnabled('x')) return;
    if (this.detector) {
      if (location.pathname.startsWith('/messages') || document.querySelector('[data-testid="DMDrawer"]')) {
        if (typeof this.detector.scanDmInbox === 'function') {
          await this.detector.scanDmInbox();
        }
        if (typeof this.detector.scanActiveDmThread === 'function') {
          await this.detector.scanActiveDmThread();
        }
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.XPlatformAdapter = XPlatformAdapter;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { XPlatformAdapter };
}
