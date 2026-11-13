// The app's own window. Talks to Rust through window.__TAURI__
// (enabled by "withGlobalTauri" in tauri.conf.json).
(() => {
  'use strict';

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const $ = (id) => document.getElementById(id);
  const form = $('scan-form');
  const usernameInput = $('username');
  const startBtn = $('start');
  const cancelBtn = $('cancel');
  const statusEl = $('status');

  const fmt = (n) => Number(n).toLocaleString();

  // ---- Status -------------------------------------------------------------
  function renderStatus(s) {
    const running = s.state === 'running';
    startBtn.disabled = running;
    usernameInput.disabled = running;
    cancelBtn.hidden = !running;
    statusEl.className = 'status';

    if (running) {
      statusEl.classList.add('running');
      if (s.waiting_for_login) {
        statusEl.textContent = 'Log in to Instagram in the window that opened. The scan continues by itself afterwards.';
      } else if (s.list === 'following') {
        statusEl.textContent = `Scanning @${s.username}: following list, ${fmt(s.live_count)} found so far…`;
      } else {
        const done = s.following_found != null ? `following done (${fmt(s.following_found)}), ` : '';
        statusEl.textContent = `Scanning @${s.username}: ${done}followers list, ${fmt(s.live_count)} found so far…`;
      }
    } else if (s.state === 'done') {
      statusEl.classList.add('done');
      statusEl.textContent = 'Scan finished.';
    } else if (s.state === 'failed' || s.state === 'cancelled') {
      statusEl.classList.add(s.state === 'failed' ? 'error' : 'done');
      statusEl.textContent = s.message || (s.state === 'failed' ? 'The scan failed.' : 'Cancelled.');
    }
  }

  // ---- Results ------------------------------------------------------------
  let report = null;
  let activeTab = 'not_following_back';

  function tabsFor(r) {
    const tabs = [
      { id: 'not_following_back', label: "Don't follow you back", users: r.not_following_back },
      { id: 'fans', label: "You don't follow back", users: r.fans },
      { id: 'mutual', label: 'Mutual', users: r.mutual },
    ];
    if (r.changes) {
      tabs.push(
        { id: 'unfollowed_you', label: 'Unfollowed you', users: r.changes.unfollowed_you },
        { id: 'new_followers', label: 'New followers', users: r.changes.new_followers },
      );
    }
    return tabs;
  }

  function renderReport(r) {
    report = r;
    $('results').hidden = false;
    $('r-user').textContent = `@${r.username}`;
    $('r-when').textContent = `Scanned ${new Date(r.scanned_at).toLocaleString()}`;
    $('t-following').textContent = fmt(r.following_count);
    $('t-followers').textContent = fmt(r.followers_count);
    $('t-nfb').textContent = fmt(r.not_following_back.length);
    $('t-fans').textContent = fmt(r.fans.length);
    $('t-mutual').textContent = fmt(r.mutual.length);
    $('csv-saved').hidden = true;
    if (!usernameInput.value) usernameInput.value = r.username;

    const short = [];
    if (r.following_complete === false) short.push(`following (${fmt(r.following_count)} of ${fmt(r.following_expected)})`);
    if (r.followers_complete === false) short.push(`followers (${fmt(r.followers_count)} of ${fmt(r.followers_expected)})`);
    const warning = $('r-warning');
    warning.hidden = short.length === 0;
    warning.textContent = short.length
      ? `Instagram stopped loading part of the list: ${short.join(' and ')}. ` +
        'Some results below may be wrong. Running the scan again later usually helps.'
      : '';

    const note = $('changes-note');
    if (r.changes) {
      note.hidden = false;
      note.textContent =
        `Compared with your scan from ${new Date(r.changes.since).toLocaleString()}.` +
        (r.changes.reliable ? '' : ' One of the two scans was incomplete, so "Unfollowed you" may include people who didn\'t.');
    } else {
      note.hidden = false;
      note.textContent = 'Scan again later to see who unfollowed you since today.';
    }

    if (!tabsFor(r).some((t) => t.id === activeTab)) activeTab = 'not_following_back';
    renderTabs();
  }

  function renderTabs() {
    const tabsEl = $('tabs');
    tabsEl.replaceChildren();
    for (const t of tabsFor(report)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t.id === activeTab));
      b.append(t.label);
      const c = document.createElement('span');
      c.className = 'count';
      c.textContent = fmt(t.users.length);
      b.append(c);
      b.addEventListener('click', () => {
        activeTab = t.id;
        renderTabs();
      });
      tabsEl.append(b);
    }
    renderList();
  }

  function renderList() {
    const tab = tabsFor(report).find((t) => t.id === activeTab);
    const q = $('filter').value.trim().toLowerCase().replace(/^@/, '');
    const users = q ? tab.users.filter((u) => u.includes(q)) : tab.users;
    const list = $('list');
    list.replaceChildren(
      ...users.map((u) => {
        const li = document.createElement('li');
        li.textContent = `@${u}`;
        return li;
      }),
    );
    $('list-empty').hidden = users.length > 0;
    $('list-count').textContent = q ? `${fmt(users.length)} of ${fmt(tab.users.length)}` : '';
  }

  // ---- Events -------------------------------------------------------------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      renderStatus(await invoke('start_scan', { username: usernameInput.value }));
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = String(err);
    }
  });

  cancelBtn.addEventListener('click', async () => {
    renderStatus(await invoke('cancel_scan'));
  });

  $('filter').addEventListener('input', () => report && renderList());

  $('save-csv').addEventListener('click', async () => {
    const out = $('csv-saved');
    out.hidden = false;
    try {
      out.textContent = `Saved to ${await invoke('save_csv')}`;
    } catch (err) {
      out.textContent = `Couldn't save: ${err}`;
    }
  });

  listen('scan-status', (e) => renderStatus(e.payload));
  listen('scan-finished', (e) => renderReport(e.payload));

  // ---- Startup ------------------------------------------------------------
  invoke('get_status').then(renderStatus).catch(() => {});
  invoke('latest_report')
    .then((r) => r && renderReport(r))
    .catch((err) => {
      statusEl.className = 'status error';
      statusEl.textContent = `Couldn't load your last scan: ${err}`;
    });
})();
