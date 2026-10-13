//! Trusted TUI-only command configuration.

use codex_config::ConfigLayerSource;
use codex_config::ConfigLayerStack;
use serde::Deserialize;
use serde_json::Value;

/// Plain values captured by the TUI before constructing a status-line payload.
/// The producer of this snapshot is wired in a later task.
#[derive(Clone, Debug, Default)]
#[allow(dead_code)]
pub(crate) struct StatusLinePayloadSnapshot {
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    pub(crate) model_id: String,
    pub(crate) model_display_name: String,
    pub(crate) effort_level: Option<String>,
    pub(crate) version: String,
    pub(crate) mode: String,
    pub(crate) approval_mode: String,
    pub(crate) sandbox: String,
    pub(crate) thread_name: Option<String>,
    pub(crate) compactions: i64,
    pub(crate) context_window_size: Option<i64>,
    pub(crate) context_used_percentage: Option<f64>,
    pub(crate) context_remaining_percentage: Option<f64>,
    pub(crate) total_tokens: Option<StatusLineTokenCounts>,
    pub(crate) last_tokens: Option<StatusLineTokenCounts>,
    pub(crate) rate_limits: Vec<StatusLineRateLimitWindow>,
    pub(crate) session_wall_duration_ms: i64,
}

/// Raw protocol token counts. Input already includes cached input.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) struct StatusLineTokenCounts {
    pub(crate) input: i64,
    pub(crate) cached_input: i64,
    pub(crate) output: i64,
    pub(crate) reasoning_output: i64,
    pub(crate) total: i64,
}

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
pub(crate) struct StatusLineRateLimitWindow {
    pub(crate) used_percent: f64,
    pub(crate) resets_at: Option<i64>,
    pub(crate) window_minutes: Option<i64>,
}

/// Launch-local state; its wall time covers active turns after this launch/resume.
#[derive(Clone, Debug, Default)]
#[allow(dead_code)]
pub(crate) struct StatusLineLaunchState {
    baseline: Option<StatusLineTokenCounts>,
    speed_tokens: Option<StatusLineTokenCounts>,
    pub(crate) turn_wall_duration_ms: i64,
}

#[allow(dead_code)]
impl StatusLineLaunchState {
    pub(crate) fn new(initial_total: Option<StatusLineTokenCounts>) -> Self {
        Self {
            baseline: initial_total,
            ..Self::default()
        }
    }

    /// `active_wall_duration_ms` is cumulative active-turn time since this launch.
    /// A missing token sample still advances that clock.
    pub(crate) fn observe_tokens(
        &mut self,
        _total: Option<StatusLineTokenCounts>,
        _active_wall_duration_ms: i64,
    ) {
        // Filled in after the focused payload tests produce hosted assertion RED.
    }

    pub(crate) fn resume(&mut self, initial_total: Option<StatusLineTokenCounts>) {
        *self = Self::new(initial_total);
    }
}

#[allow(dead_code)]
pub(crate) fn build_status_line_payload(
    _snapshot: &StatusLinePayloadSnapshot,
    _launch: &StatusLineLaunchState,
) -> Value {
    // The payload behavior is intentionally deferred until hosted assertion RED.
    serde_json::json!({})
}

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
