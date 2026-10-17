//! Trusted TUI-only command configuration.

use std::iter::Peekable;
use std::path::PathBuf;
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

/// Owned inputs for one command launch. Task 5 will construct and cancel these requests.
#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct StatusLineCommandRequest {
    pub(crate) config: StatusLineCommandConfig,
    pub(crate) payload: Value,
    pub(crate) cwd: PathBuf,
    pub(crate) width: usize,
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum StatusLineCommandError {
    Unsupported,
    InvalidCommand,
    JobCreate,
    Spawn,
    JobAssign,
    Resume,
    StdinWrite,
    StdoutRead,
    OutputCap,
    Wait,
    Timeout,
    Cancelled,
    ExitFailure,
    EmptyOutput,
    Cleanup {
        primary: Option<Box<Self>>,
        terminate: Option<std::io::Error>,
        reap: Option<std::io::Error>,
        timed_out: bool,
    },
}

/// The TUI supplies a fresh snapshot for each requested command refresh.
#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct StatusLineCommandSnapshot {
    pub(crate) session_id: String,
    pub(crate) config: Option<StatusLineCommandConfig>,
    pub(crate) payload: Value,
    pub(crate) cwd: PathBuf,
    pub(crate) width: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) struct StatusLineCommandRuntimeId {
    pub(crate) instance: u64,
    pub(crate) revision: u64,
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum StatusLineCommandEvent {
    Tick {
        runtime: StatusLineCommandRuntimeId,
        epoch: u64,
    },
    DelayReady {
        runtime: StatusLineCommandRuntimeId,
        epoch: u64,
    },
    Finished {
        runtime: StatusLineCommandRuntimeId,
        generation: u64,
        result: Result<Line<'static>, StatusLineCommandError>,
    },
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum StatusLineCommandDisplay {
    Command(Line<'static>),
    BuiltIn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum StatusLineCommandFailureKind {
    Unsupported,
    InvalidCommand,
    JobCreate,
    Spawn,
    JobAssign,
    Resume,
    StdinWrite,
    StdoutRead,
    OutputCap,
    Wait,
    Timeout,
    Cancelled,
    ExitFailure,
    EmptyOutput,
    Cleanup,
}

#[derive(Debug, Default)]
#[allow(dead_code)]
pub(crate) struct StatusLineCommandEffect {
    pub(crate) display: Option<StatusLineCommandDisplay>,
    pub(crate) warning: Option<StatusLineCommandFailureKind>,
    pub(crate) request_refresh: bool,
}

type StatusLineCommandRunFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Line<'static>, StatusLineCommandError>> + Send>,
>;

type StatusLineCommandRunFn = std::sync::Arc<
    dyn Fn(
            StatusLineCommandRequest,
            tokio::sync::oneshot::Receiver<()>,
        ) -> StatusLineCommandRunFuture
        + Send
        + Sync,
>;

static NEXT_STATUS_LINE_SCHEDULER_INSTANCE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);

/// Scheduler API scaffold. The behavioral tests are deliberately RED until implemented.
#[allow(dead_code)]
pub(crate) struct StatusLineCommandScheduler {
    runtime: StatusLineCommandRuntimeId,
    generation: u64,
    _events: tokio::sync::mpsc::UnboundedSender<StatusLineCommandEvent>,
    _runner: StatusLineCommandRunFn,
}

#[allow(dead_code)]
impl StatusLineCommandScheduler {
    pub(crate) fn new(events: tokio::sync::mpsc::UnboundedSender<StatusLineCommandEvent>) -> Self {
        let runner: StatusLineCommandRunFn = std::sync::Arc::new(|request, cancellation| {
            Box::pin(run_status_line_command(request, cancellation))
        });
        Self::from_runner(events, runner)
    }

    #[cfg(test)]
    fn with_runner(
        events: tokio::sync::mpsc::UnboundedSender<StatusLineCommandEvent>,
        runner: StatusLineCommandRunFn,
    ) -> Self {
        Self::from_runner(events, runner)
    }

    fn from_runner(
        events: tokio::sync::mpsc::UnboundedSender<StatusLineCommandEvent>,
        runner: StatusLineCommandRunFn,
    ) -> Self {
        Self {
            runtime: StatusLineCommandRuntimeId {
                instance: NEXT_STATUS_LINE_SCHEDULER_INSTANCE
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                revision: 0,
            },
            generation: 0,
            _events: events,
            _runner: runner,
        }
    }

    #[cfg(test)]
    fn runtime_id(&self) -> StatusLineCommandRuntimeId {
        self.runtime
    }

    #[cfg(test)]
    fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) async fn update(
        &mut self,
        _snapshot: StatusLineCommandSnapshot,
    ) -> StatusLineCommandEffect {
        StatusLineCommandEffect::default()
    }

    pub(crate) async fn handle_event(
        &mut self,
        _event: StatusLineCommandEvent,
    ) -> StatusLineCommandEffect {
        StatusLineCommandEffect::default()
    }

    pub(crate) async fn shutdown(&mut self) {}
}

/// Native operations used by the future Windows owner. Keeping these operations on
/// the runner path lets tests fail one real launch or cleanup step at a time.
#[cfg(windows)]
#[allow(dead_code)]
trait WindowsNativeOps: Send + Sync {
    fn create_job(&self) -> std::io::Result<std::os::windows::io::OwnedHandle>;
    fn spawn(
        &self,
        command: &mut tokio::process::Command,
    ) -> std::io::Result<tokio::process::Child>;
    fn assign(
        &self,
        job: &std::os::windows::io::OwnedHandle,
        process: std::os::windows::io::RawHandle,
    ) -> std::io::Result<()>;
    fn resume(&self, process: std::os::windows::io::RawHandle) -> std::io::Result<()>;
    fn terminate(&self, job: &std::os::windows::io::OwnedHandle) -> std::io::Result<()>;
    fn wait<'a>(
        &'a self,
        child: &'a mut tokio::process::Child,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = std::io::Result<std::process::ExitStatus>> + Send + 'a,
        >,
    >;
}

#[cfg(windows)]
#[allow(dead_code)]
struct DefaultWindowsNativeOps;

#[cfg(windows)]
impl WindowsNativeOps for DefaultWindowsNativeOps {
    fn create_job(&self) -> std::io::Result<std::os::windows::io::OwnedHandle> {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
        use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
        use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
        use windows_sys::Win32::System::JobObjects::SetInformationJobObject;

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle.cast()) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }

    fn spawn(
        &self,
        command: &mut tokio::process::Command,
    ) -> std::io::Result<tokio::process::Child> {
        command.spawn()
    }

    fn assign(
        &self,
        job: &std::os::windows::io::OwnedHandle,
        process: std::os::windows::io::RawHandle,
    ) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        if unsafe { AssignProcessToJobObject(job.as_raw_handle().cast(), process.cast()) } == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn resume(&self, process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn NtResumeProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
        }
        let status = unsafe { NtResumeProcess(process.cast()) };
        if status < 0 {
            Err(std::io::Error::other(format!(
                "NtResumeProcess status {status:#x}"
            )))
        } else {
            Ok(())
        }
    }

    fn terminate(&self, job: &std::os::windows::io::OwnedHandle) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(job.as_raw_handle().cast(), 1) } == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn wait<'a>(
        &'a self,
        child: &'a mut tokio::process::Child,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = std::io::Result<std::process::ExitStatus>> + Send + 'a,
        >,
    > {
        Box::pin(child.wait())
    }
}

#[cfg(windows)]
#[allow(dead_code)]
struct WindowsCommandOwner<O: WindowsNativeOps> {
    ops: O,
    job: Option<std::os::windows::io::OwnedHandle>,
    child: Option<tokio::process::Child>,
    assigned: bool,
    reaped: bool,
    termination_attempted: bool,
    terminate_error: Option<std::io::Error>,
}

#[cfg(windows)]
impl<O: WindowsNativeOps> WindowsCommandOwner<O> {
    fn append_error(slot: &mut Option<std::io::Error>, error: std::io::Error) {
        *slot = Some(match slot.take() {
            Some(previous) => std::io::Error::other(format!("{previous}; {error}")),
            None => error,
        });
    }

    fn kill_root(&mut self) {
        if let Some(child) = self.child.as_mut()
            && let Err(kill_error) = child.start_kill()
        {
            match child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => Self::append_error(&mut self.terminate_error, kill_error),
                Err(wait_error) => {
                    Self::append_error(&mut self.terminate_error, kill_error);
                    Self::append_error(&mut self.terminate_error, wait_error);
                }
            }
        }
    }

    fn new(ops: O, job: std::os::windows::io::OwnedHandle) -> Self {
        Self {
            ops,
            job: Some(job),
            child: None,
            assigned: false,
            reaped: false,
            termination_attempted: false,
            terminate_error: None,
        }
    }

    fn launch(
        &mut self,
        command: &mut tokio::process::Command,
    ) -> Result<(), StatusLineCommandError> {
        let child = self
            .ops
            .spawn(command)
            .map_err(|_| StatusLineCommandError::Spawn)?;
        self.child = Some(child);
        let process = self
            .child
            .as_ref()
            .and_then(tokio::process::Child::raw_handle)
            .ok_or(StatusLineCommandError::Spawn)?;
        self.ops
            .assign(self.job.as_ref().expect("job exists before spawn"), process)
            .map_err(|_| StatusLineCommandError::JobAssign)?;
        self.assigned = true;
        self.ops
            .resume(process)
            .map_err(|_| StatusLineCommandError::Resume)
    }

    fn active_processes(&self) -> std::io::Result<u32> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION;
        use windows_sys::Win32::System::JobObjects::JobObjectBasicAccountingInformation;
        use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;
        let Some(job) = self.job.as_ref() else {
            return Ok(0);
        };
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                job.as_raw_handle().cast(),
                JobObjectBasicAccountingInformation,
                (&raw mut accounting).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(accounting.ActiveProcesses)
        }
    }

    fn terminate_tree(&mut self) {
        if self.termination_attempted {
            return;
        }
        self.termination_attempted = true;
        if let Some(job) = self.job.as_ref()
            && let Err(error) = self.ops.terminate(job)
        {
            // Preserve the injected/OS failure, while a real emergency call still
            // permits verification with this same owned job handle.
            let fallback = DefaultWindowsNativeOps.terminate(job);
            self.terminate_error = Some(match fallback {
                Ok(()) => error,
                Err(other) => {
                    std::io::Error::other(format!("{error}; emergency termination: {other}"))
                }
            });
            self.kill_root();
        }
        if !self.assigned {
            self.kill_root();
        }
    }

    async fn finish(
        &mut self,
        primary: Option<StatusLineCommandError>,
    ) -> Result<(), StatusLineCommandError> {
        self.terminate_tree();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut reap_error = None;
        let mut timed_out = false;
        if !self.reaped
            && let Some(child) = self.child.as_mut()
        {
            match tokio::time::timeout_at(deadline, self.ops.wait(child)).await {
                Ok(Ok(_)) => self.reaped = true,
                Ok(Err(error)) => {
                    reap_error = Some(error);
                    match child.try_wait() {
                        Ok(Some(_)) => self.reaped = true,
                        Ok(None) => {
                            if let Err(error) = child.start_kill() {
                                Self::append_error(&mut reap_error, error);
                            }
                            match tokio::time::timeout_at(deadline, child.wait()).await {
                                Ok(Ok(_)) => self.reaped = true,
                                Ok(Err(error)) => Self::append_error(&mut reap_error, error),
                                Err(_) => timed_out = true,
                            }
                        }
                        Err(error) => {
                            Self::append_error(&mut reap_error, error);
                            if let Err(error) = child.start_kill() {
                                Self::append_error(&mut reap_error, error);
                            }
                            match tokio::time::timeout_at(deadline, child.wait()).await {
                                Ok(Ok(_)) => self.reaped = true,
                                Ok(Err(error)) => Self::append_error(&mut reap_error, error),
                                Err(_) => timed_out = true,
                            }
                        }
                    }
                }
                Err(_) => timed_out = true,
            }
        }
        if !self.reaped && self.child.is_some() {
            timed_out = true;
            Self::append_error(
                &mut reap_error,
                std::io::Error::other("child was not reaped"),
            );
        }
        loop {
            match self.active_processes() {
                Ok(0) => break,
                Ok(_) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                Ok(_) => {
                    timed_out = true;
                    Self::append_error(
                        &mut reap_error,
                        std::io::Error::other("job still has active processes"),
                    );
                    break;
                }
                Err(error) => {
                    Self::append_error(&mut reap_error, error);
                    break;
                }
            }
        }
        if self.reaped && !timed_out && reap_error.is_none() {
            self.child.take();
            self.job.take();
        }
        let terminate = self.terminate_error.take();
        if terminate.is_some() || reap_error.is_some() || timed_out {
            Err(StatusLineCommandError::Cleanup {
                primary: primary.map(Box::new),
                terminate,
                reap: reap_error,
                timed_out,
            })
        } else if let Some(primary) = primary {
            Err(primary)
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl<O: WindowsNativeOps> Drop for WindowsCommandOwner<O> {
    fn drop(&mut self) {
        if self.job.is_none() && self.child.is_none() {
            return;
        }
        self.terminate_tree();
        self.kill_root();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut reaped = self.reaped || self.child.is_none();
        let mut empty = self.job.is_none();
        while std::time::Instant::now() < deadline && (!reaped || !empty) {
            if !reaped && let Some(child) = self.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(_)) => reaped = true,
                    Ok(None) => {}
                    Err(error) => {
                        tracing::error!("status-line child reap during Drop failed: {error}");
                        break;
                    }
                }
            }
            if !empty {
                match self.active_processes() {
                    Ok(0) => empty = true,
                    Ok(_) => {}
                    Err(error) => {
                        tracing::error!("status-line job query during Drop failed: {error}");
                        break;
                    }
                }
            }
            if !reaped || !empty {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        if !reaped || !empty {
            tracing::error!(
                "status-line last-resort Drop could not verify child reap and empty job"
            );
        }
        if let Some(error) = self.terminate_error.as_ref() {
            tracing::error!("status-line termination during Drop failed: {error}");
        }
        // A failed terminate still has kill-on-last-close as the final tree stop.
        self.child.take();
        self.job.take();
    }
}

#[cfg(windows)]
#[allow(dead_code)]
async fn run_status_line_command_with_ops<O: WindowsNativeOps + 'static>(
    request: StatusLineCommandRequest,
    cancellation: tokio::sync::oneshot::Receiver<()>,
    ops: O,
) -> Result<Line<'static>, StatusLineCommandError> {
    let started = tokio::time::Instant::now();
    let (mut sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let result =
            run_status_line_command_supervised(request, cancellation, ops, started, &mut sender)
                .await;
        let _ = sender.send(result);
    });
    receiver
        .await
        .unwrap_or(Err(StatusLineCommandError::Cancelled))
}

#[cfg(windows)]
async fn run_status_line_command_supervised<O: WindowsNativeOps>(
    request: StatusLineCommandRequest,
    mut cancellation: tokio::sync::oneshot::Receiver<()>,
    ops: O,
    started: tokio::time::Instant,
    sender: &mut tokio::sync::oneshot::Sender<Result<Line<'static>, StatusLineCommandError>>,
) -> Result<Line<'static>, StatusLineCommandError> {
    use std::process::Stdio;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

    if request.config.command.trim().is_empty() {
        return Err(StatusLineCommandError::InvalidCommand);
    }
    let deadline = started + std::time::Duration::from_millis(request.config.timeout_ms);
    if tokio::time::Instant::now() >= deadline {
        return Err(StatusLineCommandError::Timeout);
    }
    let system_root = std::env::var_os("SystemRoot").ok_or(StatusLineCommandError::Spawn)?;
    let shell = PathBuf::from(system_root).join("System32").join("cmd.exe");
    if !shell.is_file() {
        return Err(StatusLineCommandError::Spawn);
    }
    let payload =
        serde_json::to_vec(&request.payload).map_err(|_| StatusLineCommandError::StdinWrite)?;
    if tokio::time::Instant::now() >= deadline {
        return Err(StatusLineCommandError::Timeout);
    }
    let mut command = tokio::process::Command::new(shell);
    command.arg("/D").arg("/S").arg("/C");
    // /S removes exactly this outer pair, retaining quoted command and argument paths.
    command.raw_arg(format!("\"{}\"", request.config.command));
    command
        .current_dir(&request.cwd)
        .env("CCSTATUSLINE_WIDTH", request.width.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
        .kill_on_drop(true);

    let job = ops
        .create_job()
        .map_err(|_| StatusLineCommandError::JobCreate)?;
    let mut owner = WindowsCommandOwner::new(ops, job);
    if tokio::time::Instant::now() >= deadline {
        return match owner.finish(Some(StatusLineCommandError::Timeout)).await {
            Err(error) => Err(error),
            Ok(()) => unreachable!("expired request must remain a timeout"),
        };
    }
    if let Err(primary) = owner.launch(&mut command) {
        return match owner.finish(Some(primary)).await {
            Err(error) => Err(error),
            Ok(()) => unreachable!("a launch failure must remain a failure"),
        };
    }
    let child = owner.child.as_mut().expect("launched child is owned");
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let missing_stdin = stdin.is_none();
    let (Some(mut stdin), Some(mut stdout)) = (stdin, stdout) else {
        let primary = if missing_stdin {
            StatusLineCommandError::StdinWrite
        } else {
            StatusLineCommandError::StdoutRead
        };
        return match owner.finish(Some(primary)).await {
            Err(error) => Err(error),
            Ok(()) => unreachable!("missing pipe must remain a failure"),
        };
    };
    let mut writer = Box::pin(async move { write_status_line_stdin(&mut stdin, &payload).await });
    let mut reader = Box::pin(async move { read_status_line_stdout(&mut stdout).await });
    let mut write_done = false;
    let mut read_done = false;
    let mut output = None;
    let mut status = None;
    let mut primary = None;
    let mut cancellation_open = true;

    while primary.is_none() && (!write_done || !read_done || status.is_none()) {
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => {
                primary = Some(StatusLineCommandError::Timeout);
            }
            cancellation_result = &mut cancellation, if cancellation_open => {
                if cancellation_result.is_ok() {
                    primary = Some(StatusLineCommandError::Cancelled);
                } else {
                    cancellation_open = false;
                }
            }
            _ = sender.closed() => {
                primary = Some(StatusLineCommandError::Cancelled);
            }
            result = &mut writer, if !write_done => {
                write_done = true;
                match result {
                    Ok(()) => {},
                    Err(error) => primary = Some(error),
                }
            }
            result = &mut reader, if !read_done => {
                read_done = true;
                match result {
                    Ok(bytes) => output = Some(bytes),
                    Err(error) => primary = Some(error),
                }
            }
            result = owner.ops.wait(owner.child.as_mut().expect("launched child is owned")), if status.is_none() => {
                match classify_status_line_wait(result) {
                    Ok(exit) => {
                        owner.reaped = true;
                        status = Some(exit);
                        // A descendant can inherit stdout and keep the pipe open after
                        // its root exits. Stop the job now, before awaiting pipe EOF.
                        owner.terminate_tree();
                    }
                    Err(error) => primary = Some(error),
                }
            }
        }
    }
    if primary.is_none() && tokio::time::Instant::now() >= deadline {
        primary = Some(StatusLineCommandError::Timeout);
    }
    if primary.is_some() {
        owner.terminate_tree();
    }
    // Both pipe futures belong to this supervisor. Dropping them closes their
    // handles before the owner begins child/job cleanup, even on early failure.
    drop(writer);
    drop(reader);
    let rendered = if primary.is_none() {
        let exit = status.as_ref().expect("successful runner has reaped root");
        if !exit.success() {
            primary = Some(StatusLineCommandError::ExitFailure);
            None
        } else {
            let line = render_status_line_command_output(
                output.as_deref().expect("successful runner drained stdout"),
                request.width,
            );
            if line.is_none() {
                primary = Some(StatusLineCommandError::EmptyOutput);
            }
            line
        }
    } else {
        None
    };
    owner.finish(primary).await?;
    Ok(rendered.expect("successful cleanup has a visible line"))
}

/// Runs a trusted status command; on Windows its supervisor owns teardown after caller abort.
#[allow(dead_code)]
pub(crate) async fn run_status_line_command(
    request: StatusLineCommandRequest,
    cancellation: tokio::sync::oneshot::Receiver<()>,
) -> Result<Line<'static>, StatusLineCommandError> {
    #[cfg(windows)]
    {
        run_status_line_command_with_ops(request, cancellation, DefaultWindowsNativeOps).await
    }
    #[cfg(not(windows))]
    {
        let _ = (request, cancellation);
        Err(StatusLineCommandError::Unsupported)
    }
}

/// Write the complete JSON payload, then close stdin so readers can observe EOF.
#[allow(dead_code)]
async fn write_status_line_stdin<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    payload: &[u8],
) -> Result<(), StatusLineCommandError> {
    use tokio::io::AsyncWriteExt;
    writer
        .write_all(payload)
        .await
        .map_err(|_| StatusLineCommandError::StdinWrite)?;
    writer
        .shutdown()
        .await
        .map_err(|_| StatusLineCommandError::StdinWrite)
}

/// Stop at byte 65,537 so a full pipe cannot turn truncated output into success.
#[allow(dead_code)]
async fn read_status_line_stdout<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Vec<u8>, StatusLineCommandError> {
    use tokio::io::AsyncReadExt;
    const LIMIT: usize = 65_536;
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|_| StatusLineCommandError::StdoutRead)?;
        if read == 0 {
            return Ok(output);
        }
        if output.len() + read > LIMIT {
            return Err(StatusLineCommandError::OutputCap);
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

/// Keeps wait-error mapping narrow enough to exercise without a fake process type.
#[allow(dead_code)]
fn classify_status_line_wait(
    status: std::io::Result<std::process::ExitStatus>,
) -> Result<std::process::ExitStatus, StatusLineCommandError> {
    status.map_err(|_| StatusLineCommandError::Wait)
}

#[cfg(test)]
#[path = "status_line_command_tests.rs"]
mod tests;
