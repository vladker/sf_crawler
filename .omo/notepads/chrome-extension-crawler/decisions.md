# Decisions - Sfera Crawler Chrome Extension
## [2026-07-09] Architecture Decisions
1. Strategy Pattern: 4 scraping strategies (API > Form > Table > Generic DOM) with priority merge
2. Sequential crawling: One tab at a time with configurable delay
3. chrome.storage.local for progress: Persist state between Stop and Resume
4. chrome.downloads for output: Save JSON via browser download API
5. Manual auth only: Extension never handles credentials
6. No external dependencies: Vanilla JS only

## API Message Protocol
- content-script > background: {type: PAGE_DATA, data, changeNumber, tabName, strategies, partial}
- popup > background: {type: START|STOP|RESUME|GET_STATUS, payload: {...}}
- background > popup: {type: STATUS, current, total, errors, collected, ...}
