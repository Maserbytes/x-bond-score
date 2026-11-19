/**
 * BondScore - Extension Popup Logic (v1.4.0)
 * Controls leaderboard, filter pills, solar system orbit view, graphic exporter,
 * dynamic theme switcher (system auto, dark, light), settings, and CRM analytics.
 */

let cachedUsers = [];
let currentFilter = 'all';
let currentPlatformFilter = 'all'; // 'all' | 'x' | 'threads' | 'bluesky'
let currentUsername = 'you';
let currentAvatarUrl = '';
let currentTheme = 'system'; // 'system' | 'dark' | 'light'
let leaderboardRefreshTimer = null;
let leaderboardLoadGeneration = 0;
let orbitRenderTimer = null;

function shouldRefreshDashboardForStorageChanges(changes, activeAccount) {
  if (!changes || typeof changes !== 'object') return false;
  if (changes.currentUser || changes.knownAccounts || changes.accountsMetadata) return true;

  const account = (activeAccount || '').replace(/^@/, '').toLowerCase().trim();
  const prefix = account ? `acc:${account}:` : '';
  const isRecordKey = (key) => {
    const sub = account ? (key.startsWith(prefix) ? key.slice(prefix.length) : '') : key;
    return /^(?:p:[a-z0-9]+:)?(?:user|events|dm):/.test(sub);
  };
  return Object.keys(changes).some(isRecordKey);
}

function queueDashboardRefresh() {
  if (leaderboardRefreshTimer) clearTimeout(leaderboardRefreshTimer);
  leaderboardRefreshTimer = setTimeout(async () => {
    leaderboardRefreshTimer = null;
    await loadLeaderboard();

    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab && activeTab.dataset.tab === 'tab-orbit') renderOrbitCanvas();
    else if (activeTab && activeTab.dataset.tab === 'tab-radar') renderRadarTab();
    else if (activeTab && activeTab.dataset.tab === 'tab-dms') renderDmsTab();
  }, 100);
}

function queueOrbitCanvasRender() {
  if (orbitRenderTimer) clearTimeout(orbitRenderTimer);
  orbitRenderTimer = setTimeout(() => {
    orbitRenderTimer = null;
    const canvas = document.getElementById('orbit-canvas');
    const activeTab = document.querySelector('.tab-btn.active');
    if (canvas && canvas.offsetParent !== null && activeTab && activeTab.dataset.tab === 'tab-orbit') {
      renderOrbitCanvas();
    }
  }, 60);
}

function isLightMode() {
  const dataTheme = document.documentElement.getAttribute('data-theme');
  if (dataTheme === 'light') return true;
  if (dataTheme === 'dark') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
}

function applyTheme(theme) {
  currentTheme = theme || 'system';
  const root = document.documentElement;

  if (theme === 'dark') {
    root.setAttribute('data-theme', 'dark');
  } else if (theme === 'light') {
    root.setAttribute('data-theme', 'light');
  } else {
    root.removeAttribute('data-theme');
  }

  // Update header toggle button
  const iconAuto = document.getElementById('theme-icon-auto');
  const iconDark = document.getElementById('theme-icon-dark');
  const iconLight = document.getElementById('theme-icon-light');
  const label = document.getElementById('theme-toggle-label');
  const toggleBtn = document.getElementById('theme-toggle-btn');

  if (iconAuto && iconDark && iconLight) {
    iconAuto.style.display = currentTheme === 'system' ? 'inline-block' : 'none';
    iconDark.style.display = currentTheme === 'dark' ? 'inline-block' : 'none';
    iconLight.style.display = currentTheme === 'light' ? 'inline-block' : 'none';
  }
  if (label) {
    label.innerText = currentTheme === 'system' ? 'Auto' : currentTheme === 'dark' ? 'Dark' : 'Light';
  }
  if (toggleBtn) {
    const isDarkNow = !isLightMode();
    toggleBtn.title = `Theme: ${currentTheme.toUpperCase()} (${isDarkNow ? 'Dark' : 'Light'} active). Click to toggle.`;
  }

  // Update Settings segmented buttons
  const segBtns = document.querySelectorAll('.theme-seg-btn');
  segBtns.forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-theme') === currentTheme);
  });

  // Re-render canvas if on orbit tab
  const activeTab = document.querySelector('.tab-btn.active');
  if (activeTab && activeTab.dataset.tab === 'tab-orbit') {
    renderOrbitCanvas();
  }
}

async function setThemeAndSave(theme) {
  applyTheme(theme);
  await window.bondStorage.updateSettings({ theme });
}

function setupTheme(initialTheme = 'system') {
  applyTheme(initialTheme);

  const toggleBtn = document.getElementById('theme-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      let nextTheme = 'dark';
      if (currentTheme === 'system') nextTheme = 'dark';
      else if (currentTheme === 'dark') nextTheme = 'light';
      else if (currentTheme === 'light') nextTheme = 'system';
      await setThemeAndSave(nextTheme);
    });
  }

  // OS preference change listener
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentTheme === 'system') {
        applyTheme('system');
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.bondStorage.init();

  const settings = await window.bondStorage.getSettings();
  setupTheme(settings.theme || 'system');

  // Tab Navigation
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(btn.dataset.tab);
      if (target) {
        target.classList.add('active');
        if (btn.dataset.tab === 'tab-orbit') {
          renderOrbitCanvas();
        } else if (btn.dataset.tab === 'tab-radar') {
          renderRadarTab();
        } else if (btn.dataset.tab === 'tab-dms') {
          renderDmsTab();
        }
      }
    });
  });

  // Load Initial State
  try {
    const versionBadge = document.getElementById('extension-version-badge');
    if (versionBadge && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
      const manifest = chrome.runtime.getManifest();
      if (manifest && manifest.version) {
        versionBadge.innerText = `v${manifest.version}`;
      }
    }
  } catch (e) {}

  await setupAccountSwitcher();
  await syncActiveTabAccountIfAvailable();
  await loadLeaderboard();
  await loadSettingsForm();
  renderRadarTab();
  setupFilterPills();
  setupSearchHandler();
  setupPlatformFilters();
  setupDmFilterPills();
  setupDmSearchHandler();
  setupOrbitExporter();
  setupTwoHandleLookup();

  // Storage change listener to keep popup in sync live with browser actions
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      const accountMetadataChanged = !!(changes.currentUser || changes.knownAccounts || changes.accountsMetadata);
      if (accountMetadataChanged) void setupAccountSwitcher();

      const activeAccount = window.bondStorage.currentUser || (currentUsername === 'you' ? '' : currentUsername);
      if (shouldRefreshDashboardForStorageChanges(changes, activeAccount)) {
        queueDashboardRefresh();
      }
    });
  }
});

/**
 * Sets up the multi-account dropdown switcher in the popup header.
 * Allows viewing separate scores and interaction CRM per account.
 */
async function setupAccountSwitcher() {
  const selectorBtn = document.getElementById('account-selector-btn');
  const dropdown = document.getElementById('account-dropdown');
  const listEl = document.getElementById('account-dropdown-list');
  const countEl = document.getElementById('account-dropdown-count');
  const handleTextEl = document.getElementById('account-handle-text');
  const avatarMiniEl = document.getElementById('account-avatar-mini');

  if (!selectorBtn || !dropdown || !listEl) return;

  const { activeAccount, accounts } = await window.bondStorage.getKnownAccounts();
  const currentAcc = activeAccount || 'you';
  currentUsername = currentAcc;

  // Update header button text and avatar
  if (handleTextEl) {
    handleTextEl.innerText = activeAccount ? `@${activeAccount}` : 'Browse X';
  }
  if (avatarMiniEl) {
    const activeMeta = accounts.find(a => a.handle === activeAccount);
    if (activeMeta && activeMeta.avatarUrl) {
      currentAvatarUrl = activeMeta.avatarUrl;
      avatarMiniEl.innerHTML = `<img src="${activeMeta.avatarUrl}" alt="${activeAccount}">`;
    } else {
      avatarMiniEl.innerText = activeAccount ? activeAccount.charAt(0).toUpperCase() : '👤';
    }
  }

  // Populate dropdown list
  if (countEl) {
    countEl.innerText = `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`;
  }

  listEl.innerHTML = '';
  if (accounts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'account-dropdown-item active';
    empty.innerHTML = `
      <div class="account-item-left">
        <div class="account-item-avatar">👤</div>
        <div class="account-item-names">
          <span class="account-item-display">Current Session</span>
          <span class="account-item-handle">Browse X to detect</span>
        </div>
      </div>
      <span class="account-item-check">✓</span>
    `;
    listEl.appendChild(empty);
  } else {
    accounts.forEach(acc => {
      const item = document.createElement('div');
      item.className = `account-dropdown-item ${acc.isActive ? 'active' : ''}`;
      item.innerHTML = `
        <div class="account-item-left">
          <div class="account-item-avatar">
            ${acc.avatarUrl ? `<img src="${acc.avatarUrl}" alt="${acc.handle}">` : acc.handle.charAt(0).toUpperCase()}
          </div>
          <div class="account-item-names">
            <span class="account-item-display">${acc.displayName || acc.handle}</span>
            <span class="account-item-handle">@${acc.handle}</span>
          </div>
        </div>
        ${acc.isActive ? `<span class="account-item-check">✓</span>` : ''}
      `;

      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        dropdown.style.display = 'none';
        selectorBtn.classList.remove('open');
        selectorBtn.setAttribute('aria-expanded', 'false');

        if (!acc.isActive) {
          await window.bondStorage.switchAccount(acc.handle);
          await setupAccountSwitcher();
          await loadLeaderboard();
          const activeTab = document.querySelector('.tab-btn.active');
          if (activeTab && activeTab.dataset.tab === 'tab-orbit') {
            renderOrbitCanvas();
          } else if (activeTab && activeTab.dataset.tab === 'tab-radar') {
            renderRadarTab();
          }
        }
      });

      listEl.appendChild(item);
    });
  }

  // Dropdown toggle logic
  selectorBtn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = dropdown.style.display !== 'none';
    if (isOpen) {
      dropdown.style.display = 'none';
      selectorBtn.classList.remove('open');
      selectorBtn.setAttribute('aria-expanded', 'false');
    } else {
      dropdown.style.display = 'block';
      selectorBtn.classList.add('open');
      selectorBtn.setAttribute('aria-expanded', 'true');
    }
  };

  // Close dropdown on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#account-bar')) {
      dropdown.style.display = 'none';
      selectorBtn.classList.remove('open');
      selectorBtn.setAttribute('aria-expanded', 'false');
    }
  });
}

/**
 * Checks if the active browser tab is on a supported network and auto-detects
 * the signed-in account on initial run. Preserves user account selection once
 * established to avoid asynchronous race overrides.
 */
async function syncActiveTabAccountIfAvailable() {
  const currentStored = await window.bondStorage.getCurrentUser();
  if (currentStored) return;

  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const url = (tabs && tabs[0] && tabs[0].url) || '';
        const supported = ['x.com', 'twitter.com', 'threads.net', 'bsky.app'].some((host) => url.includes(host));
        if (supported) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'bondscore:get_active_account' }, async (response) => {
            if (response && response.handle) {
              const freshStored = await window.bondStorage.getCurrentUser();
              if (!freshStored) {
                await window.bondStorage.switchAccount(response.handle, response.metadata);
                await setupAccountSwitcher();
                await loadLeaderboard();
                const activeTab = document.querySelector('.tab-btn.active');
                if (activeTab && activeTab.dataset.tab === 'tab-orbit') renderOrbitCanvas();
                else if (activeTab && activeTab.dataset.tab === 'tab-radar') renderRadarTab();
              }
            }
          });
        }
      });
    } catch (e) {}
  }
}

async function loadCurrentUserTag() {
  const userTag = document.getElementById('current-user-tag');
  const currentUser = await window.bondStorage.getCurrentUser();
  if (currentUser) {
    currentUsername = currentUser;
    if (userTag) userTag.innerText = `@${currentUser}`;
  } else {
    if (userTag) userTag.innerText = 'Browse a supported network to auto-detect';
  }
  // The orbit center is you: resolve your own avatar once for the canvas.
  try {
    const { accounts } = await window.bondStorage.getKnownAccounts();
    const meta = accounts.find((a) => a.handle === currentUsername);
    if (meta && meta.avatarUrl) currentAvatarUrl = meta.avatarUrl;
  } catch (e) {}
}

async function loadLeaderboard() {
  const loadGeneration = ++leaderboardLoadGeneration;
  const totalAccountsEl = document.getElementById('stat-total-accounts');
  const topScoreEl = document.getElementById('stat-top-score');
  const mutualRepliesEl = document.getElementById('stat-mutual-replies');

  const users = await window.bondStorage.getAllUsers();
  if (loadGeneration !== leaderboardLoadGeneration) return;
  cachedUsers = users;
  totalAccountsEl.innerText = cachedUsers.length;

  let maxScore = 0;
  let totalMutual = 0;

  for (const u of cachedUsers) {
    if ((u.currentScore || 0) > maxScore) maxScore = Math.round(u.currentScore);
    totalMutual += (u.stats && u.stats.mutualExchanges) || 0;
  }

  topScoreEl.innerText = maxScore;
  mutualRepliesEl.innerText = totalMutual;

  applyFilterAndRender();

  // Asynchronously resolve real avatars for contacts missing them
  const missingAvatars = cachedUsers
    .filter(u => (!u.avatarUrl || u.avatarUrl === '') && u.handle)
    .map(u => u.handle.toLowerCase().trim());
  if (missingAvatars.length > 0) {
    resolveMissingAvatarsForList(missingAvatars);
  }
}

/**
 * Sends a message to the active tab to resolve real avatars via on-page DOM or authenticated session API.
 * Updates DOM cards in-place upon response.
 */
async function resolveMissingAvatarsForList(handles) {
  if (!handles || handles.length === 0) return;
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return;

  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0] || !tabs[0].id) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'bondscore:resolve_missing_avatars', handles }, (res) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        if (res && res.results && typeof res.results === 'object') {
          for (const [handle, data] of Object.entries(res.results)) {
            if (!data || !data.avatarUrl) continue;
            const h = handle.toLowerCase();
            const user = cachedUsers.find(u => (u.handle || '').toLowerCase() === h);
            if (user) {
              user.avatarUrl = data.avatarUrl;
              if (data.displayName && (!user.displayName || user.displayName === user.handle)) {
                user.displayName = data.displayName;
              }
            }
            const wraps = document.querySelectorAll(`.mutual-avatar-wrap[data-avatar-handle="${h}"]`);
            wraps.forEach((wrap) => {
              const pin = wrap.querySelector('.mutual-pin-badge');
              wrap.innerHTML = `
                <img class="mutual-avatar" src="${escapeHtml(data.avatarUrl)}" alt="${escapeHtml((user && user.displayName) || h)}" onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='flex';">
                <div class="mutual-avatar-fallback" style="display:none;">${escapeHtml(h.charAt(0).toUpperCase())}</div>
                ${pin ? pin.outerHTML : ''}
              `;
            });
          }
        }
      });
    });
  } catch (e) {}
}

function setupPlatformFilters() {
  const bars = document.querySelectorAll('.platform-capsule-bar');
  bars.forEach((bar) => {
    const capsules = bar.querySelectorAll('.platform-capsule');
    capsules.forEach((capsule) => {
      capsule.addEventListener('click', () => {
        currentPlatformFilter = capsule.dataset.platformFilter || 'all';
        // Keep every platform bar in sync (leaderboard + DMs share the scope).
        document.querySelectorAll('.platform-capsule').forEach((c) => {
          const active = (c.dataset.platformFilter || 'all') === currentPlatformFilter;
          c.classList.toggle('active', active);
          c.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        applyFilterAndRender();
        renderDmSubSections(cachedDms.filter(matchesPlatform), currentDmFilter);
      });
    });
  });
}

function matchesPlatform(item) {
  if (currentPlatformFilter === 'all') return true;
  return (item.platform || 'x') === currentPlatformFilter;
}

/** Small platform badge used on user and DM cards. */
function platformChip(item, extraClass = '') {
  const p = BondPlatforms.get((item && item.platform) || 'x');
  return `<span class="platform-chip platform-chip-${p.id}${extraClass ? ` ${extraClass}` : ''}" title="${escapeHtml(p.fullName)}">${p.emoji} ${p.shortLabel}</span>`;
}

/** Platform-aware deep link for a conversation. */
function messageUrl(item) {
  const p = (item && item.platform) || 'x';
  const convId = String((item && item.convId) || '');
  if (p === 'threads') return `https://www.threads.net/messages/${encodeURIComponent(convId)}`;
  if (p === 'bluesky') return `https://bsky.app/messages/${encodeURIComponent(convId)}`;

  // XChat opens a thread only when it arrives through the legacy redirect:
  // /messages/<a>-<b> 302s to /i/chat/<a>-<b> and mounts the conversation.
  // Loading /i/chat/<id> directly mounts the shell but leaves the thread closed,
  // and /messages/g<id> drops the id and lands in the inbox, so groups point at
  // the inbox where the user can pick the chat.
  if (/^g/i.test(convId)) return 'https://x.com/i/chat';
  const urlId = convId.includes(':') ? convId.replace(/:/g, '-') : convId;
  return `https://x.com/messages/${encodeURIComponent(urlId)}`;
}

function setupFilterPills() {
  const pills = document.querySelectorAll('.filter-pill');
  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.dataset.filter;
      applyFilterAndRender();
    });
  });
}

function getCRMStatusForUser(u) {
  if (u.crmStatusData) return u.crmStatusData;
  const sSent = (u.stats && ((u.stats.repliesSent || 0) + (u.stats.dmsSent || 0) + (u.stats.likesSent ?? u.stats.likes ?? 0) + (u.stats.quotesSent || 0) + (u.stats.mentionsSent || 0))) || 0;
  const sRecv = (u.stats && ((u.stats.repliesReceived || 0) + (u.stats.dmsReceived || 0) + (u.stats.likesReceived || 0) + (u.stats.quotesReceived || 0) + (u.stats.mentionsReceived || 0))) || 0;
  return BondScoring.calculateCRMStatus(u.currentScore || 0, sSent, sRecv, u.streakDays || 0);
}

function applyFilterAndRender() {
  const q = (document.getElementById('mutual-search-input').value || '').toLowerCase().trim();
  let list = cachedUsers.filter(matchesPlatform);

  if (currentFilter === 'vip') {
    list = list.filter(u => u.isPinned);
  } else if (currentFilter === 'streaks') {
    list = list.filter(u => (u.streakDays || 0) > 1);
  } else if (currentFilter === 'at-risk') {
    list = list.filter(u => {
      const daysSince = (Date.now() - (u.lastInteraction || Date.now())) / (1000 * 60 * 60 * 24);
      return daysSince >= 3 && (u.currentScore || 0) >= 20;
    });
  } else if (currentFilter === 'supporters') {
    list = list.filter(u => {
      const s = ((u.stats && u.stats.repliesSent) || 0) + ((u.stats && u.stats.dmsSent) || 0) + (u.stats && (u.stats.likesSent ?? u.stats.likes) || 0) + ((u.stats && u.stats.quotesSent) || 0) + ((u.stats && u.stats.mentionsSent) || 0);
      const r = ((u.stats && u.stats.repliesReceived) || 0) + ((u.stats && u.stats.dmsReceived) || 0) + ((u.stats && u.stats.likesReceived) || 0) + ((u.stats && u.stats.quotesReceived) || 0) + ((u.stats && u.stats.mentionsReceived) || 0);
      return r > 0 && (r >= s || r >= 2);
    });
  } else if (currentFilter === 'dormant') {
    const now = Date.now();
    list = list.filter(u => {
      const days = Math.floor((now - (u.lastInteraction || now)) / 86400000);
      const s = ((u.stats && u.stats.repliesSent) || 0) + ((u.stats && u.stats.dmsSent) || 0) + (u.stats && (u.stats.likesSent ?? u.stats.likes) || 0) + ((u.stats && u.stats.quotesSent) || 0) + ((u.stats && u.stats.mentionsSent) || 0);
      const r = ((u.stats && u.stats.repliesReceived) || 0) + ((u.stats && u.stats.dmsReceived) || 0) + ((u.stats && u.stats.likesReceived) || 0) + ((u.stats && u.stats.quotesReceived) || 0) + ((u.stats && u.stats.mentionsReceived) || 0);
      return days >= 14 && ((u.currentScore || 0) > 5 || (s + r) > 0);
    });
  } else if (currentFilter === 'besties') {
    list = list.filter(u => getCRMStatusForUser(u).id === 'besties');
  } else if (currentFilter === 'mutuals') {
    list = list.filter(u => {
      const cId = getCRMStatusForUser(u).id;
      return cId === 'mutuals' || cId === 'besties';
    });
  } else if (currentFilter === 'one-sided') {
    list = list.filter(u => {
      const cId = getCRMStatusForUser(u).id;
      return cId === 'one_sided' || cId === 'one_sided_them';
    });
  } else if (currentFilter === 'signals') {
    list = list.filter(u => u.signals && (u.signals.isBlocked || u.signals.isMutual || u.signals.theyFollowYou || u.signals.youFollowThem));
  } else if (currentFilter === 'stranger') {
    list = list.filter(u => {
      const cId = getCRMStatusForUser(u).id;
      return cId === 'stranger' || cId === 'casual';
    });
  }

  if (q) {
    list = list.filter(u =>
      (u.handle && u.handle.toLowerCase().includes(q)) ||
      (u.displayName && u.displayName.toLowerCase().includes(q))
    );
  }

  renderUserList(list);
}

function renderUserList(users) {
  const listEl = document.getElementById('mutuals-list');
  listEl.innerHTML = '';

  if (!users || users.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🤝</div>
        <h3>No mutuals match</h3>
        <p>${currentFilter === 'all' ? 'Browse X, reply to mutuals, or run <strong>Deep Analysis</strong> on any profile to calculate your first Bond Score.' : 'No contacts found matching this filter.'}</p>
      </div>
    `;
    return;
  }

  users.forEach((u) => {
    const tier = BondScoring.getTier(u.currentScore);
    const scoreVal = Math.round(u.currentScore || 0);
    const isPinned = !!u.isPinned;
    const crm = getCRMStatusForUser(u);
    const dmsTotal = ((u.stats && u.stats.dmsSent) || 0) + ((u.stats && u.stats.dmsReceived) || 0);

    const item = document.createElement('div');
    item.className = 'mutual-item';

    let signalHtml = '';
    const followRel = typeof BondScoring !== 'undefined' && BondScoring.getFollowRelationship
      ? BondScoring.getFollowRelationship(u.signals)
      : null;
    if (followRel) {
      signalHtml = `<span class="popup-signal-pill ${followRel.id}" title="${followRel.desc}">${followRel.badgeText}</span>`;
    }

    const cleanH = (u.handle || '').toLowerCase().trim();
    item.innerHTML = `
      <div class="mutual-user-info">
        <div class="mutual-avatar-wrap" data-avatar-handle="${escapeHtml(cleanH)}">
          ${u.avatarUrl
            ? `<img class="mutual-avatar" src="${escapeHtml(u.avatarUrl)}" alt="${escapeHtml(u.displayName || u.handle)}" onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='flex';">
               <div class="mutual-avatar-fallback" style="display:none;">${escapeHtml((u.handle || 'X').charAt(0).toUpperCase())}</div>`
            : `<div class="mutual-avatar-fallback">${escapeHtml((u.handle || 'X').charAt(0).toUpperCase())}</div>`
          }
          ${isPinned ? `<span class="mutual-pin-badge">⭐</span>` : ''}
        </div>
        <div class="mutual-names">
          <div class="mutual-name-row">
            <span class="mutual-name">${escapeHtml(u.displayName || u.handle)}</span>
            <span class="popup-crm-pill ${crm.id}" title="${crm.desc}">${crm.emoji} ${crm.label}</span>
            ${signalHtml}
            ${(u.streakDays || 0) > 1 ? `<span class="mutual-streak-badge">🔥${u.streakDays}d</span>` : ''}
          </div>
          <div class="mutual-handle-sub">
            <span>@${escapeHtml(u.handle)}</span>
            <span class="platform-chip platform-chip-${escapeHtml(u.platform || 'x')}" title="${escapeHtml((BondPlatforms.get(u.platform || 'x').fullName) || 'X')}">${BondPlatforms.get(u.platform || 'x').emoji} ${BondPlatforms.get(u.platform || 'x').shortLabel}</span>
            ${dmsTotal > 0 ? `<span class="mutual-dm-count" title="${dmsTotal} direct messages tracked">✉️ ${dmsTotal} DMs</span>` : ''}
            ${u.note ? `<span class="mutual-note-snippet" title="${escapeHtml(u.note)}">📝 ${escapeHtml(u.note)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="mutual-right-col">
        <button class="quick-pin-btn ${isPinned ? 'pinned' : ''}" title="${isPinned ? 'Unpin VIP' : 'Pin as VIP'}">⭐</button>
        <div class="mutual-score-badge" style="background: ${tier.bg}; color: ${tier.color}; border: 1px solid ${tier.color}40">
          <span>${tier.emoji}</span>
          <strong>${scoreVal}</strong>
        </div>
      </div>
    `;

    // Click pin button to toggle VIP
    const pinBtn = item.querySelector('.quick-pin-btn');
    pinBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newPinned = await window.bondStorage.togglePin(u.handle);
      u.isPinned = newPinned;
      await loadLeaderboard();
    });

    // Click card to open the right profile on its native network
    item.addEventListener('click', () => {
      const url = BondPlatforms.profileUrl(u.platform || 'x', u.handle);
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
    });

    listEl.appendChild(item);
  });
}

function setupSearchHandler() {
  const searchInput = document.getElementById('mutual-search-input');
  searchInput.addEventListener('input', () => {
    applyFilterAndRender();
  });
}

/**
 * 🪐 Mutuals Orbit Canvas Rendering (Solar System)
 */
const ORBIT_TIERS = [
  { id: 'core', min: 70, color: '#f91880', share: 0.2 },
  { id: 'close', min: 35, color: '#1d9bf0', share: 0.32 },
  { id: 'casual', min: 0, color: '#794bc4', share: 0.45 }
];

let orbitHitAreas = [];
let orbitHoverHandle = null;
let orbitGeometry = null;

function orbitGroups() {
  const users = cachedUsers
    .filter(matchesPlatform)
    .filter((u) => (u.currentScore || 0) > 0)
    .sort((a, b) => (b.currentScore || 0) - (a.currentScore || 0));
  return {
    core: users.filter((u) => u.currentScore >= 70),
    close: users.filter((u) => u.currentScore >= 35 && u.currentScore < 70),
    casual: users.filter((u) => u.currentScore < 35)
  };
}

/**
 * Capacity-aware geometry. Each ring grows until it can seat its population
 * with breathing room, and the overflow is reported instead of piled up.
 */
function computeOrbitGeometry(size) {
  const cx = size / 2;
  const cy = size / 2;
  const scale = size / 420;
  const groups = orbitGroups();
  const sunRadius = Math.round(size * 0.088);
  const maxRadius = size / 2 - Math.round(20 * scale);
  const gap = Math.round(7 * scale);

  const rings = [];
  let previousEdge = sunRadius + Math.round(14 * scale);

  ORBIT_TIERS.forEach((tier) => {
    const all = groups[tier.id] || [];
    const diameter = Math.round(
      (tier.id === 'core' ? 32 : tier.id === 'close' ? 26 : 21) * scale
    );
    const slot = diameter + gap;
    const fitsAtMax = Math.max(1, Math.floor((Math.PI * 2 * maxRadius) / slot));
    let visible = all.slice(0, fitsAtMax);
    const needed = (slot * visible.length) / (Math.PI * 2);
    let radius = Math.max(tier.share * size, needed, previousEdge + diameter / 2 + gap);
    radius = Math.min(radius, maxRadius);
    const fitsHere = Math.max(1, Math.floor((Math.PI * 2 * radius) / slot));
    if (visible.length > fitsHere) visible = visible.slice(0, fitsHere);

    rings.push({ tier, radius, diameter, users: visible, hidden: all.length - visible.length });
    previousEdge = radius + diameter / 2;
  });

  return {
    size,
    cx,
    cy,
    sunRadius,
    rings,
    total: groups.core.length + groups.close.length + groups.casual.length
  };
}

function renderOrbitCanvas() {
  const canvas = document.getElementById('orbit-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const size = Math.max(240, Math.round(canvas.clientWidth || canvas.width || 370));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const backing = Math.round(size * dpr);
  if (canvas.width !== backing || canvas.height !== backing) {
    canvas.width = backing;
    canvas.height = backing;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const isLight = isLightMode();
  const geo = computeOrbitGeometry(size);
  orbitGeometry = geo;

  ctx.fillStyle = isLight ? '#f8fafc' : '#05070a';
  ctx.fillRect(0, 0, size, size);
  if (!isLight) drawStarfield(ctx, size, size, 60);
  else drawLightGrid(ctx, size, size);

  geo.rings.forEach((ring) => drawOrbitRing(ctx, geo.cx, geo.cy, ring.radius, ring.tier.color));

  drawCenterSun(ctx, geo.cx, geo.cy, geo.sunRadius, currentUsername);

  orbitHitAreas = [];
  geo.rings.forEach((ring, ringIndex) => {
    const count = ring.users.length;
    if (!count) return;
    const step = (Math.PI * 2) / count;
    const offset = -Math.PI / 2 + ringIndex * (Math.PI / 9);
    ring.users.forEach((u, i) => {
      const angle = offset + i * step;
      const px = geo.cx + Math.cos(angle) * ring.radius;
      const py = geo.cy + Math.sin(angle) * ring.radius;
      drawOrbitPlanet(ctx, px, py, ring.diameter, ring.tier.color, u);
      orbitHitAreas.push({
        x: px, y: py, r: ring.diameter / 2 + 2, user: u, color: ring.tier.color
      });
    });
  });

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = isLight ? '#64748b' : '#71767b';
  if (geo.total === 0) {
    ctx.font = '11px sans-serif';
    ctx.fillText('Interact with accounts on a supported network to populate your orbit', geo.cx, size - 16);
  } else {
    const hidden = geo.rings.reduce((sum, ring) => sum + ring.hidden, 0);
    if (hidden > 0) {
      ctx.font = '10px sans-serif';
      ctx.fillText(`+${hidden} more in your CRM`, geo.cx, size - 8);
    }
  }

  bindOrbitHover(canvas);
  drawOrbitTooltip(ctx, size);
}

/** Rounded capsule used by score chips, tooltips and export cards. */
function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawOrbitPlanet(ctx, px, py, diameter, color, user, opts = {}) {
  const r = diameter / 2;
  const isLight = isLightMode();
  const showChip = opts.chip !== false;

  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, r + Math.max(1.5, r * 0.09), 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  const pfp = getLoadedPfp(user.avatarUrl, queueOrbitCanvasRender);
  if (pfp) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(pfp, px - r, py - r, r * 2, r * 2);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = isLight ? '#e2e8f0' : '#16181c';
    ctx.fill();
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.max(9, Math.round(r))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((user.displayName || user.handle || 'X').charAt(0).toUpperCase(), px, py);
  }

  if (showChip) {
    const label = String(Math.round(user.currentScore || 0));
    const fontSize = Math.max(6, Math.round(diameter * 0.36));
    ctx.font = `bold ${fontSize}px sans-serif`;
    const chipW = Math.max(fontSize + 5, ctx.measureText(label).width + 7);
    const chipH = fontSize + 4;
    const chipX = px + r * 0.7;
    const chipY = py + r * 0.7;
    roundRectPath(ctx, chipX - chipW / 2, chipY - chipH / 2, chipW, chipH, chipH / 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = isLight ? '#ffffff' : '#05070a';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, chipX, chipY + 0.5);
  }

  ctx.restore();
}

function bindOrbitHover(canvas) {
  if (canvas.dataset.orbitHoverBound === 'true') return;
  canvas.dataset.orbitHoverBound = 'true';

  const locate = (event) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return null;
    const scale = (orbitGeometry ? orbitGeometry.size : rect.width) / rect.width;
    const x = (event.clientX - rect.left) * scale;
    const y = (event.clientY - rect.top) * scale;
    return orbitHitAreas.find((a) => Math.hypot(a.x - x, a.y - y) <= a.r) || null;
  };

  canvas.addEventListener('mousemove', (event) => {
    if (!orbitHitAreas.length) return;
    const hit = locate(event);
    const handle = hit ? hit.user.handle : null;
    if (handle === orbitHoverHandle) return;
    orbitHoverHandle = handle;
    renderOrbitCanvas();
  });

  canvas.addEventListener('mouseleave', () => {
    if (orbitHoverHandle === null) return;
    orbitHoverHandle = null;
    renderOrbitCanvas();
  });
}

function drawOrbitTooltip(ctx, size) {
  if (!orbitHoverHandle) return;
  const hit = orbitHitAreas.find((a) => a.user.handle === orbitHoverHandle);
  if (!hit) return;
  const user = hit.user;

  ctx.save();
  ctx.beginPath();
  ctx.arc(hit.x, hit.y, hit.r + 3, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();

  const title = `@${user.handle}`;
  const tier = BondScoring.getTier(user.currentScore || 0);
  const subtitle = `${Math.round(user.currentScore || 0)} · ${tier.name}${user.streakDays > 1 ? ` · ${user.streakDays}d streak` : ''}`;

  ctx.font = 'bold 11px sans-serif';
  const titleW = ctx.measureText(title).width;
  ctx.font = '10px sans-serif';
  const subW = ctx.measureText(subtitle).width;

  const padX = 9;
  const boxW = Math.min(size - 12, Math.max(titleW, subW) + padX * 2);
  const boxH = 36;
  const boxX = Math.min(size - boxW - 6, Math.max(6, hit.x - boxW / 2));
  const above = hit.y > size / 2;
  const boxY = above ? hit.y - hit.r - boxH - 10 : hit.y + hit.r + 10;

  roundRectPath(ctx, boxX, boxY, boxW, boxH, 9);
  ctx.fillStyle = 'rgba(9, 14, 23, 0.94)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText(title, boxX + padX, boxY + 13);
  ctx.fillStyle = '#9aa4b2';
  ctx.font = '10px sans-serif';
  ctx.fillText(subtitle, boxX + padX, boxY + 26);
  ctx.restore();
}

function drawLightGrid(ctx, w, h) {
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
  for (let x = 15; x < w; x += 26) {
    for (let y = 15; y < h; y += 26) {
      ctx.fillRect(x, y, 1.5, 1.5);
    }
  }
  ctx.restore();
}

function drawStarfield(ctx, w, h, count) {
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < count; i++) {
    const x = (Math.sin(i * 997) * 0.5 + 0.5) * w;
    const y = (Math.cos(i * 613) * 0.5 + 0.5) * h;
    const size = (i % 3 === 0) ? 1.5 : 0.8;
    const alpha = 0.2 + (i % 5) * 0.15;
    ctx.globalAlpha = alpha;
    ctx.fillRect(x, y, size, size);
  }
  ctx.globalAlpha = 1.0;
}

function drawOrbitRing(ctx, cx, cy, radius, color) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.globalAlpha = isLightMode() ? 0.38 : 0.25;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.restore();
}

/** The gravity center is always you: your own avatar, ringed in gold. */
function drawCenterSun(ctx, cx, cy, radius, username) {
  const isLight = isLightMode();
  ctx.save();

  const glow = ctx.createRadialGradient(cx, cy, radius * 0.55, cx, cy, radius * 2.1);
  glow.addColorStop(0, 'rgba(255, 200, 0, 0.42)');
  glow.addColorStop(0.6, 'rgba(255, 122, 0, 0.16)');
  glow.addColorStop(1, 'rgba(255, 122, 0, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 2.1, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, radius + 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffc400';
  ctx.fill();

  const pfp = getLoadedPfp(currentAvatarUrl, queueOrbitCanvasRender);
  if (pfp) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(pfp, cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = isLight ? '#0f172a' : '#16181c';
    ctx.fill();
    ctx.fillStyle = '#ffc400';
    ctx.font = `bold ${Math.round(radius * 0.8)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const initial = (username && username !== 'you' ? username : 'you').charAt(0).toUpperCase();
    ctx.fillText(initial, cx, cy);
  }

  ctx.restore();
}

// Cache loaded avatar images for instant canvas rendering
const pfpCache = new Map();

function getLoadedPfp(url, onLoadedCallback) {
  if (!url) return null;
  let img = pfpCache.get(url);
  if (!img) {
    img = new Image();
    // Handlers must exist before src: an avatar can finish synchronously
    // (data URIs, cached bitmaps) and then onload would never fire.
    img.onload = () => {
      if (onLoadedCallback) onLoadedCallback();
    };
    img.onerror = () => { pfpCache.delete(url); };
    img.crossOrigin = 'anonymous';
    img.src = url;
    pfpCache.set(url, img);
  }
  const ready = img.complete && img.naturalWidth > 0;
  const size = img.width || img.naturalWidth || 0;
  return ready && size > 0 ? img : null;
}

/**
 * 📸 Export High-Res Orbit Graphic
 */
function setupOrbitExporter() {
  const btn = document.getElementById('orbit-download-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    btn.innerText = 'Exporting...';

    // Create 1000x1000 high-res offscreen canvas
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = 1000;
    exportCanvas.height = 1000;
    const ctx = exportCanvas.getContext('2d');

    const w = 1000;
    const h = 1000;
    const cx = 500;
    const cy = 520;

    // Rich Dark Cosmic Background
    const bgGrad = ctx.createRadialGradient(cx, cy, 100, cx, cy, 600);
    bgGrad.addColorStop(0, '#0d131f');
    bgGrad.addColorStop(1, '#020305');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Starfield
    drawStarfield(ctx, w, h, 200);

    // Header Title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🪐 X MUTUALS ORBIT', cx, 80);

    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#1d9bf0';
    ctx.fillText(`Gravitational center: @${currentUsername}`, cx, 115);

    // Radii scale with the population so nothing overlaps
    const ringsForExport = [
      { users: cachedUsers.filter(matchesPlatform).filter(u => (u.currentScore || 0) >= 70), radius: 150, d: 46, color: '#f91880' },
      { users: cachedUsers.filter(matchesPlatform).filter(u => (u.currentScore || 0) >= 35 && (u.currentScore || 0) < 70), radius: 265, d: 38, color: '#1d9bf0' },
      { users: cachedUsers.filter(matchesPlatform).filter(u => (u.currentScore || 0) > 0 && (u.currentScore || 0) < 35), radius: 375, d: 32, color: '#794bc4' }
    ];

    ringsForExport.forEach((ring) => {
      drawOrbitRing(ctx, cx, cy, ring.radius, ring.color);
      const slot = ring.d + 10;
      const fits = Math.max(1, Math.floor((Math.PI * 2 * ring.radius) / slot));
      const visible = ring.users.slice(0, fits);
      visible.forEach((u, i) => {
        const angle = -Math.PI / 2 + (i * (Math.PI * 2)) / visible.length;
        const px = cx + Math.cos(angle) * ring.radius;
        const py = cy + Math.sin(angle) * ring.radius;
        drawOrbitPlanet(ctx, px, py, ring.d, ring.color, u);
      });
    });

    // Sun: your own avatar at the gravity center
    ctx.save();
    const sunGrad = ctx.createRadialGradient(cx, cy, 20, cx, cy, 90);
    sunGrad.addColorStop(0, 'rgba(255, 200, 0, 0.45)');
    sunGrad.addColorStop(1, 'rgba(255, 122, 0, 0)');
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 90, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, 36, 0, Math.PI * 2);
    ctx.fillStyle = '#ffc400';
    ctx.fill();

    const selfPfp = getLoadedPfp(currentAvatarUrl);
    if (selfPfp) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 33, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(selfPfp, cx - 33, cy - 33, 66, 66);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, 33, 0, Math.PI * 2);
      ctx.fillStyle = '#16181c';
      ctx.fill();
      ctx.fillStyle = '#ffc400';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(currentUsername.charAt(0).toUpperCase(), cx, cy);
    }
    ctx.restore();

    // Watermark & Creator Credit
    ctx.fillStyle = '#71767b';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`BondScore • Created by @MaserSuspended • ${new Date().toLocaleDateString()}`, cx, 960);

    // Download PNG
    const link = document.createElement('a');
    link.download = `x_mutuals_orbit_${currentUsername}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    setTimeout(() => link.remove(), 100);

    btn.innerText = '✓ Downloaded!';
    setTimeout(() => {
      btn.innerText = '📸 Share Image';
    }, 2000);
  });
}

function renderHighResPlanets(ctx, users, cx, cy, radius, color) {
  // Superseded by drawOrbitPlanet + capacity-aware rings.
  if (!users || users.length === 0) return;
  const slot = 42;
  const fits = Math.max(1, Math.floor((Math.PI * 2 * radius) / slot));
  users.slice(0, fits).forEach((u, i) => {
    const angle = -Math.PI / 2 + (i * (Math.PI * 2)) / Math.min(users.length, fits);
    drawOrbitPlanet(
      ctx,
      cx + Math.cos(angle) * radius,
      cy + Math.sin(angle) * radius,
      34,
      color,
      u
    );
  });
}

/**
 * 🌐 Platform master + granular sub-toggle controls.
 * Every change persists immediately so scripts start/stop on the next page load.
 */
function setupPlatformToggles(settings) {
  const config = BondPlatforms.getConfig(settings);

  const paint = (id) => {
    const cfg = BondPlatforms.getConfig(window.bondStorage.settingsCache || settings)[id];
    const card = document.querySelector(`[data-platform-card="${id}"]`);
    const subs = document.querySelector(`[data-platform-subs="${id}"]`);
    if (card) card.classList.toggle('is-off', !cfg.enabled);
    if (subs) {
      subs.querySelectorAll('input').forEach((input) => { input.disabled = !cfg.enabled; });
    }
  };

  ['x', 'threads', 'bluesky'].forEach((id) => {
    const master = document.getElementById(`platform-${id}-enabled`);
    const timeline = document.getElementById(`platform-${id}-timeline`);
    const dms = document.getElementById(`platform-${id}-dms`);

    if (master) master.checked = config[id].enabled;
    if (timeline) timeline.checked = config[id].timeline;
    if (dms) dms.checked = config[id].dms;
    paint(id);

    const persist = async (patch) => {
      const current = await window.bondStorage.getSettings();
      const next = BondPlatforms.patchSettings(current, id, patch);
      await window.bondStorage.updateSettings(next);
      paint(id);
    };

    const quick = document.getElementById(`quick-platform-${id}`);
    if (quick) {
      quick.checked = config[id].enabled;
      if (!quick.dataset.bound) {
        quick.dataset.bound = 'true';
        quick.addEventListener('change', () => {
          if (master) master.checked = quick.checked;
          const subContainer = document.querySelector(`[data-platform-subs="${id}"]`);
          if (subContainer) subContainer.querySelectorAll('input').forEach((input) => { input.disabled = !quick.checked; });
          persist({ enabled: quick.checked });
        });
      }
    }

    if (master && !master.dataset.bound) {
      master.dataset.bound = 'true';
      master.addEventListener('change', () => {
        if (quick) quick.checked = master.checked;
        persist({ enabled: master.checked });
      });
    }
    if (timeline && !timeline.dataset.bound) {
      timeline.dataset.bound = 'true';
      timeline.addEventListener('change', () => persist({ timeline: timeline.checked }));
    }
    if (dms && !dms.dataset.bound) {
      dms.dataset.bound = 'true';
      dms.addEventListener('change', () => persist({ dms: dms.checked }));
    }
  });
}

/**
 * ⚙️ Settings Form Handler
 */
async function loadSettingsForm() {
  const settings = await window.bondStorage.getSettings();
  setupPlatformToggles(settings);

  const halfLifeInput = document.getElementById('decay-halflife');
  const halfLifeVal = document.getElementById('decay-halflife-val');
  const graceInput = document.getElementById('grace-period');
  const graceVal = document.getElementById('grace-period-val');
  const weightMutualInput = document.getElementById('weight-mutual');
  const weightMutualVal = document.getElementById('weight-mutual-val');
  const weightReplyInput = document.getElementById('weight-reply');
  const weightReplyVal = document.getElementById('weight-reply-val');
  const weightLikeInput = document.getElementById('weight-like');
  const weightLikeVal = document.getElementById('weight-like-val');
  const groupInputs = {
    windowHours: document.getElementById('group-window-hours'),
    activeMin: document.getElementById('group-active-min'),
    energeticMin: document.getElementById('group-energetic-min'),
    hyperactiveWindowHours: document.getElementById('group-hyper-window'),
    hyperactiveMin: document.getElementById('group-hyper-min')
  };
  const groupVals = {
    windowHours: document.getElementById('group-window-hours-val'),
    activeMin: document.getElementById('group-active-min-val'),
    energeticMin: document.getElementById('group-energetic-min-val'),
    hyperactiveWindowHours: document.getElementById('group-hyper-window-val'),
    hyperactiveMin: document.getElementById('group-hyper-min-val')
  };

  halfLifeInput.value = settings.decayHalfLifeDays || 14;
  halfLifeVal.innerText = `${halfLifeInput.value} days`;

  graceInput.value = settings.gracePeriodDays ?? 5;
  graceVal.innerText = `${graceInput.value} days`;

  const weights = settings.weights || {};
  weightMutualInput.value = weights.mutualReply || 15;
  weightMutualVal.innerText = `${weightMutualInput.value} pts`;

  weightReplyInput.value = weights.replySent || 8;
  weightReplyVal.innerText = `${weightReplyInput.value} pts`;

  weightLikeInput.value = weights.like || 2;
  weightLikeVal.innerText = `${weightLikeInput.value} pts`;

  const groupCfg = settings.groupActivity || {};
  const groupDefaults = { windowHours: 20, activeMin: 21, energeticMin: 50, hyperactiveWindowHours: 1, hyperactiveMin: 99 };
  Object.keys(groupInputs).forEach((key) => {
    const input = groupInputs[key];
    const val = groupVals[key];
    if (!input || !val) return;
    input.value = groupCfg[key] !== undefined ? groupCfg[key] : groupDefaults[key];
    val.innerText = key.includes('Window') || key === 'windowHours'
      ? `${input.value} hour${input.value === '1' ? '' : 's'}`
      : String(input.value);
    input.addEventListener('input', () => {
      val.innerText = key.includes('Window') || key === 'windowHours'
        ? `${input.value} hour${input.value === '1' ? '' : 's'}`
        : String(input.value);
    });
  });

  halfLifeInput.addEventListener('input', () => halfLifeVal.innerText = `${halfLifeInput.value} days`);
  graceInput.addEventListener('input', () => graceVal.innerText = `${graceInput.value} days`);
  weightMutualInput.addEventListener('input', () => weightMutualVal.innerText = `${weightMutualInput.value} pts`);
  weightReplyInput.addEventListener('input', () => weightReplyVal.innerText = `${weightReplyInput.value} pts`);
  weightLikeInput.addEventListener('input', () => weightLikeVal.innerText = `${weightLikeInput.value} pts`);

  // Direct Messages & Privacy Controls
  const trackDmsInput = document.getElementById('setting-track-dms');
  const fadingInput = document.getElementById('setting-fading-threshold');
  const fadingVal = document.getElementById('setting-fading-val');
  const dmWeightInput = document.getElementById('setting-dm-weight');
  const dmWeightVal = document.getElementById('setting-dm-weight-val');

  if (trackDmsInput) trackDmsInput.checked = settings.trackDirectMessages !== false;
  if (fadingInput && fadingVal) {
    fadingInput.value = settings.fadingThresholdDays ?? 3;
    fadingVal.innerText = `${fadingInput.value} days`;
    fadingInput.addEventListener('input', () => fadingVal.innerText = `${fadingInput.value} days`);
  }
  if (dmWeightInput && dmWeightVal) {
    dmWeightInput.value = settings.dmScoreWeightPercent ?? 50;
    dmWeightVal.innerText = `${dmWeightInput.value}%`;
    dmWeightInput.addEventListener('input', () => dmWeightVal.innerText = `${dmWeightInput.value}%`);
  }

  // Wire up theme segmented buttons in Settings tab
  const segBtns = document.querySelectorAll('.theme-seg-btn');
  segBtns.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const themeVal = btn.getAttribute('data-theme');
      await setThemeAndSave(themeVal);
    });
  });

  const saveBtn = document.getElementById('save-settings-btn');
  saveBtn.addEventListener('click', async () => {
    saveBtn.innerText = 'Saving...';
    const current = await window.bondStorage.getSettings();
    await window.bondStorage.updateSettings({
      theme: currentTheme,
      decayHalfLifeDays: parseInt(halfLifeInput.value, 10),
      gracePeriodDays: parseInt(graceInput.value, 10),
      trackDirectMessages: trackDmsInput ? trackDmsInput.checked : true,
      fadingThresholdDays: fadingInput ? parseInt(fadingInput.value, 10) : 3,
      dmScoreWeightPercent: dmWeightInput ? parseInt(dmWeightInput.value, 10) : 50,
      weights: {
        ...(current.weights || {}),
        mutualReply: parseInt(weightMutualInput.value, 10),
        replySent: parseInt(weightReplyInput.value, 10),
        replyReceived: parseInt(weightReplyInput.value, 10),
        like: parseInt(weightLikeInput.value, 10)
      },
      groupActivity: {
        windowHours: groupInputs.windowHours ? parseInt(groupInputs.windowHours.value, 10) : 20,
        activeMin: groupInputs.activeMin ? parseInt(groupInputs.activeMin.value, 10) : 21,
        energeticMin: groupInputs.energeticMin ? parseInt(groupInputs.energeticMin.value, 10) : 50,
        hyperactiveWindowHours: groupInputs.hyperactiveWindowHours ? parseInt(groupInputs.hyperactiveWindowHours.value, 10) : 1,
        hyperactiveMin: groupInputs.hyperactiveMin ? parseInt(groupInputs.hyperactiveMin.value, 10) : 99
      }
    });
    saveBtn.innerText = '✓ Preferences Saved';
    setTimeout(() => {
      saveBtn.innerText = 'Save Preferences';
    }, 1500);
  });
}

// One delegated listener for all "open profile" cards. Inline onclick handlers
// are blocked by the extension page CSP and show up as errors.
if (!window.__bondProfileOpenBound) {
  window.__bondProfileOpenBound = true;
  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest
      ? event.target.closest('[data-open-url]')
      : null;
    if (!target) return;
    const url = target.getAttribute('data-open-url');
    if (url && chrome.tabs) chrome.tabs.create({ url });
  });
}

/**
 * 🧠 Render Local Engagement Memory, Balance, Supporters & Dormant Bonds
 */
function renderRadarTab() {
  const streaksList = document.getElementById('streaks-list');
  const supportersList = document.getElementById('supporters-list');
  const outboundList = document.getElementById('outbound-focus-list');
  const dormantList = document.getElementById('dormant-list');

  // Compute local engagement memory metrics
  const memory = BondScoring.analyzeEngagementMemory(cachedUsers.filter(matchesPlatform));

  // Update Global Balance Card
  const badgeEl = document.getElementById('eng-balance-badge');
  const barSent = document.getElementById('eng-bar-sent');
  const barRecv = document.getElementById('eng-bar-recv');
  const outVal = document.getElementById('eng-outbound-val');
  const outPct = document.getElementById('eng-outbound-pct');
  const inVal = document.getElementById('eng-inbound-val');
  const inPct = document.getElementById('eng-inbound-pct');
  const descEl = document.getElementById('eng-balance-desc');

  if (badgeEl) badgeEl.innerText = memory.balanceLabel;
  if (barSent) barSent.style.width = `${memory.globalSentRatio}%`;
  if (barRecv) barRecv.style.width = `${memory.globalRecvRatio}%`;
  if (outVal) outVal.innerText = memory.totalSent;
  if (outPct) outPct.innerText = `${memory.globalSentRatio}%`;
  if (inVal) inVal.innerText = memory.totalReceived;
  if (inPct) inPct.innerText = `${memory.globalRecvRatio}%`;
  if (descEl) descEl.innerText = memory.balanceDesc;

  // 1. Supporters List (Who engages with you most)
  if (supportersList) {
    const topSupporters = memory.supporters.slice(0, 5);
    if (topSupporters.length > 0) {
      supportersList.innerHTML = topSupporters.map(u => {
        const crm = getCRMStatusForUser(u);
        return `
          <div class="radar-item" style="cursor:pointer;" title="Click to view @${escapeHtml(u.handle)}">
            <div class="radar-item-left" data-open-url="${escapeHtml(BondPlatforms.profileUrl(u.platform || 'x', u.handle))}">
              ${u.avatarUrl ? `<img class="radar-item-avatar" src="${escapeHtml(u.avatarUrl)}" alt="">` : `<div class="radar-item-avatar" style="background:#ec4899;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${escapeHtml(u.handle.charAt(0).toUpperCase())}</div>`}
              <span class="radar-item-handle">@${escapeHtml(u.handle)}</span>
              <span class="popup-crm-pill ${crm.id}">${crm.label}</span>
            </div>
            <span class="radar-supporter-val">📥 ${u.received} received</span>
          </div>
        `;
      }).join('');
    } else {
      supportersList.innerHTML = `<div class="radar-empty">No supporter data yet. Interact on a connected platform to build memory!</div>`;
    }
  }

  // 2. Outbound Focus (Who you engage with most)
  if (outboundList) {
    const topOutbound = memory.topEngagedByYou.slice(0, 5);
    if (topOutbound.length > 0) {
      outboundList.innerHTML = topOutbound.map(u => `
        <div class="radar-item" style="cursor:pointer;" title="Click to view @${escapeHtml(u.handle)}">
          <div class="radar-item-left" data-open-url="${escapeHtml(BondPlatforms.profileUrl(u.platform || 'x', u.handle))}">
            ${u.avatarUrl ? `<img class="radar-item-avatar" src="${escapeHtml(u.avatarUrl)}" alt="">` : `<div class="radar-item-avatar" style="background:#1d9bf0;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${escapeHtml(u.handle.charAt(0).toUpperCase())}</div>`}
            <span class="radar-item-handle">@${escapeHtml(u.handle)}</span>
          </div>
          <span class="radar-outbound-val">📤 ${u.sent} sent</span>
        </div>
      `).join('');
    } else {
      outboundList.innerHTML = `<div class="radar-empty">No outbound data yet.</div>`;
    }
  }

  // 3. Dormant People (No interactions in 14+ days)
  if (dormantList) {
    const topDormant = memory.dormantPeople.slice(0, 5);
    if (topDormant.length > 0) {
      dormantList.innerHTML = topDormant.map(u => `
        <div class="radar-item">
          <div class="radar-item-left">
            ${u.avatarUrl ? `<img class="radar-item-avatar" src="${escapeHtml(u.avatarUrl)}" alt="">` : `<div class="radar-item-avatar" style="background:#71767b;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${escapeHtml(u.handle.charAt(0).toUpperCase())}</div>`}
            <span class="radar-item-handle">@${escapeHtml(u.handle)}</span>
            <span style="font-size:9px;color:#71767b;">(${Math.round(u.currentScore || 0)} pts)</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:10px;color:#71767b;">❄️ ${u.daysSince}d ago</span>
            <button class="re-engage-btn" data-handle="${escapeHtml(u.handle)}">Say Hi &rarr;</button>
          </div>
        </div>
      `).join('');

      // Wire up re-engage buttons
      dormantList.querySelectorAll('.re-engage-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          chrome.tabs.create({ url: `https://x.com/${btn.dataset.handle}` });
        });
      });
    } else {
      dormantList.innerHTML = `<div class="radar-empty">All tracked bonds are fresh and active!</div>`;
    }
  }

  // 4. Relationship Signals (Follow-backs, Unfollows, Blocks)
  const signalsRadarList = document.getElementById('signals-radar-list');
  if (signalsRadarList) {
    const signalUsers = cachedUsers.filter(matchesPlatform).filter(u => u.signals && (u.signals.isBlocked || u.signals.isMutual || u.signals.theyFollowYou !== null)).slice(0, 6);
    if (signalUsers.length > 0) {
      signalsRadarList.innerHTML = signalUsers.map(u => {
        const fRel = typeof BondScoring !== 'undefined' && BondScoring.getFollowRelationship
          ? BondScoring.getFollowRelationship(u.signals)
          : null;
        let label = fRel ? fRel.badgeText : '🤝 Mutual Follow';
        let color = fRel ? fRel.color : '#00ba7c';
        return `
          <div class="radar-item" style="cursor:pointer;" title="Click to view @${escapeHtml(u.handle)}" data-open-url="${escapeHtml(BondPlatforms.profileUrl(u.platform || 'x', u.handle))}">
            <div class="radar-item-left">
              ${u.avatarUrl ? `<img class="radar-item-avatar" src="${escapeHtml(u.avatarUrl)}" alt="">` : `<div class="radar-item-avatar" style="background:#1d9bf0;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${escapeHtml(u.handle.charAt(0).toUpperCase())}</div>`}
              <span class="radar-item-handle">@${escapeHtml(u.handle)}</span>
            </div>
            <span style="font-size:10px;font-weight:700;color:${color};">${label}</span>
          </div>
        `;
      }).join('');
    } else {
      signalsRadarList.innerHTML = `<div class="radar-empty">No relationship signals detected yet. Visit profiles on a connected platform to observe!</div>`;
    }
  }

  // 5. Active streaks
  if (streaksList) {
    const streakUsers = cachedUsers.filter(matchesPlatform).filter(u => (u.streakDays || 0) > 0).sort((a, b) => (b.streakDays || 0) - (a.streakDays || 0));
    if (streakUsers.length > 0) {
      streaksList.innerHTML = streakUsers.map(u => `
        <div class="radar-item">
          <div class="radar-item-left">
            ${u.avatarUrl ? `<img class="radar-item-avatar" src="${escapeHtml(u.avatarUrl)}" alt="">` : `<div class="radar-item-avatar" style="background:#1d9bf0;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${escapeHtml(u.handle.charAt(0).toUpperCase())}</div>`}
            <span class="radar-item-handle">@${escapeHtml(u.handle)}</span>
          </div>
          <span class="radar-streak-val">🔥 ${u.streakDays} Day Streak</span>
        </div>
      `).join('');
    } else {
      streaksList.innerHTML = `<div class="radar-empty">No active reply streaks yet. Chat daily with mutuals to ignite streaks!</div>`;
    }
  }

  // 5. Quick deep scanner button
  const deepBtn = document.getElementById('quick-deep-btn');
  const deepInput = document.getElementById('quick-deep-input');
  const deepStatus = document.getElementById('quick-deep-status');

  if (deepBtn && !deepBtn.dataset.bound) {
    deepBtn.dataset.bound = 'true';
    deepBtn.addEventListener('click', async () => {
      const handle = (deepInput.value || '').trim().replace(/^@/, '').toLowerCase();
      if (!handle) return;

      deepBtn.disabled = true;
      deepBtn.innerText = 'Analyzing...';
      deepStatus.style.display = 'block';
      deepStatus.innerText = 'Scanning conversation history...';

      try {
        const currentUser = await window.bondStorage.getCurrentUser() || 'user';
        await window.deepAnalyzer.runAnalysis(currentUser, handle, ({ percent, stage, itemsFound }) => {
          deepStatus.innerText = `${stage} (${itemsFound || 0} found)`;
        });
        deepStatus.innerText = '✓ Analysis complete! Scores updated.';
        deepBtn.innerText = '✓ Done';
        await loadLeaderboard();
        renderRadarTab();
        renderOrbitCanvas();
        setTimeout(() => {
          deepBtn.disabled = false;
          deepBtn.innerText = '⚡ Analyze';
        }, 2000);
      } catch (err) {
        deepStatus.innerText = 'Analysis failed. Make sure you are logged in to X.';
        deepBtn.disabled = false;
        deepBtn.innerText = '⚡ Analyze';
      }
    });
  }
}

/**
 * Sets up the Two-Handle Interaction Lookup component
 */
function setupTwoHandleLookup() {
  const btnSearch = document.getElementById('btn-two-handle-search');
  const btnOpen = document.getElementById('btn-two-handle-open');
  const inputA = document.getElementById('two-handle-a');
  const inputB = document.getElementById('two-handle-b');
  const statusEl = document.getElementById('two-handle-status');
  const resultsEl = document.getElementById('two-handle-results');

  if (!btnSearch || btnSearch.dataset.bound) return;
  btnSearch.dataset.bound = 'true';

  let currentSearchUrl = '';

  btnSearch.addEventListener('click', async () => {
    const handleA = (inputA.value || '').trim().replace(/^@/, '');
    const handleB = (inputB.value || '').trim().replace(/^@/, '');

    if (!handleA || !handleB) {
      statusEl.style.display = 'block';
      statusEl.innerHTML = '<span style="color:#f4212e;">⚠️ Please enter both handles.</span>';
      return;
    }

    if (handleA.toLowerCase() === handleB.toLowerCase()) {
      statusEl.style.display = 'block';
      statusEl.innerHTML = '<span style="color:#f4212e;">⚠️ Please enter two different handles.</span>';
      return;
    }

    btnSearch.disabled = true;
    btnSearch.innerText = 'Searching...';
    btnOpen.style.display = 'none';
    statusEl.style.display = 'block';
    statusEl.innerText = `Searching tweets between @${handleA} and @${handleB}...`;
    resultsEl.style.display = 'none';
    resultsEl.innerHTML = '';

    try {
      const res = await window.deepAnalyzer.lookupInteraction(handleA, handleB, ({ stage }) => {
        statusEl.innerText = stage;
      });

      currentSearchUrl = res.searchUrl;
      btnOpen.style.display = 'inline-block';

      if (res.hasInteracted) {
        statusEl.innerHTML = `<span style="color:#00ba7c;font-weight:700;">✓ Found ${res.totalCount} tweet interaction${res.totalCount > 1 ? 's' : ''}!</span>`;
        resultsEl.style.display = 'flex';
        resultsEl.innerHTML = `
          <div class="two-handle-summary">
            <span>@${escapeHtml(res.handleA)}: ${res.countAtoB}</span>
            <span>•</span>
            <span>@${escapeHtml(res.handleB)}: ${res.countBtoA}</span>
            ${res.lastInteraction ? `<span class="two-handle-last-time">Last: ${BondScoring.formatTimeAgo(res.lastInteraction)}</span>` : ''}
          </div>
          <div class="two-handle-tweets-list">
            ${res.events.slice(0, 5).map(e => `
              <div class="two-handle-tweet-item">
                <span class="two-handle-tweet-type">${e.type === 'reply_sent' ? `@${escapeHtml(res.handleA)} 💬` : e.type === 'quote' ? '🔁 Quote' : '💬 Tweet'}</span>
                <span class="two-handle-tweet-text">${escapeHtml(e.textSnippet || 'Tweet interaction')}</span>
                <span class="two-handle-tweet-time">${BondScoring.formatTimeAgo(e.timestamp)}</span>
              </div>
            `).join('')}
          </div>
        `;
      } else {
        statusEl.innerHTML = `<span style="color:#71767b;">❄️ No tweet interactions found between @${escapeHtml(res.handleA)} and @${escapeHtml(res.handleB)}.</span>`;
        resultsEl.style.display = 'flex';
        resultsEl.innerHTML = `
          <div class="two-handle-empty-hint">
            No public tweet replies found in archives. Click "Open Live on X" to run a live real-time query on X.
          </div>
        `;
      }
    } catch (err) {
      statusEl.innerHTML = `<span style="color:#f4212e;">Error: ${escapeHtml(err.message || 'Lookup failed')}</span>`;
    } finally {
      btnSearch.disabled = false;
      btnSearch.innerText = '⚡ Check Tweets';
    }
  });

  btnOpen.addEventListener('click', () => {
    if (currentSearchUrl) {
      chrome.tabs.create({ url: currentSearchUrl });
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ==========================================================================
   💬 Direct Messages & Group Chats Dashboard Logic (v1.2)
   ========================================================================== */

let cachedDms = [];
let currentDmFilter = 'all';

function setupDmFilterPills() {
  const pills = document.querySelectorAll('#dm-filter-pills .filter-pill');
  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentDmFilter = pill.dataset.dmFilter || 'all';
      renderDmSubSections(cachedDms.filter(matchesPlatform), currentDmFilter);
    });
  });
}

function setupDmSearchHandler() {
  const searchInput = document.getElementById('dm-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderDmSubSections(cachedDms.filter(matchesPlatform), currentDmFilter);
    });
  }
}

/**
 * 💬 Render DMs & Group Chats Analytics and Relationship System
 */
async function renderDmsTab() {
  const activeAcc = (currentUsername && currentUsername !== 'you') ? currentUsername : null;
  const allDms = await window.bondStorage.getAllDmConversations(activeAcc);
  cachedDms = allDms;
  const scopedDms = allDms.filter(matchesPlatform);

  const total = scopedDms.length;

  const allReplyTimes = [];
  let streakSum = 0;
  scopedDms.forEach(d => {
    if (d.medianReplyTimeMs > 0) allReplyTimes.push(d.medianReplyTimeMs);
    if (d.dailyStreak > 1) streakSum++;
  });

  let avgSpeedText = '-';
  if (allReplyTimes.length > 0) {
    const avgMs = Math.round(allReplyTimes.reduce((a, b) => a + b, 0) / allReplyTimes.length);
    avgSpeedText = BondScoring.formatDuration ? BondScoring.formatDuration(avgMs) : `${Math.round(avgMs / 60000)}m`;
  }

  const statTotal = document.getElementById('dm-stat-total');
  const statSpeed = document.getElementById('dm-stat-speed');
  const statStreaks = document.getElementById('dm-stat-streaks');

  if (statTotal) statTotal.innerText = total;
  if (statSpeed) statSpeed.innerText = avgSpeedText;
  if (statStreaks) statStreaks.innerText = streakSum;

  renderDmSubSections(scopedDms, currentDmFilter);
}

function renderDmSubSections(allDms, filter = 'all') {
  const searchInput = document.getElementById('dm-search-input');
  const query = (searchInput ? searchInput.value : '').toLowerCase().trim();

  let filtered = allDms;
  if (query) {
    filtered = filtered.filter(d => {
      const title = (d.title || '').toLowerCase();
      const id = (d.convId || '').toLowerCase();
      const parts = Array.isArray(d.participants) ? d.participants.join(' ').toLowerCase() : '';
      return title.includes(query) || id.includes(query) || parts.includes(query);
    });
  }

  // Who Should I Message? (Anti-Fading Smart List)
  const sectionCold = document.getElementById('dm-section-cold');
  const listCold = document.getElementById('dm-cold-list');
  const countCold = document.getElementById('dm-cold-count');
  const coldItems = filtered.filter(d => !d.isGroup && (d.isCoolingCandidate === true || d.isFading === true));

  if (countCold) countCold.innerText = coldItems.length;
  if (sectionCold && listCold) {
    const showCold = filter === 'cold' || (filter === 'all' && coldItems.length > 0);
    sectionCold.style.display = showCold ? 'block' : 'none';

    if (coldItems.length === 0) {
      listCold.innerHTML = '<div class="dm-empty-state">🔥 All high-bond relationships are warm and active!</div>';
    } else {
      listCold.innerHTML = coldItems.map(d => {
        const title = d.title || (d.participants && d.participants[0]) || d.convId;
        const details = d.participantDetails && d.participants && d.participantDetails[d.participants[0]];
        const avatar = details ? details.avatarUrl : '';
        const rank = d.rank || BondScoring.getDmRank(d.bondScore || 0);
        const days = d.daysSinceLast || Math.floor((Date.now() - (d.lastMessageTimestamp || Date.now())) / 86400000);

        return `
          <div class="dm-action-row cold-row" data-conv="${escapeHtml(d.convId)}">
            <div class="dm-action-avatar">
              ${avatar ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(title)}">` : `<div class="dm-avatar-fallback">${escapeHtml(title.charAt(0).toUpperCase())}</div>`}
            </div>
            <div class="dm-action-meta">
              <div class="dm-action-title-row">
                <span class="dm-action-title">${escapeHtml(title)}</span>
                ${platformChip(d)}
                <span class="bond-rank-tag bond-rank-${rank.id}">${rank.emoji} ${rank.name}</span>
              </div>
              <div class="dm-action-sub">
                <span class="dm-cold-tag">🧊 Quiet for ${days} days</span>
                <span>• Was Bond ${Math.round(d.bondScore || 0)}</span>
              </div>
            </div>
            <button class="dm-reconnect-btn" data-url="${messageUrl(d)}">Say Hi ↗</button>
          </div>
        `;
      }).join('');
    }
  }

  // 3. Closest Friends (1:1 Leaderboard)
  const sectionClosest = document.getElementById('dm-section-closest');
  const listClosest = document.getElementById('dm-closest-list');
  const countClosest = document.getElementById('dm-closest-count');
  let closestItems = filtered.filter(d => !d.isGroup && (d.bondScore || 0) > 0);
  if (filter === 'streaks') closestItems = closestItems.filter(d => (d.dailyStreak || 0) > 1);
  closestItems.sort((a, b) => (b.bondScore || 0) - (a.bondScore || 0));

  if (countClosest) countClosest.innerText = closestItems.length;
  if (sectionClosest && listClosest) {
    const showClosest = filter !== 'groups' && filter !== 'cold';
    sectionClosest.style.display = showClosest ? 'block' : 'none';

    if (closestItems.length === 0) {
      listClosest.innerHTML = '<div class="dm-empty-state">No direct messages tracked yet. Chat on a connected platform to build your private bond scores!</div>';
    } else {
      listClosest.innerHTML = closestItems.map((d, idx) => {
        const title = d.title || (d.participants && d.participants[0]) || d.convId;
        const details = d.participantDetails && d.participants && d.participantDetails[d.participants[0]];
        const avatar = details ? details.avatarUrl : '';
        const rank = d.rank || BondScoring.getDmRank(d.bondScore || 0);
        const score = Math.round(d.bondScore || 0);
        const sentPct = d.sentPercent ?? (d.totalCount > 0 ? Math.round((d.sentCount / d.totalCount) * 100) : 50);
        const recvPct = 100 - sentPct;

        return `
          <div class="dm-closest-card" data-conv="${escapeHtml(d.convId)}">
            <div class="dm-closest-top">
              <div class="dm-closest-user">
                <span class="dm-closest-rank-num">#${idx + 1}</span>
                <div class="dm-action-avatar">
                  ${avatar ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(title)}">` : `<div class="dm-avatar-fallback">${escapeHtml(title.charAt(0).toUpperCase())}</div>`}
                </div>
                <div class="dm-closest-names">
                  <div class="dm-closest-name-row">
                    <strong class="dm-closest-name">${escapeHtml(title)}</strong>
                    ${platformChip(d)}
                    <span class="bond-rank-tag bond-rank-${rank.id}">${rank.emoji} ${rank.name}</span>
                  </div>
                  <div class="dm-closest-metrics-row">
                    <span>⚡ ${d.formattedMedianReply || 'fast'}</span>
                    ${d.dailyStreak > 1 ? `<span class="dm-streak-chip">🔥 ${d.dailyStreak}d</span>` : ''}
                    <span>📬 ${d.replyRate ?? 100}% reply</span>
                  </div>
                </div>
              </div>
              <div class="dm-closest-score-badge" style="color: ${rank.color}; border: 1px solid ${rank.color}40; background: ${rank.bg}">
                <span>${score}</span>
              </div>
            </div>

            <!-- Balance Bar -->
            <div class="dm-card-balance-wrap">
              <div class="dm-card-balance-sent" style="width: ${sentPct}%;"></div>
              <div class="dm-card-balance-recv" style="width: ${recvPct}%;"></div>
            </div>
            <div class="dm-card-balance-labels">
              <span>You: ${d.sentCount || 0} (${sentPct}%)</span>
              <button class="dm-open-btn" data-url="${messageUrl(d)}">Open ↗</button>
              <span>Them: ${d.receivedCount || 0} (${recvPct}%)</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 4. Group Chats
  const sectionGroups = document.getElementById('dm-section-groups');
  const listGroups = document.getElementById('dm-groups-list');
  const countGroups = document.getElementById('dm-groups-count');
  const groupItems = filtered.filter(d => d.isGroup === true);
  groupItems.sort((a, b) => (b.groupEnergyScore || 0) - (a.groupEnergyScore || 0));

  if (countGroups) countGroups.innerText = groupItems.length;
  if (sectionGroups && listGroups) {
    const showGroups = filter === 'groups' || (filter === 'all' && groupItems.length > 0);
    sectionGroups.style.display = showGroups ? 'block' : 'none';

    if (groupItems.length === 0) {
      listGroups.innerHTML = '<div class="dm-empty-state">No group chats detected yet. Participate in group conversations on a connected platform to observe group energy!</div>';
    } else {
      listGroups.innerHTML = groupItems.map(d => {
        const energyLevel = d.groupEnergyLevel || BondScoring.getGroupEnergyLevel(d.groupEnergyScore || 0);
        const score = Math.round(d.groupEnergyScore || 0);
        const activeMembers = (d.energyMetrics && d.energyMetrics.activeMembers) || [];

        return `
          <div class="dm-group-card" data-conv="${escapeHtml(d.convId)}">
            <div class="dm-group-header">
              <div class="dm-group-info">
                <span class="dm-group-icon">👥</span>
                <div>
                  <strong class="dm-group-title">${escapeHtml(d.title || 'Group Chat')}</strong>
                  ${platformChip(d, 'dm-group-platform')}
                  <div class="dm-group-sub">${activeMembers.length || (d.participants ? d.participants.length : 1)} active participants</div>
                </div>
              </div>
              <div class="bond-energy-tag bond-energy-${energyLevel.id}">
                ${energyLevel.emoji} ${energyLevel.name} ${score}
              </div>
            </div>

            <!-- Active Member Chips -->
            <div class="dm-group-chips">
              ${activeMembers.slice(0, 4).map(m => `
                <span class="dm-member-chip">@${escapeHtml(m.handle)} (${m.share}%)</span>
              `).join('')}
            </div>

            <div class="dm-group-footer">
              <span class="dm-group-activity">${d.isDying ? '⚠️ Group is quiet / dormant' : `🔥 ${d.totalMessages || 0} messages recorded`}</span>
              <button class="dm-open-btn" data-url="${messageUrl(d)}">Open Group ↗</button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 5. Chat Memories & Milestones (Lifetime Log)
  const sectionMemories = document.getElementById('dm-section-memories');
  const listMemories = document.getElementById('dm-memories-list');
  const countMemories = document.getElementById('dm-memories-count');

  const allMilestones = [];
  filtered.forEach(d => {
    if (Array.isArray(d.memories)) {
      d.memories.forEach(m => {
        allMilestones.push({
          ...m,
          convId: d.convId,
          convTitle: d.title || (d.participants && d.participants[0]) || d.convId
        });
      });
    }
  });
  allMilestones.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const topLifetime = [...filtered].sort((a, b) => (b.lifetimeTotal || b.totalCount || 0) - (a.lifetimeTotal || a.totalCount || 0));

  if (countMemories) countMemories.innerText = allMilestones.length || topLifetime.filter(d => (d.lifetimeTotal || d.totalCount) > 0).length;

  if (sectionMemories && listMemories) {
    const showMemories = filter === 'memories' || (filter === 'all' && (topLifetime.length > 0 || allMilestones.length > 0));
    sectionMemories.style.display = showMemories ? 'block' : 'none';

    if (topLifetime.length === 0 && allMilestones.length === 0) {
      listMemories.innerHTML = '<div class="dm-empty-state">💭 No chat memories recorded yet. Chat on a connected platform to build your permanent memory ledger!</div>';
    } else {
      let html = '';

      // Top Lifetime Chats
      if (topLifetime.length > 0 && (topLifetime[0].lifetimeTotal || topLifetime[0].totalCount || 0) > 0) {
        html += `
          <div class="dm-memory-subhead">🌟 All-Time Chat Champions (Lifetime Volume)</div>
          <div class="dm-champions-grid">
            ${topLifetime.slice(0, 3).map((d) => {
              const title = d.title || (d.participants && d.participants[0]) || d.convId;
              const details = d.participantDetails && d.participants && d.participantDetails[d.participants[0]];
              const avatar = details ? details.avatarUrl : '';
              const rank = d.rank || BondScoring.getDmRank(d.bondScore || 0);
              const lifetime = d.lifetimeTotal || d.totalCount || 0;
              return `
                <div class="dm-champion-card" data-conv="${escapeHtml(d.convId)}">
                  <div class="dm-action-avatar">
                    ${avatar ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(title)}">` : `<div class="dm-avatar-fallback">${escapeHtml(title.charAt(0).toUpperCase())}</div>`}
                  </div>
                  <div class="dm-champ-info">
                    <strong class="dm-champ-title">${escapeHtml(title)}</strong>
                    <span class="dm-champ-count">${lifetime} lifetime msgs</span>
                    <span class="bond-rank-tag bond-rank-${rank.id}">${rank.emoji} ${rank.shortLabel}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }

      // Recent Milestone Feed
      if (allMilestones.length > 0) {
        html += `
          <div class="dm-memory-subhead" style="margin-top: 10px;">📜 Recent Milestone Moments</div>
          <div class="dm-milestones-feed">
            ${allMilestones.slice(0, 5).map(m => `
              <div class="dm-milestone-item">
                <span class="dm-milestone-badge">${m.badge || '✨'}</span>
                <div class="dm-milestone-info">
                  <div class="dm-milestone-title-row">
                    <strong>${escapeHtml(m.title)}</strong>
                    <span class="dm-milestone-date">${new Date(m.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  </div>
                  <span class="dm-milestone-desc">${escapeHtml(m.description)}</span>
                </div>
              </div>
            `).join('')}
          </div>
        `;
      }

      listMemories.innerHTML = html;
    }
  }

  // Wire up Open/Reply buttons to launch X messages
  const actionBtns = document.querySelectorAll('.dm-reply-btn, .dm-reconnect-btn, .dm-open-btn');
  actionBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = btn.getAttribute('data-url');
      if (url && typeof chrome !== 'undefined' && chrome.tabs) {
        chrome.tabs.create({ url });
      }
    });
  });
}
