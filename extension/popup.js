// The popup only starts a scan and shows what content.js has saved in
// chrome.storage.local. The scan itself runs in the Instagram tab, so this
// popup can be closed and reopened at any time.

// A running scan updates its status every few seconds. If the newest update
// is older than this, the tab was closed or reloaded mid-scan.
const STALE_AFTER_MS = 90 * 1000;

const storage = chrome.storage.local;

const btn = document.getElementById('scrapeAnalyzeBtn');
const downloadBtn = document.getElementById('downloadCsvBtn');
const statusDiv = document.getElementById('status');
const resultsDiv = document.getElementById('results');

let latestAnalysis = null;

function toCsvRow(values) {
  return values
    .map((value) => {
      const s = String(value ?? '');
      return `"${s.replace(/"/g, '""')}"`;
    })
    .join(',');
}

function buildAnalysisRows(analysis) {
  const following = Array.isArray(analysis.following) ? analysis.following : [];
  const followers = Array.isArray(analysis.followers) ? analysis.followers : [];

  const followingSet = new Set(following);
  const followersSet = new Set(followers);
  const allUsers = Array.from(new Set([...following, ...followers])).sort((a, b) => a.localeCompare(b));

  return allUsers.map((username) => {
    const inFollowing = followingSet.has(username) ? 'yes' : 'no';
    const inFollowers = followersSet.has(username) ? 'yes' : 'no';

    let status = 'follower_only';
    if (inFollowing === 'yes' && inFollowers === 'yes') status = 'follows_you';
    if (inFollowing === 'yes' && inFollowers === 'no') status = 'not_follows_you';

    return [username, inFollowing, inFollowers, status];
  });
}

function downloadCsv(analysis) {
  const header = ['username', 'in_following', 'in_followers', 'status'];
  const rows = buildAnalysisRows(analysis);
  const csvContent = [header, ...rows].map(toCsvRow).join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const stamp = new Date(analysis.scannedAt || Date.now()).toISOString().replace(/[:.]/g, '-');
  const safeUsername = (analysis.username || 'instagram').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safeUsername}_followers_following_${stamp}.csv`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

function isRunning(status) {
  return Boolean(status && status.state === 'running' && Date.now() - status.updatedAt < STALE_AFTER_MS);
}

function renderStatus(status) {
  btn.disabled = isRunning(status);
  if (!status) {
    statusDiv.textContent = '';
    return;
  }
  if (isRunning(status)) {
    const of = status.expected ? ` of ${status.expected}` : '';
    statusDiv.textContent =
      `Scanning ${status.list} list: ${status.count || 0}${of} found…\n` +
      "You can close this popup; keep the Instagram tab open and don't click in it.";
  } else if (status.state === 'running') {
    statusDiv.textContent = 'The last scan stopped before finishing (the tab was closed or reloaded). Start it again.';
  } else if (status.state === 'error') {
    statusDiv.textContent = status.message || 'The scan failed.';
  } else if (status.state === 'done') {
    statusDiv.textContent = `Last scan: ${new Date(status.updatedAt).toLocaleString()}`;
  } else {
    statusDiv.textContent = '';
  }
}

function renderResults(text, analysis) {
  resultsDiv.textContent = text || '';
  latestAnalysis = analysis || null;
  downloadBtn.disabled = !latestAnalysis;
}

function startScan(tabId) {
  chrome.tabs.sendMessage(tabId, { action: 'scrapeAndAnalyze' }, (response) => {
    if (chrome.runtime.lastError) {
      // The content script isn't in this tab yet (e.g. the tab was open
      // before the extension was installed): inject it and try again.
      chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
        if (chrome.runtime.lastError) {
          statusDiv.textContent = 'Open your Instagram profile page in this tab first.';
          btn.disabled = false;
          return;
        }
        chrome.tabs.sendMessage(tabId, { action: 'scrapeAndAnalyze' }, () => {
          if (chrome.runtime.lastError) {
            // Usually a stale copy left over from before the extension was reloaded.
            statusDiv.textContent = 'Reload the Instagram tab and try again.';
            btn.disabled = false;
          }
        });
      });
      return;
    }
    if (response && response.status === 'busy') {
      statusDiv.textContent = 'A scan is already running in this tab.';
    }
  });
}

btn.addEventListener('click', () => {
  btn.disabled = true;
  statusDiv.textContent = 'Starting…';
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) {
      statusDiv.textContent = 'No active tab found.';
      btn.disabled = false;
      return;
    }
    startScan(tab.id);
  });
});

downloadBtn.addEventListener('click', () => {
  if (latestAnalysis) downloadCsv(latestAnalysis);
});

// Live updates while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.scanStatus) renderStatus(changes.scanStatus.newValue);
  if (changes.latestResultText || changes.latestAnalysis) {
    storage.get(['latestResultText', 'latestAnalysis'], (data) => {
      renderResults(data.latestResultText, data.latestAnalysis);
    });
  }
});

// Show whatever was saved, including a scan that finished while the popup was closed.
storage.get(['scanStatus', 'latestResultText', 'latestAnalysis'], (data) => {
  renderStatus(data.scanStatus);
  renderResults(data.latestResultText, data.latestAnalysis);
});
