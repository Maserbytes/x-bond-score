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

    async _scanInbox(currentUser) {
      const now = Date.now();
      if (now - this.lastInboxScan < 1500) return;
      this.lastInboxScan = now;

      const rows = this.shadow.querySelectorAll(`[data-testid^="${CONVERSATION_PREFIX}"]`);
      if (!rows || rows.length === 0) return;

      for (const row of rows) {
        try {
          const raw = (row.getAttribute('data-testid') || '').slice(CONVERSATION_PREFIX.length);
          if (!raw) continue;
          const convId = raw.toLowerCase();
          const isGroup = convId.startsWith('g');

          // Only enrich conversations we already track. A list row alone does
          // not prove that any message was exchanged, so no fake counts.
          const existing = await window.bondStorage.getDmConversation(convId, false, currentUser);
          if (!existing) continue;

          const img = row.querySelector('img');
          const alt = img && img.alt ? img.alt.trim() : '';
          const title = /^user avatar$/i.test(alt) ? '' : alt;

          if (window.bondUI && window.bondUI.injectDmRowBadge) {
            await window.bondUI.injectDmRowBadge(row, convId, null, isGroup, {
              displayName: existing.title || title || '',
              avatarUrl: img && /^https?:/i.test(img.src || '') ? img.src : '',
              hasUnread: false
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
          const m = (link.getAttribute('href') || '').match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
          if (m && m[1]) {
            const handle = m[1].toLowerCase();
            if (!currentUser || handle !== currentUser) {
              targetHandle = handle;
              const img = link.querySelector('img');
              if (img && /^https?:/i.test(img.src || '')) targetAvatar = img.src;
              const text = String(link.innerText || '').trim();
              if (text && text.length <= 80) targetName = text;
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

          if (inbound) {
            const link = row.querySelector('a[href*="x.com/"], a[href*="twitter.com/"]');
            const m = link && (link.getAttribute('href') || '').match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
            if (m && m[1]) {
              senderHandle = m[1].toLowerCase();
              if (!currentUser || senderHandle !== currentUser) senders.add(senderHandle);
            }
          }

          latestDirection = direction;
          entries.push({
            fingerprint: `xchat_${convId}_${direction}_${uid}`,
            direction,
            senderHandle,
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
          const participants = existing && Array.isArray(existing.participants)
            ? existing.participants.slice()
            : [];
          if (targetHandle && !participants.includes(targetHandle)) participants.push(targetHandle);
          senders.forEach((handle) => {
            if (!participants.includes(handle)) participants.push(handle);
          });

          const title = (existing && existing.title)
            || (targetHandle ? `@${targetHandle}` : (isGroup ? this._groupTitle(convId) : convId));

          const details = Object.assign({}, (existing && existing.participantDetails) || {});
          if (targetHandle) {
            details[targetHandle] = {
              handle: targetHandle,
              displayName: targetName || targetHandle,
              avatarUrl: targetAvatar || (details[targetHandle] && details[targetHandle].avatarUrl) || ''
            };
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
