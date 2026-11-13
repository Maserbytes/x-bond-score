# ⚡ BondScore for X (Twitter)

> **Created by [@MaserSuspended](https://x.com/MaserSuspended)**  
> **Live relationship & mutual interaction score tracker for X (Twitter).**  
> Chromium Extension for Chrome and Edge (Manifest V3) • 100% Local Storage • Zero Backend.

---

## 🌟 Overview

**BondScore** tracks the strength of your relationships with accounts you interact with on X. It calculates a dynamic **Bond Score (0–100)** that:
- **Pro Design System & Adaptive Theme Switcher**:
  - **Device / OS Default (Auto)**: Detects whether your device is in Dark Mode or Light Mode and matches automatically.
  - **Quick Theme Toggle**: Instantly switch between **🌓 System**, **🌙 Dark**, and **☀️ White / Light** via the header pill or Settings.
  - **Smooth Physical Craft**: Designed with tactile button press micro-interactions (`transform: scale(0.97)`), glassmorphic surfaces, fluid cubic-bezier animations, and high-contrast WCAG AAA typography.
- **👥 Multi-Account Isolation & Instant Auto-Switching**:
  - **100% Isolated Data Per Account**: Interactions, CRM statuses, leaderboards, and scores are strictly isolated per account (`acc:<handle>:*`). Your main account, alt accounts, and project accounts each maintain their own independent relationship universes.
  - **Automatic Switch Detection on X**: Detects whenever you switch accounts on X (via the bottom-left account switcher or navigation) and instantly recalculates and swaps all badges on your timeline, profiles, and ScoreCard with zero page reload.
  - **Popup Account Dropdown Switcher**: Click the account selector in the popup header to toggle between any detected account and view its separate CRM leaderboard, solar orbit, and engagement memory.
  - **Lossless Auto-Migration**: Automatically migrates existing single-account scores into your detected account on first launch.
- **Tracks observed interactions in both directions** and stores the event ledger locally for score recalculation.
- **Seven-day profile catch-up**: performs one bounded recent-post scan the first time you view a profile, then relies on passive tracking. X may not expose every interaction, especially older likes and notifications.
- A failed catch-up is retried no more than once per day; a successful one is remembered for that account and profile.
- **Profile Follow Badges**: Displays vibrant, live relationship badges directly on user profiles:
  - `🤝 Mutual`: Both you and the user follow each other.
  - `➡️ One-Way Follow`: You follow them, but they do not follow you back.
  - `📥 Just a Follower`: They follow you, but you do not follow them back.
  - `🚫 Blocked`: Block or restricted profile state detected.
- **Two-Handle Tweet Lookup**: Enter any two handles on X to instantly check if they have ever interacted via tweets, see reply direction breakdown, and inspect tweet snippets.
- **Observes Relationship Signals**: Automatically detects and logs follow-backs, unfollows, mutual follows, and possible blocks into a private history ledger.
- **Local Engagement Memory**: Shows who engages with you vs. who you engage with, overall reciprocity balance, top supporters, and dormant people.
- **Relationship CRM Classification**: Automatically categorizes every bond into **💖 Besties**, **🤝 Mutuals**, **➡️ One-sided (You lead / They lead)**, or **👤 Stranger**.
- **Personal Relationship History Ledger**: View a full filterable timeline of all interactions (DMs, Replies, Likes, Quotes) in the Score Card.
- **Rises** with frequent mutual replies, quote tweets, comments, DMs, and likes.
- **Keeps the local event history** while the score stays steady for five inactive days, then gradually decays.
- **Displays subtly** right next to handles on timelines, profile pages, and tweet threads.
- **Provides an interactive Score Card** when you click any badge, showing conversation breakdowns, reply ratios, reciprocity radar, and notes.
- **Supports Deep Mode**: On-demand deep search through mutual tweet histories without requiring Twitter's official paid API.

---

## 🚀 Quick Start / How to Install

1. Open Google Chrome or Microsoft Edge.
2. Navigate to `chrome://extensions/` or `edge://extensions/` in the URL bar.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** (top-left button).
5. Select this directory:
   ```
   D:\x-bond-score
   ```
6. Open [x.com](https://x.com) or refresh any active X tab.
7. BondScore will immediately detect your logged-in user handle and begin displaying live badges!

---

## 🧪 Interactive Testing Sandbox

Want to test badges, decay, scoring formulas, and popups without needing to be live on X?
Double click or open **`test_harness.html`** in any web browser:
- Interactive timeline sandbox to test scores, live like boosts, decay formulas, and badge injection on any handle.
- Buttons to simulate mutual replies, likes, fast-forwarding 10 days of decay, and running deep scans.

---

## 🧩 Architecture & Modes

### 1. Light Mode (Passive Observation)
Runs continuously while you browse X:
- **Passive Event Listeners**: Detects when you send replies, click Like, or Retweet.
- **Timeline Thread Scanner**: Observes visible conversation threads between you and mutuals.
- **Zero Performance Overhead**: Debounced MutationObserver with micro-task scheduling keeps X fast and smooth.

### 2. Deep Mode (Modular Search Engine)
Click **"🔍 Run Deep Analysis"** in the Score Card or profile badge to perform a deeper conversation audit.

#### 🔌 How to Plug In Your Rezero Sanctuary Method
In `core/deep-analyzer.js`, the deep mode is completely decoupled using an adapter pattern. You can plug in your existing post-searching script in two simple ways:

#### Option A: Quick Function Hook
In `core/deep-analyzer.js` (or via console / content script), register your function:
```javascript
window.deepAnalyzer.setCustomFunction(async (currentUser, targetUser, onProgress) => {
  // Your Rezero Sanctuary post-searching code here!
  // Example:
  onProgress({ percent: 30, stage: 'Searching user archive...' });
  
  // Return array of found interaction objects:
  return [
    {
      type: 'reply_mutual',
      timestamp: Date.now() - 86400000,
      tweetId: '123456789',
      textSnippet: 'Found mutual exchange...',
      isMutual: true
    }
  ];
});
```

#### Option B: Custom Provider Class
Subclass `BaseDeepProvider` in `core/deep-analyzer.js`:
```javascript
class RezeroSanctuaryProvider extends BaseDeepProvider {
  constructor() {
    super('RezeroSanctuaryProvider');
  }

  async analyze(currentUser, targetUser, onProgress) {
    // Implement your scraper / post fetcher here
    return interactions;
  }
}

// Activate provider
window.deepAnalyzer.setProvider(new RezeroSanctuaryProvider());
```

---

## 📐 Scoring Formula & Direction + Quality Weighting

Scores are calculated using a **half-life exponential decay** formulation normalized to a **0–100** scale with five-pillar **Direction & Quality Weighting**:

$$Score = 100 \times \left(1 - e^{-\frac{\text{RawScore}}{45}}\right)$$

### 1. Direction & Quality Weighting Pillars
- **💬 Replies > Likes**: Replies carry 8–18 base pts vs 2 pts for likes. Standalone likes feature **diminishing returns** (first 3 likes yield full 2 pts, subsequent likes diminish by $\frac{2}{\sqrt{N-2}}$). Fifty passive likes without conversation cannot artificially create a soulmate bond.
- **🧵 Replies in Threads > Random Likes**: Replies inside active tweet threads (`reply_thread`) receive a **+35% Thread Depth Multiplier** ($16 \times 1.35 = 21.6\text{ pts}$), weighting substantive dialogue over 10× higher than a random like.
- **⚡ Recency Velocity**: Recent interactions are weighted higher than stale ones:
  - **Within 24 hours**: `1.50×` (50% recency momentum boost)
  - **Within 3 days**: `1.30×` (30% recency boost)
  - **Within 7 days**: `1.15×` (15% recency boost)
- **🤝 Bonus if They Engage Back (Two-Way Reciprocity)**:
  - **Inbound Effort Appreciation**: When they take the time to reply back to you or DM you, inbound actions carry a `+25%` appreciation bonus.
  - **Escalating Multiplier**: Two-way dialogue activates a `+30%` to `+60%` boost based on interaction balance ratio ($\frac{\min}{\max}$).
  - **One-Sided Protection Cap**: If you repeatedly engage (4+ likes/replies) but they never engage back with you, raw score is strictly capped at `16` (max ~32–35 Acquaintance), preventing unrequited fan accounts from ranking as Besties.

### Event Base Weights
| Interaction Type | Base Weight | Multipliers & Conditions | Notes |
| :--- | :---: | :---: | :--- |
| **Mutual DM Conversation** | `+22 pts` | Direct intimacy | Private back-and-forth direct messages |
| **Mutual Reply Exchange** | `+18 pts` | Reciprocal dialogue | High-quality public back-and-forth conversation |
| **Thread Reply** | `+16 pts` | `× 1.35` Thread Depth | Replies in active conversation threads |
| **Direct Message Received** | `+15 pts` | Inbound effort | When they initiate or send you a DM |
| **Direct Message Sent** | `+12 pts` | Outbound DM | Private messages you send |
| **Reply Received (Inbound)** | `+10 pts` | `+25%` Inbound bonus | They took the time to answer you |
| **Reply Sent (Outbound)** | `+8 pts` | Outbound effort | Standalone reply to their tweet |
| **Quote Tweet** | `+6 pts` | Public commentary | Public quote of their tweet |
| **Mention** | `+5 pts` | Direct ping | Tagging in post |
| **Like / Repost** | `+2 pts` | Diminishing returns ($N > 3$) | Lightweight engagement signal |

### Time-Decay Model
- **Grace Period**: 5 days (no decay during the first five days after the latest interaction).
- **Decay Rate**: Exponential half-life ($\lambda = \frac{\ln 2}{14 \text{ days}}$ by default).
- Configurable via the **Extension Popup > Decay & Weights** sliders.

### Relationship CRM Statuses
| Status | Badge | Condition | Description |
| :--- | :---: | :--- | :--- |
| **Besties** | 💖 | Score ≥ 65 + Active 2-Way | Deep two-way bond with active exchanges & streaks |
| **Mutuals** | 🤝 | Active Reciprocity | Balanced two-way interaction |
| **One-sided (You lead)** | ➡️ | Sent Ratio ≥ 75% | You send likes/replies/DMs, low engagement back |
| **One-sided (They lead)**| ⬅️ | Received Ratio ≥ 75% | They engage frequently, you reply rarely |
| **Acquaintance** | 👋 | Score 5–20 | Occasional light interactions |
| **Stranger / Cold** | 👤 | Score < 3 | No meaningful interaction history yet |

### Score Tiers
| Tier | Score Range | Badge | Label |
| :--- | :---: | :---: | :--- |
| **Soulmates** | 90–100 | 💎 | Core Bond |
| **Inner Circle** | 70–89 | 🔥 | Close Mutuals |
| **Conversant** | 40–69 | 🤝 | Regular Chat |
| **Acquaintance** | 15–39 | 👋 | Casual Notice |
| **Dormant** | 0–14 | ❄️ | Inactive / New |

---

## 🔒 100% Local Storage & Privacy

- All relationship scores, handles, and interaction history are saved in `chrome.storage.local`.
- No servers, no tracking, zero analytics, zero external network requests.
- Full backup & export to JSON available anytime in the extension popup.

---

## 📁 Project Structure

```
d:/x-bond-score/
├── manifest.json            # Manifest V3 specification
├── background.js            # Service worker for periodic decay calculation
├── test_harness.html        # Browser testing & verification sandbox
├── README.md                # Documentation & developer guide
├── icons/                   # High-res extension icons
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── core/
│   ├── storage.js           # chrome.storage.local manager & backup exporter
│   ├── scoring.js           # Mathematical scoring & decay algorithm
│   └── deep-analyzer.js     # Pluggable Deep Mode provider interface
├── content/
│   ├── detector.js          # Current user identification & interaction listener
│   ├── ui.js                # Inline badge injection & modal Score Card
│   ├── content.js           # Content script orchestrator & DOM observer
│   └── styles.css           # Twitter/X design system styling
└── popup/
    ├── popup.html           # Extension dashboard & leaderboard
    ├── popup.css            # Dark mode styling for popup
    └── popup.js             # Leaderboard filter, settings sliders, data export
```
