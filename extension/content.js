// Content script for scraping Instagram followers/following from profile dialogs.

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (request.action !== 'scrapeAndAnalyze') {
    return;
  }

  sendResponse({ status: 'started' });

  try {
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function normalizeText(text) {
      return (text || '').trim().toLowerCase();
    }

    function getProfileUsernameFromPath() {
      const match = window.location.pathname.match(/^\/([^/]+)\/?$/);
      return match ? match[1] : null;
    }

    async function waitForCondition(checkFn, timeoutMs = 10000, pollMs = 200) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const value = checkFn();
        if (value) {
          return value;
        }
        await sleep(pollMs);
      }
      throw new Error('Timeout');
    }

    function getDialog() {
      return document.querySelector("div[role='dialog']");
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
        dialog.querySelector("button[aria-label='Close']") ||
        dialog.querySelector("button[type='button'] svg[aria-label='Close']")
      );
    }

    function getScrollableListContainer(dialog) {
      if (!dialog) return null;

      const explicitScroller = dialog.querySelector('div.x6nl9eh.x1a5l9x9.x7vuprf.x1mg3h75.x1lliihq.x1iyjqo2.xs83m0k.xz65tgg.x1rife3k.x1n2onr6');
      if (explicitScroller) return explicitScroller;

      const candidates = [dialog, ...Array.from(dialog.querySelectorAll('*'))];
      const matching = candidates.find((element) => {
        const style = window.getComputedStyle(element);
        return (
          element.scrollHeight > element.clientHeight + 20 &&
          (style.overflowY === 'auto' || style.overflowY === 'scroll')
        );
      });

      return matching || dialog;
    }

    function forceScrollStep(scroller, dialog) {
      const before = scroller.scrollTop;

      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

      // If Instagram ignores direct scrollTop, try alternate methods.
      if (scroller.scrollTop === before) {
        scroller.scrollBy({ top: scroller.clientHeight, left: 0, behavior: 'auto' });
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 800, bubbles: true, cancelable: true }));

        const links = Array.from(dialog.querySelectorAll("a[href^='/']"));
        const lastLink = links.length ? links[links.length - 1] : null;
        if (lastLink) {
          lastLink.scrollIntoView({ block: 'end', inline: 'nearest' });
        }
      }
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
      const expectedHrefPart = `/${username}/${relationType}`;
      const allAnchors = Array.from(document.querySelectorAll('a[href]'));

      // Prefer exact profile relation links.
      const hrefMatch = allAnchors.find((a) => {
        const href = (a.getAttribute('href') || '').toLowerCase();
        return href.includes(expectedHrefPart);
      });
      if (hrefMatch) return resolveClickableElement(hrefMatch);

      // Fallback: any anchor with relation label text.
      const textMatch = allAnchors.find((a) => {
        const txt = normalizeText(a.textContent);
        return txt.includes(relationType);
      });

      if (textMatch) return resolveClickableElement(textMatch);

      // Last fallback: span/div text node containing "followers" or "following".
      const labelNodes = Array.from(document.querySelectorAll('span, div'));
      const relationLabel = labelNodes.find((el) => {
        const txt = normalizeText(el.textContent);
        return txt.endsWith(` ${relationType}`) || txt === relationType;
      });

      if (relationLabel) return resolveClickableElement(relationLabel);

      return null;
    }

    async function closeDialogIfOpen() {
      const dialog = getDialog();
      if (!dialog) return;

      const closeIcon = getCloseButton(dialog);
      if (closeIcon && closeIcon.closest('button')) {
        closeIcon.closest('button').click();
      } else if (closeIcon && closeIcon.parentElement) {
        closeIcon.parentElement.click();
      } else {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }

      await waitForCondition(() => !getDialog(), 8000, 200);
      await sleep(400);
    }

    async function openDialog(username, relationType) {
      await closeDialogIfOpen();

      const link = await waitForCondition(() => findRelationshipLink(username, relationType), 15000, 250);
      safeClick(link);

      const dialog = await waitForCondition(() => getDialog(), 15000, 200);

      // Best effort: ensure the expected dialog is open, but don't hard fail if title is empty.
      const expectedTitle = relationType === 'followers' ? 'followers' : 'following';
      await waitForCondition(() => {
        const active = getDialog();
        if (!active) return false;
        const title = getDialogTitle(active);
        return title === '' || title.includes(expectedTitle);
      }, 6000, 200);

      return dialog;
    }

    function extractUsernamesFromDialog(dialog) {
      const links = Array.from(dialog.querySelectorAll("a[href^='/']"));
      const usernames = new Set();

      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const path = href.split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '');
        const firstSegment = path.split('/')[0];

        if (!firstSegment) continue;
        // Filter out known non-user paths.
        if ([
          'accounts', 'explore', 'reels', 'stories', 'p', 'tv', 'about', 'developer',
          'direct', 'directory', 'challenge', 'privacy', 'terms', 'legal'
        ].includes(firstSegment.toLowerCase())) {
          continue;
        }

        usernames.add(firstSegment.toLowerCase());
      }

      return usernames;
    }

    async function scrapeDialogUsers(dialog) {
      let usernames = new Set();
      let lastCount = 0;
      let noNewUsersPasses = 0;
      const maxScrolls = 60;
      const scrollDelayMs = 4000;

      for (let i = 0; i < maxScrolls && noNewUsersPasses < 3; i += 1) {
        const activeDialog = getDialog() || dialog;
        const scroller = getScrollableListContainer(activeDialog);
        if (!scroller) break;

        // Merge current visible users.
        const now = extractUsernamesFromDialog(activeDialog);
        now.forEach((u) => usernames.add(u));

        if (usernames.size === lastCount) {
          noNewUsersPasses += 1;
        } else {
          noNewUsersPasses = 0;
        }
        lastCount = usernames.size;

        // Scroll the confirmed container and wait for lazy load.
        forceScrollStep(scroller, activeDialog);
        await sleep(scrollDelayMs);
      }

      // Final collection pass.
      const finalDialog = getDialog() || dialog;
      const finalUsers = extractUsernamesFromDialog(finalDialog);
      finalUsers.forEach((u) => usernames.add(u));

      return Array.from(usernames);
    }

    async function run() {
      const username = getProfileUsernameFromPath();
      if (!username) {
        chrome.runtime.sendMessage({
          action: 'showResults',
          result: 'Please open your Instagram profile page first.'
        });
        return;
      }

      const followingDialog = await openDialog(username, 'following');
      const following = await scrapeDialogUsers(followingDialog);
      await closeDialogIfOpen();

      const followersDialog = await openDialog(username, 'followers');
      const followers = await scrapeDialogUsers(followersDialog);
      await closeDialogIfOpen();

      const followersSet = new Set(followers);
      const nonFollowers = following.filter((u) => !followersSet.has(u));

      let result = `Total Following: ${following.length}\nTotal Followers: ${followers.length}\nDoesn't Follow You Back: ${nonFollowers.length}\n`;
      if (nonFollowers.length > 0) {
        result += `\nAccounts that don't follow you back:\n${nonFollowers.join('\n')}`;
      } else {
        result += '\nEveryone you follow also follows you back!';
      }

      chrome.runtime.sendMessage({ action: 'showResults', result });
    }

    await run();
  } catch (error) {
    chrome.runtime.sendMessage({
      action: 'showResults',
      result: `Error: ${error && error.message ? error.message : error}`
    });
  }
});
