use super::*;
use codex_config::ConfigLayerEntry;
use codex_config::ConfigLayerSource;
use codex_config::ConfigRequirements;
use codex_config::ConfigRequirementsToml;
use codex_utils_absolute_path::AbsolutePathBuf;

fn stack(entries: Vec<(ConfigLayerSource, &str)>) -> ConfigLayerStack {
    let layers = entries
        .into_iter()
        .map(|(name, source)| ConfigLayerEntry::new(name, source.parse().expect("TOML fixture")))
        .collect();
    ConfigLayerStack::new(
        layers,
        ConfigRequirements::default(),
        ConfigRequirementsToml::default(),
    )
    .expect("ordered config layers")
}

fn user_source() -> ConfigLayerSource {
    ConfigLayerSource::User {
        file: AbsolutePathBuf::from_absolute_path(std::env::temp_dir().join("config.toml"))
            .expect("absolute temp path"),
        profile: None,
    }
}

#[test]
fn trusted_command_uses_defaults_and_zero_disables_periodic_refresh() {
    let layers = stack(vec![(
        user_source(),
        "[tui.status_line_command]\ncommand = 'echo ready'\nrefresh_interval_secs = 0\n",
    )]);
    let resolved = StatusLineCommandResolution::from_layers(&layers);
    assert_eq!(
        resolved.config,
        Some(StatusLineCommandConfig {
            command: "echo ready".to_string(),
            refresh_interval_secs: 0,
            timeout_ms: 2000,
        })
    );
    assert!(resolved.warnings.is_empty());

    let defaults = stack(vec![(
        user_source(),
        "[tui.status_line_command]\ncommand = 'echo ready'\n",
    )]);
    assert_eq!(
        StatusLineCommandResolution::from_layers(&defaults)
            .config
            .expect("command")
            .refresh_interval_secs,
        10
    );
}

#[test]
fn missing_or_blank_command_cannot_enable_execution() {
    for value in ["", "[tui.status_line_command]\ncommand = '   '\n", "[tui.status_line_command]\n"] {
        let resolved = StatusLineCommandResolution::from_layers(&stack(vec![(user_source(), value)]));
        assert!(resolved.config.is_none(), "{value}");
    }
}

#[test]
fn invalid_trusted_types_fail_closed_with_parse_warning() {
    for value in [
        "[tui.status_line_command]\ncommand = 7\n",
        "[tui.status_line_command]\ncommand = 'echo'\ntimeout_ms = 'slow'\n",
        "[tui.status_line_command]\ncommand = 'echo'\nrefresh_interval_secs = -1\n",
        "[tui]\nstatus_line_command = 'echo'\n",
    ] {
        let resolved = StatusLineCommandResolution::from_layers(&stack(vec![(user_source(), value)]));
        assert!(resolved.config.is_none(), "{value}");
        assert!(resolved.warnings.contains(&StatusLineCommandWarning::InvalidTrustedConfig), "{value}");
    }
}

#[test]
fn non_project_layers_merge_in_precedence_order() {
    let layers = stack(vec![
        (
            ConfigLayerSource::System {
                file: AbsolutePathBuf::from_absolute_path(std::env::temp_dir().join("system.toml"))
                    .expect("absolute temp path"),
            },
            "[tui.status_line_command]\ncommand = 'echo system'\ntimeout_ms = 100\n",
        ),
        (user_source(), "[tui.status_line_command]\ncommand = 'echo user'\n"),
        (ConfigLayerSource::SessionFlags, "[tui.status_line_command]\ntimeout_ms = 3000\n"),
    ]);
    let resolved = StatusLineCommandResolution::from_layers(&layers);
    assert_eq!(
        resolved.config,
        Some(StatusLineCommandConfig {
            command: "echo user".to_string(),
            refresh_interval_secs: 10,
            timeout_ms: 3000,
        })
    );
}

#[tokio::test]
async fn loaded_trusted_project_setting_is_ignored_and_reported() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let home = temp.path().join("home");
    let project = temp.path().join("project");
    let dot_codex = project.join(".codex");
    std::fs::create_dir_all(&home)?;
    std::fs::create_dir_all(&dot_codex)?;
    std::fs::write(project.join(".git"), "gitdir: here")?;
    let project_key = toml::Value::String(project.to_string_lossy().to_string());
    std::fs::write(
        home.join("config.toml"),
        format!("[projects.{project_key}]\ntrust_level = 'trusted'\n[tui]\nstatus_line = ['model-with-reasoning']\n[tui.status_line_command]\ncommand = 'echo user'\n"),
    )?;
    std::fs::write(
        dot_codex.join("config.toml"),
        "[tui.status_line_command]\ncommand = 'echo project-marker'\ntimeout_ms = 1\n",
    )?;
    let project_cwd = AbsolutePathBuf::from_absolute_path(&project)?;
    let bootstrap = crate::legacy_core::config::load_config_toml_with_layer_stack(
        &home,
        Some(&project_cwd),
        Vec::new(),
        codex_config::ConfigLoadOptions {
            loader_overrides: codex_config::LoaderOverrides::without_managed_config_for_tests(),
            ..Default::default()
        },
    )
    .await?;
    assert!(bootstrap.config_layer_stack.layers_low_to_high().any(|layer| {
        matches!(layer.name, ConfigLayerSource::Project { .. })
            && layer.config.get("tui").and_then(|value| value.get("status_line_command"))
                .and_then(|value| value.get("command"))
                .and_then(toml::Value::as_str) == Some("echo project-marker")
    }), "the loader must actually include the configured project layer");
    let local = crate::local_settings::LocalSettings::from_bootstrap(
        &bootstrap,
        AbsolutePathBuf::from_absolute_path(&home)?,
    )?;
    assert_eq!(local.status_line_command.config.as_ref().map(|config| config.command.as_str()), Some("echo user"));
    assert!(local.status_line_command.warnings.contains(&StatusLineCommandWarning::IgnoredProjectConfig));
    assert_eq!(local.tui.status_line, Some(vec!["model-with-reasoning".to_string()]));
    Ok(())
}
