# ⚡ BondScore for X (Twitter)

> **Created by [@MaserSuspended](https://x.com/MaserSuspended)**  
> **Live relationship & mutual interaction score tracker for X (Twitter).**  
> Pure Chrome Extension (Manifest V3) • 100% Local Storage • Zero Backend • Zero API Fees.

---

## 🌟 Overview

**BondScore** tracks the strength of your relationships with accounts you interact with on X. It calculates a dynamic **Bond Score (0–100)** that:
- **Tracks every like, reply, and Direct Message (DM) you send** to build a comprehensive relationship history.
- **Two-Handle Tweet Lookup**: Enter any two handles on X to instantly check if they have ever interacted via tweets, see reply direction breakdown, and inspect tweet snippets.
- **Observes Relationship Signals**: Automatically detects and logs follow-backs, unfollows, mutual follows, and possible blocks into a private history ledger.
- **Local Engagement Memory**: Shows who engages with you vs. who you engage with, overall reciprocity balance, top supporters, and dormant people.
- **Relationship CRM Classification**: Automatically categorizes every bond into **💖 Besties**, **🤝 Mutuals**, **➡️ One-sided (You lead / They lead)**, or **👤 Stranger**.
- **Personal Relationship History Ledger**: View a full filterable timeline of all interactions (DMs, Replies, Likes, Quotes) in the Score Card.
- **Rises** with frequent mutual replies, quote tweets, comments, DMs, and likes.
- **Smoothly decays** over time if you and the other account stop interacting.
- **Displays subtly** right next to handles on timelines, profile pages, and tweet threads.
- **Provides an interactive Score Card** when you click any badge, showing conversation breakdowns, reply ratios, reciprocity radar, and notes.
- **Supports Deep Mode**: On-demand deep search through mutual tweet histories without requiring Twitter's official paid API.

---

## 🚀 Quick Start / How to Install

1. Open Google Chrome.
2. Navigate to `chrome://extensions/` in the URL bar.
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

## 📐 Scoring Formula & Decay Model

Scores are calculated using a **half-life exponential decay** formulation normalized to a **0–100** scale:

$$Score = 100 \times \left(1 - e^{-\frac{\text{RawScore}}{45}}\right)$$

### Event Weights
| Interaction Type | Weight | Notes |
| :--- | :---: | :--- |
| **Mutual DM Conversation** | `+20 pts` | Intimate back-and-forth direct messages |
| **Mutual Reply Exchange** | `+15 pts` | Reciprocal back-and-forth dialogue |
| **Direct Message (Sent/Recv)** | `+12 pts` | Direct messages on x.com/messages |
| **Direct Reply (Sent/Received)** | `+8 pts` | Single reply in thread |
| **Quote Tweet** | `+6 pts` | Public commentary |
| **Mention** | `+5 pts` | Tagging in post |
| **Like / Repost** | `+2 pts` | Basic engagement signal |
| **Two-Way Multiplier** | `× 1.25` | Applied when conversation flows both ways |

### Time-Decay Model
- **Grace Period**: 2 days (no decay for 48 hours following an interaction).
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
