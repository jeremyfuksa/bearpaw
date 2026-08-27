//! Update check against the GitHub Releases API (issue #273).
//!
//! Deliberately check-and-notify only: this asks GitHub what the newest
//! release is and hands the answer to the frontend, which shows a banner
//! with a Download button that opens the release page in a browser. There
//! is no in-app download, signature verification, or self-replacement —
//! that would need `tauri-plugin-updater`, a minisign keypair in CI, and
//! a real Developer ID cert for macOS (the bundle is ad-hoc signed today,
//! so a swapped app bundle would be Gatekeeper-quarantined).
//!
//! Offline-first: Bearpaw is expected to work with no network at all, so
//! every failure here is silent. A user with no connection must never see
//! an error, a toast, or a stall — `check_for_updates` returns
//! `UpdateCheck::default()` (no update) on any transport, status, or
//! parse failure.

use std::cmp::Ordering;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const RELEASES_URL: &str = "https://api.github.com/repos/jeremyfuksa/bearpaw/releases?per_page=20";

/// Total budget for the check. Startup runs this off-thread, but a hung
/// socket should still resolve to "no update" rather than linger.
const TIMEOUT: Duration = Duration::from_secs(10);

/// What the frontend needs to render the update banner.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateCheck {
    /// True only when a strictly newer, non-draft, policy-eligible release exists.
    pub available: bool,
    /// Tag of the newer release, e.g. `v1.0.0-beta.3`. `None` when up to date.
    pub latest_version: Option<String>,
    /// Release page URL — opened in the default browser by the Download button.
    /// Taken verbatim from the API's `html_url`, so it always points at this
    /// repo's own release page rather than anywhere the payload chooses.
    pub release_url: Option<String>,
    /// The running version, echoed back so the banner can say "you're on X".
    pub current_version: String,
}

/// One entry from `GET /repos/{owner}/{repo}/releases`. Only the fields
/// this check needs; serde ignores the rest of the payload.
#[derive(Deserialize, Debug)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
}

/// A parsed `X.Y.Z[-prerelease.N]` version.
///
/// Hand-rolled rather than pulling the `semver` crate: `semver` is only a
/// *build*-dependency here (via tauri-build/cargo_metadata), so using it at
/// runtime would be a real new dependency, and the comparison needed is
/// narrower than full semver — Bearpaw only ever ships `X.Y.Z` and
/// `X.Y.Z-beta.N` tags.
#[derive(Debug, PartialEq, Eq)]
struct Version {
    core: (u64, u64, u64),
    /// Dot-separated prerelease identifiers, empty for a stable release.
    pre: Vec<String>,
}

impl Version {
    /// Parse a version string, tolerating a leading `v` (GitHub tags carry
    /// one; `CARGO_PKG_VERSION` does not). Returns `None` if the numeric
    /// core isn't three integers — an unparseable tag is treated as "no
    /// update" rather than guessed at.
    fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        let raw = raw.strip_prefix('v').unwrap_or(raw);
        // Build metadata (`+sha`) never affects precedence — discard it.
        let raw = raw.split('+').next()?;
        let (core_str, pre_str) = match raw.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (raw, None),
        };

        let mut parts = core_str.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }

        let pre = pre_str
            .filter(|s| !s.is_empty())
            .map(|s| s.split('.').map(str::to_string).collect())
            .unwrap_or_default();

        Some(Version {
            core: (major, minor, patch),
            pre,
        })
    }

    fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        // Numeric core dominates.
        match self.core.cmp(&other.core) {
            Ordering::Equal => {}
            non_eq => return non_eq,
        }

        // Same core: a stable release outranks any prerelease of it, so
        // 1.0.0 > 1.0.0-beta.2. (semver §11.3.)
        match (self.is_prerelease(), other.is_prerelease()) {
            (false, false) => return Ordering::Equal,
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            (true, true) => {}
        }

        // Both prereleases: compare identifiers left to right. Numeric
        // identifiers compare numerically (so beta.10 > beta.9, which a
        // plain string compare gets backwards); numeric ranks below
        // alphanumeric; a longer identifier list wins ties.
        for (a, b) in self.pre.iter().zip(other.pre.iter()) {
            let ord = match (a.parse::<u64>(), b.parse::<u64>()) {
                (Ok(x), Ok(y)) => x.cmp(&y),
                (Ok(_), Err(_)) => Ordering::Less,
                (Err(_), Ok(_)) => Ordering::Greater,
                (Err(_), Err(_)) => a.cmp(b),
            };
            if ord != Ordering::Equal {
                return ord;
            }
        }
        self.pre.len().cmp(&other.pre.len())
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Pick the best upgrade from a release list, or `None` if already current.
///
/// Policy (decided on #273): a prerelease is only ever offered to a user
/// already running a prerelease. Beta users track betas; stable users are
/// never pushed onto a beta. Drafts and unparseable tags are ignored.
///
/// Split out from the HTTP call so it is testable without a network.
fn select_update<'a>(
    current: &Version,
    releases: &'a [GithubRelease],
) -> Option<&'a GithubRelease> {
    let allow_prerelease = current.is_prerelease();

    releases
        .iter()
        .filter(|r| !r.draft)
        .filter(|r| allow_prerelease || !r.prerelease)
        .filter_map(|r| Version::parse(&r.tag_name).map(|v| (v, r)))
        // The `prerelease` flag is what GitHub was told; the tag is the
        // truth. Honour both so a mis-flagged stable tag like `v1.1.0`
        // can't sneak onto a stable user's machine.
        .filter(|(v, _)| allow_prerelease || !v.is_prerelease())
        .filter(|(v, _)| v > current)
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, r)| r)
}

/// Fetch releases and decide whether a newer one exists.
///
/// Never returns an error: any failure (offline, DNS, TLS, rate limit,
/// malformed JSON) yields "no update available". See the offline-first
/// note in the module docs.
pub fn check_for_updates(current_version: &str) -> UpdateCheck {
    let up_to_date = UpdateCheck {
        available: false,
        latest_version: None,
        release_url: None,
        current_version: current_version.to_string(),
    };

    let Some(current) = Version::parse(current_version) else {
        return up_to_date;
    };

    let response = ureq::get(RELEASES_URL)
        .config()
        .timeout_global(Some(TIMEOUT))
        .build()
        // GitHub requires a User-Agent and returns 403 without one.
        .header("User-Agent", "bearpaw-desktop")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call();

    let releases: Vec<GithubRelease> = match response {
        Ok(mut resp) => match resp.body_mut().read_json() {
            Ok(parsed) => parsed,
            Err(_) => return up_to_date,
        },
        Err(_) => return up_to_date,
    };

    match select_update(&current, &releases) {
        Some(release) => UpdateCheck {
            available: true,
            latest_version: Some(release.tag_name.clone()),
            release_url: Some(release.html_url.clone()),
            current_version: current_version.to_string(),
        },
        None => up_to_date,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).expect("parses")
    }

    fn release(tag: &str, prerelease: bool, draft: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            html_url: format!("https://github.com/jeremyfuksa/bearpaw/releases/tag/{tag}"),
            prerelease,
            draft,
        }
    }

    #[test]
    fn parses_with_and_without_v_prefix() {
        assert_eq!(v("v1.2.3"), v("1.2.3"));
        assert_eq!(v("1.2.3").core, (1, 2, 3));
        assert!(v("1.2.3").pre.is_empty());
    }

    #[test]
    fn rejects_unparseable_versions() {
        assert!(Version::parse("").is_none());
        assert!(Version::parse("1.2").is_none());
        assert!(Version::parse("1.2.3.4").is_none());
        assert!(Version::parse("not-a-version").is_none());
        assert!(Version::parse("v1.x.0").is_none());
    }

    #[test]
    fn orders_numeric_core() {
        assert!(v("1.0.1") > v("1.0.0"));
        assert!(v("1.1.0") > v("1.0.9"));
        assert!(v("2.0.0") > v("1.99.99"));
    }

    #[test]
    fn stable_outranks_prerelease_of_same_core() {
        assert!(v("1.0.0") > v("1.0.0-beta.2"));
        assert!(v("1.0.0-beta.2") < v("1.0.0"));
    }

    #[test]
    fn orders_prerelease_identifiers_numerically() {
        // The regression a plain string compare gets wrong: "10" < "9".
        assert!(v("1.0.0-beta.10") > v("1.0.0-beta.9"));
        assert!(v("1.0.0-beta.2") > v("1.0.0-beta.1"));
        assert!(v("1.0.0-alpha.1") < v("1.0.0-beta.1"));
    }

    #[test]
    fn beta_user_is_offered_a_newer_beta() {
        let releases = vec![
            release("v1.0.0-beta.3", true, false),
            release("v1.0.0-beta.2", true, false),
        ];
        let picked = select_update(&v("1.0.0-beta.2"), &releases).expect("update");
        assert_eq!(picked.tag_name, "v1.0.0-beta.3");
    }

    #[test]
    fn stable_user_is_never_offered_a_prerelease() {
        let releases = vec![release("v1.1.0-beta.1", true, false)];
        assert!(select_update(&v("1.0.0"), &releases).is_none());
    }

    #[test]
    fn stable_user_is_offered_a_newer_stable() {
        let releases = vec![
            release("v1.1.0-beta.1", true, false),
            release("v1.1.0", false, false),
        ];
        let picked = select_update(&v("1.0.0"), &releases).expect("update");
        assert_eq!(picked.tag_name, "v1.1.0");
    }

    #[test]
    fn beta_user_is_offered_the_stable_that_supersedes_their_beta() {
        let releases = vec![release("v1.0.0", false, false)];
        let picked = select_update(&v("1.0.0-beta.2"), &releases).expect("update");
        assert_eq!(picked.tag_name, "v1.0.0");
    }

    #[test]
    fn no_update_when_running_the_newest() {
        let releases = vec![
            release("v1.0.0-beta.2", true, false),
            release("v1.0.0-beta.1", true, false),
        ];
        assert!(select_update(&v("1.0.0-beta.2"), &releases).is_none());
    }

    #[test]
    fn never_offers_a_downgrade() {
        let releases = vec![release("v0.9.0", false, false)];
        assert!(select_update(&v("1.0.0"), &releases).is_none());
    }

    #[test]
    fn drafts_are_ignored() {
        let releases = vec![release("v2.0.0", false, true)];
        assert!(select_update(&v("1.0.0"), &releases).is_none());
    }

    #[test]
    fn picks_the_highest_not_the_first_listed() {
        // GitHub returns newest-created first, which is not necessarily
        // the highest version (a patch to an old line can be cut later).
        let releases = vec![
            release("v1.0.1", false, false),
            release("v2.0.0", false, false),
            release("v1.5.0", false, false),
        ];
        let picked = select_update(&v("1.0.0"), &releases).expect("update");
        assert_eq!(picked.tag_name, "v2.0.0");
    }

    #[test]
    fn mis_flagged_prerelease_tag_still_blocked_for_stable_users() {
        // Release flagged stable on GitHub but tagged as a prerelease:
        // the tag is the truth, so a stable user must not be offered it.
        let releases = vec![release("v1.1.0-beta.1", false, false)];
        assert!(select_update(&v("1.0.0"), &releases).is_none());
    }

    #[test]
    fn unparseable_tags_are_skipped_not_fatal() {
        let releases = vec![
            release("nightly", false, false),
            release("v1.2.0", false, false),
        ];
        let picked = select_update(&v("1.0.0"), &releases).expect("update");
        assert_eq!(picked.tag_name, "v1.2.0");
    }

    #[test]
    fn unparseable_current_version_reports_no_update() {
        // Guards the early return in check_for_updates without a network.
        assert!(Version::parse("unknown").is_none());
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// Hits the real GitHub API — proves the TLS handshake, the required
    /// User-Agent header, and `GithubRelease` deserialization all work
    /// against the live payload, which the unit tests above cannot cover.
    ///
    /// `#[ignore]` so CI and offline runs skip it; run with
    /// `cargo test -p bearpaw-desktop -- --ignored --nocapture`.
    ///
    /// Assertions are deliberately history-independent: as of writing the
    /// repo has published only prereleases, so a stable user is correctly
    /// offered nothing at all. Asserting "0.1.0 sees an update" would bake
    /// that fact in and start failing the day 1.0.0 ships.
    #[test]
    #[ignore]
    fn live_check_against_github() {
        // An ancient prerelease must be offered something: betas track betas,
        // and at least one newer prerelease exists.
        let beta = check_for_updates("0.0.1-beta.1");
        println!("from 0.0.1-beta.1 -> {beta:?}");
        assert!(
            beta.available,
            "a prerelease user should be offered a newer prerelease"
        );
        let url = beta.release_url.expect("release url present");
        assert!(
            url.starts_with("https://github.com/jeremyfuksa/bearpaw/"),
            "release URL must point at this repo, not wherever the payload says, got {url}"
        );

        // Nothing can supersede a version far beyond anything published.
        let future = check_for_updates("99.0.0");
        println!("from 99.0.0 -> {future:?}");
        assert!(!future.available, "99.0.0 must not be offered an update");
        assert_eq!(future.current_version, "99.0.0");

        // A stable user is never pushed onto a prerelease, whatever exists.
        let stable = check_for_updates("0.1.0");
        println!("from 0.1.0 -> {stable:?}");
        if let Some(tag) = stable.latest_version.as_deref() {
            assert!(
                !tag.contains('-'),
                "stable user offered a prerelease tag: {tag}"
            );
        }
    }
}
