//! The scan state machine.
//!
//! Rust keeps track of the scan's progress; the script injected into the
//! Instagram page has no memory. Every time the page loads (or every couple of
//! seconds while it's idle) the script reports its current URL through
//! [`ScanSession::next_task`] and gets back one small [`Task`]: wait for the
//! person to log in, go to a URL, or scrape the list on the current page.
//!
//! Page loads wipe the script's state, so keeping the state here is what lets
//! a scan survive redirects, logins and full reloads on every platform.

use crate::analysis::{Analysis, ListKind};
use crate::username;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

/// How many times in a row the page may be sent to the list URL without
/// arriving there before the scan gives up.
pub const MAX_NAVIGATIONS: u32 = 6;

/// Upper bound on usernames accepted in one report. Instagram caps following
/// at 7,500; this leaves room for very large follower lists while rejecting
/// nonsense from a misbehaving page.
pub const MAX_LIST_SIZE: usize = 1_000_000;

/// Paths where Instagram is asking the person to log in or verify themselves.
const LOGIN_PATH_PREFIXES: &[&str] = &[
    "/accounts/login",
    "/accounts/emailsignup",
    "/accounts/password",
    "/challenge",
    "/two_factor",
    "/auth_platform",
];

/// What the page script should do next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Task {
    /// No scan is running, or there's nothing to do on this page.
    Idle,
    /// The page is a login or verification step; leave it to the person.
    WaitForLogin,
    /// Load this URL (a full page load).
    Navigate { url: String },
    /// Scroll through the list on the current page and report every username.
    Scrape { list: ListKind, username: String },
}

/// Overall state, for the app's status line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Idle,
    Running,
    Done,
    Cancelled,
    Failed,
}

/// A snapshot of the session for the app's UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub state: State,
    pub username: Option<String>,
    /// The list being scraped while `state` is `Running`.
    pub list: Option<ListKind>,
    pub waiting_for_login: bool,
    /// Usernames found so far in the current list.
    pub live_count: usize,
    pub following_found: Option<usize>,
    pub followers_found: Option<usize>,
    /// Why the scan was cancelled or failed.
    pub message: Option<String>,
}

impl Status {
    /// Status shown before any scan has been started.
    pub fn idle() -> Self {
        Status {
            state: State::Idle,
            username: None,
            list: None,
            waiting_for_login: false,
            live_count: 0,
            following_found: None,
            followers_found: None,
            message: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanError {
    InvalidUsername(String),
    NotRunning,
    WrongList { expected: ListKind, got: ListKind },
    TooLarge(usize),
}

impl fmt::Display for ScanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScanError::InvalidUsername(raw) => write!(f, "{raw:?} isn't a valid Instagram username"),
            ScanError::NotRunning => write!(f, "no scan is running"),
            ScanError::WrongList { expected, got } => {
                write!(f, "got the {} list while scanning {}", got.as_str(), expected.as_str())
            }
            ScanError::TooLarge(n) => write!(f, "report of {n} usernames is larger than allowed"),
        }
    }
}

impl std::error::Error for ScanError {}

#[derive(Debug, Clone, PartialEq)]
enum Phase {
    Running(ListKind),
    Done,
    Cancelled(String),
    Failed(String),
}

/// One scan of one account: following first, then followers.
#[derive(Debug, Clone)]
pub struct ScanSession {
    username: String,
    phase: Phase,
    following: Option<(BTreeSet<String>, Option<u64>)>,
    following_found: Option<usize>,
    followers_found: Option<usize>,
    waiting_for_login: bool,
    live_count: usize,
    navigations: u32,
}

impl ScanSession {
    /// Starts a scan of `raw_username`'s lists.
    pub fn start(raw_username: &str) -> Result<Self, ScanError> {
        let username = username::normalize(raw_username)
            .ok_or_else(|| ScanError::InvalidUsername(raw_username.to_string()))?;
        Ok(ScanSession {
            username,
            phase: Phase::Running(ListKind::Following),
            following: None,
            following_found: None,
            followers_found: None,
            waiting_for_login: false,
            live_count: 0,
            navigations: 0,
        })
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    pub fn is_running(&self) -> bool {
        matches!(self.phase, Phase::Running(_))
    }

    /// Decides what the page at `page_url` should do.
    pub fn next_task(&mut self, page_url: &str) -> Task {
        let Phase::Running(list) = self.phase else {
            return Task::Idle;
        };
        let Some(path) = instagram_path(page_url) else {
            return self.navigate(list);
        };
        if LOGIN_PATH_PREFIXES.iter().any(|p| path.starts_with(p)) {
            self.waiting_for_login = true;
            return Task::WaitForLogin;
        }
        self.waiting_for_login = false;
        if path == format!("/{}/{}", self.username, list.as_str()) {
            self.navigations = 0;
            return Task::Scrape { list, username: self.username.clone() };
        }
        self.navigate(list)
    }

    fn navigate(&mut self, list: ListKind) -> Task {
        self.navigations += 1;
        if self.navigations > MAX_NAVIGATIONS {
            self.fail(format!(
                "Couldn't open the {} list for @{}. Check the username, and that the account is public or you follow it.",
                list.as_str(),
                self.username
            ));
            return Task::Idle;
        }
        Task::Navigate { url: list_url(&self.username, list) }
    }

    /// Records a live count from the page while it scrolls.
    pub fn progress(&mut self, list: ListKind, count: usize) {
        if self.phase == Phase::Running(list) {
            self.live_count = count;
        }
    }

    /// Accepts a finished list from the page. Returns the full [`Analysis`]
    /// once both lists are in.
    ///
    /// Usernames are validated again here: the page is Instagram's, so
    /// nothing it sends is trusted as-is.
    pub fn report(
        &mut self,
        list: ListKind,
        usernames: Vec<String>,
        expected: Option<u64>,
    ) -> Result<Option<Analysis>, ScanError> {
        let Phase::Running(current) = self.phase else {
            return Err(ScanError::NotRunning);
        };
        if current != list {
            return Err(ScanError::WrongList { expected: current, got: list });
        }
        if usernames.len() > MAX_LIST_SIZE {
            return Err(ScanError::TooLarge(usernames.len()));
        }
        let users: BTreeSet<String> = usernames
            .iter()
            .filter_map(|u| username::normalize(u))
            .filter(|u| *u != self.username)
            .collect();
        self.live_count = 0;
        self.navigations = 0;

        match list {
            ListKind::Following => {
                self.following_found = Some(users.len());
                self.following = Some((users, expected));
                self.phase = Phase::Running(ListKind::Followers);
                Ok(None)
            }
            ListKind::Followers => {
                let (following, following_expected) = self.following.take().unwrap_or_default();
                self.followers_found = Some(users.len());
                self.phase = Phase::Done;
                Ok(Some(Analysis {
                    username: self.username.clone(),
                    scanned_at: now_ms(),
                    following,
                    followers: users,
                    following_expected,
                    followers_expected: expected,
                }))
            }
        }
    }

    /// Stops a running scan because the person asked to or closed the window.
    pub fn cancel(&mut self, reason: impl Into<String>) {
        if self.is_running() {
            self.phase = Phase::Cancelled(reason.into());
        }
    }

    /// Stops a running scan because something went wrong.
    pub fn fail(&mut self, message: impl Into<String>) {
        if self.is_running() {
            self.phase = Phase::Failed(message.into());
        }
    }

    pub fn status(&self) -> Status {
        let (state, list, message) = match &self.phase {
            Phase::Running(list) => (State::Running, Some(*list), None),
            Phase::Done => (State::Done, None, None),
            Phase::Cancelled(m) => (State::Cancelled, None, Some(m.clone())),
            Phase::Failed(m) => (State::Failed, None, Some(m.clone())),
        };
        Status {
            state,
            username: Some(self.username.clone()),
            list,
            waiting_for_login: self.waiting_for_login && state == State::Running,
            live_count: self.live_count,
            following_found: self.following_found,
            followers_found: self.followers_found,
            message,
        }
    }
}

/// `https://www.instagram.com/<username>/<list>/`
pub fn list_url(username: &str, list: ListKind) -> String {
    format!("https://www.instagram.com/{username}/{}/", list.as_str())
}

/// The lowercased path of an instagram.com URL without a trailing slash
/// (`/name/following`), or `None` for any other site.
fn instagram_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    if !username::is_instagram_host(host) {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or("").trim_end_matches('/');
    Some(format!("/{path}").to_ascii_lowercase())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn full_scan_flow() {
        let mut s = ScanSession::start("@Me").unwrap();
        assert_eq!(s.username(), "me");

        // Start page -> go to following list.
        assert_eq!(
            s.next_task("https://www.instagram.com/"),
            Task::Navigate { url: "https://www.instagram.com/me/following/".into() }
        );
        // Instagram redirects to login.
        assert_eq!(
            s.next_task("https://www.instagram.com/accounts/login/?next=%2Fme%2Ffollowing%2F"),
            Task::WaitForLogin
        );
        assert!(s.status().waiting_for_login);
        // Back after login: scrape (case and trailing slash don't matter).
        assert_eq!(
            s.next_task("https://www.instagram.com/Me/following?hl=en"),
            Task::Scrape { list: ListKind::Following, username: "me".into() }
        );
        assert!(!s.status().waiting_for_login);

        s.progress(ListKind::Following, 2);
        assert_eq!(s.status().live_count, 2);

        let done = s.report(ListKind::Following, names(&["Ann", "bob", "me", "bad name"]), Some(2)).unwrap();
        assert!(done.is_none());
        assert_eq!(s.status().following_found, Some(2));
        assert_eq!(s.status().list, Some(ListKind::Followers));

        assert_eq!(
            s.next_task("https://www.instagram.com/me/following/"),
            Task::Navigate { url: "https://www.instagram.com/me/followers/".into() }
        );
        assert_eq!(
            s.next_task("https://www.instagram.com/me/followers/"),
            Task::Scrape { list: ListKind::Followers, username: "me".into() }
        );
        let analysis = s.report(ListKind::Followers, names(&["bob", "cat"]), None).unwrap().unwrap();
        assert_eq!(analysis.not_following_back(), ["ann"]);
        assert_eq!(analysis.fans(), ["cat"]);
        assert_eq!(analysis.following_expected, Some(2));
        assert_eq!(s.status().state, State::Done);
        assert_eq!(s.next_task("https://www.instagram.com/me/followers/"), Task::Idle);
    }

    #[test]
    fn rejects_invalid_username() {
        assert!(matches!(ScanSession::start("not valid"), Err(ScanError::InvalidUsername(_))));
    }

    #[test]
    fn rejects_report_for_wrong_list() {
        let mut s = ScanSession::start("me").unwrap();
        assert_eq!(
            s.report(ListKind::Followers, vec![], None),
            Err(ScanError::WrongList { expected: ListKind::Following, got: ListKind::Followers })
        );
    }

    #[test]
    fn gives_up_after_too_many_navigations() {
        let mut s = ScanSession::start("me").unwrap();
        for _ in 0..MAX_NAVIGATIONS {
            assert!(matches!(s.next_task("https://www.instagram.com/"), Task::Navigate { .. }));
        }
        assert_eq!(s.next_task("https://www.instagram.com/"), Task::Idle);
        assert_eq!(s.status().state, State::Failed);
        assert!(s.status().message.unwrap().contains("@me"));
    }

    #[test]
    fn other_sites_are_sent_back_to_instagram() {
        let mut s = ScanSession::start("me").unwrap();
        assert!(matches!(s.next_task("https://evil.example/me/following/"), Task::Navigate { .. }));
    }

    #[test]
    fn cancel_only_affects_running_scan() {
        let mut s = ScanSession::start("me").unwrap();
        s.cancel("closed");
        assert_eq!(s.status().state, State::Cancelled);
        assert_eq!(s.status().message.as_deref(), Some("closed"));
        s.fail("later error");
        assert_eq!(s.status().message.as_deref(), Some("closed"));
        assert_eq!(s.report(ListKind::Following, vec![], None), Err(ScanError::NotRunning));
    }
}
