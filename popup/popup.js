/**
 * BondScore for X - Extension Popup Logic (v1.1)
 * Controls leaderboard, filter pills, solar system orbit view, graphic exporter,
 * settings, UPI/monetization setup, and local backup.
 */

let cachedUsers = [];
let currentFilter = 'all';
let currentUsername = 'you';

document.addEventListener('DOMContentLoaded', async () => {
  await window.bondStorage.init();

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
        }
      }
    });
  });

  // Load Initial State
  await loadCurrentUserTag();
  await loadLeaderboard();
  await loadSettingsForm();
  renderRadarTab();
  setupFilterPills();
  setupSearchHandler();
  setupOrbitExporter();
  setupTwoHandleLookup();

  // Storage change listener to keep popup in sync live with browser actions
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(() => {
      loadLeaderboard();
      const activeTab = document.querySelector('.tab-btn.active');
      if (activeTab && activeTab.dataset.tab === 'tab-orbit') {
        renderOrbitCanvas();
      } else if (activeTab && activeTab.dataset.tab === 'tab-radar') {
        renderRadarTab();
      }
    });
  }
});

async function loadCurrentUserTag() {
  const userTag = document.getElementById('current-user-tag');
  const currentUser = await window.bondStorage.getCurrentUser();
  if (currentUser) {
    currentUsername = currentUser;
    userTag.innerText = `@${currentUser}`;
  } else {
    userTag.innerText = 'Browse X to auto-detect';
  }
}

async function loadLeaderboard() {
  const totalAccountsEl = document.getElementById('stat-total-accounts');
  const topScoreEl = document.getElementById('stat-top-score');
  const mutualRepliesEl = document.getElementById('stat-mutual-replies');

  cachedUsers = await window.bondStorage.getAllUsers();
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
  const sSent = (u.stats && ((u.stats.repliesSent || 0) + (u.stats.dmsSent || 0) + (u.stats.likes || 0))) || 0;
  const sRecv = (u.stats && ((u.stats.repliesReceived || 0) + (u.stats.dmsReceived || 0))) || 0;
  return BondScoring.calculateCRMStatus(u.currentScore || 0, sSent, sRecv, u.streakDays || 0);
}

function applyFilterAndRender() {
  const q = (document.getElementById('mutual-search-input').value || '').toLowerCase().trim();
  let list = cachedUsers;

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
      const s = ((u.stats && u.stats.repliesSent) || 0) + ((u.stats && u.stats.dmsSent) || 0) + ((u.stats && u.stats.likes) || 0);
      const r = ((u.stats && u.stats.repliesReceived) || 0) + ((u.stats && u.stats.dmsReceived) || 0);
      return r > 0 && (r >= s || r >= 2);
    });
  } else if (currentFilter === 'dormant') {
    const now = Date.now();
    list = list.filter(u => {
      const days = Math.floor((now - (u.lastInteraction || now)) / 86400000);
      const s = ((u.stats && u.stats.repliesSent) || 0) + ((u.stats && u.stats.dmsSent) || 0) + ((u.stats && u.stats.likes) || 0);
      const r = ((u.stats && u.stats.repliesReceived) || 0) + ((u.stats && u.stats.dmsReceived) || 0);
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

    item.innerHTML = `
      <div class="mutual-user-info">
        <div class="mutual-avatar-wrap">
          ${u.avatarUrl
            ? `<img class="mutual-avatar" src="${escapeHtml(u.avatarUrl)}" alt="${escapeHtml(u.displayName || u.handle)}">`
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

    // Click card to open X profile in new tab
    item.addEventListener('click', () => {
      chrome.tabs.create({ url: `https://x.com/${u.handle}` });
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
function renderOrbitCanvas() {
  const canvas = document.getElementById('orbit-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const centerX = w / 2;
  const centerY = h / 2;

  // Clear & Cosmic Space Background
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, w, h);

  // Background stars
  drawStarfield(ctx, w, h, 60);

  // Orbit Radii
  const rCore = 52;
  const rClose = 100;
  const rCasual = 150;

  // Draw concentric orbit tracks
  drawOrbitRing(ctx, centerX, centerY, rCasual, '#794bc4', 'Mutuals & Acquaintances (1-34)');
  drawOrbitRing(ctx, centerX, centerY, rClose, '#1d9bf0', 'Close Conversants (35-69)');
  drawOrbitRing(ctx, centerX, centerY, rCore, '#f91880', 'Core Bonds (70+)');

  // Draw Sun / Center User
  drawCenterSun(ctx, centerX, centerY, currentUsername);

  // Group mutuals by inclusive tier rings - all tracked mutuals appear and persist!
  const coreUsers = cachedUsers.filter(u => (u.currentScore || 0) >= 70);
  const closeUsers = cachedUsers.filter(u => (u.currentScore || 0) >= 35 && (u.currentScore || 0) < 70);
  const casualUsers = cachedUsers.filter(u => (u.currentScore || 0) < 35);

  distributePlanetsOnRing(ctx, coreUsers, centerX, centerY, rCore, '#f91880');
  distributePlanetsOnRing(ctx, closeUsers, centerX, centerY, rClose, '#1d9bf0');
  distributePlanetsOnRing(ctx, casualUsers, centerX, centerY, rCasual, '#794bc4');

  // If no mutuals, draw empty state tip
  if (cachedUsers.length === 0) {
    ctx.fillStyle = '#71767b';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Interact with accounts on X to populate your orbit', centerX, centerY + 90);
  }
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

function drawOrbitRing(ctx, cx, cy, radius, color, label) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.restore();
}

function drawCenterSun(ctx, cx, cy, username) {
  ctx.save();

  // Outer glow
  const grad = ctx.createRadialGradient(cx, cy, 6, cx, cy, 26);
  grad.addColorStop(0, '#ffd400');
  grad.addColorStop(0.5, 'rgba(255, 122, 0, 0.4)');
  grad.addColorStop(1, 'rgba(255, 122, 0, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.fill();

  // Core sphere
  ctx.fillStyle = '#ff7a00';
  ctx.beginPath();
  ctx.arc(cx, cy, 14, 0, Math.PI * 2);
  ctx.fill();

  // Text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('YOU', cx, cy);

  ctx.restore();
}

// Cache loaded avatar images for instant canvas rendering
const pfpCache = new Map();

function getLoadedPfp(url, onLoadedCallback) {
  if (!url) return null;
  if (pfpCache.has(url)) {
    const img = pfpCache.get(url);
    return (img.complete && img.naturalWidth > 0) ? img : null;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  img.onload = () => {
    if (onLoadedCallback) onLoadedCallback();
  };
  pfpCache.set(url, img);
  return null;
}

function distributePlanetsOnRing(ctx, users, cx, cy, radius, color) {
  if (!users || users.length === 0) return;
  const count = users.length;
  const angleStep = (Math.PI * 2) / count;
  const offset = radius * 0.1;
  const pfpRadius = 13; // 26px diameter for clear avatar visibility

  users.forEach((u, i) => {
    const angle = i * angleStep + offset;
    const px = cx + Math.cos(angle) * radius;
    const py = cy + Math.sin(angle) * radius;

    ctx.save();

    // 1. Accent border ring in tier color
    ctx.beginPath();
    ctx.arc(px, py, pfpRadius + 1.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // 2. Profile Picture (PFP) or initial fallback
    const pfp = getLoadedPfp(u.avatarUrl, () => {
      const canvas = document.getElementById('orbit-canvas');
      if (canvas && canvas.offsetParent !== null) {
        renderOrbitCanvas();
      }
    });

    if (pfp) {
      // Draw circular clipped avatar PFP
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, pfpRadius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(pfp, px - pfpRadius, py - pfpRadius, pfpRadius * 2, pfpRadius * 2);
      ctx.restore();
    } else {
      // Fallback: dark planet with colored initial
      ctx.beginPath();
      ctx.arc(px, py, pfpRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#16181c';
      ctx.fill();

      ctx.fillStyle = color;
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const initial = (u.displayName || u.handle || 'X').charAt(0).toUpperCase();
      ctx.fillText(initial, px, py);
    }

    // 3. Planet handle & score pill
    ctx.font = 'bold 9px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    const labelY = py > cy ? py + pfpRadius + 11 : py - pfpRadius - 4;
    ctx.fillText(`@${u.handle.slice(0, 9)} (${Math.round(u.currentScore || 0)})`, px, labelY);

    ctx.restore();
  });
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

    // Radii
    const rCore = 140;
    const rClose = 260;
    const rCasual = 380;

    drawOrbitRing(ctx, cx, cy, rCasual, '#794bc4', 'Mutuals & Acquaintances');
    drawOrbitRing(ctx, cx, cy, rClose, '#1d9bf0', 'Close Conversants');
    drawOrbitRing(ctx, cx, cy, rCore, '#f91880', 'Core Bonds');

    // Sun
    ctx.save();
    const sunGrad = ctx.createRadialGradient(cx, cy, 15, cx, cy, 60);
    sunGrad.addColorStop(0, '#ffd400');
    sunGrad.addColorStop(0.5, 'rgba(255, 122, 0, 0.4)');
    sunGrad.addColorStop(1, 'rgba(255, 122, 0, 0)');
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 60, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff7a00';
    ctx.beginPath();
    ctx.arc(cx, cy, 32, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`@${currentUsername.slice(0, 8)}`, cx, cy);
    ctx.restore();

    // Planets - inclusive rings for all tracked accounts
    const coreUsers = cachedUsers.filter(u => (u.currentScore || 0) >= 70);
    const closeUsers = cachedUsers.filter(u => (u.currentScore || 0) >= 35 && (u.currentScore || 0) < 70);
    const casualUsers = cachedUsers.filter(u => (u.currentScore || 0) < 35);

    renderHighResPlanets(ctx, coreUsers, cx, cy, rCore, '#f91880');
    renderHighResPlanets(ctx, closeUsers, cx, cy, rClose, '#1d9bf0');
    renderHighResPlanets(ctx, casualUsers, cx, cy, rCasual, '#794bc4');

    // Watermark & Creator Credit
    ctx.fillStyle = '#71767b';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`BondScore for X • Created by @MaserSuspended • ${new Date().toLocaleDateString()}`, cx, 960);

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
  if (!users || users.length === 0) return;
  const count = users.length;
  const angleStep = (Math.PI * 2) / count;
  const pfpRadius = 22;

  users.forEach((u, i) => {
    const angle = i * angleStep;
    const px = cx + Math.cos(angle) * radius;
    const py = cy + Math.sin(angle) * radius;

    ctx.save();
    // Glowing border ring in tier color
    ctx.beginPath();
    ctx.arc(px, py, pfpRadius + 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    const pfp = getLoadedPfp(u.avatarUrl);
    if (pfp) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, pfpRadius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(pfp, px - pfpRadius, py - pfpRadius, pfpRadius * 2, pfpRadius * 2);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(px, py, pfpRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#16181c';
      ctx.fill();

      ctx.fillStyle = color;
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const initial = (u.displayName || u.handle || 'X').charAt(0).toUpperCase();
      ctx.fillText(initial, px, py);
    }

    // Label
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    const labelY = py > cy ? py + pfpRadius + 16 : py - pfpRadius - 6;
    ctx.fillText(`@${u.handle} (${Math.round(u.currentScore || 0)})`, px, labelY);

    ctx.restore();
  });
}

/**
 * ⚙️ Settings Form Handler
 */
async function loadSettingsForm() {
  const settings = await window.bondStorage.getSettings();

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

  halfLifeInput.value = settings.decayHalfLifeDays || 14;
  halfLifeVal.innerText = `${halfLifeInput.value} days`;

  graceInput.value = settings.gracePeriodDays || 2;
  graceVal.innerText = `${graceInput.value} days`;

  const weights = settings.weights || {};
  weightMutualInput.value = weights.mutualReply || 15;
  weightMutualVal.innerText = `${weightMutualInput.value} pts`;

  weightReplyInput.value = weights.replySent || 8;
  weightReplyVal.innerText = `${weightReplyInput.value} pts`;

  weightLikeInput.value = weights.like || 2;
  weightLikeVal.innerText = `${weightLikeInput.value} pts`;

  halfLifeInput.addEventListener('input', () => halfLifeVal.innerText = `${halfLifeInput.value} days`);
  graceInput.addEventListener('input', () => graceVal.innerText = `${graceInput.value} days`);
  weightMutualInput.addEventListener('input', () => weightMutualVal.innerText = `${weightMutualInput.value} pts`);
  weightReplyInput.addEventListener('input', () => weightReplyVal.innerText = `${weightReplyInput.value} pts`);
  weightLikeInput.addEventListener('input', () => weightLikeVal.innerText = `${weightLikeInput.value} pts`);

  const saveBtn = document.getElementById('save-settings-btn');
  saveBtn.addEventListener('click', async () => {
    saveBtn.innerText = 'Saving...';
    const current = await window.bondStorage.getSettings();
    await window.bondStorage.updateSettings({
      decayHalfLifeDays: parseInt(halfLifeInput.value, 10),
      gracePeriodDays: parseInt(graceInput.value, 10),
      weights: {
        ...(current.weights || {}),
        mutualReply: parseInt(weightMutualInput.value, 10),
        replySent: parseInt(weightReplyInput.value, 10),
        replyReceived: parseInt(weightReplyInput.value, 10),
        like: parseInt(weightLikeInput.value, 10)
      }
    });
    saveBtn.innerText = '✓ Preferences Saved';
    setTimeout(() => {
      saveBtn.innerText = 'Save Preferences';
    }, 1500);
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
  const memory = BondScoring.analyzeEngagementMemory(cachedUsers);

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
          <div class="radar-item" style="cursor:pointer;" title="Click to view @${escapeHtml(u.handle)} on X">
            <div class="radar-item-left" onclick="chrome.tabs.create({url:'https://x.com/${escapeHtml(u.handle)}'})">
              ${u.avatarUrl ? `<img class="radar-item-avatar" src="${escapeHtml(u.avatarUrl)}" alt="">` : `<div class="radar-item-avatar" style="background:#ec4899;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${escapeHtml(u.handle.charAt(0).toUpperCase())}</div>`}
              <span class="radar-item-handle">@${escapeHtml(u.handle)}</span>
              <span class="popup-crm-pill ${crm.id}">${crm.label}</span>
            </div>
            <span class="radar-supporter-val">📥 ${u.received} received</span>
          </div>
        `;
      }).join('');
    } else {
      supportersList.innerHTML = `<div class="radar-empty">No supporter data yet. Interact on X to build memory!</div>`;
    }
  }

  // 2. Outbound Focus (Who you engage with most)
  if (outboundList) {
    const topOutbound = memory.topEngagedByYou.slice(0, 5);
    if (topOutbound.length > 0) {
      outboundList.innerHTML = topOutbound.map(u => `
        <div class="radar-item" style="cursor:pointer;" title="Click to view @${escapeHtml(u.handle)} on X">
          <div class="radar-item-left" onclick="chrome.tabs.create({url:'https://x.com/${escapeHtml(u.handle)}'})">
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
    const signalUsers = cachedUsers.filter(u => u.signals && (u.signals.isBlocked || u.signals.isMutual || u.signals.theyFollowYou !== null)).slice(0, 6);
    if (signalUsers.length > 0) {
      signalsRadarList.innerHTML = signalUsers.map(u => {
        const fRel = typeof BondScoring !== 'undefined' && BondScoring.getFollowRelationship
          ? BondScoring.getFollowRelationship(u.signals)
          : null;
        let label = fRel ? fRel.badgeText : '🤝 Mutual Follow';
        let color = fRel ? fRel.color : '#00ba7c';
        return `
          <div class="radar-item" style="cursor:pointer;" title="Click to view @${escapeHtml(u.handle)} on X" onclick="chrome.tabs.create({url:'https://x.com/${escapeHtml(u.handle)}'})">
            <div class="radar-item-left">
              ${u.avatarUrl ? `<img class="radar-item-avatar" src="${escapeHtml(u.avatarUrl)}" alt="">` : `<div class="radar-item-avatar" style="background:#1d9bf0;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${escapeHtml(u.handle.charAt(0).toUpperCase())}</div>`}
              <span class="radar-item-handle">@${escapeHtml(u.handle)}</span>
            </div>
            <span style="font-size:10px;font-weight:700;color:${color};">${label}</span>
          </div>
        `;
      }).join('');
    } else {
      signalsRadarList.innerHTML = `<div class="radar-empty">No relationship signals detected yet. Visit profiles on X to observe!</div>`;
    }
  }

  // 5. Active streaks
  if (streaksList) {
    const streakUsers = cachedUsers.filter(u => (u.streakDays || 0) > 0).sort((a, b) => (b.streakDays || 0) - (a.streakDays || 0));
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
