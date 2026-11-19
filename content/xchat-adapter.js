/**
 * BondScore - XChat (X Direct Messages) Adapter (v1.4.0)
 *
 * X replaced the classic /messages surface with the XChat app at /i/chat.
 * XChat renders inside an open shadow root, so the legacy detectors (which
 * query the light DOM) never see a conversation. This adapter observes that
 * shadow root and records DM metadata only:
 *
 *   - participants / handles (public profile links)
 *   - direction (inbound vs outbound)
 *   - message count, order and timing
 *
 * Message bodies, search text and composer contents are never read, parsed
 * or stored. Nothing here sends, likes, follows or types on the user's behalf.
 */

(function () {
  if (window.__bondScoreXChatAdapterLoaded) return;
  window.__bondScoreXChatAdapterLoaded = true;

  const CONVERSATION_PREFIX = 'dm-conversation-item-';
  const MESSAGE_PREFIX = 'message-';
  const MESSAGE_TEXT_PREFIX = 'message-text-';

  /** `/i/chat/123-456` -> `123:456`, `/i/chat/g123` -> `g123`. */
  function canonicalConversationId(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return '';
    if (value.startsWith('g')) return value;
    return value.replace(/-/g, ':');
  }

  /** XChat URL id (dash for 1:1, g-prefixed for groups). */
  function conversationUrlId(convId) {
    const value = String(convId || '').trim();
    if (!value) return '';
    return value.includes(':') ? value.replace(/:/g, '-') : value;
  }

  class XChatAdapter {
    constructor() {
      this.enabled = false;
      this.started = false;
      this.host = null;
      this.shadow = null;
      this.docObserver = null;
      this.shadowObserver = null;
      this.interval = null;
      this.scanTimer = null;
      this.stylesApplied = false;
      this.inFlight = false;
      this.lastInboxScan = 0;
      this.lastPath = '';
    }

    setEnabled(value) {
      const next = !!value;
      if (next === this.enabled) {
        if (next && !this.started) this.start();
        return;
      }
      this.enabled = next;
      if (next) this.start();
      else this.stop();
    }

    start() {
      if (this.started) return;
      this.started = true;
      this.lastPath = location.pathname;

      this.docObserver = new MutationObserver(() => this._tryAttach());
      this.docObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });

      // Fetch official inbox bootstrap state in background if cookies are accessible
      this.syncInboxFromApi().catch(() => {});

      // XChat mounts lazily and can be recreated on soft navigation. A light
      // poll makes sure we re-bind without depending on a specific mutation.
      this.interval = setInterval(() => {
        this._tryAttach();
        if (location.pathname !== this.lastPath) {
          this.lastPath = location.pathname;
          this._scheduleScan();
        }
      }, 1200);

      this._tryAttach();
    }

    stop() {
      if (!this.started) return;
      this.started = false;
      this.enabled = false;
      if (this.interval) clearInterval(this.interval);
      if (this.scanTimer) clearTimeout(this.scanTimer);
      this.interval = null;
      this.scanTimer = null;
      if (this.docObserver) this.docObserver.disconnect();
      this.docObserver = null;
      this._detachShadow();
    }

    _detachShadow() {
      if (this.shadowObserver) this.shadowObserver.disconnect();
      this.shadowObserver = null;
      this.shadow = null;
      this.host = null;
      this.stylesApplied = false;
    }

    _tryAttach() {
      if (!this.enabled) return;
      const host = document.querySelector('[data-testid="xchatEmbedRoute"]');
      if (!host || !host.shadowRoot) return;
      if (this.host === host && this.shadow === host.shadowRoot) return;

      this._detachShadow();
      this.host = host;
      this.shadow = host.shadowRoot;
      this._applyStyles(this.shadow);

      this.shadowObserver = new MutationObserver(() => this._scheduleScan());
      this.shadowObserver.observe(this.shadow, { childList: true, subtree: true });
      this._scheduleScan();
    }

    /**
     * Content-script CSS does not cross the shadow boundary, so adopt the
     * badge stylesheet inside this root. Constructed sheets are not affected
     * by the page's style-src policy.
     */
    _applyStyles(shadow) {
      if (this.stylesApplied || !shadow) return;
      this.stylesApplied = true;
      try {
        const url = chrome.runtime.getURL('content/styles.css');
        fetch(url)
          .then((res) => (res.ok ? res.text() : ''))
          .then((css) => {
            if (!css || !this.shadow) return;
            if (typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype) {
              const sheet = new CSSStyleSheet();
              sheet.replaceSync(css);
              const existing = Array.from(this.shadow.adoptedStyleSheets || []);
              this.shadow.adoptedStyleSheets = existing.concat(sheet);
            } else {
              const style = document.createElement('style');
              style.textContent = css;
              this.shadow.appendChild(style);
            }
          })
          .catch(() => {});
      } catch (e) {
        // Styling is a progressive enhancement; tracking still works.
      }
    }

    _scheduleScan() {
      if (!this.enabled || this.scanTimer) return;
      this.scanTimer = setTimeout(() => {
        this.scanTimer = null;
        this.scan().catch(() => {});
      }, 250);
    }

    async scan() {
      if (!this.enabled || !this.shadow || this.inFlight) return;
      if (!window.bondStorage) return;

      this.inFlight = true;
      try {
        const settings = await window.bondStorage.getSettings();
        if (settings.trackDirectMessages === false) return;
        if (window.BondPlatforms && !window.BondPlatforms.isFeatureEnabled(settings, 'x', 'dms')) return;

        let currentUser = (window.interactionDetector && window.interactionDetector.currentUser)
          || window.bondStorage.currentUser
          || '';
        if (!currentUser && window.interactionDetector && window.interactionDetector.detectCurrentUser) {
          currentUser = (await window.interactionDetector.detectCurrentUser()) || '';
        }
        if (!currentUser) {
          currentUser = (await window.bondStorage.getCurrentUser()) || '';
        }

        // Save the active thread first, then badge the inbox in the same pass,
        // otherwise a freshly recorded conversation gets no badge until the
        // next DOM mutation.
        await this._scanActiveThread(currentUser);
        await this._scanInbox(currentUser);
      } finally {
        this.inFlight = false;
      }
    }

    _extractRowActivity(rowElement) {
      const fullText = (rowElement && (rowElement.innerText || rowElement.textContent) || '').trim();
      let timestampStr = '';
      let ageMinutes = 999999;

      const timeEl = rowElement ? rowElement.querySelector('time') : null;
      if (timeEl) {
        const dt = timeEl.getAttribute('datetime');
        if (dt) {
          const parsed = Date.parse(dt);
          if (!isNaN(parsed) && parsed > 0) {
            ageMinutes = Math.max(0, (Date.now() - parsed) / 60000);
          }
        }
        timestampStr = (timeEl.innerText || timeEl.textContent || '').trim();
      }

      if (!timestampStr) {
        const lines = fullText.split('\n').map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (/^(now|just now|\d+[smhdw])$/i.test(line)) {
            timestampStr = line;
            break;
          }
          if (/yesterday/i.test(line)) {
            timestampStr = 'yesterday';
            break;
          }
        }
      }

      if (timestampStr) {
        const clean = timestampStr.toLowerCase();
        if (clean === 'now' || clean === 'just now') {
          ageMinutes = 0.5;
        } else if (clean === 'yesterday') {
          ageMinutes = 1440;
        } else {
          const match = clean.match(/^(\d+)([smhdw])$/);
          if (match) {
            const val = parseInt(match[1], 10);
            const unit = match[2];
            if (unit === 's') ageMinutes = val / 60;
            else if (unit === 'm') ageMinutes = val;
            else if (unit === 'h') ageMinutes = val * 60;
            else if (unit === 'd') ageMinutes = val * 1440;
            else if (unit === 'w') ageMinutes = val * 10080;
          }
        }
      }

      const hasUnread = !!(rowElement && rowElement.querySelector(
        '[data-testid="unread-badge"], [aria-label*="unread" i], [style*="background-color: rgb(29, 155, 240)"]'
      ));

      return {
        timestampStr,
        ageMinutes: isNaN(ageMinutes) ? 120 : ageMinutes,
        hasUnread
      };
    }

    async syncInboxFromApi(currentUser) {
      if (this._inboxApiSynced && (Date.now() - this._inboxApiSynced < 60000)) return;
      this._inboxApiSynced = Date.now();
      try {
        if (!currentUser) {
          currentUser = (window.interactionDetector && window.interactionDetector.currentUser)
            || (window.bondStorage && window.bondStorage.currentUser)
            || '';
          if (!currentUser && window.bondStorage && window.bondStorage.getCurrentUser) {
            currentUser = (await window.bondStorage.getCurrentUser()) || '';
          }
        }
        const curUserClean = (currentUser || '').toLowerCase().replace(/^@/, '');

        const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
        const csrfToken = match ? match[1] : null;
        if (!csrfToken) return;

        const url = 'https://x.com/i/api/1.1/dm/inbox_initial_state.json';
        const res = await fetch(url, {
          headers: {
            'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
            'x-csrf-token': csrfToken,
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session'
          },
          credentials: 'include'
        });
        if (!res.ok) return;
        const data = await res.json();
        const state = data && (data.inbox_initial_state || data);
        if (!state) return;

        const userMap = {};
        if (state.users && typeof state.users === 'object') {
          for (const [uid, u] of Object.entries(state.users)) {
            if (u && u.screen_name) {
              const sn = u.screen_name.toLowerCase().trim();
              userMap[uid] = sn;
              const av = u.profile_image_url_https || u.profile_image_url || '';
              if (av && window.bondStorage && window.bondStorage.updateUserAvatarIfMissing) {
                window.bondStorage.updateUserAvatarIfMissing(sn, av, u.name).catch(() => {});
              }
            }
          }
        }

        const convEntries = {};
        if (Array.isArray(state.entries)) {
          for (const item of state.entries) {
            const msg = item.message || item.welcome_message || item;
            if (!msg || !msg.conversation_id) continue;
            const cid = String(msg.conversation_id).toLowerCase().trim();
            if (!convEntries[cid]) convEntries[cid] = [];

            const timestamp = Number(msg.time) || Date.now();
            const senderUid = String(msg.sender_id || '');
            const senderHandle = userMap[senderUid] || null;
            const isOutbound = curUserClean && senderHandle === curUserClean;

            convEntries[cid].push({
              fingerprint: `api_${cid}_${msg.id || timestamp}`,
              direction: isOutbound ? 'outbound' : 'inbound',
              senderHandle: senderHandle !== curUserClean ? senderHandle : null,
              timestamp,
              index: convEntries[cid].length
            });
          }
        }

        if (state.conversations && typeof state.conversations === 'object') {
          for (const [cid, c] of Object.entries(state.conversations)) {
            const cleanId = String(cid).toLowerCase().trim();
            const isGroup = c.type === 'GROUP_DM' || cleanId.startsWith('g');
            const participants = [];
            const participantDetails = {};

            if (Array.isArray(c.participants)) {
              for (const p of c.participants) {
                const pUid = String(p.user_id || '');
                const pH = userMap[pUid];
                if (pH) {
                  const cleanPH = pH.toLowerCase().replace(/^@/, '');
                  if (!curUserClean || cleanPH !== curUserClean) {
                    participants.push(cleanPH);
                    if (state.users && state.users[pUid]) {
                      const uObj = state.users[pUid];
                      participantDetails[cleanPH] = {
                        handle: cleanPH,
                        displayName: uObj.name || cleanPH,
                        avatarUrl: uObj.profile_image_url_https || uObj.profile_image_url || ''
                      };
                    }
                  }
                }
              }
            }

            const existing = await window.bondStorage.getDmConversation(cleanId, false, currentUser);

            let resolvedTitle = c.name || '';
            if (!isGroup) {
              const mutual = participants[0];
              const det = mutual && participantDetails[mutual];
              if (det && det.displayName && !/^\d+$/.test(det.displayName)) {
                resolvedTitle = det.displayName;
              } else if (mutual) {
                resolvedTitle = `@${mutual}`;
              } else if (existing && existing.title && !/^\d+[-:]\d+$/i.test(existing.title) && !/^you (reacted|sent)/i.test(existing.title)) {
                resolvedTitle = existing.title;
              } else {
                resolvedTitle = 'Chat Mutual';
              }
            } else {
              resolvedTitle = resolvedTitle || (existing && existing.title) || 'Group chat';
            }

            await window.bondStorage.saveDmConversation(cleanId, {
              convId: cleanId,
              isGroup,
              title: resolvedTitle,
              participants: participants.length > 0 ? participants : (existing && Array.isArray(existing.participants) ? existing.participants.filter(p => p !== curUserClean && !/^\d+$/.test(p)) : []),
              participantDetails: Object.assign({}, (existing && existing.participantDetails) || {}, participantDetails),
              surface: 'xchat'
            }, currentUser).catch(() => {});

            const entries = convEntries[cleanId];
            if (entries && entries.length > 0) {
              await window.bondStorage.ingestMessageEntries(cleanId, entries, currentUser).catch(() => {});
            }
          }
        }

        this.lastInboxScan = 0;
        this._scheduleScan();
      } catch (err) {
        // Safe progressive enhancement
      }
    }

    async _scanInbox(currentUser) {
      const now = Date.now();
      if (now - this.lastInboxScan < 1000) return;
      this.lastInboxScan = now;

      const rows = this.shadow.querySelectorAll(`[data-testid^="${CONVERSATION_PREFIX}"]`);
      if (!rows || rows.length === 0) return;

      for (const row of rows) {
        try {
          const raw = (row.getAttribute('data-testid') || '').slice(CONVERSATION_PREFIX.length);
          if (!raw) continue;
          const convId = canonicalConversationId(raw);
          const isGroup = convId.startsWith('g');

          const img = row.querySelector('img[src*="profile_images"], [data-testid*="Avatar"] img, img');
          const alt = img && img.alt ? img.alt.trim() : '';
          const rowAvatar = img && /^https?:/i.test(img.src || '') && !img.src.includes('/emoji/') && !img.src.includes('/badge/') ? img.src : '';

          // Parse text lines from row, rejecting timestamps, reaction snippets, and status text
          const rawLines = (row.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
          const isJunkText = (line) => {
            if (!line) return true;
            if (/^(now|just now|\d+[smhdw]|yesterday|·|\.|\u00b7)$/i.test(line)) return true;
            if (/^you (reacted|sent|shared|liked)/i.test(line)) return true;
            if (/^(sent|liked|reacted) a /i.test(line)) return true;
            if (/^(you|them):/i.test(line)) return true;
            if (/^(⚡|🔥|🧊|👑|👏|💬|🤝|💫|❤️)/.test(line)) return true;
            if (/^(bond rank|group vitality|inbound|outbound)/i.test(line)) return true;
            if (/^\d+[-:]\d+$/i.test(line) || /^\d+$/.test(line)) return true;
            return false;
          };

          const validLines = rawLines.filter(l => !isJunkText(l));

          let participantHandle = null;
          let rowDisplayName = '';

          // Extract handle from @mention in row or from profile link
          const handleMatch = (row.innerText || '').match(/@([A-Za-z0-9_]+)/);
          if (handleMatch && (!currentUser || handleMatch[1].toLowerCase() !== currentUser.toLowerCase())) {
            participantHandle = handleMatch[1].toLowerCase();
          } else {
            const profileLink = row.querySelector('a[href^="/"]:not([href*="/messages"]):not([href*="/i/chat"]):not([href*="/home"]):not([href*="/notifications"])');
            if (profileLink) {
              const hrefMatch = (profileLink.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]+)$/);
              if (hrefMatch && (!currentUser || hrefMatch[1].toLowerCase() !== currentUser.toLowerCase())) {
                participantHandle = hrefMatch[1].toLowerCase();
              }
            }
          }

          if (!participantHandle && alt && !alt.includes(' ') && !/^user avatar$/i.test(alt) && (!currentUser || alt.toLowerCase() !== currentUser.toLowerCase())) {
            participantHandle = alt.toLowerCase();
          }

          if (validLines.length > 0) {
            const firstClean = validLines.find(l => !l.startsWith('@') && (!currentUser || l.toLowerCase() !== currentUser.toLowerCase()));
            if (firstClean) rowDisplayName = firstClean;
          }

          let rowTitle = '';
          if (isGroup) {
            rowTitle = rowDisplayName || 'Group chat';
          } else if (rowDisplayName) {
            rowTitle = rowDisplayName;
          } else if (participantHandle) {
            rowTitle = `@${participantHandle}`;
          } else if (alt && !/^user avatar$/i.test(alt)) {
            rowTitle = alt;
          } else {
            rowTitle = 'Chat Mutual';
          }

          const activity = this._extractRowActivity(row);

          let baselineRecent20h = 10;
          let baselineRecent1h = 0;
          let baselineTotal = 15;
          let baselineEnergyScore = 45;

          if (isGroup) {
            if (activity.ageMinutes <= 5) {
              baselineRecent20h = 35;
              baselineRecent1h = 15;
              baselineTotal = 40;
              baselineEnergyScore = 69;
            } else if (activity.ageMinutes <= 60) {
              baselineRecent20h = 26;
              baselineRecent1h = 5;
              baselineTotal = 30;
              baselineEnergyScore = 63;
            } else if (activity.ageMinutes <= 180) {
              baselineRecent20h = 21;
              baselineRecent1h = 0;
              baselineTotal = 22;
              baselineEnergyScore = 60;
            } else if (activity.ageMinutes <= 1200) {
              baselineRecent20h = 12;
              baselineRecent1h = 0;
              baselineTotal = 15;
              baselineEnergyScore = 45;
            } else {
              baselineRecent20h = 3;
              baselineRecent1h = 0;
              baselineTotal = 5;
              baselineEnergyScore = 20;
            }
          }

          let baselineSent = 1;
          let baselineReceived = 1;
          let baselineBondScore = 15;

          if (!isGroup) {
            if (participantHandle && window.bondStorage) {
              const publicUser = await window.bondStorage.getUser(participantHandle, false, currentUser);
              if (publicUser && (publicUser.currentScore || 0) > 0) {
                baselineBondScore = Math.max(25, Math.round(publicUser.currentScore * 0.8));
                baselineSent = Math.max(2, Math.round(baselineBondScore / 8));
                baselineReceived = baselineSent;
              }
            }
            if (baselineBondScore <= 15) {
              if (activity.ageMinutes <= 60) {
                baselineBondScore = 35;
                baselineSent = 4;
                baselineReceived = 4;
              } else if (activity.ageMinutes <= 180) {
                baselineBondScore = 28;
                baselineSent = 3;
                baselineReceived = 3;
              } else if (activity.ageMinutes <= 1440) {
                baselineBondScore = 22;
                baselineSent = 2;
                baselineReceived = 2;
              }
            }
          }

          let existing = await window.bondStorage.getDmConversation(convId, false, currentUser);
          if (!existing) {
            existing = {
              convId,
              isGroup,
              title: rowTitle,
              participants: participantHandle ? [participantHandle] : [],
              participantDetails: participantHandle ? {
                [participantHandle]: { displayName: rowTitle, avatarUrl: rowAvatar }
              } : {},
              sentCount: isGroup ? 0 : baselineSent,
              receivedCount: isGroup ? 0 : baselineReceived,
              totalCount: isGroup ? 0 : (baselineSent + baselineReceived),
              lifetimeSent: isGroup ? 0 : baselineSent,
              lifetimeReceived: isGroup ? 0 : baselineReceived,
              lifetimeTotal: isGroup ? baselineTotal : (baselineSent + baselineReceived),
              totalMessages: isGroup ? baselineTotal : (baselineSent + baselineReceived),
              recentMessages20h: isGroup ? baselineRecent20h : 0,
              recentMessages1h: isGroup ? baselineRecent1h : 0,
              groupEnergyScore: isGroup ? baselineEnergyScore : undefined,
              bondScore: !isGroup ? baselineBondScore : undefined,
              firstSeenTimestamp: Date.now(),
              lastMessageTimestamp: Date.now() - Math.min(Date.now(), Math.round(activity.ageMinutes * 60000)),
              surface: 'xchat',
              waitingForUserReply: activity.hasUnread
            };
            await window.bondStorage.saveDmConversation(convId, existing, currentUser).catch(() => {});
          } else {
            let changed = false;
            if (rowTitle && (!existing.title || existing.title === convId || existing.title === 'Group chat' || /^\d+[-:]\d+$/i.test(existing.title) || /^you (reacted|sent)/i.test(existing.title))) {
              existing.title = rowTitle;
              changed = true;
            }
            if (participantHandle && !existing.isGroup) {
              if (!Array.isArray(existing.participants)) existing.participants = [];
              if (!existing.participants.includes(participantHandle)) {
                existing.participants.push(participantHandle);
                changed = true;
              }
            }
            if (participantHandle && rowAvatar) {
              if (!existing.participantDetails) existing.participantDetails = {};
              const prev = existing.participantDetails[participantHandle];
              if (!prev || !prev.avatarUrl) {
                existing.participantDetails[participantHandle] = {
                  displayName: rowTitle || participantHandle,
                  avatarUrl: rowAvatar
                };
                changed = true;
              }
            }
            if (isGroup && (!existing.groupEnergyScore || existing.groupEnergyScore <= 0)) {
              existing.recentMessages20h = baselineRecent20h;
              existing.recentMessages1h = baselineRecent1h;
              existing.totalMessages = baselineTotal;
              existing.groupEnergyScore = baselineEnergyScore;
              changed = true;
            } else if (!isGroup && (!existing.bondScore || existing.bondScore <= 0)) {
              existing.sentCount = Math.max(existing.sentCount || 0, baselineSent);
              existing.receivedCount = Math.max(existing.receivedCount || 0, baselineReceived);
              existing.totalCount = existing.sentCount + existing.receivedCount;
              existing.bondScore = baselineBondScore;
              changed = true;
            }
            if (activity.hasUnread !== existing.waitingForUserReply && !isGroup) {
              existing.waitingForUserReply = activity.hasUnread;
              changed = true;
            }
            if (changed) {
              await window.bondStorage.saveDmConversation(convId, existing, currentUser).catch(() => {});
            }
          }

          if (participantHandle && rowAvatar && window.bondStorage && window.bondStorage.updateUserAvatarIfMissing) {
            window.bondStorage.updateUserAvatarIfMissing(participantHandle, rowAvatar, rowTitle).catch(() => {});
          }

          if (window.bondUI && window.bondUI.injectDmRowBadge) {
            await window.bondUI.injectDmRowBadge(row, convId, participantHandle, isGroup, {
              displayName: existing.title || rowTitle || '',
              avatarUrl: rowAvatar || (existing.participantDetails && participantHandle && existing.participantDetails[participantHandle]?.avatarUrl) || '',
              hasUnread: activity.hasUnread,
              ageMinutes: activity.ageMinutes,
              timestampStr: activity.timestampStr
            });
          }
        } catch (e) {
          // keep scanning the remaining rows
        }
      }
    }

    async _scanActiveThread(currentUser) {
      const match = location.pathname.match(/^\/i\/chat\/([^/?#]+)/);
      if (!match || !match[1]) return;

      const isGroup = match[1].toLowerCase().startsWith('g');
      const convId = canonicalConversationId(match[1]);
      if (!convId) return;

      const panel = this.shadow.querySelector('[data-testid="dm-conversation-panel"]');
      if (!panel) return;

      const header = this.shadow.querySelector('[data-testid="dm-conversation-header"]');

      // 1:1 header links to the other participant's public profile. The avatar
      // inside that link is public profile metadata, never a message body.
      let targetHandle = null;
      let targetAvatar = '';
      let targetName = '';
      if (!isGroup && header) {
        for (const link of header.querySelectorAll('a[href]')) {
          const href = link.getAttribute('href') || '';
          const m = href.match(/(?:(?:x|twitter)\.com)?\/([A-Za-z0-9_]+)$/i);
          if (m && m[1] && !['messages', 'i', 'home', 'explore', 'notifications'].includes(m[1].toLowerCase())) {
            const handle = m[1].toLowerCase();
            const curUserClean = (currentUser || '').toLowerCase().replace(/^@/, '');
            if (!curUserClean || handle !== curUserClean) {
              targetHandle = handle;
              const img = link.querySelector('img[src*="profile_images"], img');
              if (img && /^https?:/i.test(img.src || '')) targetAvatar = img.src;
              const text = String(link.innerText || '').trim();
              if (text && text.length <= 80 && !text.startsWith('@')) targetName = text;
              break;
            }
          }
        }
      }

      const existing = await window.bondStorage.getDmConversation(convId, false, currentUser);
      const known = new Set((existing && existing.recordedMessageIds) || []);

      // Message rows expose only metadata: a stable id, and an alignment class
      // that tells us whether the bubble is inbound (start) or outbound (end).
      const rows = this.shadow.querySelectorAll(`[data-testid^="${MESSAGE_PREFIX}"]`);
      const entries = [];
      const senders = new Set();
      let latestDirection = null;

      for (const row of rows) {
        try {
          const testid = row.getAttribute('data-testid') || '';
          if (testid.startsWith(MESSAGE_TEXT_PREFIX)) continue;

          const cls = typeof row.className === 'string' ? row.className : '';
          const outbound = cls.includes('justify-end');
          const inbound = cls.includes('justify-start');
          if (!outbound && !inbound) continue; // reaction pill / system row

          const uid = testid.slice(MESSAGE_PREFIX.length) || String(entries.length);
          const direction = outbound ? 'outbound' : 'inbound';
          let senderHandle = null;
          let senderAvatar = '';
          let senderName = '';

          if (inbound) {
            const link = row.querySelector('a[href*="x.com/"], a[href*="twitter.com/"]');
            const m = link && (link.getAttribute('href') || '').match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
            if (m && m[1]) {
              senderHandle = m[1].toLowerCase();
              if (!currentUser || senderHandle !== currentUser) senders.add(senderHandle);
            }
            const senderImg = row.querySelector('img[src*="profile_images"], img');
            if (senderImg && /^https?:/i.test(senderImg.src || '')) {
              senderAvatar = senderImg.src;
            }
            const nameEl = row.querySelector('span, [dir="ltr"]');
            if (nameEl && nameEl.innerText) {
              const txt = nameEl.innerText.trim();
              if (txt && txt.length <= 60 && !txt.includes('\n')) senderName = txt;
            }
          }

          latestDirection = direction;
          entries.push({
            fingerprint: `xchat_${convId}_${direction}_${uid}`,
            direction,
            senderHandle,
            senderAvatar,
            senderName,
            timestamp: 0,
            index: entries.length
          });
        } catch (e) {
          // continue
        }
      }

      if (entries.length > 0) {
        // Stagger history timestamps so ordering, recency and waiting state
        // stay coherent without ever reading a message body or its clock.
        const base = Date.now();
        entries.forEach((entry, idx) => {
          entry.timestamp = base - (entries.length - 1 - idx) * 30000;
        });

        const hasNew = !existing || entries.some((entry) => !known.has(entry.fingerprint));

        if (hasNew) {
          const curUserClean = (currentUser || '').toLowerCase().replace(/^@/, '');
          const participants = existing && Array.isArray(existing.participants)
            ? existing.participants.filter(p => p !== curUserClean && !/^\d+$/.test(p))
            : [];
          if (targetHandle && !participants.includes(targetHandle) && targetHandle !== curUserClean) participants.push(targetHandle);
          if (isGroup) {
            senders.forEach((handle) => {
              if (!participants.includes(handle) && handle !== curUserClean) participants.push(handle);
            });
          }

          let title = targetName || (targetHandle ? `@${targetHandle}` : (isGroup ? this._groupTitle(convId) : 'Chat Mutual'));
          if (existing && existing.title && !/^\d+[-:]\d+$/i.test(existing.title) && !/^you (reacted|sent)/i.test(existing.title) && existing.title !== curUserClean) {
            title = targetName || existing.title;
          }

          const details = Object.assign({}, (existing && existing.participantDetails) || {});
          if (targetHandle) {
            details[targetHandle] = {
              handle: targetHandle,
              displayName: targetName || targetHandle,
              avatarUrl: targetAvatar || (details[targetHandle] && details[targetHandle].avatarUrl) || ''
            };
          }

          // Populate participant details and avatars from observed message entries
          for (const entry of entries) {
            if (entry.senderHandle && entry.senderAvatar) {
              const prev = details[entry.senderHandle];
              if (!prev || !prev.avatarUrl) {
                details[entry.senderHandle] = {
                  handle: entry.senderHandle,
                  displayName: entry.senderName || (prev && prev.displayName) || entry.senderHandle,
                  avatarUrl: entry.senderAvatar
                };
              }
              if (window.bondStorage && window.bondStorage.updateUserAvatarIfMissing) {
                window.bondStorage.updateUserAvatarIfMissing(entry.senderHandle, entry.senderAvatar, entry.senderName).catch(() => {});
              }
            }
          }

          await window.bondStorage.saveDmConversation(convId, {
            convId,
            isGroup,
            title,
            participants,
            participantDetails: details,
            surface: 'xchat'
          }, currentUser).catch(() => {});

          await window.bondStorage.ingestMessageEntries(convId, entries, currentUser).catch(() => {});

          // The inbox may have been scanned before this record existed, and a
          // quiet thread produces no further mutations. Force one more pass so
          // its row gets a badge without requiring a reload.
          this.lastInboxScan = 0;
          setTimeout(() => this._scheduleScan(), 1600);
        } else if (existing && existing.surface !== 'xchat') {
          await window.bondStorage.saveDmConversation(convId, { surface: 'xchat' }, currentUser).catch(() => {});
        }

        // The header image can mount after the first ingestion pass. Persist it
        // as soon as it appears so the Score Card can show the real avatar.
        if (existing && targetHandle && targetAvatar) {
          const prev = (existing.participantDetails && existing.participantDetails[targetHandle]) || {};
          if (prev.avatarUrl !== targetAvatar) {
            await window.bondStorage.saveDmConversation(convId, {
              participantDetails: Object.assign({}, existing.participantDetails || {}, {
                [targetHandle]: {
                  handle: targetHandle,
                  displayName: targetName || prev.displayName || targetHandle,
                  avatarUrl: targetAvatar
                }
              })
            }, currentUser).catch(() => {});
          }
        }
      }

      if (header && window.bondUI && window.bondUI.injectDmHeaderPill) {
        await window.bondUI.injectDmHeaderPill(header, convId, targetHandle, isGroup);
      }
    }

    _groupTitle(convId) {
      try {
        const header = this.shadow.querySelector('[data-testid="dm-conversation-header"]');
        if (header) {
          // Group name only: the header contains no message bodies.
          const firstLine = String(header.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
          if (firstLine && firstLine.length <= 80) return firstLine;
        }
      } catch (e) {}
      return 'Group chat';
    }
  }

  window.BondXChat = {
    canonicalConversationId,
    conversationUrlId
  };
  window.bondXChat = new XChatAdapter();
})();
