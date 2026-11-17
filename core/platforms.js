/**
 * BondScore - Platform Registry & Granular Controls (v1.4.0)
 * Single source of truth for the supported networks, their defaults, and the
 * per-platform master/sub toggles. Everything stays local: this module only
 * describes behaviour, it never contacts a server.
 */

const BOND_PLATFORMS = {
  x: {
    id: 'x',
    name: 'X',
    fullName: 'X (Twitter)',
    shortLabel: 'X',
    icon: '𝕏',
    emoji: '𝕏',
    accent: '#1D9BF0',
    accentSoft: 'rgba(29, 155, 240, 0.16)',
    hosts: ['x.com', 'twitter.com'],
    feedPaths: ['/home', '/explore', '/notifications', '/search'],
    profilePattern: /^\/([A-Za-z0-9_]{1,15})\/?$/,
    defaultEnabled: true,
    supportsGroups: true
  },
  threads: {
    id: 'threads',
    name: 'Threads',
    fullName: 'Threads',
    shortLabel: 'Threads',
    icon: '🧵',
    emoji: '🧵',
    accent: '#8B5CF6',
    accentSoft: 'rgba(139, 92, 246, 0.16)',
    hosts: ['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'],
    feedPaths: ['/', '/@'],
    profilePattern: /^\/@([A-Za-z0-9._]{1,40})\/?$/,
    defaultEnabled: false,
    supportsGroups: false
  },
  bluesky: {
    id: 'bluesky',
    name: 'Bluesky',
    fullName: 'Bluesky (AT Protocol)',
    shortLabel: 'Bluesky',
    icon: '🦋',
    emoji: '🦋',
    accent: '#1185FE',
    accentSoft: 'rgba(17, 133, 254, 0.16)',
    hosts: ['bsky.app'],
    feedPaths: ['/', '/search', '/feeds', '/notifications'],
    profilePattern: /^\/profile\/([A-Za-z0-9._:-]{1,80})\/?$/,
    defaultEnabled: false,
    supportsGroups: false
  }
};

const BOND_PLATFORM_LIST = ['x', 'threads', 'bluesky'];

/**
 * Default per-platform control block. A master `enabled` switch gates both
 * sub-toggles; the sub-toggles separately gate feed badges and DM metadata.
 */
const BOND_PLATFORM_DEFAULTS = {
  x: { enabled: true, timeline: true, dms: true },
  threads: { enabled: false, timeline: true, dms: true },
  bluesky: { enabled: false, timeline: true, dms: true }
};

class BondPlatforms {
  /** Returns a platform descriptor, or X as a safe fallback. */
  static get(id) {
    return BOND_PLATFORMS[id] || BOND_PLATFORMS.x;
  }

  static all() {
    return BOND_PLATFORM_LIST.map((id) => BOND_PLATFORMS[id]);
  }

  /** Resolves the platform for a hostname (content-script context). */
  static detect(hostname = '') {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
    for (const id of BOND_PLATFORM_LIST) {
      if (BOND_PLATFORMS[id].hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
        return BOND_PLATFORMS[id];
      }
    }
    return BOND_PLATFORMS.x;
  }

  /** Resolves the current page's platform. */
  static current() {
    if (typeof location !== 'undefined' && location.hostname) {
      return this.detect(location.hostname);
    }
    return BOND_PLATFORMS.x;
  }

  /** Merges stored platform settings over the launch defaults. */
  static getConfig(settings = {}) {
    const stored = (settings && settings.platforms) || {};
    const config = {};
    for (const id of BOND_PLATFORM_LIST) {
      const base = BOND_PLATFORM_DEFAULTS[id];
      const value = stored[id] || {};
      config[id] = {
        enabled: value.enabled !== undefined ? !!value.enabled : base.enabled,
        timeline: value.timeline !== undefined ? !!value.timeline : base.timeline,
        dms: value.dms !== undefined ? !!value.dms : base.dms
      };
    }
    return config;
  }

  /** True when the platform master toggle is on. */
  static isEnabled(settings = {}, id = null) {
    const platform = id || this.current().id;
    return this.getConfig(settings)[platform].enabled;
  }

  /** True when the platform is on AND the requested sub-toggle is on. */
  static isFeatureEnabled(settings = {}, id, feature = 'timeline') {
    const platform = id || this.current().id;
    const cfg = this.getConfig(settings)[platform];
    if (!cfg || !cfg.enabled) return false;
    if (feature === 'timeline' || feature === 'dms') return !!cfg[feature];
    return true;
  }

  /** A human readable status line for the settings UI. */
  static describe(settings = {}, id) {
    const cfg = this.getConfig(settings)[id];
    if (!cfg || !cfg.enabled) return 'Off';
    if (!cfg.timeline && !cfg.dms) return 'On · all features off';
    const parts = [];
    if (cfg.timeline) parts.push('Timeline');
    if (cfg.dms) parts.push('DMs');
    return `On · ${parts.join(' + ')}`;
  }

  /** Canonical profile URL for a handle on a platform. */
  static profileUrl(id, handle) {
    const clean = String(handle || '').replace(/^@/, '');
    switch (id) {
      case 'threads':
        return `https://www.threads.net/@${clean}`;
      case 'bluesky':
        return `https://bsky.app/profile/${clean}`;
      default:
        return `https://x.com/${clean}`;
    }
  }

  /** Normalises a handle coming from any supported platform. */
  static normalizeHandle(handle = '') {
    return String(handle || '')
      .trim()
      .replace(/^@+/, '')
      .replace(/^https?:\/\/[^/]+\/(?:@|profile\/)?/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }

  /** Merge partial platform config into a settings object without dropping siblings. */
  static patchSettings(settings = {}, id, patch = {}) {
    const existing = this.getConfig(settings);
    const target = existing[id] || BOND_PLATFORM_DEFAULTS.x;
    return {
      ...settings,
      platforms: {
        ...existing,
        [id]: { ...target, ...patch }
      }
    };
  }
}

if (typeof window !== 'undefined') {
  window.BondPlatforms = BondPlatforms;
  window.BOND_PLATFORMS = BOND_PLATFORMS;
  window.BOND_PLATFORM_DEFAULTS = BOND_PLATFORM_DEFAULTS;
}
if (typeof globalThis !== 'undefined') {
  globalThis.BondPlatforms = BondPlatforms;
  globalThis.BOND_PLATFORMS = BOND_PLATFORMS;
  globalThis.BOND_PLATFORM_DEFAULTS = BOND_PLATFORM_DEFAULTS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BondPlatforms, BOND_PLATFORMS, BOND_PLATFORM_LIST, BOND_PLATFORM_DEFAULTS };
}
