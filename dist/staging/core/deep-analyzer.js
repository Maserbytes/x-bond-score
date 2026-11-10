/**
 * BondScore for X - Modular Deep Analysis Engine
 * Allows on-demand deep scanning of mutual interactions between the current user and any target account.
 * Designed to easily plug in custom search/scraping methods (e.g. from Rezero Sanctuary).
 */

class BaseDeepProvider {
  constructor(name = 'BaseProvider') {
    this.name = name;
  }

  /**
   * Must be implemented by custom providers.
   * @param {string} currentUser - handle of logged-in user
   * @param {string} targetUser - handle of user being analyzed
   * @param {Function} onProgress - callback({ percent: number, stage: string, itemsFound: number })
   * @returns {Promise<Array<{ type: string, timestamp: number, tweetId: string, textSnippet: string, isMutual: boolean }>>}
   */
  async analyze(currentUser, targetUser, onProgress) {
    throw new Error('Not implemented');
  }
}

/**
 * Default Provider: Advanced X Search & DOM Scraper
 * Uses X's native search queries:
 *   (from:userA to:userB) OR (from:userB to:userA)
 * Queries X's internal timeline or searches via background session.
 */
class XSearchQueryAnalyzer extends BaseDeepProvider {
  constructor() {
    super('XSearchQueryAnalyzer');
  }

  async analyze(currentUser, targetUser, onProgress) {
    const cleanCurrent = (currentUser || '').replace(/^@/, '').toLowerCase().trim();
    const cleanTarget = (targetUser || '').replace(/^@/, '').toLowerCase().trim();

    if (!cleanCurrent || !cleanTarget) {
      throw new Error('Both currentUser and targetUser are required for Deep Analysis');
    }

    onProgress({ percent: 10, stage: 'Preparing interaction query...', itemsFound: 0 });

    const searchQuery = `(from:${cleanCurrent} to:${cleanTarget}) OR (from:${cleanTarget} to:${cleanCurrent})`;
    console.log(`[BondScore] Deep analyzing via query: ${searchQuery}`);

    // Check if user has plugged in a custom function (e.g. Rezero Sanctuary)
    if (window.customDeepAnalysisFunction && typeof window.customDeepAnalysisFunction === 'function') {
      console.log('[BondScore] Executing user-provided customDeepAnalysisFunction...');
      onProgress({ percent: 25, stage: 'Running custom search engine...', itemsFound: 0 });
      return await window.customDeepAnalysisFunction(cleanCurrent, cleanTarget, onProgress);
    }

    // Default internal search pipeline
    return await this._executeSearchPipeline(cleanCurrent, cleanTarget, searchQuery, onProgress);
  }

  /**
   * Default execution pipeline using X's internal search query
   */
  async _executeSearchPipeline(currentUser, targetUser, query, onProgress) {
    const results = [];
    const now = Date.now();

    onProgress({ percent: 30, stage: 'Scanning conversation archives...', itemsFound: 0 });

    try {
      // 1. Try fetching via internal endpoint if cookies & CSRF are accessible
      const csrfToken = this._getCsrfToken();
      if (csrfToken) {
        onProgress({ percent: 50, stage: 'Querying X internal search timeline...', itemsFound: 0 });
        const apiEvents = await this._queryInternalApi(query, csrfToken);
        if (apiEvents && apiEvents.length > 0) {
          results.push(...apiEvents);
        }
      }
    } catch (err) {
      console.warn('[BondScore] Internal search query failed, using DOM / heuristic fallback:', err);
    }

    // If API returned fewer or failed, query any visible on-page tweets/thread replies
    onProgress({ percent: 75, stage: 'Aggregating active thread records...', itemsFound: results.length });
    const domEvents = this._scrapeCurrentPageReplies(currentUser, targetUser);
    for (const evt of domEvents) {
      if (!results.some(r => r.tweetId && r.tweetId === evt.tweetId)) {
        results.push(evt);
      }
    }

    onProgress({ percent: 100, stage: results.length > 0 ? 'Deep analysis complete!' : 'No conversation records found.', itemsFound: results.length });
    return results;
  }

  _getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? match[1] : null;
  }

  /**
   * Internal query to X Search timeline API
   */
  async _queryInternalApi(query, csrfToken) {
    try {
      const url = `https://x.com/i/api/2/search/adaptive.json?q=${encodeURIComponent(query)}&count=40&query_source=typed_query&pc=1&spelling_corrections=1`;
      const res = await fetch(url, {
        headers: {
          'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          'x-csrf-token': csrfToken,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session'
        },
        credentials: 'include'
      });

      if (!res.ok) return [];
      const json = await res.json();
      const events = [];
      const tweets = (json && json.globalObjects && json.globalObjects.tweets) ? json.globalObjects.tweets : {};

      for (const [tweetId, tweet] of Object.entries(tweets)) {
        const text = tweet.full_text || '';
        const inReplyTo = tweet.in_reply_to_screen_name ? tweet.in_reply_to_screen_name.toLowerCase() : '';

        let type = 'reply_mutual';
        let isMutual = true;

        if (inReplyTo) {
          type = 'reply_mutual';
          isMutual = true;
        } else if (tweet.is_quote_status) {
          type = 'quote';
          isMutual = false;
        } else {
          type = 'mention';
          isMutual = false;
        }

        events.push({
          type,
          timestamp: new Date(tweet.created_at).getTime() || Date.now(),
          tweetId: tweetId,
          textSnippet: text,
          isMutual
        });
      }
      return events;
    } catch (e) {
      return [];
    }
  }

  /**
   * Scrapes replies and exchanges currently loaded in DOM
   */
  _scrapeCurrentPageReplies(currentUser, targetUser) {
    const events = [];
    const tweetElements = document.querySelectorAll('article[data-testid="tweet"]');

    tweetElements.forEach((tweetEl) => {
      try {
        const textEl = tweetEl.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText : '';
        const timeEl = tweetEl.querySelector('time');
        const timestamp = timeEl && timeEl.getAttribute('datetime')
          ? new Date(timeEl.getAttribute('datetime')).getTime()
          : Date.now();

        // Extract tweet link to get ID
        const link = tweetEl.querySelector('a[href*="/status/"]');
        const match = link ? link.getAttribute('href').match(/\/status\/(\d+)/) : null;
        const tweetId = match ? match[1] : `dom_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;

        // Check author
        const userLinks = tweetEl.querySelectorAll('a[role="link"][href^="/"]');
        let authorHandle = '';
        for (const ul of userLinks) {
          const href = ul.getAttribute('href').replace(/^\//, '');
          if (href && !href.includes('/') && href !== 'home' && href !== 'explore') {
            authorHandle = href.toLowerCase();
            break;
          }
        }

        const isFromCurrent = authorHandle === currentUser;
        const isFromTarget = authorHandle === targetUser;

        if (isFromCurrent || isFromTarget) {
          events.push({
            type: isFromCurrent ? 'reply_sent' : 'reply_received',
            timestamp,
            tweetId,
            textSnippet: text,
            isMutual: true
          });
        }
      } catch (err) {
        // continue
      }
    });

    return events;
  }
}

/**
 * DeepAnalyzer Manager
 */
class DeepAnalyzerManager {
  constructor() {
    this.provider = new XSearchQueryAnalyzer();
    this.activeScans = new Set();
  }

  /**
   * Swap out or register a custom provider (e.g., Rezero Sanctuary method)
   * @param {BaseDeepProvider} customProvider
   */
  setProvider(customProvider) {
    if (customProvider && typeof customProvider.analyze === 'function') {
      this.provider = customProvider;
      console.log(`[BondScore] Active Deep Provider changed to: ${customProvider.name || 'Custom'}`);
    }
  }

  /**
   * Hook for user to inject raw function:
   * (currentUser, targetUser, onProgress) => Promise<Array<events>>
   */
  setCustomFunction(fn) {
    window.customDeepAnalysisFunction = fn;
    console.log('[BondScore] Custom deep analysis function registered successfully.');
  }

  /**
   * Performs deep analysis on a specific target user.
   */
  async runAnalysis(currentUser, targetUser, onProgress = () => {}) {
    const cleanTarget = (targetUser || '').replace(/^@/, '').toLowerCase().trim();
    if (this.activeScans.has(cleanTarget)) {
      console.warn(`[BondScore] Deep analysis already in progress for @${cleanTarget}`);
      return null;
    }

    this.activeScans.add(cleanTarget);
    try {
      const events = await this.provider.analyze(currentUser, cleanTarget, onProgress);

      if (events && events.length > 0) {
        onProgress({ percent: 90, stage: 'Saving records to local storage...', itemsFound: events.length });

        for (const evt of events) {
          await window.bondStorage.recordInteraction(cleanTarget, evt);
        }

        // Increment deep scan stat
        const user = await window.bondStorage.getUser(cleanTarget);
        if (user) {
          user.stats = user.stats || {};
          user.stats.deepScans = (user.stats.deepScans || 0) + 1;
          await window.bondStorage.saveUser(cleanTarget, user);
        }
      }

      onProgress({ percent: 100, stage: 'Ready!', itemsFound: events.length });

      // Notify content script UI to update badges immediately
      window.dispatchEvent(new CustomEvent('bondscore:updated', { detail: { handle: cleanTarget } }));

      return await window.bondStorage.getUser(cleanTarget);
    } finally {
      this.activeScans.delete(cleanTarget);
    }
  }

  /**
   * Looks up tweet interactions between ANY two handles (e.g. handleA and handleB)
   * and reports whether they have ever interacted via tweets, direction, and snippet history.
   */
  async lookupInteraction(handleA, handleB, onProgress = () => {}) {
    const cleanA = (handleA || '').replace(/^@/, '').toLowerCase().trim();
    const cleanB = (handleB || '').replace(/^@/, '').toLowerCase().trim();

    if (!cleanA || !cleanB) {
      throw new Error('Please enter two handles to check interactions.');
    }

    if (cleanA === cleanB) {
      throw new Error('Please enter two different handles.');
    }

    onProgress({ percent: 15, stage: `Searching tweets between @${cleanA} and @${cleanB}...`, itemsFound: 0 });

    let events = [];
    try {
      events = await this.provider.analyze(cleanA, cleanB, onProgress);
    } catch (e) {
      console.warn('[BondScore] Search query lookup notice:', e);
    }

    // Also check local storage records for any cached interactions involving either account
    if (window.bondStorage) {
      try {
        const localA = await window.bondStorage.getEvents(cleanA);
        const localB = await window.bondStorage.getEvents(cleanB);
        for (const evt of [...localA, ...localB]) {
          const text = (evt.textSnippet || '').toLowerCase();
          if (text.includes(`@${cleanA}`) || text.includes(`@${cleanB}`)) {
            if (!events.some(r => r.tweetId && r.tweetId === evt.tweetId)) {
              events.push(evt);
            }
          }
        }
      } catch (e) {}
    }

    // Sort by timestamp descending
    events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const countAtoB = events.filter(e => e.type === 'reply_sent' || (e.textSnippet && e.textSnippet.toLowerCase().includes(`@${cleanB}`))).length;
    const countBtoA = events.filter(e => e.type === 'reply_received' || (e.textSnippet && e.textSnippet.toLowerCase().includes(`@${cleanA}`))).length;
    const hasInteracted = events.length > 0;

    const query = `(from:${cleanA} to:${cleanB}) OR (from:${cleanB} to:${cleanA})`;
    const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;

    onProgress({
      percent: 100,
      stage: hasInteracted ? `Found ${events.length} interaction(s)!` : 'No tweet interactions found.',
      itemsFound: events.length
    });

    return {
      handleA: cleanA,
      handleB: cleanB,
      hasInteracted,
      totalCount: events.length,
      countAtoB,
      countBtoA,
      events,
      lastInteraction: events[0] ? events[0].timestamp : null,
      searchUrl
    };
  }
}

window.deepAnalyzer = new DeepAnalyzerManager();
window.BaseDeepProvider = BaseDeepProvider;
