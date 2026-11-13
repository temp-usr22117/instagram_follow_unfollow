// Content script: scrapes the Following and Followers lists from your
// Instagram profile and saves the result in chrome.storage.local.
//
// Everything is saved here, in the page, rather than sent to the popup:
// the popup closes as soon as you click elsewhere, and a scan can take
// many minutes. The popup reads the saved status and results whenever it
// opens, and updates live while it's open.

(() => {
  // The popup may inject this file again if it can't reach it; only the
  // first copy should listen, or every click would start two scans.
  if (window.__igAnalyzerLoaded) return;
  window.__igAnalyzerLoaded = true;

  // ---- Tunables -----------------------------------------------------------
  const SCROLL_PAUSE_MS = [1500, 2800]; // random pause between scrolls
  const LOADING_WAIT_MS = 800;          // extra wait per check while a spinner shows
  const LOADING_MAX_CHECKS = 12;
  const STALL_ROUNDS = 6;               // rounds with nothing new => end of list
  const MAX_SCRAPE_MS = 45 * 60 * 1000; // hard stop for one list

  // First path segments that are Instagram pages, not profiles.
  const RESERVED = new Set([
    'about', 'accounts', 'api', 'ar', 'blog', 'challenge', 'contact', 'developer', 'direct',
    'directory', 'download', 'emails', 'explore', 'graphql', 'help', 'jobs', 'legal', 'lite',
    'locations', 'meta-verified', 'nametag', 'oauth', 'p', 'popular', 'press', 'privacy',
    'professional', 'qr', 'reel', 'reels', 'session', 'static', 'stories', 'terms', 'threads',
    'topics', 'tv', 'web', 'your_activity',
  ]);

  const DIALOG_SELECTOR = "div[role='dialog']";

  let running = false;

  // ---- Helpers ------------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const between = ([min, max]) => min + Math.random() * (max - min);
  const normalizeText = (text) => (text || '').trim().toLowerCase();

  async function waitForCondition(checkFn, timeoutMs = 10000, pollMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = checkFn();
      if (value) return value;
      await sleep(pollMs);
    }
    throw new Error('Timeout');
  }

  function setStatus(status) {
    return chrome.storage.local.set({ scanStatus: { ...status, updatedAt: Date.now() } });
  }

  function getProfileUsernameFromPath() {
    const match = window.location.pathname.match(/^\/([^/]+)\/?$/);
    return match ? match[1].toLowerCase() : null;
  }

  // "/name/", "https://www.instagram.com/name/?x" -> "name"; anything else -> null.
  function usernameFromHref(href) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, location.origin);
    } catch (e) {
      return null;
    }
    if (!/^(www\.)?instagram\.com$/.test(url.hostname)) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return null;
    let name;
    try {
      name = decodeURIComponent(segments[0]).toLowerCase();
    } catch (e) {
      return null;
    }
    if (!/^[a-z0-9._]{1,30}$/.test(name) || /^\.+$/.test(name) || RESERVED.has(name)) return null;
    return name;
  }

  function profileLinks(root) {
    return Array.from(root.querySelectorAll('a[href]')).filter((a) => usernameFromHref(a.getAttribute('href')));
  }

  // ---- Opening and closing the list pop-up --------------------------------
  function getDialog() {
    // The list pop-up is the dialog that contains profile links; other
    // dialogs (notification prompts and the like) are ignored.
    const dialogs = Array.from(document.querySelectorAll(DIALOG_SELECTOR)).reverse();
    return dialogs.find((d) => profileLinks(d).length > 0) || dialogs[0] || null;
  }

  function getDialogTitle(dialog) {
    if (!dialog) return '';
    const titleNode = dialog.querySelector('h1, h2, h3, [role="heading"]');
    return normalizeText(titleNode ? titleNode.textContent : '');
  }

  function getCloseButton(dialog) {
    if (!dialog) return null;
    return (
      dialog.querySelector("svg[aria-label='Close']") ||
      dialog.querySelector("button[aria-label='Close']")
    );
  }

  function resolveClickableElement(node) {
    if (!node) return null;
    return node.closest('a, button, [role="button"], [role="link"]') || node;
  }

  function safeClick(node) {
    if (!node) return;
    try {
      node.click();
    } catch (e) {
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }

  function findRelationshipLink(username, relationType) {
    const want = `/${username}/${relationType}`;
    const anchors = Array.from(document.querySelectorAll('a[href]'));

    const hrefMatch = anchors.find(
      (a) => (a.getAttribute('href') || '').toLowerCase().replace(/\/+$/, '') === want,
    );
    if (hrefMatch) return resolveClickableElement(hrefMatch);

    // Fallback: the count's text, e.g. "123 following". It must contain a
    // number so it never matches the "Following" button on someone else's
    // profile, which opens the unfollow menu.
    const label = new RegExp(`\\d[\\d.,\\s]*[kmb]?\\s*${relationType}\\b`, 'i');
    const candidates = Array.from(document.querySelectorAll('a, [role="link"], [role="button"], button, span'))
      .filter((el) => {
        const text = (el.textContent || '').trim();
        return text.length < 40 && label.test(text);
      })
      .sort((a, b) => a.textContent.length - b.textContent.length);
    return candidates.length ? resolveClickableElement(candidates[0]) : null;
  }

  async function closeDialogIfOpen() {
    const dialog = document.querySelector(DIALOG_SELECTOR);
    if (!dialog) return;

    const closeIcon = getCloseButton(dialog);
    if (closeIcon && closeIcon.closest('button, [role="button"]')) {
      closeIcon.closest('button, [role="button"]').click();
    } else if (closeIcon && closeIcon.parentElement) {
      closeIcon.parentElement.click();
    } else {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    await waitForCondition(() => !document.querySelector(DIALOG_SELECTOR), 8000, 200);
    await sleep(400);
  }

  async function openDialog(username, relationType) {
    await closeDialogIfOpen();

    const link = await waitForCondition(() => findRelationshipLink(username, relationType), 15000, 250)
      .catch(() => {
        throw new Error(`Couldn't find the "${relationType}" link on the profile. Is this your profile page?`);
      });
    safeClick(link);

    // Wait until the pop-up shows at least one account.
    const dialog = await waitForCondition(() => {
      const d = getDialog();
      return d && profileLinks(d).length > 0 ? d : null;
    }, 20000, 250).catch(() => {
      throw new Error(`The ${relationType} list didn't open or stayed empty. Try again in a minute.`);
    });

    // Best effort: make sure it's the right list, but don't fail on an empty title.
    await waitForCondition(() => {
      const title = getDialogTitle(getDialog());
      return title === '' || title.includes(relationType);
    }, 6000, 200).catch(() => {});

    return dialog;
  }

  // ---- Scrolling and reading the list -------------------------------------

  // The element that actually scrolls. Instagram's class names are
  // generated and change often, so look for computed overflow instead.
  let cachedScroller = null;
  function getScrollableListContainer(dialog) {
    if (cachedScroller && cachedScroller.isConnected && dialog.contains(cachedScroller)) {
      return cachedScroller;
    }
    let best = null;
    for (const el of [dialog, ...dialog.querySelectorAll('div')]) {
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      const overflowY = window.getComputedStyle(el).overflowY;
      if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
    cachedScroller = best || dialog;
    return cachedScroller;
  }

  function forceScrollStep(scroller, dialog) {
    const before = scroller.scrollTop;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

    // If Instagram ignores direct scrollTop, try other ways.
    if (scroller.scrollTop === before) {
      scroller.scrollBy({ top: scroller.clientHeight, left: 0, behavior: 'auto' });
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 800, bubbles: true, cancelable: true }));
      const links = profileLinks(dialog);
      if (links.length) links[links.length - 1].scrollIntoView({ block: 'end', inline: 'nearest' });
    }
  }

  function isLoading(dialog) {
    return Boolean(dialog.querySelector('[role="progressbar"], svg[aria-label^="Loading"]'));
  }

  // Instagram may add a "Suggested for you" section below the list. Links
  // after that heading are not part of the list. (Matches English text only.)
  function suggestionsMarker(dialog) {
    for (const el of dialog.querySelectorAll('span, h2, h3, h4, div')) {
      if (el.childElementCount === 0 && /^suggested(\s+for\s+you)?$/i.test(el.textContent.trim())) return el;
    }
    return null;
  }

  function extractUsernamesFromDialog(dialog, self) {
    const marker = suggestionsMarker(dialog);
    const usernames = new Set();
    for (const link of profileLinks(dialog)) {
      if (marker && marker.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
      const name = usernameFromHref(link.getAttribute('href'));
      if (name && name !== self) usernames.add(name);
    }
    return usernames;
  }

  // The exact count shown on the profile header, or null when it's missing
  // or abbreviated ("1.2K"). Used to stop early and to flag short lists.
  function readExpectedCount(username, relationType) {
    const want = `/${username}/${relationType}`;
    const link = Array.from(document.querySelectorAll('a[href]')).find(
      (a) => (a.getAttribute('href') || '').toLowerCase().replace(/\/+$/, '') === want,
    );
    if (!link) return null;
    const titled = link.querySelector('[title]');
    const raw = ((titled && titled.getAttribute('title')) || link.textContent || '').replace(/\s/g, '');
    const match = raw.match(/^([\d.,]+)([kmb])?/i);
    if (!match || match[2]) return null;
    const n = parseInt(match[1].replace(/[.,]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  // Scrolls until the list stops growing (no fixed scroll limit), so long
  // lists are read to the end.
  async function scrapeDialogUsers(dialog, username, relationType, expected) {
    const usernames = new Set();
    const started = Date.now();
    let stalls = 0;
    cachedScroller = null;

    while (Date.now() - started < MAX_SCRAPE_MS) {
      const active = getDialog() || dialog;
      const scroller = getScrollableListContainer(active);
      const sizeBefore = usernames.size;
      const heightBefore = scroller.scrollHeight;

      extractUsernamesFromDialog(active, username).forEach((u) => usernames.add(u));
      await setStatus({ state: 'running', username, list: relationType, count: usernames.size, expected });
      if (expected && usernames.size >= expected) break;

      forceScrollStep(scroller, active);
      await sleep(between(SCROLL_PAUSE_MS));
      for (let i = 0; i < LOADING_MAX_CHECKS && isLoading(active); i += 1) {
        await sleep(LOADING_WAIT_MS);
      }

      extractUsernamesFromDialog(active, username).forEach((u) => usernames.add(u));
      const grew = usernames.size > sizeBefore || scroller.scrollHeight > heightBefore;
      stalls = grew ? 0 : stalls + 1;
      if (stalls >= STALL_ROUNDS) break;
    }

    return Array.from(usernames).sort();
  }

  // ---- The scan -----------------------------------------------------------
  function describeShortfall(found, expected, relationType) {
    // Instagram's counts include some accounts it never lists, so allow 2%.
    return expected && found < expected * 0.98
      ? `${relationType} (${found} of ${expected})`
      : null;
  }

  async function run() {
    const username = getProfileUsernameFromPath();
    if (!username) {
      await setStatus({ state: 'error', message: 'Please open your Instagram profile page first.' });
      return;
    }

    await setStatus({ state: 'running', username, list: 'following', count: 0 });
    const followingExpected = readExpectedCount(username, 'following');
    const followersExpected = readExpectedCount(username, 'followers');

    const scrapeList = async (relationType, expected) => {
      if (expected === 0) return []; // nothing to open
      const dialog = await openDialog(username, relationType);
      const users = await scrapeDialogUsers(dialog, username, relationType, expected);
      await closeDialogIfOpen();
      return users;
    };

    const following = await scrapeList('following', followingExpected);
    await setStatus({ state: 'running', username, list: 'followers', count: 0 });
    const followers = await scrapeList('followers', followersExpected);

    const followersSet = new Set(followers);
    const nonFollowers = following.filter((u) => !followersSet.has(u));

    let result = `Total Following: ${following.length}\nTotal Followers: ${followers.length}\nDoesn't Follow You Back: ${nonFollowers.length}\n`;
    const short = [
      describeShortfall(following.length, followingExpected, 'following'),
      describeShortfall(followers.length, followersExpected, 'followers'),
    ].filter(Boolean);
    if (short.length) {
      result += `\nWarning: Instagram stopped loading part of the list: ${short.join(' and ')}. Some results may be wrong; try again later.\n`;
    }
    if (nonFollowers.length > 0) {
      result += `\nAccounts that don't follow you back:\n${nonFollowers.join('\n')}`;
    } else {
      result += '\nEveryone you follow also follows you back!';
    }

    await chrome.storage.local.set({
      latestResultText: result,
      latestAnalysis: { username, scannedAt: Date.now(), following, followers, nonFollowers },
    });
    await setStatus({ state: 'done', username });
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== 'scrapeAndAnalyze') return;

    if (running) {
      sendResponse({ status: 'busy' });
      return;
    }
    running = true;
    sendResponse({ status: 'started' });

    run()
      .catch((error) =>
        setStatus({
          state: 'error',
          message: `Error: ${error && error.message ? error.message : error}`,
        }),
      )
      .finally(() => {
        running = false;
      });
  });
})();
