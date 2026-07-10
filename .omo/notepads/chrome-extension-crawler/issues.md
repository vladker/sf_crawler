# Issues — Sfera Crawler Chrome Extension

## [2026-07-09] Known Issues
- Background.js (Task 3) and popup.js (Task 4) are 1-line placeholders — need full implementation
- Popup.css is minimal (21 lines) — needs complete styling
- content-script.js uses localStorage for API cache — may be limited by MV3 isolation; consider sessionStorage or chrome.storage.session
