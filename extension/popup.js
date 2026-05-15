// Use window.chrome or browser for storage API
const storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : (typeof browser !== 'undefined' && browser.storage && browser.storage.local)
    ? browser.storage.local
    : null;

let latestAnalysis = null;

const btn = document.getElementById('scrapeAnalyzeBtn');
const downloadBtn = document.getElementById('downloadCsvBtn');
const resultsDiv = document.getElementById('results');

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

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
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

function sendScrapeMessage(tabId) {
  chrome.tabs.sendMessage(tabId, {action: 'scrapeAndAnalyze'}, (response) => {
    if (chrome.runtime.lastError) {
      // Content script not injected, so inject it and retry
      chrome.scripting.executeScript({
        target: {tabId: tabId},
        files: ['content.js']
      }, () => {
        chrome.tabs.sendMessage(tabId, {action: 'scrapeAndAnalyze'});
      });
    }
  });
}

btn.addEventListener('click', async () => {
  document.getElementById('results').innerText = 'Navigating and scraping...';
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    sendScrapeMessage(tabs[0].id);
  });
});

downloadBtn.addEventListener('click', () => {
  if (!latestAnalysis) {
    return;
  }
  downloadCsv(latestAnalysis);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'showResults') {
    document.getElementById('results').innerText = message.result;
    if (message.analysis) {
      latestAnalysis = message.analysis;
      downloadBtn.disabled = false;
      if (storage) {
        storage.set({ latestAnalysis });
      }
    }
  }
});

if (storage) {
  storage.get(['latestAnalysis'], (data) => {
    if (data.latestAnalysis) {
      latestAnalysis = data.latestAnalysis;
      downloadBtn.disabled = false;
    }
  });
}
