//! Trusted TUI-only command configuration.

use codex_config::ConfigLayerSource;
use codex_config::ConfigLayerStack;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const MAX_SAFE_JSON_INTEGER: i64 = 9_007_199_254_740_991;

fn safe_count(value: i64) -> Option<i64> {
    (0..=MAX_SAFE_JSON_INTEGER)
        .contains(&value)
        .then_some(value)
}

fn safe_positive_count(value: i64) -> Option<i64> {
    (1..=MAX_SAFE_JSON_INTEGER)
        .contains(&value)
        .then_some(value)
}

fn safe_percent(value: f64) -> Option<f64> {
    (value.is_finite() && (0.0..=100.0).contains(&value)).then_some(value)
}

fn insert_count(map: &mut Map<String, Value>, name: &str, value: i64) {
    if let Some(value) = safe_count(value) {
        map.insert(name.to_string(), json!(value));
    }
}

fn speed_counts_valid(counts: StatusLineTokenCounts) -> bool {
    safe_count(counts.input).is_some()
        && safe_count(counts.output).is_some()
        && safe_count(counts.total).is_some()
}

fn speed_counter_decreased(
    previous: StatusLineTokenCounts,
    current: StatusLineTokenCounts,
) -> bool {
    current.input < previous.input
        || current.output < previous.output
        || current.total < previous.total
}

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

/// Launch-local speed state. Its wall time covers the current token-baseline interval.
#[derive(Clone, Debug, Default)]
#[allow(dead_code)]
pub(crate) struct StatusLineLaunchState {
    baseline: Option<StatusLineTokenCounts>,
    last_observed_tokens: Option<StatusLineTokenCounts>,
    baseline_active_wall_duration_ms: i64,
    active_wall_duration_ms: i64,
    speed_tokens: Option<StatusLineTokenCounts>,
    pub(crate) turn_wall_duration_ms: i64,
}

#[allow(dead_code)]
impl StatusLineLaunchState {
    pub(crate) fn new(initial_total: Option<StatusLineTokenCounts>) -> Self {
        let initial_total = initial_total.filter(|counts| speed_counts_valid(*counts));
        Self {
            baseline: initial_total,
            last_observed_tokens: initial_total,
            ..Self::default()
        }
    }

    /// `active_wall_duration_ms` is cumulative active-turn time since this launch.
    /// A missing token sample still advances that clock.
    pub(crate) fn observe_tokens(
        &mut self,
        total: Option<StatusLineTokenCounts>,
        active_wall_duration_ms: i64,
    ) {
        let Some(active_wall_duration_ms) = safe_count(active_wall_duration_ms) else {
            self.speed_tokens = None;
            self.turn_wall_duration_ms = 0;
            return;
        };
        if active_wall_duration_ms < self.active_wall_duration_ms {
            self.speed_tokens = None;
            self.turn_wall_duration_ms = 0;
            return;
        }
        self.active_wall_duration_ms = active_wall_duration_ms;
        self.speed_tokens = None;

        let valid_total = total.filter(|counts| speed_counts_valid(*counts));
        if let Some(total) = valid_total {
            let rebaseline = self.baseline.is_none()
                || self
                    .last_observed_tokens
                    .is_some_and(|previous| speed_counter_decreased(previous, total));
            if rebaseline {
                self.baseline = Some(total);
                self.baseline_active_wall_duration_ms = active_wall_duration_ms;
            }
            self.last_observed_tokens = Some(total);
        }

        self.turn_wall_duration_ms = active_wall_duration_ms
            .checked_sub(self.baseline_active_wall_duration_ms)
            .filter(|duration| self.baseline.is_some() && safe_count(*duration).is_some())
            .unwrap_or(0);

        if let (Some(total), Some(baseline)) = (valid_total, self.baseline)
            && self.turn_wall_duration_ms > 0
        {
            let input = total.input.checked_sub(baseline.input).and_then(safe_count);
            let output = total
                .output
                .checked_sub(baseline.output)
                .and_then(safe_count);
            let total_delta = total.total.checked_sub(baseline.total).and_then(safe_count);
            if let (Some(input), Some(output), Some(total)) = (input, output, total_delta) {
                self.speed_tokens = Some(StatusLineTokenCounts {
                    input,
                    output,
                    total,
                    ..StatusLineTokenCounts::default()
                });
            }
        }
    }

    pub(crate) fn resume(&mut self, initial_total: Option<StatusLineTokenCounts>) {
        *self = Self::new(initial_total);
    }
}

#[allow(dead_code)]
pub(crate) fn build_status_line_payload(
    snapshot: &StatusLinePayloadSnapshot,
    launch: &StatusLineLaunchState,
) -> Value {
    let mut root = Map::new();
    root.insert("hook_event_name".to_string(), json!("Status"));
    root.insert("session_id".to_string(), json!(snapshot.session_id));
    root.insert("cwd".to_string(), json!(snapshot.cwd));
    root.insert(
        "workspace".to_string(),
        json!({"current_dir": snapshot.cwd, "project_dir": snapshot.cwd}),
    );
    root.insert(
        "model".to_string(),
        json!({"id": snapshot.model_id, "display_name": snapshot.model_display_name}),
    );
    if let Some(effort) = &snapshot.effort_level {
        root.insert("effort".to_string(), json!({"level": effort}));
    }
    root.insert("version".to_string(), json!(snapshot.version));
    root.insert("output_style".to_string(), json!({"name": snapshot.mode}));

    let mut cost = Map::new();
    insert_count(
        &mut cost,
        "total_duration_ms",
        snapshot.session_wall_duration_ms,
    );
    root.insert("cost".to_string(), Value::Object(cost));

    let mut context = Map::new();
    if let Some(size) = snapshot.context_window_size.and_then(safe_positive_count) {
        context.insert("context_window_size".to_string(), json!(size));
    }
    if let Some(percent) = snapshot.context_used_percentage.and_then(safe_percent) {
        context.insert("used_percentage".to_string(), json!(percent));
    }
    if let Some(percent) = snapshot.context_remaining_percentage.and_then(safe_percent) {
        context.insert("remaining_percentage".to_string(), json!(percent));
    }
    if let Some(total) = snapshot.total_tokens {
        insert_count(&mut context, "total_input_tokens", total.input);
        insert_count(&mut context, "total_output_tokens", total.output);
    }
    if let Some(last) = snapshot.last_tokens {
        let mut current = Map::new();
        if let (Some(input), Some(cached)) = (safe_count(last.input), safe_count(last.cached_input))
        {
            current.insert(
                "input_tokens".to_string(),
                json!(input.saturating_sub(cached)),
            );
        }
        insert_count(&mut current, "cache_read_input_tokens", last.cached_input);
        insert_count(&mut current, "output_tokens", last.output);
        if !current.is_empty() {
            context.insert("current_usage".to_string(), Value::Object(current));
        }
    }
    root.insert("context_window".to_string(), Value::Object(context));

    let mut common_rate_limits = Map::new();
    let mut codex_rate_limits = Vec::new();
    for window in &snapshot.rate_limits {
        let Some(percent) = safe_percent(window.used_percent) else {
            continue;
        };
        let resets_at = window.resets_at.and_then(safe_count);
        let window_minutes = window.window_minutes.and_then(safe_positive_count);
        codex_rate_limits.push(json!({
            "used_percent": percent,
            "resets_at": resets_at,
            "window_minutes": window_minutes,
        }));
        let label = match window_minutes {
            Some(300) => Some("five_hour"),
            Some(10_080) => Some("seven_day"),
            _ => None,
        };
        if let Some(label) = label {
            let mut period = Map::new();
            period.insert("used_percentage".to_string(), json!(percent));
            if let Some(resets_at) = resets_at {
                period.insert("resets_at".to_string(), json!(resets_at));
            }
            common_rate_limits.insert(label.to_string(), Value::Object(period));
        }
    }
    root.insert("rate_limits".to_string(), Value::Object(common_rate_limits));

    let mut codex = Map::new();
    codex.insert("schema".to_string(), json!(1));
    codex.insert("approval_mode".to_string(), json!(snapshot.approval_mode));
    codex.insert("sandbox".to_string(), json!(snapshot.sandbox));
    codex.insert("thread_name".to_string(), json!(snapshot.thread_name));
    insert_count(&mut codex, "compactions", snapshot.compactions);
    insert_count(
        &mut codex,
        "turn_wall_duration_ms",
        launch.turn_wall_duration_ms,
    );
    if let Some(speed) = launch.speed_tokens {
        codex.insert(
            "speed_tokens".to_string(),
            json!({"input": speed.input, "output": speed.output, "total": speed.total}),
        );
    }
    if let Some(total) = snapshot.total_tokens {
        let mut tokens = Map::new();
        insert_count(&mut tokens, "input", total.input);
        insert_count(&mut tokens, "cached_input", total.cached_input);
        insert_count(&mut tokens, "output", total.output);
        insert_count(&mut tokens, "reasoning_output", total.reasoning_output);
        insert_count(&mut tokens, "total", total.total);
        if !tokens.is_empty() {
            codex.insert("tokens".to_string(), Value::Object(tokens));
        }
    }
    codex.insert("rate_limits".to_string(), Value::Array(codex_rate_limits));
    root.insert("codex".to_string(), Value::Object(codex));
    Value::Object(root)
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
