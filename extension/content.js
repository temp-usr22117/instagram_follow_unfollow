// Content script is now optional, scraping is done via injected function from popup.js

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (request.action === 'scrapeAndAnalyze') {
    sendResponse({status: 'started'});
    try {
      function waitForSelector(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
          const start = Date.now();
          function check() {
            const el = document.querySelector(selector);
            if (el) return resolve(el);
            if (Date.now() - start > timeout) return reject('Timeout');
            setTimeout(check, 200);
          }
          check();
        });
      }

      function getActiveDialog() {
        return document.querySelector("div[role='dialog']") || document.querySelector("div.x1lliihq.x1iyjqo2");
      }

      function getScrollableListContainer(dialog) {
        if (!dialog) return null;

        const candidates = [dialog, ...Array.from(dialog.querySelectorAll("*"))];
        const exactScroller = candidates.find((element) => {
          const style = window.getComputedStyle(element);
          return (
            element.scrollHeight > element.clientHeight + 20 &&
            (style.overflowY === 'auto' || style.overflowY === 'scroll')
          );
        });

        if (exactScroller) return exactScroller;

        const explicitScroller = dialog.querySelector("div.x1lliihq.x1iyjqo2");
        if (explicitScroller) return explicitScroller;

        return dialog;
      }

      async function waitForDialogToClose(timeout = 10000) {
        const start = Date.now();
        return new Promise((resolve) => {
          function poll() {
            const dialog = getActiveDialog();
            if (!dialog) return resolve(true);
            if (Date.now() - start > timeout) return resolve(false);
            setTimeout(poll, 200);
          }
          poll();
        });
      }
      async function cliScrollAndScrape(dialogSelector, userSelector) {
        const dialog = await waitForSelector(dialogSelector);
        let usernames = new Set();
        let consecutive_scrolls_with_no_new_users = 0;
        let max_scrolls = 50;
        let scroll_count = 0;
        let lastCount = 0;
        const scrollDelayMs = 7000;

        function collectUsernames() {
          let current_elements = Array.from(dialog.querySelectorAll(userSelector));
          for (let el of current_elements) {
            let href = el.getAttribute("href");
            if (href) {
              let path = href.split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '');
              let username = path.split('/')[0];
              if (username && username !== 'verified') {
                usernames.add(username.trim().toLowerCase());
              }
            }
          }
        }
        return new Promise((resolve) => {
          function scrollAndCollect() {
            const scroller = getScrollableListContainer(dialog);
            collectUsernames();
            let currentCount = usernames.size;
            if (currentCount === lastCount) {
              consecutive_scrolls_with_no_new_users++;
            } else {
              consecutive_scrolls_with_no_new_users = 0;
            }
            lastCount = currentCount;
            scroller.scrollTop = scroller.scrollHeight;
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            scroll_count++;
            if (consecutive_scrolls_with_no_new_users < 3 && scroll_count < max_scrolls) {
              setTimeout(scrollAndCollect, scrollDelayMs); // Match the slower, proven CLI timing
            } else {
              collectUsernames();
              resolve(Array.from(usernames));
            }
          }
          scrollAndCollect();
        });
      }
      async function clickAndScrape(linkSelector, dialogSelector, userSelector) {
        // Wait for link and click
        const link = await waitForSelector(linkSelector, 15000);
        link.click();
        await waitForSelector(dialogSelector, 15000);
        await new Promise(r => setTimeout(r, 3000));
        const users = await cliScrollAndScrape(dialogSelector, userSelector);
        // Try to close dialog
        let closed = false;
        try {
          const closeBtn = document.querySelector("div[role='dialog'] svg[aria-label='Close']");
          if (closeBtn) {
            closeBtn.click();
            closed = await waitForDialogToClose(5000);
          }
        } catch (e) {}
        if (!closed) {
          document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
          closed = await waitForDialogToClose(5000);
        }
        await new Promise(r => setTimeout(r, 1000));
        return users;
      }
      async function closeAnyOpenDialog() {
        let closed = false;
        try {
          const closeBtn = document.querySelector("div[role='dialog'] svg[aria-label='Close']");
          if (closeBtn) {
            closeBtn.click();
            closed = await waitForDialogToClose(5000);
          }
        } catch (e) {}
        if (!closed) {
          document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
          await waitForDialogToClose(5000);
        }
      }
      async function main() {
        // Get username from profile URL
        const match = window.location.pathname.match(/^\/([^\/]+)\/?$/);
        if (!match) return 'Please open your Instagram profile page.';
        const username = match[1];
        // Scrape following
        let following = [];
        let followers = [];
        try {
          following = await clickAndScrape(
            `a[href='/${username}/following/']`,
            "div[role='dialog']",
            "a[href^='/'][role='link']"
          );
        } catch (e) {
          return 'Error opening/scraping Following dialog: ' + e;
        }
        try {
          followers = await clickAndScrape(
            `a[href='/${username}/followers/']`,
            "div[role='dialog']",
            "a[href^='/'][role='link']"
          );
        } catch (e) {
          return 'Error opening/scraping Followers dialog: ' + e;
        }
        // Analyze
        const nonFollowers = following.filter(u => !followers.includes(u));
        let result = `Total Following: ${following.length}\nTotal Followers: ${followers.length}\nDoesn't Follow You Back: ${nonFollowers.length}\n`;
        if (nonFollowers.length) {
          result += '\nAccounts that don\'t follow you back:\n' + nonFollowers.join('\n');
        } else {
          result += '\nEveryone you follow also follows you back!';
        }
        await closeAnyOpenDialog();
        chrome.runtime.sendMessage({action: 'showResults', result});
      }
      main();
    } catch (e) {
      chrome.runtime.sendMessage({action: 'showResults', result: 'Error: ' + e});
    }
  }
});
