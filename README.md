
# Instagram Follower/Following Analyzer

Analyze your Instagram followers and following lists using either a CLI bot (Python/Selenium) or a browser extension (Chrome/Brave).

---

## 1. CLI Bot (Python/Selenium)

### Features
- Scrapes followers and following lists using Selenium and Brave browser
- Compares lists and outputs results
- Uses your local Brave profile for login persistence

### Requirements
- Python 3.8+
- Brave (or Google Chrome/Chromium)

ChromeDriver is downloaded automatically by Selenium to match your browser. To use your own, put it at `./chromedriver`.

### Setup
```bash
./setup.sh                 # creates venv/ and installs requirements.txt
source venv/bin/activate
python first_time_login.py # once: log in to Instagram, session is saved in brave_profile/
```
Brave is expected at `/usr/bin/brave-browser`; set `BRAVE_PATH` to change it. Chrome/Chromium is used if Brave isn't found.

### Usage
```bash
python instagram_bot.py
```
Enter your username when asked. The bot opens your profile, scrolls each list to the end, and prints who doesn't follow you back.

---

## 2. Browser Extension (Chrome/Brave)

### Features
- Fully automates scraping and analysis of followers/following from Instagram web UI
- No login required (uses your active session)
- Simple popup UI with a single "Scrape & Analyze" button

### Setup
1. Open Chrome/Brave and go to `chrome://extensions`.
2. Enable "Developer mode" (top right).
3. Click "Load unpacked" and select the `extension/` folder in this project.
4. The extension icon will appear in your browser toolbar.

### Usage
1. Go to your Instagram profile page in the browser.
2. Click the extension icon.
3. Click the "Scrape & Analyze" button.
4. The extension opens, scrolls and reads both lists, then shows who doesn't follow you back.
   You can close the popup while it runs; reopen it any time to see progress or the results.
   Keep the Instagram tab open and don't click in it until the scan finishes.
5. Click "Download CSV" to save both lists.

---

## Project Structure
- `instagram_bot.py` — CLI bot for local use
- `first_time_login.py` — one-time login helper for the CLI bot
- `browser.py` — browser/driver setup shared by the two scripts above
- `brave_profile/` — Browser profile for CLI bot (not committed)
- `rust/` — cross-platform Rust/Tauri app (work in progress, see `rust/README.md`)
- `extension/` — Browser extension files
- `README.md` — This guide

---

## Troubleshooting
- For CLI bot: If you use your own `./chromedriver`, it must match your Brave version (or delete it and let Selenium download one). Keep `brave_profile/` for login persistence.
- For extension: Make sure you are logged in to Instagram in your browser before scraping. Open your Instagram profile page before clicking the extension icon.

---

## License
MIT

---

## Credits
Developed by reetik-rana and contributors.

