// Injected by Follow Analyser into every page of its Instagram window.
//
// This script has no memory of its own: page loads wipe it. Every couple of
// seconds it sends the current URL to Rust (`scan_next`) and does the one task
// it gets back: nothing, wait for login, go to a URL, or scroll through the
// list on this page and report the usernames (`scan_report`).
//
// Instagram's own scripts share this page, so the Rust side re-validates
// everything sent from here.
(() => {
  'use strict';

  if (window.top !== window.self) return;
  if (!/^(www\.)?instagram\.com$/.test(location.hostname)) return;
  if (window.__followAnalyserWorker) return;
  window.__followAnalyserWorker = true;

  // ---- Tunables -----------------------------------------------------------
  const POLL_MS = 1500;                 // how often to ask Rust for a task
  const LIST_APPEAR_TIMEOUT_MS = 20000; // wait this long for the list to show
  const SCROLL_PAUSE_MS = [1500, 2800]; // random pause between scrolls
  const LOADING_WAIT_MS = 800;          // extra wait per check while a spinner shows
  const LOADING_MAX_CHECKS = 12;
  const STALL_ROUNDS = 6;               // rounds with nothing new => end of list
  const MAX_SCRAPE_MS = 45 * 60 * 1000; // hard stop for one list
  const PHONE_LAYOUT_MAX_WIDTH = 735;   // below this Instagram shows lists as pages

  // Same list as follow_core::username::RESERVED_PATHS.
  const RESERVED = new Set([
    'about', 'accounts', 'api', 'ar', 'blog', 'challenge', 'contact', 'developer', 'direct',
    'directory', 'download', 'emails', 'explore', 'graphql', 'help', 'jobs', 'legal', 'lite',
    'locations', 'meta-verified', 'nametag', 'oauth', 'p', 'popular', 'press', 'privacy',
    'professional', 'qr', 'reel', 'reels', 'session', 'static', 'stories', 'terms', 'threads',
    'topics', 'tv', 'web', 'your_activity',
  ]);

  // ---- Helpers ------------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const between = ([min, max]) => min + Math.random() * (max - min);

  function invoke(cmd, args) {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      return Promise.reject(new Error('Tauri IPC is not available on this page'));
    }
    return internals.invoke(cmd, args);
  }

  async function waitFor(check, timeoutMs, pollMs = 250) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = check();
      if (value) return value;
      await sleep(pollMs);
    }
    return null;
  }

  function usernameFromHref(href) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, location.origin);
    } catch {
      return null;
    }
    if (!/^(www\.)?instagram\.com$/.test(url.hostname)) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return null;
    let name;
    try {
      name = decodeURIComponent(segments[0]).toLowerCase();
    } catch {
      return null;
    }
    if (!/^[a-z0-9._]{1,30}$/.test(name) || /^\.+$/.test(name) || RESERVED.has(name)) return null;
    return name;
  }

  function profileLinks(root) {
    return Array.from(root.querySelectorAll('a[href]')).filter((a) => usernameFromHref(a.getAttribute('href')));
  }

  const isPhoneLayout = () => window.innerWidth <= PHONE_LAYOUT_MAX_WIDTH;

  // ---- Status banner on the Instagram page --------------------------------
  let bannerEl = null;
  function banner(text) {
    if (!document.body) return;
    if (!bannerEl || !bannerEl.isConnected) {
      bannerEl = document.createElement('div');
      Object.assign(bannerEl.style, {
        position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
        zIndex: '2147483647', padding: '8px 16px', borderRadius: '999px',
        background: 'rgba(20, 20, 24, 0.92)', color: '#fff',
        font: '600 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif',
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)', pointerEvents: 'none', maxWidth: '90vw',
      });
      document.body.appendChild(bannerEl);
    }
    bannerEl.textContent = text;
  }

  // ---- Finding the list ---------------------------------------------------

  // Desktop: the list is in a pop-up (role="dialog"). Phone layout: the list
  // is the page itself.
  const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog[open]';

  function findListRoot() {
    const dialogs = Array.from(document.querySelectorAll(DIALOG_SELECTOR)).reverse();
    const dialog = dialogs.find((d) => profileLinks(d).length > 0);
    if (dialog) return dialog;
    if (isPhoneLayout()) {
      const main = document.querySelector('main') || document.body;
      if (main && profileLinks(main).length > 0) return main;
    }
    return null;
  }

  // On desktop, loading /<user>/following/ may open the pop-up by itself.
  // If it doesn't, click the count on the profile header: first by link
  // target, then (like the browser extension) by its "123 following" text.
  function findListLink(username, list) {
    const want = `/${username}/${list}`;
    const byHref = Array.from(document.querySelectorAll('a[href]')).find(
      (a) => (a.getAttribute('href') || '').toLowerCase().replace(/\/+$/, '') === want,
    );
    if (byHref) return byHref;

    // Must contain a number ("123 following") so this never matches the
    // "Following" button on another profile, which opens the unfollow menu.
    const label = new RegExp(`\\d[\\d.,\\s]*[kmb]?\\s*${list}\\b`, 'i');
    const candidates = Array.from(
      document.querySelectorAll('a, [role="link"], [role="button"], button, span'),
    ).filter((el) => {
      const text = (el.textContent || '').trim();
      return text.length < 40 && label.test(text);
    });
    // Prefer the tightest match (the count itself, not a big container).
    candidates.sort((a, b) => a.textContent.length - b.textContent.length);
    const hit = candidates[0];
    return hit ? hit.closest('a, [role="link"], [role="button"], button') || hit : null;
  }

  function clickListLink(username, list) {
    const link = findListLink(username, list);
    if (!link) return false;
    link.click();
    return true;
  }

  // The element that actually scrolls. Instagram's class names change all the
  // time, so look for computed overflow instead of matching classes.
  let cachedScroller = null;
  function findScroller(root) {
    if (!root.matches(DIALOG_SELECTOR)) {
      return document.scrollingElement || document.documentElement;
    }
    if (cachedScroller && cachedScroller.isConnected && root.contains(cachedScroller)) {
      return cachedScroller;
    }
    let best = null;
    for (const el of [root, ...root.querySelectorAll('div')]) {
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
    cachedScroller = best || root;
    return cachedScroller;
  }

  function scrollDown(scroller, root) {
    const before = scroller.scrollTop;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    if (scroller.scrollTop === before) {
      // Some layouts ignore scrollTop; nudge them in other ways.
      scroller.scrollBy({ top: scroller.clientHeight, behavior: 'auto' });
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 800, bubbles: true, cancelable: true }));
      const links = profileLinks(root);
      if (links.length) links[links.length - 1].scrollIntoView({ block: 'end' });
    }
  }

  function isLoading(root) {
    return Boolean(root.querySelector('[role="progressbar"], svg[aria-label^="Loading"]'));
  }

  // Instagram may append a "Suggested for you" section to a list. Everything
  // after that heading is excluded. (English-only text match.)
  function suggestionsMarker(root) {
    for (const el of root.querySelectorAll('span, h2, h3, h4, div')) {
      if (el.childElementCount === 0 && /^suggested(\s+for\s+you)?$/i.test(el.textContent.trim())) return el;
    }
    return null;
  }

  function extractUsernames(root, self) {
    const marker = suggestionsMarker(root);
    const found = new Set();
    for (const a of profileLinks(root)) {
      if (marker && marker.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
      const name = usernameFromHref(a.getAttribute('href'));
      if (name && name !== self) found.add(name);
    }
    return found;
  }

  // The exact count shown on the profile header, or null when it's missing
  // or abbreviated ("1.2K"). Used only to judge whether the list is complete.
  function readExpectedCount(username, list) {
    const want = `/${username}/${list}`;
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

  // ---- Diagnostics --------------------------------------------------------

  // A description of the page's structure, saved by the app when the list
  // can't be found, so a layout change can be fixed without guessing. It
  // holds tags, roles, link targets and short text snippets, and stays on
  // this device unless you share it.
  function diagnostics(username, list, clicked) {
    const trim = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      href: el.getAttribute('href'),
      text: trim(el.textContent, 80),
    });
    const relationLabel = /\bfollow(ers|ing)\b/i;
    return {
      list,
      username,
      clickedListLink: clicked,
      url: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      viewport: [window.innerWidth, window.innerHeight],
      phoneLayout: isPhoneLayout(),
      readyState: document.readyState,
      hasMain: Boolean(document.querySelector('main')),
      hasHeader: Boolean(document.querySelector('header')),
      linkCount: document.querySelectorAll('a[href]').length,
      profileLinkCount: profileLinks(document).length,
      dialogs: Array.from(document.querySelectorAll(DIALOG_SELECTOR)).map((d) => ({
        ...describe(d),
        text: trim(d.textContent, 300),
        linkCount: d.querySelectorAll('a[href]').length,
        profileLinkCount: profileLinks(d).length,
        sampleHrefs: Array.from(d.querySelectorAll('a[href]')).slice(0, 15).map((a) => a.getAttribute('href')),
      })),
      relationElements: Array.from(document.querySelectorAll('a, [role="link"], [role="button"], button, span'))
        .filter((el) => relationLabel.test(el.textContent || '') && (el.textContent || '').length < 60)
        .slice(0, 25)
        .map(describe),
      linksWithFollowInHref: Array.from(document.querySelectorAll('a[href*="follow"]')).slice(0, 15).map(describe),
      pageText: trim(document.body && document.body.innerText, 800),
    };
  }

  // ---- The scrape task ----------------------------------------------------
  async function scrapeList(list, username) {
    banner(`Follow Analyser: opening your ${list} list…`);

    let root = await waitFor(findListRoot, LIST_APPEAR_TIMEOUT_MS / 2);
    let clicked = false;
    if (!root) {
      // The header may still be rendering; give the link a few seconds to appear.
      clicked = Boolean(await waitFor(() => clickListLink(username, list), 8000, 500));
      if (clicked) root = await waitFor(findListRoot, LIST_APPEAR_TIMEOUT_MS);
    }
    if (!root) {
      await invoke('scan_error', {
        message: `Couldn't find the ${list} list on @${username}'s profile ` +
          `(${clicked ? 'clicked the link, but no list appeared' : 'no pop-up and no link to click'}). ` +
          'The account may be private, or Instagram changed its page layout.',
        details: JSON.stringify(diagnostics(username, list, clicked), null, 2),
      });
      return;
    }

    const expected = readExpectedCount(username, list);
    const users = new Set();
    const started = Date.now();
    let stalls = 0;

    while (Date.now() - started < MAX_SCRAPE_MS) {
      const current = findListRoot() || root;
      const scroller = findScroller(current);
      const sizeBefore = users.size;
      const heightBefore = scroller.scrollHeight;

      extractUsernames(current, username).forEach((u) => users.add(u));
      invoke('scan_progress', { list, count: users.size }).catch(() => {});
      banner(`Follow Analyser: ${list} — ${users.size}${expected ? ` of ${expected}` : ''} found. Please don't click in this window.`);
      if (expected && users.size >= expected) break;

      scrollDown(scroller, current);
      await sleep(between(SCROLL_PAUSE_MS));
      for (let i = 0; i < LOADING_MAX_CHECKS && isLoading(current); i += 1) {
        await sleep(LOADING_WAIT_MS);
      }

      extractUsernames(current, username).forEach((u) => users.add(u));
      const grew = users.size > sizeBefore || scroller.scrollHeight > heightBefore;
      stalls = grew ? 0 : stalls + 1;
      if (stalls >= STALL_ROUNDS) break;
    }

    banner(`Follow Analyser: ${list} done — ${users.size} found.`);
    await invoke('scan_report', { list, usernames: Array.from(users), expected });
  }

  // ---- Worker loop --------------------------------------------------------
  let busy = false;

  async function tick() {
    if (busy || document.readyState === 'loading') return;
    busy = true;
    try {
      const task = await invoke('scan_next', { url: location.href });
      switch (task && task.kind) {
        case 'wait_for_login':
          banner('Follow Analyser: log in to Instagram in this window. The scan starts by itself afterwards.');
          break;
        case 'navigate':
          banner('Follow Analyser: opening your list…');
          location.assign(task.url);
          await sleep(5000); // the page is unloading; don't ask again meanwhile
          break;
        case 'scrape':
          await scrapeList(task.list, task.username);
          break;
        default:
          if (bannerEl) bannerEl.remove();
      }
    } catch (e) {
      // No scan running, or IPC isn't ready yet: try again on the next tick.
    } finally {
      busy = false;
    }
  }

  setInterval(tick, POLL_MS);
})();
