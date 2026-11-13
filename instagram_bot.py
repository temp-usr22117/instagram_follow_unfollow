import random
import time
import traceback

from selenium.common.exceptions import StaleElementReferenceException, TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from browser import make_driver

# --- Tunables ---
SCROLL_PAUSE_SECONDS = (1.5, 2.8)  # random pause between scrolls
LOADING_WAIT_SECONDS = 0.8         # extra wait per check while a spinner shows
LOADING_MAX_CHECKS = 12
STALL_ROUNDS = 6                   # rounds with nothing new => end of list
MAX_SCRAPE_SECONDS = 45 * 60       # hard stop for one list

TARGET_USERNAME = input("Enter your Instagram username: ").strip().lstrip("@").lower()

driver = make_driver()
wait = WebDriverWait(driver, 10)

# --- JavaScript run inside the page ---
# Everything below is scoped to the list pop-up, so links on the profile
# page behind it are never counted. The scrolling element is found by its
# computed style, not by Instagram's generated class names, which change often.
JS_HELPERS = r"""
const RESERVED = new Set([
  'about', 'accounts', 'api', 'ar', 'blog', 'challenge', 'contact', 'developer', 'direct',
  'directory', 'download', 'emails', 'explore', 'graphql', 'help', 'jobs', 'legal', 'lite',
  'locations', 'meta-verified', 'nametag', 'oauth', 'p', 'popular', 'press', 'privacy',
  'professional', 'qr', 'reel', 'reels', 'session', 'static', 'stories', 'terms', 'threads',
  'topics', 'tv', 'web', 'your_activity',
]);
function usernameFromHref(href) {
  if (!href) return null;
  let url;
  try { url = new URL(href, location.origin); } catch (e) { return null; }
  if (!/^(www\.)?instagram\.com$/.test(url.hostname)) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  let name;
  try { name = decodeURIComponent(segments[0]).toLowerCase(); } catch (e) { return null; }
  if (!/^[a-z0-9._]{1,30}$/.test(name) || /^\.+$/.test(name) || RESERVED.has(name)) return null;
  return name;
}
function profileLinks(root) {
  return Array.from(root.querySelectorAll('a[href]')).filter((a) => usernameFromHref(a.getAttribute('href')));
}
function findListDialog() {
  const dialogs = Array.from(document.querySelectorAll("div[role='dialog']")).reverse();
  return dialogs.find((d) => profileLinks(d).length > 0) || null;
}
function findScroller(dialog) {
  let best = null;
  for (const el of [dialog, ...dialog.querySelectorAll('div')]) {
    if (el.scrollHeight <= el.clientHeight + 20) continue;
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
    if (!best || el.scrollHeight > best.scrollHeight) best = el;
  }
  return best || dialog;
}
// Instagram may add a "Suggested for you" section below the list; links
// after that heading are skipped. (Matches English text only.)
function suggestionsMarker(dialog) {
  for (const el of dialog.querySelectorAll('span, h2, h3, h4, div')) {
    if (el.childElementCount === 0 && /^suggested(\s+for\s+you)?$/i.test(el.textContent.trim())) return el;
  }
  return null;
}
"""

FIND_DIALOG_JS = JS_HELPERS + "return findListDialog();"

READ_JS = JS_HELPERS + r"""
const dialog = arguments[0], self = arguments[1];
const marker = suggestionsMarker(dialog);
const users = new Set();
for (const a of profileLinks(dialog)) {
  if (marker && (marker.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
  const name = usernameFromHref(a.getAttribute('href'));
  if (name && name !== self) users.add(name);
}
return {
  users: Array.from(users),
  height: findScroller(dialog).scrollHeight,
  loading: Boolean(dialog.querySelector('[role="progressbar"], svg[aria-label^="Loading"]')),
};
"""

SCROLL_JS = JS_HELPERS + r"""
const dialog = arguments[0];
const scroller = findScroller(dialog);
const before = scroller.scrollTop;
scroller.scrollTop = scroller.scrollHeight;
scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
if (scroller.scrollTop === before) {
  scroller.scrollBy({ top: scroller.clientHeight, behavior: 'auto' });
  const links = profileLinks(dialog);
  if (links.length) links[links.length - 1].scrollIntoView({ block: 'end' });
}
"""

# The exact count on the profile header, or null if missing or abbreviated ("1.2K").
EXPECTED_COUNT_JS = r"""
const want = `/${arguments[0]}/${arguments[1]}`;
const link = Array.from(document.querySelectorAll('a[href]')).find(
  (a) => (a.getAttribute('href') || '').toLowerCase().replace(/\/+$/, '') === want);
if (!link) return null;
const titled = link.querySelector('[title]');
const raw = ((titled && titled.getAttribute('title')) || link.textContent || '').replace(/\s/g, '');
const m = raw.match(/^([\d.,]+)([kmb])?/i);
if (!m || m[2]) return null;
const n = parseInt(m[1].replace(/[.,]/g, ''), 10);
return Number.isFinite(n) ? n : null;
"""


def wait_for_list_dialog(timeout=20):
    return WebDriverWait(driver, timeout).until(lambda d: d.execute_script(FIND_DIALOG_JS))


def scrape_list(expected):
    """Scrolls the open list pop-up to the end and returns its usernames."""
    print("Waiting for the list dialog to appear...")
    try:
        dialog = wait_for_list_dialog()
    except TimeoutException:
        print("ERROR: The list didn't open or stayed empty. The page structure may have changed.")
        return set()

    print("Dialog appeared. Starting to scrape...")
    usernames = set()
    stalls = 0
    started = time.time()

    while time.time() - started < MAX_SCRAPE_SECONDS:
        try:
            state = driver.execute_script(READ_JS, dialog, TARGET_USERNAME)
            size_before, height_before = len(usernames), state["height"]
            usernames.update(state["users"])
            of = f" of {expected}" if expected else ""
            print(f"Scraped {len(usernames)}{of} usernames so far...")
            if expected and len(usernames) >= expected:
                break

            driver.execute_script(SCROLL_JS, dialog)
            time.sleep(random.uniform(*SCROLL_PAUSE_SECONDS))
            for _ in range(LOADING_MAX_CHECKS):
                if not driver.execute_script(READ_JS, dialog, TARGET_USERNAME)["loading"]:
                    break
                time.sleep(LOADING_WAIT_SECONDS)

            state = driver.execute_script(READ_JS, dialog, TARGET_USERNAME)
            usernames.update(state["users"])
        except StaleElementReferenceException:
            # Instagram re-rendered the pop-up; find it again and carry on.
            dialog = wait_for_list_dialog()
            continue

        grew = len(usernames) > size_before or state["height"] > height_before
        stalls = 0 if grew else stalls + 1
        if stalls:
            print(f"[DEBUG] Nothing new after scroll ({stalls}/{STALL_ROUNDS}).")
        if stalls >= STALL_ROUNDS:
            break
    else:
        print("[DEBUG] Reached the time limit. There may be more users not loaded.")

    if expected and len(usernames) < expected * 0.98:
        print(f"WARNING: found {len(usernames)} of {expected}. Instagram stopped loading part of the list; "
              "results may be wrong. Try again later.")
    print(f"Reached the end of the list. Total usernames: {len(usernames)}")
    return usernames


def close_dialog():
    try:
        driver.find_element(By.CSS_SELECTOR, "div[role='dialog'] svg[aria-label='Close']").click()
        print("[DEBUG] Clicked close button on dialog.")
    except Exception as e:
        print(f"[DEBUG] Could not click close button: {e}. Trying ESC key...")
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
    time.sleep(1)
    wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))


def open_and_scrape(relation):
    expected = driver.execute_script(EXPECTED_COUNT_JS, TARGET_USERNAME, relation)
    if expected == 0:
        print(f"[DEBUG] '{relation}' count is 0; skipping.")
        return set()
    print(f"[DEBUG] Attempting to open '{relation}' dialog...")
    selector = f"a[href='/{TARGET_USERNAME}/{relation}/']"
    wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, selector))).click()
    users = scrape_list(expected)
    close_dialog()
    print(f"✅ '{relation}' dialog closed.")
    return users


# --- MAIN SCRIPT ---
print("🚀 Starting the Instagram bot...")
try:
    driver.get(f"https://www.instagram.com/{TARGET_USERNAME}/")
    print(f"Navigated to {TARGET_USERNAME}'s profile.")

    following_usernames = open_and_scrape("following")
    followers_usernames = open_and_scrape("followers")

    # Show both lists for transparency
    print("\n--- SCRAPED USERNAMES ---")
    print(f"Following ({len(following_usernames)}): {sorted(following_usernames)}")
    print(f"Followers ({len(followers_usernames)}): {sorted(followers_usernames)}")

    # Analyze and Print Results
    print("\n--- ANALYSIS COMPLETE ---")
    non_followers = following_usernames - followers_usernames
    print(f"Total Following: {len(following_usernames)}")
    print(f"Total Followers: {len(followers_usernames)}")
    print(f"Doesn't Follow You Back: {len(non_followers)}")
    print("-------------------------")
    if non_followers:
        print("Accounts that don't follow you back:")
        for user in sorted(non_followers):
            print(user)
    else:
        print("Everyone you follow also follows you back!")
except Exception as e:
    print(f"An error occurred: {e}")
    print("[TRACEBACK]")
    traceback.print_exc()
finally:
    input("\n--- Script finished. Press Enter to close the browser. ---")
    driver.quit()
