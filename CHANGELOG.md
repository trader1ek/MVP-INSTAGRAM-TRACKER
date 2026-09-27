# Changelog

## 2.0 — 2026-09-27
- **Change tracking.** Every complete scan is saved to IndexedDB. The next scan lists these in a **Changes** tab:
  - new followers and accounts that unfollowed
  - accounts it started or stopped following
  - username changes
- Every apparent "loss" is verified individually, so accounts Instagram skipped don't show up as false alarms.
- **History** screen, **Saved accounts** list, back up / restore.
- "Instagram order" sort (usually newest first).
- The whole project is now in English.

## 1.6
- Extra passes no longer stop early when the first pages contain only known accounts. Only truly empty pages count as the end of the list.

## 1.5
- **Circuit breaker.** When Instagram throttles (returns a warning page instead of JSON), extra searches stop after 2 retries.
- Result verification setting: my account only (default) / all accounts / off.

## 1.4
- The following list is fetched in 200-item pages. For most accounts this is a single request with no overlapping pages.
- Session scan list and comparison of 2–5 accounts (common followers / common following).

## 1.3
- Detection of Instagram's overlapping pages. When the profile count is unavailable, the target count is taken from the raw record count of the first pass.
- Extra passes: single large page, reverse order, offset, letter search.

## 1.2
- A scan no longer stops at an empty page in the middle of the list.
- Offset pass and **Diagnostics** report.

## 1.1
- Instagram's keyboard shortcuts no longer capture what you type in the panel.
- Second completion pass, and individual verification of "not following back" results.

## 1.0
- First release, merging davidarroyo1234/InstagramUnfollowers and HenryLok0/Instagram_Follower_Checker:
  - UI, scanning other accounts, ID-based matching
  - whitelist, filters, CSV/JSON export
  - safe unfollowing with 429 backoff
