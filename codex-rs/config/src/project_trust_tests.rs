//! Exercises project-key precedence and map matching across path conventions.

use super::*;
use codex_protocol::config_types::TrustLevel;
use pretty_assertions::assert_eq;

fn config_with_projects(entries: &[(&str, Option<TrustLevel>)]) -> ConfigToml {
    ConfigToml {
        projects: Some(
            entries
                .iter()
                .map(|(key, trust_level)| {
                    (
                        key.to_string(),
                        ProjectConfig {
                            trust_level: *trust_level,
                        },
                    )
                })
                .collect(),
        ),
        ..Default::default()
    }
}

fn assert_lookup_order(lookup: &ProjectTrustLookup, entries: &[(&str, Option<TrustLevel>)]) {
    let mut config = config_with_projects(entries);
    for (key, trust_level) in entries {
        assert_eq!(
            config.get_active_project_for_lookup(lookup),
            Some(ProjectConfig {
                trust_level: *trust_level
            }),
        );
        config.projects.as_mut().unwrap().remove(*key);
    }
    assert_eq!(config.get_active_project_for_lookup(lookup), None);
    assert_eq!(
        ConfigToml::default().get_active_project_for_lookup(lookup),
        None
    );
}

#[test]
fn posix_lookup_preserves_cwd_root_alias_order_and_case() {
    let lookup = ProjectTrustLookup::from_paths(
        PathConvention::Posix,
        ProjectTrustPath {
            original: "/alias/src".into(),
            canonical: Some("/repo/src".into()),
        },
        Some(ProjectTrustPath {
            original: "/alias".into(),
            canonical: Some("/repo".into()),
        }),
    );
    assert_lookup_order(
        &lookup,
        &[
            ("/repo/src", None),
            ("/alias/src", Some(TrustLevel::Trusted)),
            ("/repo", Some(TrustLevel::Untrusted)),
            ("/alias", Some(TrustLevel::Trusted)),
        ],
    );
    assert_eq!(
        config_with_projects(&[("/Repo/src", Some(TrustLevel::Trusted))])
            .get_active_project_for_lookup(&lookup),
        None,
    );
}

#[test]
fn windows_prefers_exact_normalized_key_then_sorted_aliases() {
    let lookup = ProjectTrustLookup::from_paths(
        PathConvention::Windows,
        ProjectTrustPath {
            original: r"C:\Repo".into(),
            canonical: None,
        },
        /*repo_root*/ None,
    );
    assert_lookup_order(
        &lookup,
        &[
            (r"c:\repo", Some(TrustLevel::Trusted)),
            (r"C:\REPO", Some(TrustLevel::Untrusted)),
            (r"C:\Repo", Some(TrustLevel::Trusted)),
        ],
    );
}

#[cfg(windows)]
#[test]
fn native_project_lookup_preserves_untrusted_verbatim_cwd() {
    let directory = tempfile::tempdir().expect("temporary synthetic project");
    let cwd = std::fs::canonicalize(directory.path()).expect("verbatim cwd");
    let key = crate::loader::project_trust_key(directory.path());
    let config = config_with_projects(&[(&key, Some(TrustLevel::Untrusted))]);

    assert_eq!(
        config.get_active_project(&cwd, None),
        Some(ProjectConfig {
            trust_level: Some(TrustLevel::Untrusted),
        }),
    );
}

#[cfg(windows)]
#[test]
fn native_project_lookup_preserves_explicit_none_before_repo_trust() {
    let directory = tempfile::tempdir().expect("temporary synthetic repository");
    let child = directory.path().join("project");
    std::fs::create_dir(&child).expect("synthetic child project");
    let cwd = std::fs::canonicalize(&child).expect("verbatim child cwd");
    let root = std::fs::canonicalize(directory.path()).expect("verbatim root");
    let child_key = crate::loader::project_trust_key(&child);
    let root_key = crate::loader::project_trust_key(directory.path());
    let config =
        config_with_projects(&[(&child_key, None), (&root_key, Some(TrustLevel::Trusted))]);

    assert_eq!(
        config.get_active_project(&cwd, Some(&root)),
        Some(ProjectConfig { trust_level: None }),
    );
}

#[cfg(windows)]
#[test]
fn native_project_lookup_does_not_match_a_sibling_directory() {
    let directory = tempfile::tempdir().expect("temporary synthetic parent");
    let project = directory.path().join("project");
    let sibling = directory.path().join("project-other");
    std::fs::create_dir(&project).expect("synthetic project");
    std::fs::create_dir(&sibling).expect("synthetic sibling");
    let key = crate::loader::project_trust_key(&project);
    let config = config_with_projects(&[(&key, Some(TrustLevel::Trusted))]);
    let cwd = std::fs::canonicalize(&sibling).expect("verbatim sibling cwd");

    assert_eq!(config.get_active_project(&cwd, None), None);
}
