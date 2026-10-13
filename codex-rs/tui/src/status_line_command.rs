//! Trusted TUI-only command configuration.

use codex_config::ConfigLayerSource;
use codex_config::ConfigLayerStack;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct StatusLineCommandConfig {
    pub(crate) command: String,
    #[serde(default = "default_refresh_interval_secs")]
    pub(crate) refresh_interval_secs: u64,
    #[serde(default = "default_timeout_ms")]
    pub(crate) timeout_ms: u64,
}

fn default_refresh_interval_secs() -> u64 {
    10
}

fn default_timeout_ms() -> u64 {
    2000
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StatusLineCommandWarning {
    IgnoredProjectConfig,
    InvalidTrustedConfig,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct StatusLineCommandResolution {
    pub(crate) config: Option<StatusLineCommandConfig>,
    pub(crate) warnings: Vec<StatusLineCommandWarning>,
}

impl StatusLineCommandResolution {
    pub(crate) fn from_layers(layers: &ConfigLayerStack) -> Self {
        let mut command_value: Option<toml::Value> = None;
        let mut ignored_project_config = false;
        for layer in layers.layers_low_to_high() {
            let Some(value) = layer
                .config
                .get("tui")
                .and_then(|tui| tui.get("status_line_command"))
            else {
                continue;
            };
            if matches!(layer.name, ConfigLayerSource::Project { .. }) {
                ignored_project_config = true;
                continue;
            }
            if let Some(base) = command_value.as_mut() {
                codex_config::merge_toml_values(base, value);
            } else {
                command_value = Some(value.clone());
            }
        }

        let mut resolution = Self::default();
        if ignored_project_config {
            resolution
                .warnings
                .push(StatusLineCommandWarning::IgnoredProjectConfig);
        }
        if let Some(value) = command_value {
            let parsed: Result<StatusLineCommandConfig, toml::de::Error> = value.try_into();
            match parsed {
                Ok(config) if !config.command.trim().is_empty() => {
                    resolution.config = Some(config);
                }
                _ => resolution
                    .warnings
                    .push(StatusLineCommandWarning::InvalidTrustedConfig),
            }
        }
        resolution
    }
}

#[cfg(test)]
#[path = "status_line_command_tests.rs"]
mod tests;
