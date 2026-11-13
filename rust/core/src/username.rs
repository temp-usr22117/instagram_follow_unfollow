//! Instagram username validation and extraction from profile links.

/// First path segments on instagram.com that are pages, not profiles.
/// Kept in sync with `RESERVED` in `app/src-tauri/scraper.js`.
pub const RESERVED_PATHS: &[&str] = &[
    "about", "accounts", "api", "ar", "blog", "challenge", "contact", "developer", "direct",
    "directory", "download", "emails", "explore", "graphql", "help", "jobs", "legal", "lite",
    "locations", "meta-verified", "nametag", "oauth", "p", "popular", "press", "privacy",
    "professional", "qr", "reel", "reels", "session", "static", "stories", "terms", "threads",
    "topics", "tv", "web", "your_activity",
];

/// Longest username Instagram allows.
pub const MAX_LEN: usize = 30;

/// Lowercases and validates a username typed by a person or found in a link.
///
/// Accepts an optional leading `@` and surrounding whitespace. Returns `None`
/// for anything that can't be an Instagram username: wrong characters, too
/// long, made only of periods, or one of the [`RESERVED_PATHS`].
pub fn normalize(raw: &str) -> Option<String> {
    let name = raw.trim().trim_start_matches('@').to_ascii_lowercase();
    let valid_chars = name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_');
    let only_periods = name.bytes().all(|b| b == b'.');
    if name.is_empty()
        || name.len() > MAX_LEN
        || !valid_chars
        || only_periods
        || RESERVED_PATHS.contains(&name.as_str())
    {
        return None;
    }
    Some(name)
}

/// Extracts the username from a profile link such as `/name/`,
/// `https://www.instagram.com/name/?hl=en` or `https://instagram.com/name`.
///
/// Links with more than one path segment (`/name/followers/`, `/p/abc/`) or
/// pointing to another site return `None`.
pub fn from_profile_href(href: &str) -> Option<String> {
    let path = match href.split_once("://") {
        Some((_scheme, rest)) => {
            let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
            if !is_instagram_host(host) {
                return None;
            }
            path
        }
        None => href,
    };
    let path = path.split(['?', '#']).next().unwrap_or("");
    let mut segments = path.split('/').filter(|s| !s.is_empty());
    match (segments.next(), segments.next()) {
        (Some(first), None) => normalize(first),
        _ => None,
    }
}

/// True for `instagram.com` and `www.instagram.com`, with or without a port.
pub fn is_instagram_host(host: &str) -> bool {
    let host = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    host == "instagram.com" || host == "www.instagram.com"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_case_at_sign_and_whitespace() {
        assert_eq!(normalize("  @Some.User_1 ").as_deref(), Some("some.user_1"));
    }

    #[test]
    fn rejects_invalid_names() {
        for bad in ["", "@", "has space", "emoji😀", "dash-name", "..", ".", "explore", "p", "a".repeat(31).as_str()] {
            assert_eq!(normalize(bad), None, "{bad:?} should be rejected");
        }
        assert!(normalize(&"a".repeat(30)).is_some());
    }

    #[test]
    fn extracts_from_relative_and_absolute_links() {
        assert_eq!(from_profile_href("/alice/").as_deref(), Some("alice"));
        assert_eq!(from_profile_href("/Alice").as_deref(), Some("alice"));
        assert_eq!(from_profile_href("https://www.instagram.com/bob/?hl=en").as_deref(), Some("bob"));
        assert_eq!(from_profile_href("https://instagram.com/bob#x").as_deref(), Some("bob"));
    }

    #[test]
    fn ignores_non_profile_links() {
        for href in ["/", "/alice/followers/", "/p/Cx12ab/", "/explore/", "/reels/", "https://facebook.com/alice/", "https://evil.com/www.instagram.com/alice"] {
            assert_eq!(from_profile_href(href), None, "{href:?} should be ignored");
        }
    }
}
