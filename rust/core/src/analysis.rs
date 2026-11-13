//! One completed scan and what can be worked out from it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Share of the profile's displayed count a scraped list must reach to count
/// as complete. Instagram's counts include some accounts it never lists
/// (deactivated or restricted ones), so an exact match is too strict.
pub const COMPLETE_RATIO: f64 = 0.98;

/// Which of the two lists on a profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListKind {
    Following,
    Followers,
}

impl ListKind {
    /// The path segment Instagram uses for this list, e.g. `/name/following/`.
    pub fn as_str(self) -> &'static str {
        match self {
            ListKind::Following => "following",
            ListKind::Followers => "followers",
        }
    }
}

/// Both lists for one account, as saved in a snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Analysis {
    pub username: String,
    /// Unix time in milliseconds when the scan finished.
    pub scanned_at: u64,
    pub following: BTreeSet<String>,
    pub followers: BTreeSet<String>,
    /// The counts shown on the profile at scan time, when the page script
    /// could read them exactly. Used to tell whether a list is complete.
    pub following_expected: Option<u64>,
    pub followers_expected: Option<u64>,
}

impl Analysis {
    /// Accounts you follow that don't follow you back.
    pub fn not_following_back(&self) -> Vec<String> {
        self.following.difference(&self.followers).cloned().collect()
    }

    /// Accounts that follow you that you don't follow back.
    pub fn fans(&self) -> Vec<String> {
        self.followers.difference(&self.following).cloned().collect()
    }

    /// Accounts in both lists.
    pub fn mutual(&self) -> Vec<String> {
        self.following.intersection(&self.followers).cloned().collect()
    }

    /// `Some(true)` if the following list reached the profile's count,
    /// `Some(false)` if it fell short, `None` if the count wasn't known.
    pub fn following_complete(&self) -> Option<bool> {
        completeness(self.following.len(), self.following_expected)
    }

    /// Same as [`Analysis::following_complete`] for the followers list.
    pub fn followers_complete(&self) -> Option<bool> {
        completeness(self.followers.len(), self.followers_expected)
    }
}

fn completeness(found: usize, expected: Option<u64>) -> Option<bool> {
    expected.map(|e| found as f64 >= e as f64 * COMPLETE_RATIO)
}

/// Follower changes between two scans of the same account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Changes {
    /// `scanned_at` of the earlier scan.
    pub since: u64,
    /// Followers in the earlier scan who are gone now.
    pub unfollowed_you: Vec<String>,
    /// Followers now who weren't in the earlier scan.
    pub new_followers: Vec<String>,
    /// False when either scan's followers list was known to be incomplete,
    /// in which case `unfollowed_you` may include people who never left.
    pub reliable: bool,
}

impl Changes {
    pub fn between(previous: &Analysis, current: &Analysis) -> Self {
        Changes {
            since: previous.scanned_at,
            unfollowed_you: previous.followers.difference(&current.followers).cloned().collect(),
            new_followers: current.followers.difference(&previous.followers).cloned().collect(),
            reliable: previous.followers_complete() != Some(false)
                && current.followers_complete() != Some(false),
        }
    }
}

/// Everything the app's results screen shows for one scan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub username: String,
    pub scanned_at: u64,
    pub following_count: usize,
    pub followers_count: usize,
    pub following_expected: Option<u64>,
    pub followers_expected: Option<u64>,
    pub following_complete: Option<bool>,
    pub followers_complete: Option<bool>,
    pub not_following_back: Vec<String>,
    pub fans: Vec<String>,
    pub mutual: Vec<String>,
    /// Compared with the previous scan of the same account, if there is one.
    pub changes: Option<Changes>,
}

impl Report {
    pub fn build(current: &Analysis, previous: Option<&Analysis>) -> Self {
        Report {
            username: current.username.clone(),
            scanned_at: current.scanned_at,
            following_count: current.following.len(),
            followers_count: current.followers.len(),
            following_expected: current.following_expected,
            followers_expected: current.followers_expected,
            following_complete: current.following_complete(),
            followers_complete: current.followers_complete(),
            not_following_back: current.not_following_back(),
            fans: current.fans(),
            mutual: current.mutual(),
            changes: previous.map(|p| Changes::between(p, current)),
        }
    }
}

#[cfg(test)]
pub(crate) fn sample(scanned_at: u64, following: &[&str], followers: &[&str]) -> Analysis {
    Analysis {
        username: "me".into(),
        scanned_at,
        following: following.iter().map(|s| s.to_string()).collect(),
        followers: followers.iter().map(|s| s.to_string()).collect(),
        following_expected: None,
        followers_expected: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_into_three_groups() {
        let a = sample(1, &["ann", "bob", "cat"], &["bob", "cat", "dan"]);
        assert_eq!(a.not_following_back(), ["ann"]);
        assert_eq!(a.fans(), ["dan"]);
        assert_eq!(a.mutual(), ["bob", "cat"]);
    }

    #[test]
    fn completeness_uses_ratio() {
        let mut a = sample(1, &[], &[]);
        a.followers = (0..98).map(|i| format!("u{i}")).collect();
        a.followers_expected = Some(100);
        assert_eq!(a.followers_complete(), Some(true));
        a.followers_expected = Some(101);
        assert_eq!(a.followers_complete(), Some(false));
        a.followers_expected = None;
        assert_eq!(a.followers_complete(), None);
    }

    #[test]
    fn changes_between_scans() {
        let old = sample(1, &[], &["ann", "bob"]);
        let new = sample(2, &[], &["bob", "cat"]);
        let c = Changes::between(&old, &new);
        assert_eq!(c.since, 1);
        assert_eq!(c.unfollowed_you, ["ann"]);
        assert_eq!(c.new_followers, ["cat"]);
        assert!(c.reliable);
    }

    #[test]
    fn changes_unreliable_when_a_list_was_cut_short() {
        let mut old = sample(1, &[], &["ann", "bob"]);
        old.followers_expected = Some(500);
        let new = sample(2, &[], &["bob"]);
        assert!(!Changes::between(&old, &new).reliable);
    }
}
