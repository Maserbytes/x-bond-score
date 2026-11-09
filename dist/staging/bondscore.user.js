// ==UserScript==
// @name         BondScore for X (Android & Mobile Userscript)
// @namespace    https://github.com/maserbyte/x-bond-score
// @version      1.1.0
// @description  Live relationship score, mutual streaks & reciprocity radar on X (Twitter). Works on Android (Kiwi Browser, Firefox Mobile with Tampermonkey) and Desktop browsers.
// @author       Maserbyte
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  console.log('[BondScore Userscript] Initializing on X...');

  // --- Storage Adapter (GM_setValue or localStorage fallback) ---
  const Storage = {
    get: function (key, defVal) {
      if (typeof GM_getValue !== 'undefined') {
        const val = GM_getValue(key, null);
        return val !== null ? val : defVal;
      }
      try {
        const raw = localStorage.getItem(`bondscore_${key}`);
        return raw ? JSON.parse(raw) : defVal;
      } catch (e) {
        return defVal;
      }
    },
    set: function (key, val) {
      if (typeof GM_setValue !== 'undefined') {
        GM_setValue(key, val);
        return;
      }
      try {
        localStorage.setItem(`bondscore_${key}`, JSON.stringify(val));
      } catch (e) {}
    }
  };

  // --- Scoring Engine ---
  const Scoring = {
    HALF_LIFE_DAYS: 14,
    GRACE_DAYS: 2,

    getTier: function (score) {
      const s = Math.round(score || 0);
      if (s >= 90) return { name: 'Soulmate', emoji: '💖', color: '#F91880', bg: 'rgba(249, 24, 128, 0.15)' };
      if (s >= 70) return { name: 'Bestie', emoji: '🔥', color: '#FF7A00', bg: 'rgba(255, 122, 0, 0.15)' };
      if (s >= 40) return { name: 'Close Mutual', emoji: '✨', color: '#1D9BF0', bg: 'rgba(29, 155, 240, 0.15)' };
      if (s >= 15) return { name: 'Acquaintance', emoji: '🌱', color: '#00BA7C', bg: 'rgba(0, 186, 124, 0.15)' };
      return { name: 'Dormant', emoji: '❄️', color: '#71767B', bg: 'rgba(113, 118, 123, 0.15)' };
    },

    calculateDecayedScore: function (initialScore, lastInteractionMs) {
      if (!initialScore || initialScore <= 0) return 0;
      const elapsedDays = (Date.now() - (lastInteractionMs || Date.now())) / (1000 * 60 * 60 * 24);
      if (elapsedDays <= this.GRACE_DAYS) return initialScore;
      const decayTime = elapsedDays - this.GRACE_DAYS;
      const decayFactor = Math.pow(0.5, decayTime / this.HALF_LIFE_DAYS);
      return Math.max(0, Math.min(100, Math.round(initialScore * decayFactor * 10) / 10));
    }
  };

  // --- Detect Current User ---
  function getCurrentUser() {
    let saved = Storage.get('current_user', null);
    if (saved) return saved;

    const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (accountSwitcher) {
      const text = accountSwitcher.innerText || '';
      const match = text.match(/@([A-Za-z0-9_]{1,15})/);
      if (match && match[1]) {
        saved = match[1].toLowerCase();
        Storage.set('current_user', saved);
        return saved;
      }
    }
    return null;
  }

  // --- Inject Badges ---
  function injectBadges() {
    const currentUser = getCurrentUser();
    const userBadges = Storage.get('users_data', {});

    // Find tweet author containers
    const userNamesContainers = document.querySelectorAll('[data-testid="User-Name"]:not([data-bond-injected])');
    userNamesContainers.forEach((container) => {
      container.setAttribute('data-bond-injected', 'true');
      const handleLink = container.querySelector('a[href^="/"]');
      if (!handleLink) return;

      const href = handleLink.getAttribute('href') || '';
      const handleMatch = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (!handleMatch) return;

      const handle = handleMatch[1].toLowerCase();
      if (currentUser && handle === currentUser) return;

      const userData = userBadges[handle] || { score: 0, lastSeen: Date.now(), streakDays: 0, isPinned: false };
      const currentScore = Scoring.calculateDecayedScore(userData.score, userData.lastSeen);
      const tier = Scoring.getTier(currentScore);

      const badge = document.createElement('span');
      badge.className = 'bond-mobile-badge';
      badge.setAttribute('data-mobile-handle', handle);
      badge.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 3px;
        margin-left: 6px;
        padding: 2px 7px;
        border-radius: 9999px;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        background: ${tier.bg};
        color: ${tier.color};
        border: 1px solid ${tier.color}40;
        vertical-align: middle;
      `;

      badge.innerHTML = `
        ${userData.isPinned ? '⭐ ' : ''}<span>${tier.emoji}</span> <span>${Math.round(currentScore)}</span>
        ${userData.streakDays > 1 ? `<span style="font-size:9px;color:#ff7a00;margin-left:2px;">🔥${userData.streakDays}d</span>` : ''}
      `;

      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMobileScoreCard(handle, userData, currentScore, tier);
      });

      container.appendChild(badge);
    });
  }

  // --- Mobile Score Card Modal ---
  function openMobileScoreCard(handle, userData, score, tier) {
    const existing = document.getElementById('bond-mobile-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'bond-mobile-modal';
    modal.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85);
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    modal.innerHTML = `
      <div style="background:#16181c;border:1px solid #2f3336;border-radius:16px;padding:20px;width:100%;max-width:340px;color:#e7e9ea;box-shadow:0 10px 30px rgba(0,0,0,0.8);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div>
            <h3 style="margin:0;font-size:17px;font-weight:800;color:#ffffff;">@${handle}</h3>
            <div style="font-size:12px;color:#71767b;">${tier.name} Mutual</div>
          </div>
          <button id="bond-modal-close" style="background:transparent;border:none;color:#71767b;font-size:20px;cursor:pointer;">&times;</button>
        </div>

        <div style="text-align:center;padding:16px;background:#000000;border:1px solid #2f3336;border-radius:12px;margin-bottom:14px;">
          <div style="font-size:36px;font-weight:900;color:${tier.color};">${Math.round(score)}</div>
          <div style="font-size:12px;color:#71767b;margin-top:2px;">Relationship Bond Score</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;font-size:12px;">
          <div style="background:#202327;padding:8px 10px;border-radius:8px;">
            <div style="color:#71767b;font-size:10px;">Streak</div>
            <div style="font-weight:700;color:#ff7a00;">${userData.streakDays || 0} days 🔥</div>
          </div>
          <div style="background:#202327;padding:8px 10px;border-radius:8px;">
            <div style="color:#71767b;font-size:10px;">VIP Status</div>
            <div style="font-weight:700;color:${userData.isPinned ? '#ffd400' : '#71767b'};">${userData.isPinned ? '⭐ Pinned' : 'Normal'}</div>
          </div>
        </div>

        <div style="display:flex;gap:8px;">
          <button id="bond-toggle-pin-btn" style="flex:1;background:#202327;border:1px solid #2f3336;color:#ffffff;padding:8px;border-radius:9999px;font-size:12px;font-weight:700;cursor:pointer;">
            ${userData.isPinned ? 'Unpin VIP' : '⭐ Pin as VIP'}
          </button>
          <button id="bond-add-score-btn" style="flex:1;background:#1d9bf0;border:none;color:#ffffff;padding:8px;border-radius:9999px;font-size:12px;font-weight:700;cursor:pointer;">
            +5 Reply Boost
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('#bond-modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    modal.querySelector('#bond-toggle-pin-btn').addEventListener('click', () => {
      userData.isPinned = !userData.isPinned;
      const allUsers = Storage.get('users_data', {});
      allUsers[handle] = userData;
      Storage.set('users_data', allUsers);
      modal.remove();
      injectBadges();
    });

    modal.querySelector('#bond-add-score-btn').addEventListener('click', () => {
      userData.score = Math.min(100, (userData.score || 0) + 5);
      userData.lastSeen = Date.now();
      const allUsers = Storage.get('users_data', {});
      allUsers[handle] = userData;
      Storage.set('users_data', allUsers);
      modal.remove();
      injectBadges();
    });
  }

  // Live click listener for real-time like boosts on mobile
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target) return;

    const likeBtn = target.closest('[data-testid="like"]');
    if (likeBtn) {
      const tweetEl = likeBtn.closest('article[data-testid="tweet"]');
      if (!tweetEl) return;
      const userNames = tweetEl.querySelector('[data-testid="User-Name"]');
      if (!userNames) return;
      const handleLink = userNames.querySelector('a[href^="/"]');
      if (!handleLink) return;
      const href = handleLink.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (!match) return;
      const handle = match[1].toLowerCase();
      const currentUser = getCurrentUser();
      if (currentUser && handle === currentUser) return;

      const allUsers = Storage.get('users_data', {});
      const userData = allUsers[handle] || { score: 0, lastSeen: Date.now(), streakDays: 0, isPinned: false };
      userData.score = Math.min(100, Math.round((userData.score || 0) + 4));
      userData.lastSeen = Date.now();
      allUsers[handle] = userData;
      Storage.set('users_data', allUsers);

      const badges = document.querySelectorAll(`span.bond-mobile-badge[data-mobile-handle="${handle}"]`);
      badges.forEach(b => {
        const tier = Scoring.getTier(userData.score);
        b.style.background = tier.bg;
        b.style.color = tier.color;
        b.style.borderColor = tier.color + '40';
        b.innerHTML = `${userData.isPinned ? '⭐ ' : ''}<span>${tier.emoji}</span> <span>${Math.round(userData.score)}</span>`;
      });
    }
  }, true);

  // Listen for timeline updates with debouncing to prevent mobile scroll stutter
  let injectTimer = null;
  function scheduleInject() {
    if (injectTimer) return;
    injectTimer = setTimeout(() => {
      injectTimer = null;
      injectBadges();
    }, 150);
  }

  const observer = new MutationObserver((mutations) => {
    let hasAdded = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        hasAdded = true;
        break;
      }
    }
    if (hasAdded) scheduleInject();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial pass
  setTimeout(injectBadges, 1500);

  if (typeof GM_registerMenuCommand !== 'undefined') {
    GM_registerMenuCommand('BondScore: Reset Stored Data', () => {
      if (confirm('Clear all mobile BondScore data?')) {
        Storage.set('users_data', {});
        alert('Cleared.');
        location.reload();
      }
    });
  }
})();
