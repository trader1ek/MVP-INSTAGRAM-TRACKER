// MVP Instagram Tracker — extension service worker.
// Clicking the toolbar icon (or Alt+Shift+I) injects the tracker into the Instagram tab.
// The tracker runs in the page's MAIN world, exactly like pasting it into the console, so it
// shares the same session cookies and the same saved history (IndexedDB) as the console version.

const IG_HOME = 'https://www.instagram.com/';
const isInstagram = (url) => /^https:\/\/www\.instagram\.com\//.test(url || '');

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['ig-tracker.js'], world: 'MAIN' });
}

async function openTracker(tab) {
  if (tab && isInstagram(tab.url)) return inject(tab.id);

  // Not on Instagram: open it in a new tab and start the tracker once the page has loaded.
  // The listener is registered before the tab exists so a fast "complete" event is never missed.
  let targetId = null, done = false;
  const tryInject = (tabId, url) => {
    if (done || tabId !== targetId || !isInstagram(url)) return;
    done = true;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    inject(tabId).catch((e) => console.error('MVP Instagram Tracker:', e));
  };
  const onUpdated = (tabId, info, updated) => { if (info.status === 'complete') tryInject(tabId, updated.url); };
  chrome.tabs.onUpdated.addListener(onUpdated);
  const created = await chrome.tabs.create({ url: IG_HOME });
  targetId = created.id;
  const now = await chrome.tabs.get(created.id);
  if (now.status === 'complete') tryInject(now.id, now.url);
}

chrome.action.onClicked.addListener((tab) => {
  openTracker(tab).catch((e) => console.error('MVP Instagram Tracker:', e));
});

self.openTracker = openTracker; // for automated tests
