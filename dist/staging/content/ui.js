/**
 * BondScore for X - UI Injection & Score Card Component (v1.1.0)
 * Renders badges inline with streaks, reciprocity radar, 30-day sparklines, VIP pins, and private notes.
 */

class BondUI {
  constructor() {
    this.activeModal = null;
    this.modalKeydownHandler = null;
    this.initGlobalListeners();
  }

  initGlobalListeners() {
    window.addEventListener('bondscore:updated', (e) => {
      const handle = e.detail && e.detail.handle;
      if (handle) {
        this.refreshBadgesForUser(handle);
      }
    });

    window.addEventListener('bondscore:account_switched', async (e) => {
      const newAccount = e.detail && e.detail.currentAccount;
      const oldAccount = e.detail && e.detail.previousAccount;
      await this.handleAccountSwitched(newAccount, oldAccount);
    });
  }

  /**
   * Refreshes all badges on the current page when switching active accounts.
   */
  async handleAccountSwitched(newAccount, oldAccount) {
    console.log(`[BondScore UI] Account switched: ${oldAccount ? '@' + oldAccount : 'initial'} -> @${newAccount}. Refreshing page scores...`);

    // 1. If currently open ScoreCard modal, refresh or close it
    if (this.activeModal) {
      const modalHandle = this.activeModal.dataset.handle;
      if (modalHandle && newAccount && modalHandle.toLowerCase().trim() === newAccount.toLowerCase().trim()) {
        this.closeScoreCard();
      } else if (modalHandle) {
        await this.updateModalContent(modalHandle);
      }
    }

    // 2. Refresh all inline badges across timeline and profile
    const badges = document.querySelectorAll('.bond-badge');
    for (const b of badges) {
      const handle = b.getAttribute('data-bond-handle');
      if (!handle) continue;

      // If this badge is on the new account (oneself), remove it
      if (newAccount && handle.toLowerCase().trim() === newAccount.toLowerCase().trim()) {
        b.remove();
        continue;
      }

      await this.refreshBadgesForUser(handle, false);
    }

    // 3. Refresh all follow relationship badges
    const followBadges = document.querySelectorAll('.bond-follow-badge');
    for (const fb of followBadges) {
      const handle = fb.getAttribute('data-bond-follow-handle');
      if (handle) {
        if (newAccount && handle.toLowerCase().trim() === newAccount.toLowerCase().trim()) {
          fb.remove();
        } else {
          await this.updateProfileFollowBadge(handle);
        }
      }
    }
  }

  /**
   * Injects a badge next to a user handle on tweets or profile headers.
   * Completely immune to async race duplication.
   */
  async injectBadge(containerEl, handle, isProfileHeader = false) {
    if (!containerEl || !handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();

    // 1. Immediate synchronous deduplication: if badge(s) already exist, keep only 1 and exit
    const existingBadges = containerEl.querySelectorAll('.bond-badge');
    if (existingBadges.length > 0) {
      for (let i = 1; i < existingBadges.length; i++) {
        existingBadges[i].remove();
      }
      if (isProfileHeader) {
        const user = await window.bondStorage.getUser(cleanHandle);
        this.injectOrUpdateFollowBadge(containerEl, cleanHandle, user ? user.signals : null);
      }
      return;
    }

    // 2. Synchronous lock to prevent multiple concurrent async invocations on the same container
    if (containerEl.getAttribute('data-bond-pending') === cleanHandle) {
      return;
    }
    containerEl.setAttribute('data-bond-pending', cleanHandle);

    try {
      const currentUser = await window.bondStorage.getCurrentUser();
      if (currentUser && cleanHandle === currentUser) {
        containerEl.removeAttribute('data-bond-pending');
        return;
      }

      const user = (await window.bondStorage.getUser(cleanHandle)) || {
        handle: cleanHandle,
        currentScore: 0,
        tier: 'dormant',
        streakDays: 0,
        isPinned: false
      };

      const settings = await window.bondStorage.getSettings();
      if (!settings.showBadgesOnTimeline && !isProfileHeader) {
        containerEl.removeAttribute('data-bond-pending');
        return;
      }

      // 3. Re-verify right before appending in case another async task completed first
      const checkAgain = containerEl.querySelectorAll('.bond-badge');
      if (checkAgain.length > 0) {
        for (let i = 1; i < checkAgain.length; i++) {
          checkAgain[i].remove();
        }
        containerEl.removeAttribute('data-bond-pending');
        return;
      }

      const tier = BondScoring.getTier(user.currentScore);
      const scoreVal = Math.round(user.currentScore || 0);

      const sSent = (user.stats && ((user.stats.repliesSent || 0) + (user.stats.dmsSent || 0) + (user.stats.likes || 0))) || 0;
      const sRecv = (user.stats && ((user.stats.repliesReceived || 0) + (user.stats.dmsReceived || 0))) || 0;
      const crm = user.crmStatusData || (typeof BondScoring !== 'undefined' && BondScoring.calculateCRMStatus ? BondScoring.calculateCRMStatus(scoreVal, sSent, sRecv, user.streakDays || 0) : null);

      const badge = document.createElement('span');
      badge.className = `bond-badge ${isProfileHeader ? 'bond-badge-profile' : ''}`;
      badge.setAttribute('data-bond-handle', cleanHandle);
      badge.title = `BondScore: ${scoreVal} (${tier.name}) • CRM: ${crm ? crm.label : 'Mutual'} - Click for details`;
      badge.style.setProperty('--bond-color', tier.color);
      badge.style.setProperty('--bond-bg', tier.bg);

      const trendSymbol = user.trend === 'rising' ? '▲' : user.trend === 'decaying' ? '▼' : '';
      const trendClass = user.trend ? `trend-${user.trend}` : '';

      badge.innerHTML = `
        <span class="bond-badge-inner">
          ${user.isPinned ? `<span class="bond-pin-star" title="VIP Mutual">⭐</span>` : ''}
          <span class="bond-emoji">${tier.emoji}</span>
          <span class="bond-score-num">${scoreVal}</span>
          ${crm && crm.id !== 'stranger' ? `<span class="bond-crm-pill bond-crm-${crm.id}">${crm.label}</span>` : ''}
          ${user.streakDays > 1 ? `<span class="bond-streak-tag">🔥${user.streakDays}d</span>` : ''}
          ${trendSymbol ? `<span class="bond-trend ${trendClass}">${trendSymbol}</span>` : ''}
        </span>
      `;

      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openScoreCard(cleanHandle, badge);
      });

      containerEl.appendChild(badge);

      // If on a profile header, inject or update the dedicated Follow Relationship Badge
      if (isProfileHeader) {
        this.injectOrUpdateFollowBadge(containerEl, cleanHandle, user.signals);
      }
    } finally {
      containerEl.removeAttribute('data-bond-pending');
    }
  }

  /**
   * Injects or updates the follow relationship badge on a profile:
   * - Mutual: 🤝 Mutual
   * - One-Way Follow: ➡️ One-Way Follow
   * - Just a Follower: 📥 Just a Follower
   * - Blocked: 🚫 Blocked
   */
  injectOrUpdateFollowBadge(containerEl, handle, signals) {
    if (!containerEl || !handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const followRel = typeof BondScoring !== 'undefined' && BondScoring.getFollowRelationship
      ? BondScoring.getFollowRelationship(signals)
      : null;

    let followBadge = containerEl.querySelector(`.bond-follow-badge[data-bond-follow-handle="${cleanHandle}"]`) ||
                      containerEl.querySelector('.bond-follow-badge');

    if (!followRel) {
      if (followBadge) followBadge.remove();
      return;
    }

    if (!followBadge) {
      followBadge = document.createElement('span');
      followBadge.setAttribute('data-bond-follow-handle', cleanHandle);
      followBadge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openScoreCard(cleanHandle, followBadge);
      });
      containerEl.appendChild(followBadge);
    }

    followBadge.className = `bond-follow-badge ${followRel.className}`;
    followBadge.title = `${followRel.label}: ${followRel.desc} - Click for details`;
    followBadge.innerHTML = followRel.badgeText;
  }

  /**
   * Scans and updates follow relationship badges for a user across profile headers
   */
  async updateProfileFollowBadge(handle, signals = null) {
    if (!handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    if (!signals) {
      const user = await window.bondStorage.getUser(cleanHandle);
      signals = user ? user.signals : null;
    }

    // Look for profile header UserName container
    const profileHeaders = document.querySelectorAll('div[data-testid="UserName"]');
    profileHeaders.forEach(header => {
      this.injectOrUpdateFollowBadge(header, cleanHandle, signals);
    });

    // Also look for existing standalone follow badges with this handle
    const existingBadges = document.querySelectorAll(`.bond-follow-badge[data-bond-follow-handle="${cleanHandle}"]`);
    existingBadges.forEach(b => {
      if (b.parentElement) {
        this.injectOrUpdateFollowBadge(b.parentElement, cleanHandle, signals);
      }
    });
  }

  /**
   * Immediately bumps the badge score and shows pulse animation with zero latency
   */
  optimisticBoost(handle, pointBoost = 4) {
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const badges = document.querySelectorAll(`.bond-badge[data-bond-handle="${cleanHandle}"]`);
    badges.forEach((b) => {
      const scoreNumEl = b.querySelector('.bond-score-num');
      const emojiEl = b.querySelector('.bond-emoji');
      if (scoreNumEl) {
        const cur = parseFloat(scoreNumEl.innerText) || 0;
        const next = Math.min(100, Math.round(cur + pointBoost));
        scoreNumEl.innerText = next;
        const tier = BondScoring.getTier(next);
        b.style.setProperty('--bond-color', tier.color);
        b.style.setProperty('--bond-bg', tier.bg);
        if (emojiEl) emojiEl.innerText = tier.emoji;
      }
      b.classList.remove('bond-badge-bump');
      void b.offsetWidth;
      b.classList.add('bond-badge-bump');
    });
  }

  /**
   * Refreshes all visible badges for a specific handle
   */
  async refreshBadgesForUser(handle, shouldAnimate = true) {
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const user = (await window.bondStorage.getUser(cleanHandle)) || {
      handle: cleanHandle,
      currentScore: 0,
      tier: 'dormant',
      streakDays: 0,
      isPinned: false,
      trend: 'steady',
      stats: { repliesSent: 0, repliesReceived: 0, dmsSent: 0, dmsReceived: 0, mutualExchanges: 0, likes: 0, quotes: 0 }
    };

    const tier = BondScoring.getTier(user.currentScore);
    const scoreVal = Math.round(user.currentScore || 0);
    const trendSymbol = user.trend === 'rising' ? '▲' : user.trend === 'decaying' ? '▼' : '';

    const sSent = (user.stats && ((user.stats.repliesSent || 0) + (user.stats.dmsSent || 0) + (user.stats.likes || 0))) || 0;
    const sRecv = (user.stats && ((user.stats.repliesReceived || 0) + (user.stats.dmsReceived || 0))) || 0;
    const crm = user.crmStatusData || (typeof BondScoring !== 'undefined' && BondScoring.calculateCRMStatus ? BondScoring.calculateCRMStatus(scoreVal, sSent, sRecv, user.streakDays || 0) : null);

    const badges = document.querySelectorAll(`.bond-badge[data-bond-handle="${cleanHandle}"]`);
    const seenParents = new Set();
    badges.forEach((b) => {
      if (b.parentElement) {
        if (seenParents.has(b.parentElement)) {
          b.remove();
          return;
        }
        seenParents.add(b.parentElement);
      }
      b.style.setProperty('--bond-color', tier.color);
      b.style.setProperty('--bond-bg', tier.bg);
      b.title = `BondScore: ${scoreVal} (${tier.name}) • CRM: ${crm ? crm.label : 'Mutual'} - Click for details`;
      const inner = b.querySelector('.bond-badge-inner');
      if (inner) {
        inner.innerHTML = `
          ${user.isPinned ? `<span class="bond-pin-star" title="VIP Mutual">⭐</span>` : ''}
          <span class="bond-emoji">${tier.emoji}</span>
          <span class="bond-score-num">${scoreVal}</span>
          ${crm && crm.id !== 'stranger' ? `<span class="bond-crm-pill bond-crm-${crm.id}">${crm.label}</span>` : ''}
          ${user.streakDays > 1 ? `<span class="bond-streak-tag">🔥${user.streakDays}d</span>` : ''}
          ${trendSymbol ? `<span class="bond-trend trend-${user.trend}">${trendSymbol}</span>` : ''}
        `;
      }
      if (shouldAnimate) {
        b.classList.remove('bond-badge-bump');
        void b.offsetWidth;
        b.classList.add('bond-badge-bump');
      }
    });

    // Also update follow relationship badge on profile header
    await this.updateProfileFollowBadge(cleanHandle, user.signals);

    if (this.activeModal && this.activeModal.dataset.handle === cleanHandle) {
      this.updateModalContent(cleanHandle);
    }
  }

  /**
   * Opens the interactive Score Card popover/modal
   */
  async openScoreCard(handle, anchorEl = null) {
    this.closeScoreCard();

    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const currentUser = await window.bondStorage.getCurrentUser();
    const user = (await window.bondStorage.getUser(cleanHandle)) || {
      handle: cleanHandle,
      displayName: cleanHandle,
      avatarUrl: '',
      currentScore: 0,
      tier: 'dormant',
      streakDays: 0,
      isPinned: false,
      note: '',
      stats: { repliesSent: 0, repliesReceived: 0, mutualExchanges: 0, likes: 0, quotes: 0, deepScans: 0 }
    };

    const events = await window.bondStorage.getEvents(cleanHandle);
    const settings = await window.bondStorage.getSettings();
    const scoringResult = BondScoring.calculateUserScore(events, settings, user.currentScore);
    const tier = scoringResult.tier;
    const scoreVal = Math.round(user.currentScore || scoringResult.score || 0);
    const reciprocity = scoringResult.reciprocity;

    const sSent = (user.stats && ((user.stats.repliesSent || 0) + (user.stats.dmsSent || 0) + (user.stats.likes || 0))) || 0;
    const sRecv = (user.stats && ((user.stats.repliesReceived || 0) + (user.stats.dmsReceived || 0))) || 0;
    const crm = scoringResult.crmStatus || user.crmStatusData || BondScoring.calculateCRMStatus(scoreVal, sSent, sRecv, user.streakDays || 0);

    const dmEvents = events.filter(e => e.type && e.type.startsWith('dm_'));
    const replyEvents = events.filter(e => e.type && e.type.startsWith('reply_'));
    const likeEvents = events.filter(e => e.type === 'like' || e.type === 'quote');
    const signalEvents = events.filter(e => e.type && e.type.startsWith('signal_'));

    // Relationship Signals Follow Badge (Mutual, One-Way Follow, Just a Follower, Blocked)
    const followRel = typeof BondScoring !== 'undefined' && BondScoring.getFollowRelationship
      ? BondScoring.getFollowRelationship(user.signals)
      : null;
    let signalStatusHtml = '';
    if (followRel) {
      signalStatusHtml = `<span class="bond-follow-badge ${followRel.className}" title="${followRel.desc}">${followRel.badgeText}</span>`;
    }

    // Local Engagement Memory Insight
    let engagementMemoryText = 'Balanced reciprocal interaction';
    const signals = user.signals || {};
    const totalExchanges = sSent + sRecv;
    if (signals.isBlocked) {
      engagementMemoryText = `🚫 Possible Block: Profile displays blocked state or restricted access`;
    } else if (sRecv >= 2 && sRecv > sSent) {
      engagementMemoryText = `🌟 Supporter: They engage with you most (${sRecv} inbound responses vs ${sSent} sent by you)`;
    } else if (sSent >= 2 && sSent > sRecv) {
      engagementMemoryText = `🎯 Outbound Focus: You engage with them more (${sSent} sent by you vs ${sRecv} responses)`;
    } else if (sSent > 0 && sRecv > 0) {
      engagementMemoryText = `⚖️ Balanced Bond: Healthy reciprocal back-and-forth dialogue`;
    } else if (totalExchanges === 0) {
      engagementMemoryText = `👤 Cold / Stranger: No engagement logged yet`;
    }
    const daysSinceInteraction = Math.floor((Date.now() - (user.lastInteraction || Date.now())) / 86400000);
    if (daysSinceInteraction >= 14 && totalExchanges > 0 && !signals.isBlocked) {
      engagementMemoryText += ` • ❄️ Dormant for ${daysSinceInteraction}d`;
    }

    const modal = document.createElement('div');
    modal.className = 'bond-modal-backdrop';
    modal.dataset.handle = cleanHandle;
    if (settings && settings.theme && settings.theme !== 'system') {
      modal.setAttribute('data-theme', settings.theme);
    }
    this.activeModal = modal;

    modal.innerHTML = `
      <div class="bond-card" role="dialog" aria-modal="true">
        <!-- Card Header -->
        <div class="bond-card-header">
          <div class="bond-card-user">
            ${user.avatarUrl ? `<img class="bond-avatar" src="${this.escapeHtml(user.avatarUrl)}" alt="${this.escapeHtml(user.displayName)}"/>` : `<div class="bond-avatar-placeholder">${cleanHandle.charAt(0).toUpperCase()}</div>`}
            <div class="bond-user-meta">
              <div class="bond-display-name-row">
                <span class="bond-display-name">${this.escapeHtml(user.displayName || cleanHandle)}</span>
                ${signalStatusHtml}
                <button class="bond-pin-btn ${user.isPinned ? 'pinned' : ''}" id="bond-pin-toggle-btn" title="${user.isPinned ? 'Unpin VIP' : 'Pin as VIP'}">
                  ${user.isPinned ? '★ VIP' : '☆ Pin'}
                </button>
              </div>
              <div class="bond-handle">@${cleanHandle} <span class="bond-viewing-account" style="font-size: 11px; opacity: 0.7; margin-left: 6px;">(Viewing as @${currentUser || 'you'})</span></div>
            </div>
          </div>
          <button class="bond-close-btn" title="Close" aria-label="Close">&times;</button>
        </div>

        <!-- Relationship CRM & Engagement Memory Banner -->
        <div class="bond-crm-card" style="border-left: 3px solid ${crm.color};">
          <div class="bond-crm-top">
            <span class="bond-crm-pill large bond-crm-${crm.id}">${crm.emoji} ${crm.label}${crm.subLabel ? ` · ${crm.subLabel}` : ''}</span>
            <span class="bond-crm-type-badge">Relationship CRM</span>
          </div>
          <div class="bond-crm-desc">${crm.desc}</div>
          <div class="bond-crm-memory-row">
            <span class="bond-crm-memory-icon">🧠</span>
            <span class="bond-crm-memory-text">${engagementMemoryText}</span>
          </div>
        </div>

        <!-- Inactivity Alert (if bond at risk) -->
        ${scoringResult.decayWarning ? `
          <div class="bond-warning-banner">
            <span class="bond-warning-icon">❄️</span>
            <div>
              <strong>Bond at Risk!</strong>
              <div>No replies in ${scoringResult.daysSinceLast} days. Score will decay soon.</div>
            </div>
          </div>
        ` : ''}

        <!-- Hero Gauge & Streaks -->
        <div class="bond-score-hero">
          <div class="bond-gauge-wrapper">
            <svg class="bond-gauge-svg" viewBox="0 0 100 100">
              <circle class="bond-gauge-bg" cx="50" cy="50" r="42" />
              <circle class="bond-gauge-val" cx="50" cy="50" r="42" style="stroke: ${tier.color}; stroke-dashoffset: ${264 - (264 * scoreVal) / 100};" />
            </svg>
            <div class="bond-gauge-center">
              <div class="bond-gauge-score" style="color: ${tier.color}">${scoreVal}</div>
              <div class="bond-gauge-tier">${tier.emoji} ${tier.name}</div>
            </div>
          </div>
          <div class="bond-status-sub">
            <div class="bond-badges-row">
              <span class="bond-status-badge ${user.trend ? 'trend-' + user.trend : ''}">
                ${user.trend === 'rising' ? '▲ Rising' : user.trend === 'decaying' ? '▼ Decaying' : '▬ Steady'}
              </span>
              ${user.streakDays > 0 ? `<span class="bond-streak-badge">🔥 ${user.streakDays} Day Streak</span>` : ''}
            </div>
            <div class="bond-last-seen">Last Interaction: <strong>${BondScoring.formatTimeAgo(user.lastInteraction)}</strong></div>
            <!-- Quality & Weighting Multipliers Badge Row -->
            <div class="bond-badges-row" style="margin-top: 4px; flex-wrap: wrap; justify-content: center; gap: 4px;">
              ${scoringResult.recencyBoost > 1.0 ? `<span class="bond-status-badge" style="background:rgba(29,155,240,0.18);color:#1d9bf0;" title="Interactions within 24-72 hours receive an active recency momentum boost">⚡ ${scoringResult.recencyBoost}x Recency Boost</span>` : ''}
              ${scoringResult.twoWayMultiplier > 1.0 ? `<span class="bond-status-badge" style="background:rgba(0,186,124,0.18);color:#00ba7c;" title="Mutual two-way dialogue adds an escalating reciprocity bonus">🤝 +${Math.round((scoringResult.twoWayMultiplier - 1) * 100)}% Reciprocal Return</span>` : ''}
              ${scoringResult.qualityMetrics && scoringResult.qualityMetrics.threadReplies > 0 ? `<span class="bond-status-badge" style="background:rgba(168,85,247,0.18);color:#a855f7;" title="Replies in conversational threads weighted higher than standalone likes">🧵 Thread Depth</span>` : ''}
            </div>
          </div>
        </div>

        <!-- Reciprocity Radar -->
        <div class="bond-reciprocity-box">
          <div class="bond-reciprocity-header">
            <span>⚖️ Reciprocity Balance</span>
            <span class="bond-reciprocity-lbl">${reciprocity.label}</span>
          </div>
          <div class="bond-reciprocity-bar">
            <div class="bond-reciprocity-fill" style="width: ${reciprocity.ratio}%;"></div>
          </div>
          <div class="bond-reciprocity-sub">
            <span>You sent: ${(user.stats.repliesSent || 0) + (user.stats.dmsSent || 0)} (${reciprocity.ratio}%)</span>
            <span>They replied: ${(user.stats.repliesReceived || 0) + (user.stats.dmsReceived || 0)} (${100 - reciprocity.ratio}%)</span>
          </div>
        </div>

        <!-- 30-Day Trend Sparkline Graph -->
        <div class="bond-sparkline-box">
          <div class="bond-sparkline-header">
            <span>📈 30-Day Bond Trajectory</span>
            <span class="bond-sparkline-current">${scoreVal}/100</span>
          </div>
          <div class="bond-sparkline-svg-wrap">
            <svg viewBox="0 0 240 50" class="bond-sparkline-svg">
              <polyline fill="none" stroke="#2f3336" stroke-width="1" stroke-dasharray="2,2" points="0,25 240,25" />
              <polyline fill="none" stroke="${tier.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${scoringResult.sparklinePoints}" />
            </svg>
          </div>
          <div class="bond-sparkline-labels">
            <span>30 days ago</span>
            <span>Today</span>
          </div>
        </div>

        <!-- Stats Grid (CRM Breakdown) -->
        <div class="bond-stats-grid">
          <div class="bond-stat-item">
            <div class="bond-stat-val">${(user.stats.dmsSent || 0) + (user.stats.dmsReceived || 0)}</div>
            <div class="bond-stat-lbl">✉️ Direct Messages</div>
          </div>
          <div class="bond-stat-item">
            <div class="bond-stat-val">${user.stats.mutualExchanges || 0}</div>
            <div class="bond-stat-lbl">🤝 Mutual Replies</div>
          </div>
          <div class="bond-stat-item">
            <div class="bond-stat-val">${(user.stats.repliesSent || 0) + (user.stats.dmsSent || 0)}</div>
            <div class="bond-stat-lbl">📤 Sent by You</div>
          </div>
          <div class="bond-stat-item">
            <div class="bond-stat-val">${(user.stats.repliesReceived || 0) + (user.stats.dmsReceived || 0)}</div>
            <div class="bond-stat-lbl">📥 Received</div>
          </div>
          <div class="bond-stat-item">
            <div class="bond-stat-val">${(user.stats.likes || 0) + (user.stats.quotes || 0)}</div>
            <div class="bond-stat-lbl">❤️ Likes & Quotes</div>
          </div>
          <div class="bond-stat-item">
            <div class="bond-stat-val">${user.streakDays || 0}d</div>
            <div class="bond-stat-lbl">🔥 Reply Streak</div>
          </div>
        </div>

        <!-- Private Note Field -->
        <div class="bond-note-section">
          <div class="bond-note-label">📝 Private Note (Saved locally)</div>
          <div class="bond-note-input-row">
            <input type="text" class="bond-note-input" id="bond-note-input" placeholder="e.g. Met at tech conference, artist friend..." value="${this.escapeHtml(user.note || '')}" maxlength="180">
            <button class="bond-note-save-btn" id="bond-note-save-btn">Save</button>
          </div>
        </div>

        <!-- Deep Mode Section -->
        <div class="bond-deep-section">
          <div class="bond-deep-header">
            <div>
              <div class="bond-deep-title">⚡ Deep Mode Analysis</div>
              <div class="bond-deep-desc">Scans conversation archive for mutual interactions without paid API.</div>
            </div>
          </div>

          <div class="bond-deep-progress-bar" style="display: none;">
            <div class="bond-deep-progress-fill" style="width: 0%;"></div>
          </div>
          <div class="bond-deep-status-text" style="display: none;">Ready</div>

          <button class="bond-deep-btn" id="bond-run-deep-btn">
            <span>🔍 Run Deep Analysis</span>
          </button>
        </div>

        <!-- Personal Relationship History Ledger -->
        <div class="bond-timeline-preview">
          <div class="bond-timeline-header-wrap">
            <div class="bond-timeline-title">📜 Relationship History Ledger (${events.length})</div>
            <div class="bond-timeline-filters" id="bond-timeline-filters">
              <button class="bond-tl-filter-btn active" data-filter="all">All (${events.length})</button>
              <button class="bond-tl-filter-btn" data-filter="dm">✉️ DMs (${dmEvents.length})</button>
              <button class="bond-tl-filter-btn" data-filter="reply">💬 Replies (${replyEvents.length})</button>
              <button class="bond-tl-filter-btn" data-filter="like">❤️ Likes (${likeEvents.length})</button>
              <button class="bond-tl-filter-btn" data-filter="signal">📡 Signals (${signalEvents.length})</button>
            </div>
          </div>
          <div class="bond-timeline-list" id="bond-timeline-ledger">
            ${this.renderTimelineItems(events)}
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event listeners
    const closeBtn = modal.querySelector('.bond-close-btn');
    closeBtn.addEventListener('click', () => this.closeScoreCard());

    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.closeScoreCard();
    });

    this.modalKeydownHandler = (e) => {
      if (e.key === 'Escape') this.closeScoreCard();
    };
    window.addEventListener('keydown', this.modalKeydownHandler);

    // Pin Toggle
    const pinBtn = modal.querySelector('#bond-pin-toggle-btn');
    pinBtn.addEventListener('click', async () => {
      const isPinned = await window.bondStorage.togglePin(cleanHandle);
      pinBtn.classList.toggle('pinned', isPinned);
      pinBtn.innerText = isPinned ? '★ VIP' : '☆ Pin';
      this.refreshBadgesForUser(cleanHandle);
    });

    // Save Note
    const noteInput = modal.querySelector('#bond-note-input');
    const noteSaveBtn = modal.querySelector('#bond-note-save-btn');
    noteSaveBtn.addEventListener('click', async () => {
      noteSaveBtn.innerText = 'Saved';
      await window.bondStorage.saveNote(cleanHandle, noteInput.value.trim());
      setTimeout(() => { noteSaveBtn.innerText = 'Save'; }, 1200);
    });

    // CRM Timeline Filter Buttons
    const tlFilters = modal.querySelectorAll('.bond-tl-filter-btn');
    const ledgerEl = modal.querySelector('#bond-timeline-ledger');
    tlFilters.forEach((btn) => {
      btn.addEventListener('click', () => {
        tlFilters.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filterType = btn.dataset.filter;
        let filtered = events;
        if (filterType === 'dm') {
          filtered = dmEvents;
        } else if (filterType === 'reply') {
          filtered = replyEvents;
        } else if (filterType === 'like') {
          filtered = likeEvents;
        } else if (filterType === 'signal') {
          filtered = signalEvents;
        }
        if (ledgerEl) {
          ledgerEl.innerHTML = this.renderTimelineItems(filtered);
        }
      });
    });

    // Deep Analysis Button Trigger
    const deepBtn = modal.querySelector('#bond-run-deep-btn');
    const progressBar = modal.querySelector('.bond-deep-progress-bar');
    const progressFill = modal.querySelector('.bond-deep-progress-fill');
    const statusText = modal.querySelector('.bond-deep-status-text');

    deepBtn.addEventListener('click', async () => {
      try {
        deepBtn.disabled = true;
        deepBtn.classList.add('loading');
        progressBar.style.display = 'block';
        statusText.style.display = 'block';

        const currentUser = await window.bondStorage.getCurrentUser();
        await window.deepAnalyzer.runAnalysis(currentUser, cleanHandle, ({ percent, stage, itemsFound }) => {
          progressFill.style.width = `${percent}%`;
          statusText.innerText = `${stage} (${itemsFound || 0} found)`;
        });

        deepBtn.disabled = false;
        deepBtn.classList.remove('loading');
        deepBtn.innerHTML = `<span>✓ Deep Analysis Complete</span>`;
        setTimeout(() => {
          if (this.activeModal) {
            this.updateModalContent(cleanHandle);
          }
        }, 700);
      } catch (err) {
        console.error('[BondScore] Deep analysis error:', err);
        deepBtn.disabled = false;
        deepBtn.classList.remove('loading');
        statusText.innerText = 'Analysis incomplete. Click to retry.';
      }
    });
  }

  renderTimelineItems(items) {
    if (!items || items.length === 0) {
      return `<div class="bond-empty-events">No interactions recorded in this category yet.</div>`;
    }
    const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp);
    return sorted.map(e => {
      const typeInfo = this.getEventInfo(e.type);
      return `
        <div class="bond-event-row ${e.type}">
          <div class="bond-event-type-wrap">
            <span class="bond-event-tag ${typeInfo.className}">${typeInfo.label}</span>
          </div>
          <div class="bond-event-content-wrap">
            <span class="bond-event-snippet">${e.textSnippet ? this.escapeHtml(e.textSnippet) : typeInfo.defaultSnippet}</span>
            <div class="bond-event-meta-sub">
              <span class="bond-event-time">${BondScoring.formatTimeAgo(e.timestamp)}</span>
              ${e.tweetId && !e.tweetId.startsWith('dm_') ? `<span class="bond-event-id">• ID ${this.escapeHtml(e.tweetId.slice(0, 10))}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  getEventInfo(type) {
    switch (type) {
      case 'signal_follow_back':
        return { label: '🎉 Follow-back', className: 'bond-type-signal-fb', defaultSnippet: 'Followed you back!' };
      case 'signal_mutual_follow':
        return { label: '🤝 Mutual Follow', className: 'bond-type-signal-mutual', defaultSnippet: 'Mutual follow established' };
      case 'signal_unfollowed':
        return { label: '⚠️ Unfollowed', className: 'bond-type-signal-unfollow', defaultSnippet: 'No longer following you' };
      case 'signal_blocked':
        return { label: '🚫 Blocked', className: 'bond-type-signal-blocked', defaultSnippet: 'Possible block detected' };
      case 'signal_you_followed':
        return { label: '➕ You Followed', className: 'bond-type-signal-you', defaultSnippet: 'You followed user' };
      case 'signal_you_unfollowed':
        return { label: '➖ You Unfollowed', className: 'bond-type-signal-you-unfollow', defaultSnippet: 'You unfollowed user' };
      case 'dm_sent':
        return { label: '✉️ DM Sent', className: 'bond-type-dm-sent', defaultSnippet: 'Direct message sent' };
      case 'dm_received':
        return { label: '✉️ DM Recv', className: 'bond-type-dm-recv', defaultSnippet: 'Direct message received' };
      case 'dm_mutual':
        return { label: '✉️ Mutual DM', className: 'bond-type-dm-mutual', defaultSnippet: 'Active DM dialogue' };
      case 'reply_mutual':
        return { label: '🤝 Mutual', className: 'bond-type-mutual', defaultSnippet: 'Two-way reply exchange' };
      case 'reply_thread':
        return { label: '🧵 Thread Reply', className: 'bond-type-thread', defaultSnippet: 'Conversational reply in thread' };
      case 'reply_sent':
        return { label: '💬 Reply Sent', className: 'bond-type-sent', defaultSnippet: 'Reply sent by you' };
      case 'reply_received':
        return { label: '💬 Reply Recv', className: 'bond-type-recv', defaultSnippet: 'Reply received from user' };
      case 'like':
        return { label: '❤️ Liked', className: 'bond-type-like', defaultSnippet: 'Liked tweet' };
      case 'quote':
        return { label: '🔁 Quoted', className: 'bond-type-quote', defaultSnippet: 'Quote tweet' };
      case 'deep_sync':
        return { label: '🔍 Deep Scan', className: 'bond-type-scan', defaultSnippet: 'Archived conversation' };
      default:
        return { label: '⚡ Active', className: 'bond-type-default', defaultSnippet: 'Interaction logged' };
    }
  }

  async updateModalContent(handle) {
    if (!this.activeModal) return;
    this.closeScoreCard();
    await this.openScoreCard(handle);
  }

  closeScoreCard() {
    if (this.activeModal) {
      this.activeModal.remove();
      this.activeModal = null;
    }
    if (this.modalKeydownHandler) {
      window.removeEventListener('keydown', this.modalKeydownHandler);
      this.modalKeydownHandler = null;
    }
  }

  formatEventType(type) {
    return this.getEventInfo(type).label;
  }

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

window.bondUI = new BondUI();
