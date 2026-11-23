# Queue for X and LinkedIn

A Chrome extension that adds a pink **Queue** button next to Post in the X and LinkedIn composers. One click schedules your post into the next free slot in your queue, using the site's own scheduler. The result is a normal scheduled post on X or LinkedIn.

No API, no server, no account. Everything stays in your browser.

## How it works

- **Queue** picks the next slot after the last post in your queue and fills in the site's own schedule picker. Before it presses Schedule, it checks that the site shows exactly the chosen time. If anything doesn't match, it stops and leaves the composer as it is.
- **▾** shows the next few slots, lets you pick the cadence, and has a "Re-read queue" option.
- **The queue** is the run of upcoming posts that starts near now with no long gap. A post after a long gap counts as a specific-date post (an anniversary post, say). Queue leaves it where it is and keeps clear of it.
- For a specific date and time, use the site's own schedule button as usual.

## Cadence

Pick it per site in the ▾ menu:

- Every 61–90 min (random): the X default
- Every hour, every 90 minutes, every 3 hours, every day: a fixed gap after the last post in the queue
- Daily at set times: the LinkedIn default (9 PM and 1 AM). Change them with "Edit times…"

Settings are saved in `chrome.storage.local` under `xq_cfg`.

## Install

Download from **https://kamphey.com/q** (not in the Chrome Web Store yet):

1. Download the ZIP and double-click it. You get a folder called `queue-extension`. Keep it somewhere it won't get deleted.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `queue-extension` folder.
4. Reload any open x.com or linkedin.com tabs.

Or clone this repo and load the `extension` folder the same way.

To update: download again, replace the folder, and click the reload arrow on Queue's card in `chrome://extensions`.

## Files

- `extension/slots.js`: pure logic: cadences, slot picking, parsing the sites' date labels.
- `extension/content.js`: X. Reads the Scheduled list, adds the button, drives X's schedule picker.
- `extension/li.js`: LinkedIn. Reads the list from the composer's "Scheduled" tab, drives LinkedIn's picker.
- `extension/background.js`: reads X's scheduled page in a background tab and caches the list.
- `test/slots.test.js`: `node test/slots.test.js`
- `store/`: Chrome Web Store assets, privacy policy, `fit-screens.sh` (fits screenshots to 1280×800), and `build-download.sh` (builds the kamphey.com/q ZIP; then deploy kamphey.com).

## Fragile bits (checked November 2026)

Both sites change their markup without notice. Labels are matched in English (en-US) and times are read in the browser's local timezone.

**X**
- Composer: `[aria-label="Schedule post"]`. Submit button text: `Post` / `Schedule` / `Reply`.
- Picker: day buttons labelled like `Tuesday, November 24, 2026`, `[aria-label="Next month"]`, times as `[role=option]` like `2:00 PM` in 15-minute steps.
- Scheduled list: spans like `Will send on Mon, Nov 23, 2026 at 7:30 AM`.
- In a hidden background tab, X can render the Scheduled list in a different timezone (seen 8 hours off). Each visible read is saved as `trusted`, hidden reads are lined up against it (`XQSlots.bestShift`), and the learned shift is applied.

**LinkedIn**
- Composer: `dialog[open]` with a contenteditable textbox. Submit button text: `Post` / `Schedule`.
- The clock link next to Post is labelled `Scheduled (N)`. Its picker has a `mm/dd/yyyy` date field, a time field like `1:00 AM`, a preview `Posting at Thu, Nov 26, 1:00 AM`, and a Confirm button.
- List rows read `Posting Mon, Nov 23, 2026 at 6:00 PM`. LinkedIn draws the list only while the tab is visible, so Queue reads it from inside the composer.

## Privacy

Queue reads only the dates and times of your scheduled posts, stores them in your browser, and sends nothing anywhere. Full policy: https://kamphey.com/queue/privacy/
