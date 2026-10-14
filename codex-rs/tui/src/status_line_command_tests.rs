use super::*;
use codex_config::ConfigLayerEntry;
use codex_config::ConfigLayerSource;
use codex_config::ConfigRequirements;
use codex_config::ConfigRequirementsToml;
use codex_utils_absolute_path::AbsolutePathBuf;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use serde_json::json;

fn counts(
    input: i64,
    cached_input: i64,
    output: i64,
    reasoning_output: i64,
    total: i64,
) -> StatusLineTokenCounts {
    StatusLineTokenCounts {
        input,
        cached_input,
        output,
        reasoning_output,
        total,
    }
}

fn payload_snapshot() -> StatusLinePayloadSnapshot {
    StatusLinePayloadSnapshot {
        session_id: "thread-123".to_string(),
        cwd: "/work/project".to_string(),
        model_id: "gpt-6".to_string(),
        model_display_name: "GPT-6".to_string(),
        effort_level: Some("high".to_string()),
        version: "1.2.3".to_string(),
        mode: "Codex".to_string(),
        approval_mode: "on-request".to_string(),
        sandbox: "workspace-write".to_string(),
        thread_name: Some("Migration".to_string()),
        compactions: 2,
        context_window_size: Some(200_000),
        context_used_percentage: Some(25.0),
        context_remaining_percentage: Some(75.0),
        total_tokens: Some(counts(50_400, 20_000, 2_090, 900, 52_490)),
        last_tokens: Some(counts(400, 100, 90, 30, 490)),
        rate_limits: vec![],
        session_wall_duration_ms: 12_345,
    }
}

fn payload(snapshot: &StatusLinePayloadSnapshot) -> serde_json::Value {
    build_status_line_payload(snapshot, &StatusLineLaunchState::new(snapshot.total_tokens))
}

#[test]
fn payload_has_consumer_metadata_and_schema_one_extras() {
    let p = payload(&payload_snapshot());
    assert_eq!(p["hook_event_name"], "Status");
    assert_eq!(p["session_id"], "thread-123");
    assert_eq!(p["cwd"], "/work/project");
    assert_eq!(p["workspace"]["current_dir"], "/work/project");
    assert_eq!(p["workspace"]["project_dir"], "/work/project");
    assert_eq!(p["model"], json!({"id": "gpt-6", "display_name": "GPT-6"}));
    assert_eq!(p["effort"]["level"], "high");
    assert_eq!(p["version"], "1.2.3");
    assert_eq!(p["output_style"]["name"], "Codex");
    assert_eq!(p["cost"]["total_duration_ms"], 12_345);
    assert_eq!(p["codex"]["schema"], 1);
    assert_eq!(p["codex"]["approval_mode"], "on-request");
    assert_eq!(p["codex"]["sandbox"], "workspace-write");
    assert_eq!(p["codex"]["thread_name"], "Migration");
    assert_eq!(p["codex"]["compactions"], 2);
}

#[test]
fn payload_splits_cached_input_and_keeps_cumulative_thread_totals() {
    let p = payload(&payload_snapshot());
    assert_eq!(p["context_window"]["context_window_size"], 200_000);
    assert_eq!(p["context_window"]["total_input_tokens"], 50_400);
    assert_eq!(p["context_window"]["total_output_tokens"], 2_090);
    assert_eq!(p["context_window"]["used_percentage"], 25.0);
    assert_eq!(p["context_window"]["remaining_percentage"], 75.0);
    assert_eq!(
        p["context_window"]["current_usage"],
        json!({
            "input_tokens": 300,
            "output_tokens": 90,
            "cache_read_input_tokens": 100
        })
    );
    assert_eq!(
        p["codex"]["tokens"],
        json!({
            "input": 50_400,
            "cached_input": 20_000,
            "output": 2_090,
            "reasoning_output": 900,
            "total": 52_490
        })
    );
}

#[test]
fn fresh_session_omits_unknown_usage_and_percentages() {
    let mut snapshot = payload_snapshot();
    snapshot.total_tokens = None;
    snapshot.last_tokens = None;
    snapshot.context_used_percentage = None;
    snapshot.context_remaining_percentage = None;
    let p = payload(&snapshot);
    let context = &p["context_window"];
    assert_eq!(context["context_window_size"], 200_000);
    for field in [
        "total_input_tokens",
        "total_output_tokens",
        "current_usage",
        "used_percentage",
        "remaining_percentage",
    ] {
        assert!(context.get(field).is_none(), "unexpected {field}");
    }
    assert!(
        p["codex"]
            .get("tokens")
            .is_none_or(serde_json::Value::is_null)
    );
}

#[test]
fn cached_input_larger_than_input_clamps_uncached_input_to_zero() {
    let mut snapshot = payload_snapshot();
    snapshot.last_tokens = Some(counts(40, 60, 5, 0, 45));
    let p = payload(&snapshot);
    assert_eq!(p["context_window"]["current_usage"]["input_tokens"], 0);
    assert_eq!(
        p["context_window"]["current_usage"]["cache_read_input_tokens"],
        60
    );
}

#[test]
fn common_rate_limits_follow_exact_window_lengths_even_when_source_order_is_swapped() {
    let mut snapshot = payload_snapshot();
    snapshot.rate_limits = vec![
        StatusLineRateLimitWindow {
            used_percent: 70.0,
            resets_at: Some(1_791_544_719),
            window_minutes: Some(10_080),
        },
        StatusLineRateLimitWindow {
            used_percent: 12.5,
            resets_at: Some(1_791_500_000),
            window_minutes: Some(300),
        },
    ];
    let p = payload(&snapshot);
    assert_eq!(
        p["rate_limits"]["five_hour"],
        json!({"used_percentage": 12.5, "resets_at": 1_791_500_000})
    );
    assert_eq!(
        p["rate_limits"]["seven_day"],
        json!({"used_percentage": 70.0, "resets_at": 1_791_544_719})
    );
    assert_eq!(p["codex"]["rate_limits"][0]["window_minutes"], 10_080);
    assert_eq!(p["codex"]["rate_limits"][1]["window_minutes"], 300);
}

#[test]
fn unusual_and_unknown_windows_remain_only_in_codex_extras() {
    let mut snapshot = payload_snapshot();
    snapshot.rate_limits = vec![
        StatusLineRateLimitWindow {
            used_percent: 35.0,
            resets_at: None,
            window_minutes: Some(60),
        },
        StatusLineRateLimitWindow {
            used_percent: 50.0,
            resets_at: Some(1_791_500_000),
            window_minutes: None,
        },
    ];
    let p = payload(&snapshot);
    assert!(p["rate_limits"].get("five_hour").is_none());
    assert!(p["rate_limits"].get("seven_day").is_none());
    assert_eq!(
        p["codex"]["rate_limits"][0],
        json!({"used_percent": 35.0, "resets_at": null, "window_minutes": 60})
    );
    assert_eq!(
        p["codex"]["rate_limits"][1],
        json!({"used_percent": 50.0, "resets_at": 1_791_500_000, "window_minutes": null})
    );
}

#[test]
fn invalid_percentages_and_window_metadata_are_not_emitted() {
    let mut snapshot = payload_snapshot();
    snapshot.context_used_percentage = Some(f64::NAN);
    snapshot.context_remaining_percentage = Some(101.0);
    snapshot.rate_limits = vec![
        StatusLineRateLimitWindow {
            used_percent: -1.0,
            resets_at: Some(123),
            window_minutes: Some(300),
        },
        StatusLineRateLimitWindow {
            used_percent: f64::INFINITY,
            resets_at: None,
            window_minutes: Some(10_080),
        },
        StatusLineRateLimitWindow {
            used_percent: 42.0,
            resets_at: Some(-1),
            window_minutes: Some(0),
        },
    ];
    let p = payload(&snapshot);
    assert!(p["context_window"].get("used_percentage").is_none());
    assert!(p["context_window"].get("remaining_percentage").is_none());
    assert!(p["rate_limits"].get("five_hour").is_none());
    assert!(p["rate_limits"].get("seven_day").is_none());
    assert_eq!(
        p["codex"]["rate_limits"],
        json!([{"used_percent": 42.0, "resets_at": null, "window_minutes": null}])
    );
}

#[test]
fn invalid_counts_are_omitted_individually_without_json_precision_loss() {
    const UNSAFE: i64 = 9_007_199_254_740_992;
    let mut snapshot = payload_snapshot();
    snapshot.compactions = -1;
    snapshot.session_wall_duration_ms = UNSAFE;
    snapshot.context_window_size = Some(-1);
    snapshot.total_tokens = Some(counts(-1, UNSAFE, 4, -5, UNSAFE));
    snapshot.last_tokens = Some(counts(-1, UNSAFE, 4, 0, 4));
    let p = payload(&snapshot);
    let tokens = &p["codex"]["tokens"];
    for field in ["input", "cached_input", "reasoning_output", "total"] {
        assert!(tokens.get(field).is_none(), "unexpected {field}");
    }
    assert_eq!(tokens["output"], 4);
    assert!(p["codex"].get("compactions").is_none());
    assert!(p["cost"].get("total_duration_ms").is_none());
    assert!(p["context_window"].get("context_window_size").is_none());
    assert!(p["context_window"].get("total_input_tokens").is_none());
    assert_eq!(p["context_window"]["total_output_tokens"], 4);
    assert!(
        p["context_window"]["current_usage"]
            .get("input_tokens")
            .is_none()
    );
    assert!(
        p["context_window"]["current_usage"]
            .get("cache_read_input_tokens")
            .is_none()
    );
    assert_eq!(p["context_window"]["current_usage"]["output_tokens"], 4);

    snapshot.total_tokens = Some(counts(5, 1, UNSAFE, 0, UNSAFE));
    snapshot.last_tokens = Some(counts(5, 1, UNSAFE, 0, UNSAFE));
    let p = payload(&snapshot);
    assert_eq!(p["context_window"]["total_input_tokens"], 5);
    assert!(p["context_window"].get("total_output_tokens").is_none());
    assert_eq!(p["context_window"]["current_usage"]["input_tokens"], 4);
    assert_eq!(
        p["context_window"]["current_usage"]["cache_read_input_tokens"],
        1
    );
    assert!(
        p["context_window"]["current_usage"]
            .get("output_tokens")
            .is_none()
    );
}

#[test]
fn maximum_safe_integer_counts_are_accepted() {
    const MAX_SAFE: i64 = 9_007_199_254_740_991;
    let mut snapshot = payload_snapshot();
    snapshot.compactions = MAX_SAFE;
    snapshot.session_wall_duration_ms = MAX_SAFE;
    snapshot.total_tokens = Some(counts(MAX_SAFE, 0, 0, 0, MAX_SAFE));
    snapshot.last_tokens = Some(counts(MAX_SAFE, 0, 0, 0, MAX_SAFE));
    let p = payload(&snapshot);
    assert_eq!(p["codex"]["tokens"]["input"], MAX_SAFE);
    assert_eq!(p["codex"]["compactions"], MAX_SAFE);
    assert_eq!(p["cost"]["total_duration_ms"], MAX_SAFE);
    assert_eq!(p["context_window"]["total_input_tokens"], MAX_SAFE);
    assert_eq!(
        p["context_window"]["current_usage"]["input_tokens"],
        MAX_SAFE
    );
}

#[test]
fn payload_does_not_claim_unsupported_claude_or_api_fields() {
    let p = payload(&payload_snapshot());
    for field in [
        "transcript_path",
        "vim",
        "worktree",
        "api_duration_ms",
        "total_cost_usd",
    ] {
        assert!(p.get(field).is_none(), "unexpected {field}");
        assert!(p["codex"].get(field).is_none(), "unexpected codex.{field}");
    }
    assert!(p["cost"].get("total_cost_usd").is_none());
    assert!(p["rate_limits"].get("primary").is_none());
    assert!(p["rate_limits"].get("secondary").is_none());
}

#[test]
fn launch_baseline_needs_a_later_valid_sample_for_speed() {
    let snapshot = payload_snapshot();
    let launch = StatusLineLaunchState::new(snapshot.total_tokens);
    let first = build_status_line_payload(&snapshot, &launch);
    assert!(
        first["codex"]
            .get("speed_tokens")
            .is_none_or(serde_json::Value::is_null)
    );
    assert!(
        first["codex"]
            .get("turn_wall_duration_ms")
            .is_none_or(|wall| wall.is_null() || *wall == json!(0))
    );

    let mut later_snapshot = snapshot;
    later_snapshot.total_tokens = Some(counts(50_800, 20_100, 2_180, 930, 52_980));
    let mut launch = launch;
    launch.observe_tokens(later_snapshot.total_tokens, 5_000);
    let later = build_status_line_payload(&later_snapshot, &launch);
    assert_eq!(later["codex"]["turn_wall_duration_ms"], 5_000);
    assert_eq!(
        later["codex"]["speed_tokens"],
        json!({"input": 400, "output": 90, "total": 490})
    );
}

#[test]
fn late_first_token_baseline_restarts_the_matching_active_time_interval() {
    let mut snapshot = payload_snapshot();
    snapshot.total_tokens = None;
    snapshot.last_tokens = None;
    snapshot.session_wall_duration_ms = 10_000;
    let mut launch = StatusLineLaunchState::new(None);

    let first_total = counts(100, 25, 20, 5, 120);
    snapshot.total_tokens = Some(first_total);
    launch.observe_tokens(Some(first_total), 3_000);
    let first = build_status_line_payload(&snapshot, &launch);
    assert_eq!(first["cost"]["total_duration_ms"], 10_000);
    assert_eq!(first["codex"]["tokens"]["total"], 120);
    assert!(
        first["codex"]
            .get("speed_tokens")
            .is_none_or(serde_json::Value::is_null)
    );
    assert!(
        first["codex"]
            .get("turn_wall_duration_ms")
            .is_none_or(|wall| wall.is_null() || *wall == json!(0))
    );

    let later_total = counts(140, 30, 35, 8, 175);
    snapshot.total_tokens = Some(later_total);
    snapshot.session_wall_duration_ms = 14_000;
    launch.observe_tokens(Some(later_total), 7_000);
    let later = build_status_line_payload(&snapshot, &launch);
    assert_eq!(later["cost"]["total_duration_ms"], 14_000);
    assert_eq!(later["context_window"]["total_input_tokens"], 140);
    assert_eq!(later["codex"]["tokens"]["total"], 175);
    assert_eq!(later["codex"]["turn_wall_duration_ms"], 4_000);
    assert_eq!(
        later["codex"]["speed_tokens"],
        json!({"input": 40, "output": 15, "total": 55})
    );
}

#[test]
fn active_time_without_new_tokens_counts_toward_the_matching_speed_interval() {
    let mut snapshot = payload_snapshot();
    let mut launch = StatusLineLaunchState::new(snapshot.total_tokens);
    snapshot.total_tokens = None;
    launch.observe_tokens(None, 3_000);
    let during_gap = build_status_line_payload(&snapshot, &launch);
    assert_eq!(during_gap["codex"]["turn_wall_duration_ms"], 3_000);
    assert!(
        during_gap["codex"]
            .get("speed_tokens")
            .is_none_or(serde_json::Value::is_null)
    );

    let later_total = counts(50_440, 20_000, 2_100, 900, 52_540);
    snapshot.total_tokens = Some(later_total);
    launch.observe_tokens(Some(later_total), 7_000);
    let later = build_status_line_payload(&snapshot, &launch);
    assert_eq!(later["codex"]["turn_wall_duration_ms"], 7_000);
    assert_eq!(
        later["codex"]["speed_tokens"],
        json!({"input": 40, "output": 10, "total": 50})
    );
}

#[test]
fn resume_restarts_launch_clock_and_baseline_while_retaining_thread_totals() {
    let mut snapshot = payload_snapshot();
    let mut launch = StatusLineLaunchState::new(Some(counts(100, 20, 10, 2, 110)));
    launch.observe_tokens(snapshot.total_tokens, 9_000);
    launch.resume(snapshot.total_tokens);
    snapshot.session_wall_duration_ms = 0;
    let p = build_status_line_payload(&snapshot, &launch);
    assert_eq!(p["cost"]["total_duration_ms"], 0);
    assert_eq!(p["codex"]["turn_wall_duration_ms"], 0);
    assert!(
        p["codex"]
            .get("speed_tokens")
            .is_none_or(serde_json::Value::is_null)
    );
    assert_eq!(p["codex"]["tokens"]["total"], 52_490);
    assert_eq!(p["context_window"]["total_input_tokens"], 50_400);
}

#[test]
fn counter_reset_first_sample_omits_speed_and_rebases_from_new_total() {
    let mut snapshot = payload_snapshot();
    let mut launch = StatusLineLaunchState::new(snapshot.total_tokens);
    snapshot.total_tokens = Some(counts(20, 2, 5, 1, 25));
    launch.observe_tokens(snapshot.total_tokens, 3_000);
    let p = build_status_line_payload(&snapshot, &launch);
    assert!(
        p["codex"]
            .get("speed_tokens")
            .is_none_or(serde_json::Value::is_null)
    );
    assert_eq!(p["codex"]["tokens"]["input"], 20);
}

#[test]
fn counter_reset_restarts_both_speed_tokens_and_active_time() {
    let mut snapshot = payload_snapshot();
    let mut launch = StatusLineLaunchState::new(snapshot.total_tokens);
    launch.observe_tokens(Some(counts(50_800, 20_100, 2_180, 930, 52_980)), 2_000);

    let reset_total = counts(20, 2, 5, 1, 25);
    snapshot.total_tokens = Some(reset_total);
    snapshot.session_wall_duration_ms = 20_000;
    launch.observe_tokens(Some(reset_total), 3_000);
    let reset = build_status_line_payload(&snapshot, &launch);
    assert_eq!(reset["cost"]["total_duration_ms"], 20_000);
    assert_eq!(reset["codex"]["tokens"]["total"], 25);
    assert!(
        reset["codex"]
            .get("speed_tokens")
            .is_none_or(serde_json::Value::is_null)
    );
    assert!(
        reset["codex"]
            .get("turn_wall_duration_ms")
            .is_none_or(|wall| wall.is_null() || *wall == json!(0))
    );

    let later_total = counts(50, 3, 15, 2, 65);
    snapshot.total_tokens = Some(later_total);
    snapshot.session_wall_duration_ms = 25_000;
    launch.observe_tokens(Some(later_total), 8_000);
    let later = build_status_line_payload(&snapshot, &launch);
    assert_eq!(later["cost"]["total_duration_ms"], 25_000);
    assert_eq!(later["context_window"]["total_input_tokens"], 50);
    assert_eq!(later["codex"]["tokens"]["total"], 65);
    assert_eq!(later["codex"]["turn_wall_duration_ms"], 5_000);
    assert_eq!(
        later["codex"]["speed_tokens"],
        json!({"input": 30, "output": 10, "total": 40})
    );
}

fn stack(entries: Vec<(ConfigLayerSource, &str)>) -> ConfigLayerStack {
    let layers = entries
        .into_iter()
        .map(|(name, source)| {
            let table = toml::from_str::<toml::Table>(source).expect("TOML fixture");
            ConfigLayerEntry::new(name, toml::Value::Table(table))
        })
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
    for value in [
        "",
        "[tui.status_line_command]\ncommand = '   '\n",
        "[tui.status_line_command]\n",
    ] {
        let resolved =
            StatusLineCommandResolution::from_layers(&stack(vec![(user_source(), value)]));
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
        let resolved =
            StatusLineCommandResolution::from_layers(&stack(vec![(user_source(), value)]));
        assert!(resolved.config.is_none(), "{value}");
        assert!(
            resolved
                .warnings
                .contains(&StatusLineCommandWarning::InvalidTrustedConfig),
            "{value}"
        );
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
        (
            user_source(),
            "[tui.status_line_command]\ncommand = 'echo user'\n",
        ),
        (
            ConfigLayerSource::SessionFlags,
            "[tui.status_line_command]\ntimeout_ms = 3000\n",
        ),
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
        format!(
            "[projects.{project_key}]\ntrust_level = 'trusted'\n[tui]\nstatus_line = ['model-with-reasoning']\n[tui.status_line_command]\ncommand = 'echo user'\n"
        ),
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
    assert!(
        bootstrap
            .config_layer_stack
            .layers_low_to_high()
            .any(|layer| {
                matches!(layer.name, ConfigLayerSource::Project { .. })
                    && layer
                        .config
                        .get("tui")
                        .and_then(|value| value.get("status_line_command"))
                        .and_then(|value| value.get("command"))
                        .and_then(toml::Value::as_str)
                        == Some("echo project-marker")
            }),
        "the loader must actually include the configured project layer"
    );
    let local = crate::local_settings::LocalSettings::from_bootstrap(
        &bootstrap,
        AbsolutePathBuf::from_absolute_path(&home)?,
    )?;
    assert_eq!(
        local
            .status_line_command
            .config
            .as_ref()
            .map(|config| config.command.as_str()),
        Some("echo user")
    );
    assert!(
        local
            .status_line_command
            .warnings
            .contains(&StatusLineCommandWarning::IgnoredProjectConfig)
    );
    assert_eq!(
        local.tui.status_line,
        Some(vec!["model-with-reasoning".to_string()])
    );
    Ok(())
}

fn rendered(output: &[u8], width: usize) -> Line<'static> {
    render_status_line_command_output(output, width).expect("visible command output should render")
}

fn rendered_text(line: &Line<'_>) -> String {
    line.spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect()
}

#[test]
fn render_crlf_skips_empty_first_line_and_keeps_first_visible_line() {
    let line = rendered(b"\r\nfirst\r\nsecond", 20);
    assert_eq!(rendered_text(&line), "first");
}

#[test]
fn render_skips_whitespace_only_and_escape_only_lines_but_preserves_selected_padding() {
    let line = rendered(b" \t \n\x1b[31m\x1b[0m\n  keep  \nsecond", 20);
    assert_eq!(rendered_text(&line), "  keep  ");
    assert_eq!(line.width(), 8);
}

#[test]
fn render_only_blank_and_escape_lines_produce_no_visible_line() {
    assert!(render_status_line_command_output(b" \t\n\x1b[31m\x1b[0m\r\n", 20).is_none());
}

#[test]
fn render_zero_width_does_not_fabricate_a_visible_line() {
    assert!(render_status_line_command_output(b"hello", 0).is_none());
}

#[test]
fn render_invalid_utf8_rejects_the_output_without_replacement_text() {
    assert!(render_status_line_command_output(b"good\xff", 20).is_none());
}

#[test]
fn render_c0_c1_and_delete_controls_cannot_reach_footer_text() {
    let line = rendered(b"a\x00\x01\x7f\xc2\x80\xc2\x9fb", 20);
    assert_eq!(rendered_text(&line), "ab");
}

#[test]
fn render_csi_cursor_and_erase_controls_cannot_reach_footer_text() {
    let line = rendered(b"A\x1b[2J\x1b[4CB\x1b[1D", 20);
    assert_eq!(rendered_text(&line), "AB");
}

#[test]
fn render_osc_title_content_and_terminator_cannot_reach_footer_text() {
    let line = rendered(b"a\x1b]0;secret title\x07b", 20);
    assert_eq!(rendered_text(&line), "ab");
}

#[test]
fn render_osc_clipboard_content_and_terminator_cannot_reach_footer_text() {
    let line = rendered(b"a\x1b]52;c;c2VjcmV0\x1b\\b", 20);
    assert_eq!(rendered_text(&line), "ab");
}

#[test]
fn render_osc_hyperlink_keeps_label_without_opening_or_closing_controls() {
    let line = rendered(
        b"\x1b]8;;https://example.invalid\x1b\\label\x1b]8;;\x1b\\",
        20,
    );
    assert_eq!(rendered_text(&line), "label");
}

#[test]
fn render_dcs_apc_and_pm_control_strings_cannot_reach_footer_text() {
    let line = rendered(
        b"a\x1bPsecret\x1b\\b\x1b_hidden\x1b\\c\x1b^private\x1b\\d",
        20,
    );
    assert_eq!(rendered_text(&line), "abcd");
}

#[test]
fn render_newline_inside_osc_control_string_does_not_select_hidden_content() {
    let line = rendered(b"\x1b]0;hidden\ncontent\x07visible\nnext", 20);
    assert_eq!(rendered_text(&line), "visible");
}

#[test]
fn render_newline_inside_dcs_control_string_does_not_select_hidden_content() {
    let line = rendered(b"\x1bPhidden\ncontent\x1b\\visible\nnext", 20);
    assert_eq!(rendered_text(&line), "visible");
}

#[test]
fn render_c1_osc_control_string_is_removed_with_its_content() {
    let line = rendered("a\u{009d}0;hidden\u{009c}b".as_bytes(), 20);
    assert_eq!(rendered_text(&line), "ab");
}

#[test]
fn render_sgr_color_and_reset_create_only_safe_styled_spans() {
    let line = rendered(b"\x1b[31mred\x1b[0mplain", 20);
    assert_eq!(rendered_text(&line), "redplain");
    assert_eq!(
        line.spans,
        vec![
            Span::styled("red", Style::default().fg(Color::Red)),
            Span::raw("plain"),
        ]
    );
}

#[test]
fn render_rgb_sgr_color_is_retained_as_an_owned_span() {
    let line = rendered(b"\x1b[38;2;12;34;56mRGB\x1b[0m", 20);
    assert_eq!(
        line.spans,
        vec![Span::styled(
            "RGB",
            Style::default().fg(Color::Rgb(12, 34, 56)),
        )]
    );
}

#[test]
fn render_sgr_bold_modifier_is_retained_without_escape_bytes() {
    let line = rendered(b"\x1b[1mbold\x1b[0m", 20);
    assert_eq!(
        line.spans,
        vec![Span::styled(
            "bold",
            Style::default().add_modifier(Modifier::BOLD),
        )]
    );
}

#[test]
fn render_exact_terminal_width_does_not_add_an_ellipsis() {
    let line = rendered(b"exact", 5);
    assert_eq!(rendered_text(&line), "exact");
    assert_eq!(line.width(), 5);
}

#[test]
fn render_recomputes_fit_from_the_same_output_after_width_changes() {
    let output = b"resize";
    assert_eq!(rendered_text(&rendered(output, 4)), "res…");
    assert_eq!(rendered_text(&rendered(output, 6)), "resize");
}

#[test]
fn render_result_owns_its_text_after_command_bytes_are_dropped() {
    let line = {
        let output = b"owned".to_vec();
        rendered(&output, 5)
    };
    assert_eq!(rendered_text(&line), "owned");
}

#[test]
fn render_width_one_uses_one_column_for_the_ellipsis() {
    let line = rendered(b"long", 1);
    assert_eq!(rendered_text(&line), "…");
    assert_eq!(line.width(), 1);
}

#[test]
fn render_truncation_preserves_leading_spaces_and_drops_trailing_overflow() {
    let line = rendered(b"  abc  ", 5);
    assert_eq!(rendered_text(&line), "  ab…");
    assert_eq!(line.width(), 5);
}

#[test]
fn render_cjk_cluster_uses_two_columns_and_is_never_split() {
    let exact = rendered("界a".as_bytes(), 3);
    assert_eq!(rendered_text(&exact), "界a");
    assert_eq!(exact.width(), 3);
    let narrow = rendered("界a".as_bytes(), 2);
    assert_eq!(rendered_text(&narrow), "…");
    assert_eq!(narrow.width(), 1);
}

#[test]
fn render_powerline_glyph_remains_intact_at_a_column_boundary() {
    let line = rendered("ab".as_bytes(), 2);
    assert_eq!(rendered_text(&line), "…");
    assert_eq!(line.width(), 2);
}

#[test]
fn render_combining_accent_remains_attached_to_its_base_when_truncated() {
    let line = rendered("e\u{301}ab".as_bytes(), 2);
    assert_eq!(rendered_text(&line), "e\u{301}…");
    assert_eq!(line.width(), 2);
}

#[test]
fn render_skin_tone_emoji_is_one_unsplit_two_column_cluster() {
    let line = rendered("👍🏽ab".as_bytes(), 3);
    assert_eq!(rendered_text(&line), "👍🏽…");
    assert_eq!(line.width(), 3);
}

#[test]
fn render_zwj_family_emoji_is_one_unsplit_two_column_cluster() {
    let line = rendered("👩‍👩‍👧‍👦ab".as_bytes(), 3);
    assert_eq!(rendered_text(&line), "👩‍👩‍👧‍👦…");
    assert_eq!(line.width(), 3);
}

#[test]
fn render_regional_indicator_flag_is_one_unsplit_two_column_cluster() {
    let line = rendered("🇺🇸ab".as_bytes(), 3);
    assert_eq!(rendered_text(&line), "🇺🇸…");
    assert_eq!(line.width(), 3);
}

#[test]
fn render_style_boundary_inside_grapheme_uses_first_scalar_style() {
    let line = rendered("\x1b[31me\x1b[34m\u{301}\x1b[0mx".as_bytes(), 2);
    assert_eq!(rendered_text(&line), "e\u{301}x");
    assert_eq!(line.width(), 2);
    assert_eq!(
        line.spans[0],
        Span::styled("e\u{301}", Style::default().fg(Color::Red))
    );
    assert_eq!(line.spans[1], Span::raw("x"));

    let narrow = rendered("\x1b[31me\x1b[34m\u{301}\x1b[0mxy".as_bytes(), 2);
    assert_eq!(rendered_text(&narrow), "e\u{301}…");
    assert_eq!(
        narrow.spans[0],
        Span::styled("e\u{301}", Style::default().fg(Color::Red))
    );
}
