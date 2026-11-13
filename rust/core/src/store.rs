//! Saving scans to disk and reading them back.
//!
//! Layout: `<root>/u_<username>/<scanned_at>.json`, one file per scan.
//! Plain JSON files work the same on every platform, need no database
//! library, and can be opened by hand. The `u_` prefix keeps a username such
//! as `..` from ever being treated as a path.

use crate::analysis::{Analysis, Report};
use crate::username;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub struct SnapshotStore {
    root: PathBuf,
}

impl SnapshotStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        SnapshotStore { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn user_dir(&self, user: &str) -> io::Result<PathBuf> {
        let user = username::normalize(user)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("invalid username {user:?}")))?;
        Ok(self.root.join(format!("u_{user}")))
    }

    /// Writes a scan to disk. Writes to a temporary file first and renames it,
    /// so a crash mid-write never leaves a half-written snapshot.
    pub fn save(&self, analysis: &Analysis) -> io::Result<PathBuf> {
        let dir = self.user_dir(&analysis.username)?;
        fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.json", analysis.scanned_at));
        let tmp = dir.join(format!("{}.json.tmp", analysis.scanned_at));
        fs::write(&tmp, serde_json::to_vec_pretty(analysis).map_err(io::Error::other)?)?;
        fs::rename(&tmp, &path)?;
        Ok(path)
    }

    /// `scanned_at` of every saved scan of `user`, oldest first.
    pub fn history(&self, user: &str) -> io::Result<Vec<u64>> {
        let dir = self.user_dir(user)?;
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut stamps: Vec<u64> = entries
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json")?.parse().ok())
            .collect();
        stamps.sort_unstable();
        Ok(stamps)
    }

    pub fn load(&self, user: &str, scanned_at: u64) -> io::Result<Analysis> {
        let path = self.user_dir(user)?.join(format!("{scanned_at}.json"));
        serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)
    }

    /// The most recent scan of `user`, if any.
    pub fn latest(&self, user: &str) -> io::Result<Option<Analysis>> {
        match self.history(user)?.last() {
            Some(&ts) => self.load(user, ts).map(Some),
            None => Ok(None),
        }
    }

    /// The account whose most recent scan is newest of all.
    pub fn last_scanned_user(&self) -> io::Result<Option<String>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut best: Option<(u64, String)> = None;
        for entry in entries.filter_map(Result::ok) {
            let Some(user) = entry.file_name().to_str().and_then(|n| n.strip_prefix("u_")).map(str::to_owned) else {
                continue;
            };
            if let Some(&ts) = self.history(&user).unwrap_or_default().last() {
                if best.as_ref().is_none_or(|(b, _)| ts > *b) {
                    best = Some((ts, user));
                }
            }
        }
        Ok(best.map(|(_, user)| user))
    }

    /// The results screen for `user`'s latest scan, compared with the scan
    /// before it. With `user` = `None`, uses the most recently scanned account.
    pub fn latest_report(&self, user: Option<&str>) -> io::Result<Option<Report>> {
        let user = match user {
            Some(u) => u.to_string(),
            None => match self.last_scanned_user()? {
                Some(u) => u,
                None => return Ok(None),
            },
        };
        let history = self.history(&user)?;
        let Some((&latest, earlier)) = history.split_last() else {
            return Ok(None);
        };
        let current = self.load(&user, latest)?;
        let previous = match earlier.last() {
            Some(&ts) => Some(self.load(&user, ts)?),
            None => None,
        };
        Ok(Some(Report::build(&current, previous.as_ref())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::sample;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("follow-core-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn empty_store() {
        let tmp = TempDir::new("empty");
        let store = SnapshotStore::new(&tmp.0);
        assert_eq!(store.history("me").unwrap(), Vec::<u64>::new());
        assert!(store.latest("me").unwrap().is_none());
        assert!(store.latest_report(None).unwrap().is_none());
    }

    #[test]
    fn saves_loads_and_compares() {
        let tmp = TempDir::new("roundtrip");
        let store = SnapshotStore::new(&tmp.0);
        let first = sample(100, &["ann"], &["ann", "bob"]);
        let second = sample(200, &["ann"], &["ann", "cat"]);
        store.save(&second).unwrap();
        store.save(&first).unwrap();

        assert_eq!(store.history("me").unwrap(), [100, 200]);
        assert_eq!(store.latest("me").unwrap().unwrap(), second);

        let report = store.latest_report(None).unwrap().unwrap();
        assert_eq!(report.scanned_at, 200);
        let changes = report.changes.unwrap();
        assert_eq!(changes.unfollowed_you, ["bob"]);
        assert_eq!(changes.new_followers, ["cat"]);
    }

    #[test]
    fn picks_most_recently_scanned_user() {
        let tmp = TempDir::new("users");
        let store = SnapshotStore::new(&tmp.0);
        let mut a = sample(300, &[], &[]);
        a.username = "alice".into();
        let mut b = sample(400, &[], &[]);
        b.username = "bob".into();
        store.save(&a).unwrap();
        store.save(&b).unwrap();
        assert_eq!(store.last_scanned_user().unwrap().as_deref(), Some("bob"));
    }

    #[test]
    fn rejects_unsafe_usernames() {
        let tmp = TempDir::new("unsafe");
        let store = SnapshotStore::new(&tmp.0);
        assert!(store.history("../etc").is_err());
        assert!(store.history("..").is_err());
    }
}
