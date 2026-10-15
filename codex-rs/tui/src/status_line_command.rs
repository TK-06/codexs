//! Trusted TUI-only command configuration.

use std::iter::Peekable;
use std::str::Chars;

use codex_config::ConfigLayerSource;
use codex_config::ConfigLayerStack;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

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
                json!(input.saturating_sub(cached).max(0)),
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

/// Only these SGR attributes are allowed into the footer. Other terminal controls
/// are consumed without passing their bytes or contents to ratatui.
#[derive(Default)]
struct SafeSgr {
    foreground: Option<Color>,
    background: Option<Color>,
    modifiers: Modifier,
}

impl SafeSgr {
    fn style(&self) -> Style {
        let mut style = Style::default();
        if let Some(color) = self.foreground {
            style = style.fg(color);
        }
        if let Some(color) = self.background {
            style = style.bg(color);
        }
        if !self.modifiers.is_empty() {
            style = style.add_modifier(self.modifiers);
        }
        style
    }

    fn apply(&mut self, parameters: &str) {
        let values: Option<Vec<u16>> = if parameters.is_empty() {
            Some(vec![0])
        } else {
            parameters
                .split(';')
                .map(|value| {
                    if value.is_empty() {
                        Some(0)
                    } else {
                        value.parse::<u16>().ok()
                    }
                })
                .collect()
        };
        let Some(values) = values else {
            return;
        };

        let mut index = 0;
        while index < values.len() {
            match values[index] {
                0 => *self = Self::default(),
                1 => self.modifiers.insert(Modifier::BOLD),
                2 => self.modifiers.insert(Modifier::DIM),
                3 => self.modifiers.insert(Modifier::ITALIC),
                4 => self.modifiers.insert(Modifier::UNDERLINED),
                7 => self.modifiers.insert(Modifier::REVERSED),
                22 => self.modifiers.remove(Modifier::BOLD | Modifier::DIM),
                23 => self.modifiers.remove(Modifier::ITALIC),
                24 => self.modifiers.remove(Modifier::UNDERLINED),
                27 => self.modifiers.remove(Modifier::REVERSED),
                30..=37 => self.foreground = Some(ansi_color(values[index] - 30, false)),
                39 => self.foreground = None,
                40..=47 => self.background = Some(ansi_color(values[index] - 40, false)),
                49 => self.background = None,
                90..=97 => self.foreground = Some(ansi_color(values[index] - 90, true)),
                100..=107 => self.background = Some(ansi_color(values[index] - 100, true)),
                38 | 48 => {
                    let (color, consumed) = extended_ansi_color(&values[index..]);
                    if let Some(color) = color {
                        if values[index] == 38 {
                            self.foreground = Some(color);
                        } else {
                            self.background = Some(color);
                        }
                    }
                    index += consumed;
                    continue;
                }
                _ => {}
            }
            index += 1;
        }
    }
}

fn ansi_color(index: u16, bright: bool) -> Color {
    match (index, bright) {
        (0, false) => Color::Black,
        (1, false) => Color::Red,
        (2, false) => Color::Green,
        (3, false) => Color::Yellow,
        (4, false) => Color::Blue,
        (5, false) => Color::Magenta,
        (6, false) => Color::Cyan,
        (7, false) => Color::Gray,
        (0, true) => Color::DarkGray,
        (1, true) => Color::LightRed,
        (2, true) => Color::LightGreen,
        (3, true) => Color::LightYellow,
        (4, true) => Color::LightBlue,
        (5, true) => Color::LightMagenta,
        (6, true) => Color::LightCyan,
        _ => Color::White,
    }
}

fn extended_ansi_color(values: &[u16]) -> (Option<Color>, usize) {
    match values {
        [_, 5, value, ..] => (u8::try_from(*value).ok().map(Color::Indexed), 3),
        [_, 2, red, green, blue, ..] => (
            u8::try_from(*red)
                .ok()
                .zip(u8::try_from(*green).ok())
                .zip(u8::try_from(*blue).ok())
                .map(|((red, green), blue)| Color::Rgb(red, green, blue)),
            5,
        ),
        _ => (None, values.len()),
    }
}

fn consume_csi(chars: &mut Peekable<Chars<'_>>) -> Option<String> {
    let mut parameters = String::new();
    let mut valid_sgr = true;
    for character in chars.by_ref() {
        if ('@'..='~').contains(&character) {
            return (character == 'm' && valid_sgr).then_some(parameters);
        }
        if (character.is_ascii_digit() || character == ';') && parameters.len() < 128 {
            parameters.push(character);
        } else {
            valid_sgr = false;
        }
    }
    None
}

fn consume_control_string(chars: &mut Peekable<Chars<'_>>, osc: bool) {
    while let Some(character) = chars.next() {
        if character == '\u{009c}' || (osc && character == '\x07') {
            break;
        }
        if character == '\x1b' && chars.peek() == Some(&'\\') {
            chars.next();
            break;
        }
    }
}

fn consume_escape(chars: &mut Peekable<Chars<'_>>, sgr: &mut SafeSgr) {
    match chars.next() {
        Some('[') => {
            if let Some(parameters) = consume_csi(chars) {
                sgr.apply(&parameters);
            }
        }
        Some(']') => consume_control_string(chars, true),
        Some('P' | '_' | '^' | 'X') => consume_control_string(chars, false),
        Some(intermediate) if (' '..='/').contains(&intermediate) => {
            for character in chars.by_ref() {
                if ('0'..='~').contains(&character) {
                    break;
                }
            }
        }
        _ => {}
    }
}

fn append_grapheme(spans: &mut Vec<Span<'static>>, grapheme: &str, style: Style) {
    if let Some(last) = spans.last_mut()
        && last.style == style
    {
        last.content.to_mut().push_str(grapheme);
    } else {
        spans.push(Span::styled(grapheme.to_owned(), style));
    }
}

fn render_visible_line(characters: &[(char, Style)], width: usize) -> Option<Line<'static>> {
    let text: String = characters.iter().map(|(character, _)| *character).collect();
    if text.trim().is_empty() || UnicodeWidthStr::width(text.as_str()) == 0 {
        return None;
    }

    // Grapheme segmentation runs over the whole visible line, across SGR
    // boundaries. The first scalar's style owns any spanning cluster.
    let mut scalar_styles = characters.iter().map(|(_, style)| *style);
    let graphemes: Vec<(&str, Style, usize)> = text
        .graphemes(true)
        .map(|grapheme| {
            let style = scalar_styles.next().unwrap_or_default();
            for _ in 1..grapheme.chars().count() {
                scalar_styles.next();
            }
            (grapheme, style, UnicodeWidthStr::width(grapheme))
        })
        .collect();
    let full_width = graphemes.iter().fold(0usize, |used, (_, _, columns)| {
        used.saturating_add(*columns)
    });
    let truncated = full_width > width;
    let budget = if truncated { width - 1 } else { width };
    let mut used = 0usize;
    let mut spans = Vec::new();
    for (grapheme, style, columns) in graphemes {
        if used.saturating_add(columns) > budget {
            break;
        }
        used += columns;
        append_grapheme(&mut spans, grapheme, style);
    }
    if truncated {
        append_grapheme(&mut spans, "…", Style::default());
    }
    Some(Line::from(spans))
}

/// Retain the first nonblank visible line of trusted command output, allowing
/// only safe SGR styling and fitting whole graphemes into the footer width.
#[allow(dead_code)]
pub(crate) fn render_status_line_command_output(
    output: &[u8],
    width: usize,
) -> Option<Line<'static>> {
    if width == 0 {
        return None;
    }
    let output = std::str::from_utf8(output).ok()?;
    let mut chars = output.chars().peekable();
    let mut sgr = SafeSgr::default();
    let mut line = Vec::new();
    while let Some(character) = chars.next() {
        match character {
            '\r' | '\n' => {
                if let Some(rendered) = render_visible_line(&line, width) {
                    return Some(rendered);
                }
                line.clear();
            }
            '\x1b' => consume_escape(&mut chars, &mut sgr),
            '\u{009b}' => {
                if let Some(parameters) = consume_csi(&mut chars) {
                    sgr.apply(&parameters);
                }
            }
            '\u{009d}' => consume_control_string(&mut chars, true),
            '\u{0090}' | '\u{0098}' | '\u{009e}' | '\u{009f}' => {
                consume_control_string(&mut chars, false);
            }
            character if character.is_control() => {}
            character => line.push((character, sgr.style())),
        }
    }
    render_visible_line(&line, width)
}

#[cfg(test)]
#[path = "status_line_command_tests.rs"]
mod tests;
