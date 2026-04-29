
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
- Brave or any browser
- ChromeDriver (matching your Brave/Chrome version)
- Selenium (`pip install selenium`)

### Setup
1. Install browser and ChromeDriver.
2. Clone this repository.
3. Install Python dependencies:
   ```bash
   pip install selenium
   ```
4. Ensure `brave_profile/` (or your specific browser_profile) exists in the project root (used for browser session).

### Usage
1. Edit `instagram_bot.py` to set your username and any options.
2. Run the bot:
   ```bash
   python instagram_bot.py
   ```
3. Follow the prompts. The bot will open Brave, log in (if needed), and scrape your lists.

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
4. The extension will automatically open, scroll, and scrape both followers and following lists, then display the analysis (who doesn't follow you back).

---

## Project Structure
- `instagram_bot.py` — CLI bot for local use
- `brave_profile/` — Browser profile for CLI bot
- `extension/` — Browser extension files
- `README.md` — This guide

---

## Troubleshooting
- For CLI bot: Make sure ChromeDriver matches your Brave version. Keep `brave_profile/` for login persistence.
- For extension: Make sure you are logged in to Instagram in your browser before scraping. Open your Instagram profile page before clicking the extension icon.

---

## License
MIT

---

## Credits
Developed by reetik-rana and contributors.

