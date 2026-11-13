# Follow Analyser (Rust / Tauri)

A desktop app (mobile coming next) that shows who doesn't follow you back on
Instagram. It opens Instagram in its own window, you log in there, and it
scrolls through your Following and Followers lists by itself. Results stay on
your device.

## Layout

```
rust/
├── core/                    # follow-core: all logic, no UI, fully unit-tested
│   └── src/
│       ├── username.rs      # validating usernames, parsing profile links
│       ├── analysis.rs      # one scan; who doesn't follow back; changes between scans
│       ├── scan.rs          # state machine that drives the Instagram page
│       ├── store.rs         # JSON snapshots on disk
│       └── csv.rs           # CSV export (same columns as the browser extension)
└── app/
    ├── ui/                  # the app's window: plain HTML/CSS/JS, no build step
    └── src-tauri/
        ├── src/lib.rs       # Tauri commands; opens/closes the Instagram window
        ├── scraper.js       # injected into every Instagram page
        ├── capabilities/    # which window may call which command
        └── tauri.conf.json
```

## How a scan works

1. You type your username and press **Start scan**. Rust creates a
   `ScanSession` and opens an Instagram window with `scraper.js` injected.
2. Every 1.5 s the script sends its current URL to Rust (`scan_next`) and
   gets one task back:
   - `wait_for_login` on login or verification pages;
   - `navigate` to `instagram.com/<you>/following/` (then `/followers/`);
   - `scrape` once it's on the right page.
3. The scrape task scrolls the list, waiting for each batch to load, and
   stops after several rounds with nothing new (or once it reaches the count
   shown on your profile). It sends live counts (`scan_progress`) and finally
   the full list (`scan_report`).
4. After both lists, Rust saves a snapshot, compares it with your previous
   one, sends the report to the app window and closes the Instagram window.

The script keeps no state, so redirects, logins and reloads don't break a
scan: the next page simply asks Rust again.

### Security

Instagram's own scripts run on the same pages as `scraper.js`, so:

- Only four commands are granted to `instagram.com`
  (`capabilities/instagram.json`); the app's window gets its own five
  (`capabilities/main.json`). `build.rs` registers the commands so nothing is
  allowed by default.
- Each scan command also checks it was called from the Instagram window.
- Rust re-validates every username it receives and caps report sizes.
- The app never sees your password; you log in on Instagram's real page.

## Data on disk

Snapshots go in the app's data folder, one JSON file per scan:

| OS | Folder |
|---|---|
| Linux | `~/.local/share/dev.followanalyser.app/snapshots/` |
| macOS | `~/Library/Application Support/dev.followanalyser.app/snapshots/` |
| Windows | `%APPDATA%\dev.followanalyser.app\snapshots\` |

**Save CSV** writes to your Downloads folder.

## Running it (Linux)

One-time system packages (Ubuntu/Debian):

```bash
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Then, from `rust/`:

```bash
cargo test -p follow-core          # core logic tests
cargo run -p follow-analyser       # start the app
```

`cargo run` is enough for development: the UI is static files, so no Node or
Tauri CLI is needed. For installers (`.deb`, `.AppImage`, …):

```bash
cargo install tauri-cli --version "^2" --locked
cd app/src-tauri
cargo tauri icon icons/icon.png    # generates every icon size/format the bundlers need
cargo tauri build
```

## Known limits

- **Instagram changes its page.** The scraper avoids Instagram's generated
  class names and finds the list by structure, but a redesign can still break
  it. All page-specific logic is in `scraper.js`.
- **Big lists are slow** (a few seconds per batch), and Instagram sometimes
  stops loading before the end. The app compares what it found with the count
  on your profile and warns when a list looks incomplete.
- The "Suggested for you" section is skipped by matching English text only.
- **Mobile isn't wired up yet**: phones give an app a single web view, so the
  scan will run inside the main window there (step 3 of the plan).
- Automated scrolling is against Instagram's terms; the scraper scrolls at a
  human pace, but use it at your own risk.
