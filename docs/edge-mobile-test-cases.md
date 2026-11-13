# BondScore for X: Edge mobile test cases

## Build and environment

- Extension: BondScore for X - Relationship & Mutuals Tracker
- Microsoft Edge Add-ons ID: `nfdlljgdanjpmnidofpfkkgkkbckkghh`
- Version: 1.1.1
- Platforms tested: Edge for Android and Edge for iOS (publisher reported working)
- Device and exact Edge versions: not recorded
- Data handling: interaction and score data are stored locally by the extension; no BondScore login is required.

## Core mobile checks

| ID | Steps | Expected result | Publisher result |
|---|---|---|---|
| M1 | Install BondScore from Edge Add-ons on a mobile device. | Extension installs and appears in Edge's Extensions menu. | Pass on Android and iOS. |
| M2 | Open X Home and scroll the timeline. | BondScore relationship badges render beside account names without blocking X controls or scrolling. | Pass on Android; supplied screenshot shows badges on the timeline. Pass on iOS (publisher report). |
| M3 | Open an X profile. | The profile relationship badge renders and remains usable at mobile width. | Pass (publisher report). |
| M4 | Tap a BondScore badge. | The scorecard opens, shows its details, and can be dismissed. | Pass on Android (publisher report). |
| M5 | Open BondScore from Edge's Extensions menu. | The dashboard opens; its tabs, content, and scrolling controls are usable on a mobile viewport. | Pass on Android (publisher report). |
| M6 | Reload X and revisit the timeline. | Previously stored score data remains available and badges render again. | Pass (publisher report). |

## Scope note

The publisher reports one data-counting limitation in version 1.1.1: some inbound-only interactions are not reflected consistently in the Engagement Memory summary. Inbound-only contacts belong under Supporters / “They lead”; the Mutuals classification is intended for two-way interaction. This is separate from mobile installation and rendering.

