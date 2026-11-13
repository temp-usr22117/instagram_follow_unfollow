//! CSV export. Same columns as the browser extension's "Download CSV", so
//! files from either tool can be opened side by side.

use crate::analysis::Analysis;

pub const HEADER: [&str; 4] = ["username", "in_following", "in_followers", "status"];

/// One row per account found in either list, sorted by username.
///
/// `status` is `follows_you` (mutual), `not_follows_you` (you follow them,
/// they don't follow back) or `follower_only` (they follow you, you don't).
pub fn to_csv(analysis: &Analysis) -> String {
    let mut out = row(HEADER);
    for user in analysis.following.union(&analysis.followers) {
        let in_following = analysis.following.contains(user);
        let in_followers = analysis.followers.contains(user);
        let status = match (in_following, in_followers) {
            (true, true) => "follows_you",
            (true, false) => "not_follows_you",
            _ => "follower_only",
        };
        out.push_str(&row([user.as_str(), yes_no(in_following), yes_no(in_followers), status]));
    }
    out
}

fn yes_no(b: bool) -> &'static str {
    if b { "yes" } else { "no" }
}

fn row<const N: usize>(fields: [&str; N]) -> String {
    let quoted: Vec<String> = fields.iter().map(|f| format!("\"{}\"", f.replace('"', "\"\""))).collect();
    quoted.join(",") + "\n"
}

/// File name like the extension's: `<user>_followers_following_<time>.csv`.
pub fn file_name(analysis: &Analysis) -> String {
    format!("{}_followers_following_{}.csv", analysis.username, analysis.scanned_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::sample;

    #[test]
    fn rows_and_statuses() {
        let a = sample(5, &["ann", "bob"], &["bob", "cat"]);
        assert_eq!(
            to_csv(&a),
            "\"username\",\"in_following\",\"in_followers\",\"status\"\n\
             \"ann\",\"yes\",\"no\",\"not_follows_you\"\n\
             \"bob\",\"yes\",\"yes\",\"follows_you\"\n\
             \"cat\",\"no\",\"yes\",\"follower_only\"\n"
        );
        assert_eq!(file_name(&a), "me_followers_following_5.csv");
    }

    #[test]
    fn escapes_quotes() {
        assert_eq!(row(["a\"b"]), "\"a\"\"b\"\n");
    }
}
