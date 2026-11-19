/**
 * BondScore - UI Injection & Score Card Component (v1.4.0)
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
        this.refreshBadgesForUser(handle, false);
      }
    });

    window.addEventListener('bondscore:account_switched', async (e) => {
      const newAccount = e.detail && e.detail.currentAccount;
      const oldAccount = e.detail && e.detail.previousAccount;
      await this.handleAccountSwitched(newAccount, oldAccount);
    });

    window.addEventListener('bondscore:dm_updated', async (e) => {
      const convId = e.detail && e.detail.convId;
      if (convId) {
        this.refreshDmHeaderPill(convId);
      }
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
   * Single source of truth for badge markup.
   * `signature` lets the scanner skip re-writing identical content, which is
   * what made Threads badges flicker on every DOM mutation after a like.
   */
  buildBadgeInner(scoreVal, tier, crm, user) {
    const trendSymbol = user.trend === 'rising' ? '▲' : user.trend === 'decaying' ? '▼' : '';
    const trendClass = user.trend ? `trend-${user.trend}` : '';
    const body = `
          ${user.isPinned ? `<span class="bond-pin-star" title="VIP Mutual">⭐</span>` : ''}
          <span class="bond-emoji">${tier.emoji}</span>
          <span class="bond-score-num">${scoreVal}</span>
          ${crm && crm.id !== 'stranger' ? `<span class="bond-crm-pill bond-crm-${crm.id}">${crm.label}</span>` : ''}
          ${user.streakDays > 1 ? `<span class="bond-streak-tag">🔥${user.streakDays}d</span>` : ''}
          ${trendSymbol ? `<span class="bond-trend ${trendClass}">${trendSymbol}</span>` : ''}
        `;
    return {
      body,
      html: `<span class="bond-badge-inner">${body}</span>`,
      signature: [
        user.isPinned ? 'pin' : '',
        tier.id || tier.emoji || '',
        scoreVal,
        crm ? crm.id : '',
        user.streakDays || 0,
        trendSymbol
      ].join('|')
    };
  }

  /**
   * Injects a badge next to a user handle on tweets or profile headers.
   * Completely immune to async race duplication.
   */
  async injectBadge(containerEl, handle, isProfileHeader = false) {
    if (!containerEl || !handle) return;
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();

    // A profile badge from an older placement can survive a DOM redesign.
    // Keep only the one in the intended container.
    if (isProfileHeader) {
      document.querySelectorAll(`.bond-badge-profile[data-bond-handle="${cleanHandle}"]`).forEach((old) => {
        if (!containerEl.contains(old)) old.remove();
      });
    }

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

      const sSent = (user.stats && ((user.stats.repliesSent || 0) + (user.stats.dmsSent || 0) + (user.stats.likesSent ?? user.stats.likes ?? 0) + (user.stats.quotesSent || 0) + (user.stats.repostsSent || 0) + (user.stats.mentionsSent || 0))) || 0;
      const sRecv = (user.stats && ((user.stats.repliesReceived || 0) + (user.stats.dmsReceived || 0) + (user.stats.likesReceived || 0) + (user.stats.quotesReceived || 0) + (user.stats.repostsReceived || 0) + (user.stats.mentionsReceived || 0))) || 0;
      const crm = user.crmStatusData || (typeof BondScoring !== 'undefined' && BondScoring.calculateCRMStatus ? BondScoring.calculateCRMStatus(scoreVal, sSent, sRecv, user.streakDays || 0) : null);

      const badge = document.createElement('span');
      badge.className = `bond-badge ${isProfileHeader ? 'bond-badge-profile' : ''}`;
      badge.setAttribute('data-bond-handle', cleanHandle);
      badge.title = `BondScore: ${scoreVal} (${tier.name}) • CRM: ${crm ? crm.label : 'Mutual'} - Click for details`;
      badge.style.setProperty('--bond-color', tier.color);
      badge.style.setProperty('--bond-bg', tier.bg);

      const rendered = this.buildBadgeInner(scoreVal, tier, crm, user);
      badge.innerHTML = rendered.html;
      badge.dataset.bondSig = rendered.signature;

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
   * Gives instant feedback on an interaction.
   * The number is intentionally left alone: guessing "+3" and then replacing it
   * with the real recomputed score is what produced the Threads flicker.
   */
  optimisticBoost(handle, pointBoost = 4) {
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const badges = Array.from(document.querySelectorAll(`.bond-badge[data-bond-handle="${cleanHandle}"]`)).slice(0, 4);
    badges.forEach((b) => {
      b.classList.remove('bond-badge-bump');
      void b.offsetWidth;
      b.classList.add('bond-badge-bump');
      b.addEventListener('animationend', () => b.classList.remove('bond-badge-bump'), { once: true });
    });
  }

  /**
   * Refreshes all visible badges for a specific handle
   */
  async refreshBadgesForUser(handle, shouldAnimate = false) {
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    // Force a storage read: a cached pre-interaction record can otherwise
    // overwrite a freshly bumped badge with 0 a moment later.
    const user = (await window.bondStorage.getUser(cleanHandle, true)) || {
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

    const sSent = (user.stats && ((user.stats.repliesSent || 0) + (user.stats.dmsSent || 0) + (user.stats.likesSent ?? user.stats.likes ?? 0) + (user.stats.quotesSent || 0) + (user.stats.repostsSent || 0) + (user.stats.mentionsSent || 0))) || 0;
    const sRecv = (user.stats && ((user.stats.repliesReceived || 0) + (user.stats.dmsReceived || 0) + (user.stats.likesReceived || 0) + (user.stats.quotesReceived || 0) + (user.stats.repostsReceived || 0) + (user.stats.mentionsReceived || 0))) || 0;
    const crm = user.crmStatusData || (typeof BondScoring !== 'undefined' && BondScoring.calculateCRMStatus ? BondScoring.calculateCRMStatus(scoreVal, sSent, sRecv, user.streakDays || 0) : null);
    const rendered = this.buildBadgeInner(scoreVal, tier, crm, user);

    const badges = document.querySelectorAll(`.bond-badge[data-bond-handle="${cleanHandle}"]`);
    const seenParents = new Set();
    let changed = false;
    badges.forEach((b) => {
      if (b.parentElement) {
        if (seenParents.has(b.parentElement)) {
          b.remove();
          return;
        }
        seenParents.add(b.parentElement);
      }
      // Every DOM write on a scanned badge costs a repaint, so only touch the
      // element when its rendered content actually differs.
      if (b.dataset.bondSig !== rendered.signature) {
        b.dataset.bondSig = rendered.signature;
        b.style.setProperty('--bond-color', tier.color);
        b.style.setProperty('--bond-bg', tier.bg);
        b.title = `BondScore: ${scoreVal} (${tier.name}) • CRM: ${crm ? crm.label : 'Mutual'} - Click for details`;
        const inner = b.querySelector('.bond-badge-inner');
        if (inner) inner.innerHTML = rendered.body;
        changed = true;
      }
    });

    if (shouldAnimate && changed) {
      badges.forEach((b) => {
        b.classList.remove('bond-badge-bump');
        void b.offsetWidth;
        b.classList.add('bond-badge-bump');
        b.addEventListener('animationend', () => b.classList.remove('bond-badge-bump'), { once: true });
      });
    }

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
    // Deep Mode uses X's own in-tab archive search; keep it off other networks.
    const isXHost = !window.BondPlatforms || window.BondPlatforms.current().id === 'x';
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
    const scoreVal = Math.round(scoringResult.score || 0);
    const reciprocity = scoringResult.reciprocity;

    const sSent = (user.stats && ((user.stats.repliesSent || 0) + (user.stats.dmsSent || 0) + (user.stats.likesSent ?? user.stats.likes ?? 0) + (user.stats.quotesSent || 0) + (user.stats.repostsSent || 0) + (user.stats.mentionsSent || 0))) || 0;
    const sRecv = (user.stats && ((user.stats.repliesReceived || 0) + (user.stats.dmsReceived || 0) + (user.stats.likesReceived || 0) + (user.stats.quotesReceived || 0) + (user.stats.repostsReceived || 0) + (user.stats.mentionsReceived || 0))) || 0;
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
              <div>No interaction in ${scoringResult.daysSinceLast} days. The score is decaying.</div>
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
            <div class="bond-stat-val">${(user.stats.likes || 0) + (user.stats.reposts || 0) + (user.stats.quotes || 0)}</div>
            <div class="bond-stat-lbl">❤️ Likes · 🔁 Reposts</div>
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
        ${isXHost ? `
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
        ` : ''}

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

    if (deepBtn && progressBar && progressFill && statusText) {
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

  /**
   * Injects or updates a DM relationship rank or energy badge in the DM inbox conversation row.
   */
  async injectDmRowBadge(convElement, convId, participantHandle, isGroup, metadata = {}) {
    if (!convElement || !convId) return;
    const cleanConvId = convId.toLowerCase().trim();
    const settings = await window.bondStorage.getSettings();
    if (settings.showBadgesInDMs === false || settings.trackDirectMessages === false) return;

    let badge = convElement.querySelector(`.bond-dm-row-badge[data-bond-dm-conv="${cleanConvId}"]`);
    const conv = (await window.bondStorage.getDmConversation(cleanConvId)) || {
      convId: cleanConvId,
      isGroup,
      sentCount: 1,
      receivedCount: 1,
      totalCount: 2,
      lifetimeTotal: 2,
      bondScore: 10,
      dailyStreak: 0
    };

    let badgeHtml = '';
    if (conv.isGroup) {
      const energyLevel = conv.groupEnergyLevel || (typeof BondScoring !== 'undefined' ? BondScoring.getGroupEnergyLevel(conv.groupEnergyScore || 0) : null);
      const score = Math.round(conv.groupEnergyScore || 0);
      badgeHtml = `
        <span class="bond-energy-tag bond-energy-${energyLevel ? energyLevel.id : 'chill'}">
          <span class="bond-dm-emoji">${energyLevel ? energyLevel.emoji : '⚡'}</span>
          <span class="bond-dm-label">${energyLevel ? energyLevel.name : 'Energy'}</span>
          <span class="bond-dm-score">${score}</span>
        </span>
      `;
    } else {
      const rank = conv.rank || (typeof BondScoring !== 'undefined' ? BondScoring.getDmRank(conv.bondScore || 0) : null);
      const score = Math.round(conv.bondScore || 0);
      badgeHtml = `
        <span class="bond-rank-tag bond-rank-${rank ? rank.id : 'acquaintance'}">
          <span class="bond-dm-emoji">${rank ? rank.emoji : '👋'}</span>
          <span class="bond-dm-label">${rank ? rank.shortLabel : 'Acquaintance'}</span>
          <span class="bond-dm-score">${score}</span>
        </span>
        ${conv.dailyStreak > 1 ? `<span class="bond-status-pill bond-streak-pill" title="Daily Streak">🔥${conv.dailyStreak}d</span>` : ''}
        ${conv.isFading ? `<span class="bond-status-pill bond-cooling-pill" title="High-bond chat cooling off">🧊 Cold</span>` : ''}
      `;
    }

    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'bond-dm-row-badge';
      badge.setAttribute('data-bond-dm-conv', cleanConvId);
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openDmScoreCard(cleanConvId, badge);
      });

      const targetContainer = convElement.querySelector('[dir="ltr"], div[style*="flex-direction: row"], [data-testid="User-Name"], [class*="min-w-0"][class*="flex-col"], [class*="min-w-0"], span') || convElement;
      targetContainer.appendChild(badge);
    }

    badge.innerHTML = badgeHtml;
  }

  /**
   * Injects or updates the interactive DM Header Pill inside an open conversation.
   */
  async injectDmHeaderPill(headerElement, convId, targetHandle, isGroup) {
    if (!headerElement || !convId) return;
    const cleanConvId = convId.toLowerCase().trim();
    const settings = await window.bondStorage.getSettings();
    if (settings.showBadgesInDMs === false || settings.trackDirectMessages === false) return;

    // XChat reuses the header node across conversations. Drop pills belonging
    // to a previously opened thread so only the active conversation is shown.
    headerElement.querySelectorAll('.bond-dm-header-pill').forEach((oldPill) => {
      if (oldPill.getAttribute('data-bond-dm-header') !== cleanConvId) oldPill.remove();
    });

    let pill = headerElement.querySelector(`.bond-dm-header-pill[data-bond-dm-header="${cleanConvId}"]`);
    const conv = (await window.bondStorage.getDmConversation(cleanConvId)) || {
      convId: cleanConvId,
      isGroup,
      sentCount: 1,
      receivedCount: 1,
      totalCount: 2,
      lifetimeTotal: 2,
      bondScore: 10,
      dailyStreak: 0
    };

    let pillHtml = '';
    if (conv.isGroup) {
      const energyLevel = conv.groupEnergyLevel || (typeof BondScoring !== 'undefined' ? BondScoring.getGroupEnergyLevel(conv.groupEnergyScore || 0) : null);
      const score = Math.round(conv.groupEnergyScore || 0);
      pillHtml = `
        <div class="bond-header-pill-inner bond-header-pill-group">
          <span class="bond-header-pill-emoji">${energyLevel ? energyLevel.emoji : '⚡'}</span>
          <span class="bond-header-pill-rank">${energyLevel ? energyLevel.name : 'Group Energy'}</span>
          <span class="bond-header-pill-score">${score}</span>
          <span class="bond-header-pill-dot">•</span>
          <span class="bond-header-pill-meta">${conv.energyMetrics ? conv.energyMetrics.distinctMembers : 1} Members</span>
        </div>
      `;
    } else {
      const rank = conv.rank || (typeof BondScoring !== 'undefined' ? BondScoring.getDmRank(conv.bondScore || 0) : null);
      const score = Math.round(conv.bondScore || 0);
      const replyRate = conv.replyRate ?? 100;
      pillHtml = `
        <div class="bond-header-pill-inner">
          <span class="bond-header-pill-emoji">${rank ? rank.emoji : '👋'}</span>
          <span class="bond-header-pill-rank">${rank ? rank.name : 'Acquaintance'}</span>
          <span class="bond-header-pill-score">${score}</span>
          <span class="bond-header-pill-dot">•</span>
          <span class="bond-header-pill-meta">${replyRate}% Reply</span>
          ${conv.dailyStreak > 1 ? `<span class="bond-header-pill-dot">•</span><span class="bond-header-pill-streak">🔥 ${conv.dailyStreak}d</span>` : ''}
        </div>
      `;
    }

    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'bond-dm-header-pill';
      pill.setAttribute('data-bond-dm-header', cleanConvId);
      pill.title = 'Click to open Conversation Bond & Analytics';
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openDmScoreCard(cleanConvId, pill);
      });

      const actionsContainer = headerElement.querySelector('div[style*="flex-direction: row"], [role="group"]');
      if (actionsContainer && actionsContainer.parentNode) {
        actionsContainer.parentNode.insertBefore(pill, actionsContainer);
      } else {
        headerElement.appendChild(pill);
      }
    }

    pill.innerHTML = pillHtml;
  }

  /**
   * Refreshes the DM header pill for a conversation ID.
   */
  async refreshDmHeaderPill(convId) {
    if (!convId) return;
    const cleanConvId = convId.toLowerCase().trim();
    const pill = document.querySelector(`.bond-dm-header-pill[data-bond-dm-header="${cleanConvId}"]`);
    if (pill && pill.parentElement) {
      await this.injectDmHeaderPill(pill.parentElement, cleanConvId, null, false);
    }
  }

  /**
   * Opens the rich 1:1 Direct Message or Group Chat Analytics Modal.
   */
  async openDmScoreCard(convId, anchorEl = null) {
    this.closeScoreCard();
    const cleanConvId = (convId || '').toLowerCase().trim();
    const currentUser = await window.bondStorage.getCurrentUser();
    const settings = await window.bondStorage.getSettings();
    const conv = (await window.bondStorage.getDmConversation(cleanConvId)) || {
      convId: cleanConvId,
      isGroup: /^\d+$/.test(cleanConvId),
      title: cleanConvId,
      participants: [cleanConvId],
      sentCount: 0,
      receivedCount: 0,
      totalCount: 0,
      bondScore: 0,
      dailyStreak: 0
    };

    const isGroup = !!conv.isGroup;
    let participantHandle = null;
    let publicUser = null;
    let combined = null;

    if (!isGroup) {
      participantHandle = conv.participants && conv.participants.length > 0
        ? conv.participants.find(p => p !== currentUser) || conv.participants[0]
        : cleanConvId.replace(/^@/, '');
      publicUser = await window.bondStorage.getUser(participantHandle);
      combined = BondScoring.calculateCombinedRelationship(publicUser, conv, settings);
    }

    const modal = document.createElement('div');
    modal.className = 'bond-modal-backdrop';
    modal.dataset.dmConv = cleanConvId;
    if (settings && settings.theme && settings.theme !== 'system') {
      modal.setAttribute('data-theme', settings.theme);
    }
    this.activeModal = modal;

    let modalBodyHtml = '';
    if (isGroup) {
      const energyLevel = conv.groupEnergyLevel || BondScoring.getGroupEnergyLevel(conv.groupEnergyScore || 0);
      const energyScore = Math.round(conv.groupEnergyScore || 0);
      const activeMembers = (conv.energyMetrics && conv.energyMetrics.activeMembers) || [];

      modalBodyHtml = `
        <div class="bond-card" role="dialog" aria-modal="true">
          <div class="bond-card-header">
            <div class="bond-card-user">
              <div class="bond-avatar-placeholder" style="background: linear-gradient(135deg, #10b981, #3b82f6);">👥</div>
              <div class="bond-user-meta">
                <div class="bond-display-name-row">
                  <span class="bond-display-name">${this.escapeHtml(conv.title || 'Group Chat')}</span>
                  <span class="bond-energy-tag bond-energy-${energyLevel.id}">${energyLevel.emoji} ${energyLevel.name}</span>
                </div>
                <div class="bond-handle">${conv.participants ? conv.participants.length : activeMembers.length} participants</div>
              </div>
            </div>
            <button class="bond-close-btn" title="Close">&times;</button>
          </div>

          <div class="bond-score-hero">
            <div class="bond-gauge-wrapper">
              <svg class="bond-gauge-svg" viewBox="0 0 100 100">
                <circle class="bond-gauge-bg" cx="50" cy="50" r="42" />
                <circle class="bond-gauge-val" cx="50" cy="50" r="42" style="stroke: ${energyLevel.color}; stroke-dashoffset: ${264 - (264 * energyScore) / 100};" />
              </svg>
              <div class="bond-gauge-center">
                <span class="bond-gauge-score" style="color: ${energyLevel.color};">${energyScore}</span>
                <span class="bond-gauge-label">ENERGY</span>
              </div>
            </div>
            <div class="bond-hero-meta">
              <div class="bond-hero-status" style="color: ${energyLevel.color}; font-weight: 700; font-size: 14px;">
                ${energyLevel.emoji} ${energyLevel.name} Discussion
              </div>
              <div class="bond-hero-desc" style="font-size: 12px; opacity: 0.8; margin-top: 4px;">
                ${energyLevel.description}
              </div>
              ${conv.isDying ? `
                <div class="bond-warning-banner" style="margin-top: 8px;">
                  <span class="bond-warning-icon">⚠️</span>
                  <div><strong>Chat is going quiet!</strong> Not enough recent messages to stay Active.</div>
                </div>
              ` : ''}
            </div>
          </div>

          <div class="bond-section-title">🏆 Most Active Members</div>
          <div class="bond-group-members-list">
            ${activeMembers.length > 0 ? activeMembers.slice(0, 6).map((m, idx) => `
              <div class="bond-group-member-row">
                <span class="bond-member-rank">#${idx + 1}</span>
                <span class="bond-member-handle">@${this.escapeHtml(m.handle)}</span>
                <div class="bond-member-bar-wrap">
                  <div class="bond-member-bar" style="width: ${m.share}%;"></div>
                </div>
                <span class="bond-member-count">${m.count} msgs (${m.share}%)</span>
              </div>
            `).join('') : '<div class="bond-empty-text">No active member data yet.</div>'}
          </div>
        </div>
      `;
    } else {
      const rank = conv.rank || BondScoring.getDmRank(conv.bondScore || 0);
      const scoreVal = Math.round(conv.bondScore || 0);
      const totalCount = conv.totalCount || 0;
      const sentCount = conv.sentCount || 0;
      const receivedCount = conv.receivedCount || 0;
      const sentPct = conv.sentPercent ?? (totalCount > 0 ? Math.round((sentCount / totalCount) * 100) : 50);
      const recvPct = 100 - sentPct;

      const details = conv.participantDetails && participantHandle && conv.participantDetails[participantHandle];
      const displayName = details ? details.displayName : (publicUser ? publicUser.displayName : participantHandle);
      const avatarUrl = details ? details.avatarUrl : (publicUser ? publicUser.avatarUrl : '');

      modalBodyHtml = `
        <div class="bond-card" role="dialog" aria-modal="true">
          <div class="bond-card-header">
            <div class="bond-card-user">
              ${avatarUrl ? `<img class="bond-avatar" src="${this.escapeHtml(avatarUrl)}" alt="${this.escapeHtml(displayName)}"/>` : `<div class="bond-avatar-placeholder">${participantHandle ? participantHandle.charAt(0).toUpperCase() : '?'}</div>`}
              <div class="bond-user-meta">
                <div class="bond-display-name-row">
                  <span class="bond-display-name">${this.escapeHtml(displayName || participantHandle)}</span>
                  <span class="bond-rank-tag bond-rank-${rank.id}">${rank.emoji} ${rank.name}</span>
                </div>
                <div class="bond-handle">@${this.escapeHtml(participantHandle || cleanConvId)} <span class="bond-viewing-account" style="font-size: 11px; opacity: 0.7; margin-left: 6px;">(1:1 Private DM)</span></div>
              </div>
            </div>
            <button class="bond-close-btn" title="Close">&times;</button>
          </div>

          <div class="bond-score-hero">
            <div class="bond-gauge-wrapper">
              <svg class="bond-gauge-svg" viewBox="0 0 100 100">
                <circle class="bond-gauge-bg" cx="50" cy="50" r="42" />
                <circle class="bond-gauge-val" cx="50" cy="50" r="42" style="stroke: ${rank.color}; stroke-dashoffset: ${264 - (264 * scoreVal) / 100};" />
              </svg>
              <div class="bond-gauge-center">
                <span class="bond-gauge-score" style="color: ${rank.color};">${scoreVal}</span>
                <span class="bond-gauge-label">BOND</span>
              </div>
            </div>
            <div class="bond-hero-meta">
              <div class="bond-hero-status" style="color: ${rank.color}; font-weight: 700; font-size: 14px;">
                ${rank.emoji} Level ${rank.level}: ${rank.name}
              </div>
              <div class="bond-hero-desc" style="font-size: 12px; opacity: 0.8; margin-top: 4px;">
                ${rank.description}
              </div>
              ${conv.nextRank ? `
                <div class="bond-next-rank-badge" style="margin-top: 8px;">
                  <span>⚡ <strong>${conv.pointsToNext} pts</strong> to reach ${conv.nextRank.emoji} ${conv.nextRank.name}</span>
                </div>
              ` : `
                <div class="bond-next-rank-badge max-rank" style="margin-top: 8px;">
                  <span>👑 Max Relationship Level Achieved!</span>
                </div>
              `}
            </div>
          </div>

          <div class="bond-rank-progression">
            <div class="bond-progression-track">
              <div class="bond-progression-fill" style="width: ${scoreVal}%; background: ${rank.color};"></div>
            </div>
            <div class="bond-progression-steps">
              <span class="bond-prog-step ${scoreVal >= 0 ? 'active' : ''}">👋 Acquaintance</span>
              <span class="bond-prog-step ${scoreVal >= 26 ? 'active' : ''}">🤝 Friend</span>
              <span class="bond-prog-step ${scoreVal >= 51 ? 'active' : ''}">🔥 Close Friend</span>
              <span class="bond-prog-step ${scoreVal >= 76 ? 'active' : ''}">💖 Bestie</span>
              <span class="bond-prog-step ${scoreVal >= 91 ? 'active' : ''}">👑 Ride or Die</span>
            </div>
          </div>

          <div class="bond-balance-card">
            <div class="bond-balance-header">
              <span>⚖️ Conversation Balance</span>
              <span class="bond-balance-ratio-badge">${conv.balanceRatio >= 0.75 ? 'Balanced 50/50' : conv.sentPercent > 65 ? 'You Lead 📤' : 'They Lead 📥'}</span>
            </div>
            <div class="bond-balance-bar-wrap">
              <div class="bond-balance-fill-sent" style="width: ${sentPct}%;"></div>
              <div class="bond-balance-fill-recv" style="width: ${recvPct}%;"></div>
            </div>
            <div class="bond-balance-metrics">
              <span>📤 Sent: <strong>${sentCount}</strong> (${sentPct}%)</span>
              <span>📥 Received: <strong>${receivedCount}</strong> (${recvPct}%)</span>
            </div>
          </div>

          <div class="bond-dm-metric-grid">
            <div class="bond-dm-metric-box">
              <span class="bond-dm-metric-label">⚡ Reply Speed</span>
              <strong class="bond-dm-metric-val">${conv.formattedMedianReply || 'Instant'}</strong>
              <span class="bond-dm-metric-sub">Median turnaround</span>
            </div>
            <div class="bond-dm-metric-box">
              <span class="bond-dm-metric-label">📬 Reply Rate</span>
              <strong class="bond-dm-metric-val">${conv.replyRate ?? 100}%</strong>
              <span class="bond-dm-metric-sub">Inbound answered</span>
            </div>
            <div class="bond-dm-metric-box">
              <span class="bond-dm-metric-label">🔥 Daily Streak</span>
              <strong class="bond-dm-metric-val">${conv.dailyStreak || 0}d</strong>
              <span class="bond-dm-metric-sub">Consecutive days</span>
            </div>
          </div>

          <div class="bond-section-title" style="margin-top: 14px;">💭 Chat Memories & Milestones</div>
          <div class="bond-memories-card">
            <div class="bond-memory-stats-grid">
              <div class="bond-mem-stat-item">
                <span class="bond-mem-stat-label">📅 Memory Since</span>
                <strong class="bond-mem-stat-val">${new Date(conv.firstSeenTimestamp || conv.lastMessageTimestamp || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</strong>
              </div>
              <div class="bond-mem-stat-item">
                <span class="bond-mem-stat-label">💬 Lifetime Messages</span>
                <strong class="bond-mem-stat-val">${conv.lifetimeTotal || conv.totalCount || 0} msgs</strong>
              </div>
              <div class="bond-mem-stat-item">
                <span class="bond-mem-stat-label">🏆 Peak Relationship</span>
                <strong class="bond-mem-stat-val">${(conv.highestRankAchieved && conv.highestRankAchieved.name) || rank.name}</strong>
              </div>
              <div class="bond-mem-stat-item">
                <span class="bond-mem-stat-label">🔥 Longest Streak</span>
                <strong class="bond-mem-stat-val">${conv.allTimeLongestStreak || conv.dailyStreak || 0}d record</strong>
              </div>
            </div>

            <div class="bond-memories-timeline">
              ${(conv.memories && conv.memories.length > 0) ? conv.memories.slice().reverse().slice(0, 5).map(m => `
                <div class="bond-timeline-item">
                  <span class="bond-timeline-badge">${m.badge || '✨'}</span>
                  <div class="bond-timeline-content">
                    <div class="bond-timeline-title-row">
                      <span class="bond-timeline-title">${this.escapeHtml(m.title)}</span>
                      <span class="bond-timeline-time">${new Date(m.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                    </div>
                    <div class="bond-timeline-desc">${this.escapeHtml(m.description)}</div>
                  </div>
                </div>
              `).join('') : `
                <div class="bond-timeline-empty">
                  <span class="bond-empty-icon">💭</span>
                  <span>BondScore is actively logging chat memories and milestone moments!</span>
                </div>
              `}
            </div>
          </div>

          ${combined ? `
            <div class="bond-combined-card">
              <div class="bond-combined-header">
                <span class="bond-combined-title">🌟 Overall Relationship Strength</span>
                <span class="bond-combined-badge">${combined.combinedScore} / 100</span>
              </div>
              <div class="bond-combined-desc">
                Public Timeline: <strong>${combined.publicScore}</strong> (${combined.publicTier.name}) + Private DM: <strong>${combined.dmScore}</strong> (${combined.dmRank.name})
                ${combined.synergy ? '<br><span class="bond-synergy-pill">⚡ Intimacy Synergy Active (+8 pts)</span>' : ''}
              </div>
            </div>
          ` : ''}

          ${conv.isFading ? `
            <div class="bond-warning-banner" style="margin-top: 12px;">
              <span class="bond-warning-icon">🧊</span>
              <div>
                <strong>High-bond conversation going cold!</strong>
                <div>No messages in ${conv.daysSinceLast} days. Reach out and keep the spark alive!</div>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }

    modal.innerHTML = modalBodyHtml;

    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.closeScoreCard();
    });
    const closeBtn = modal.querySelector('.bond-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeScoreCard());

    this.modalKeydownHandler = (e) => {
      if (e.key === 'Escape') this.closeScoreCard();
    };
    window.addEventListener('keydown', this.modalKeydownHandler);

    document.body.appendChild(modal);
  }
}

window.bondUI = new BondUI();
