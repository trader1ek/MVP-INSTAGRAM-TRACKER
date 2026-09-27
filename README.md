# MVP Instagram Tracker

A browser tool that fetches **complete** Instagram follower and following lists, shows who doesn't follow back, and **tracks follower/following changes over time**. Use it as a Chrome extension, or paste it into the console on instagram.com.

> All data stays in your browser. Nothing is sent to any server.

## Features

- **Complete scans.** Instagram's API returns overlapping pages: it repeats some accounts and silently skips others. The tool detects this and fills the gaps with extra passes (small pages, reverse order, numeric offset, letter search) until the list matches the real count.
- **Follow-back analysis.** Who doesn't follow you back, who you don't follow back, and mutuals.
- **Scan other accounts** (read-only). Works for public accounts and for private accounts you follow.
- **Change tracking.** Every complete scan is saved in the browser (IndexedDB). When you scan the same account again, you see:
  - new followers
  - accounts that unfollowed
  - accounts it started or stopped following
  - username changes

  Every apparent "loss" is verified individually, so accounts Instagram skipped don't show up as false alarms.
- **Change history.** A per-account log of every change, grouped by day, with timestamps.
- **Account comparison.** Common followers and common following across 2–5 accounts.
- **Unfollow** (your own account only):
  - bulk unfollow selected accounts
  - whitelist (★) to protect accounts from selection
  - rate-limit pauses
  - automatic stop on errors or blocks
- **Filters and export.**
  - search, plus filters for verified, private and no-photo accounts
  - "Instagram order" sort (usually newest first)
  - CSV / JSON / copy to clipboard
- **Safe pacing.** Randomized delays and long pauses. A circuit breaker stops extra requests as soon as Instagram starts throttling.
- **Diagnostics report.** A technical report for troubleshooting that contains no usernames.

## Installation

### Option A — Chrome extension (recommended)

1. Download this repository: **Code → Download ZIP**, then unzip it. Or clone it with git.
2. Open `chrome://extensions` in Chrome, Edge, Brave or another Chromium browser.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension` folder.
5. Pin the extension. Then either click its icon or press **Alt+Shift+I**.

If you are not on Instagram, the extension opens instagram.com in a new tab and starts the tracker there. Log in to Instagram in that browser first.

### Option B — Console (no installation)

1. Open [instagram.com](https://www.instagram.com) on a computer and log in.
2. Open the console:
   - Windows: `Ctrl + Shift + J`
   - Mac: `⌘ + ⌥ + J`
3. Chrome blocks pasting the first time. Type `allow pasting` and press Enter.
4. Copy the **whole** [`ig-tracker.js`](ig-tracker.js) file, paste it into the console and press Enter.

Both options run the same code and share the same saved history.

## Usage

1. In the panel, enter a username and press **Scan**. Leave the field empty to scan your own account.
2. Minimize the panel with `▁`. Bring it back with the **IG** button in the bottom-right corner or the extension icon.

## How change tracking works

1. The first scan of an account saves a **first snapshot**.
2. Every later scan is compared with the previous snapshot. The differences appear in the **Changes** tab.
3. All changes accumulate in the **🕘 History** screen.
4. **Back up** and **Restore backup** in the *Saved accounts* section move your records to another browser.

Incomplete scans (stopped early, or throttled by Instagram) never overwrite a snapshot.

## Building the extension zip

`ig-tracker.js` in the repository root is the source. Run `./build-extension.sh` to copy it into `extension/` and create `dist/mvp-instagram-tracker-extension-v<version>.zip`.

## Settings

Available under ⚙️ **Settings**:

| Setting | Default |
|---|---|
| Scan: delay between pages | 1 s |
| Scan: long pause every N pages / pause length | 6 pages / 10 s |
| Unfollow: delay between actions | 4 s |
| Unfollow: pause every N actions / pause length | 5 actions / 5 min |
| Result verification | My account only |

## Limitations and warnings

- **Unofficial API.** The tool uses Instagram's unofficial internal web API. This is against Instagram's Terms of Use, and the tool may stop working whenever Instagram changes something.
- **Scan frequency.** Scanning too often or bulk unfollowing can get your account **temporarily restricted**. Scan the same account no more than once or twice a day.
- **Count differences.** The profile count and the list can differ by a few accounts. Instagram counts deactivated or restricted accounts but doesn't list them.
- **Local storage only.** Records live in this browser only; clearing browser data deletes them. Use **Back up** regularly.
- **Personal use.** The tool is for personal and educational use. Respect other people's privacy.

## Credits

Built on top of two MIT-licensed open-source projects:

- [davidarroyo1234/InstagramUnfollowers](https://github.com/davidarroyo1234/InstagramUnfollowers): the UI concept, whitelist and unfollow flow
- [HenryLok0/Instagram_Follower_Checker](https://github.com/HenryLok0/Instagram_Follower_Checker): scanning other accounts and multi-account comparison

## License

[MIT](LICENSE)
