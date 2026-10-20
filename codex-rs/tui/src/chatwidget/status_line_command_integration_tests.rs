//! Actual-widget behavioral contract. The initial inert glue must fail these
//! assertions before implementation; the existing scheduler is the only scheduler.

use super::*;
use crate::chatwidget::tests::make_chatwidget_manual_with_sender;
use crate::status_line_command::*;
use codex_app_server_protocol::ItemCompletedNotification;
use codex_app_server_protocol::ItemStartedNotification;
use codex_app_server_protocol::TurnItemsView;
use codex_app_server_protocol::TurnStartedNotification;
use ratatui::buffer::Buffer;
use ratatui::style::Color;
use ratatui::style::Modifier;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

const SPACING: Duration = Duration::from_millis(300);

#[derive(Debug)]
struct Started {
    request: StatusLineCommandRequest,
    at: tokio::time::Instant,
    finish: oneshot::Sender<Result<Line<'static>, StatusLineCommandError>>,
    cancelled: oneshot::Receiver<()>,
    cleanup: oneshot::Sender<()>,
}

struct Harness {
    chat: ChatWidget,
    events: mpsc::UnboundedReceiver<AppEvent>,
    _ops: mpsc::UnboundedReceiver<crate::app_command::AppCommand>,
    starts: mpsc::UnboundedReceiver<Started>,
    history: Vec<String>,
    last_output: Option<(StatusLineCommandIdentity, StatusLineCommandRuntimeId, u64)>,
}

async fn settle() {
    for _ in 0..128 {
        tokio::task::yield_now().await;
    }
}

fn command(interval: u64) -> StatusLineCommandResolution {
    StatusLineCommandResolution {
        config: Some(StatusLineCommandConfig {
            command: "synthetic-status-command".into(),
            refresh_interval_secs: interval,
            timeout_ms: 2_000,
        }),
        warnings: Vec::new(),
    }
}

fn text(buffer: &Buffer) -> String {
    buffer.content.iter().map(|cell| cell.symbol()).collect()
}

fn draw(chat: &ChatWidget, width: u16) -> Buffer {
    let area = Rect::new(0, 0, width, chat.desired_height(width).max(1));
    let mut buffer = Buffer::empty(area);
    chat.render(area, &mut buffer);
    buffer
}

fn styled(value: &str) -> Line<'static> {
    render_status_line_command_output(value.as_bytes(), 200).expect("nonempty synthetic output")
}

/// Copy captured actor metadata verbatim, changing only the UI identity. The
/// original event is delivered afterward as a positive control, so neither an
/// invented runtime nor duplicate suppression can explain rejection.
fn with_identity(event: &AppEvent, identity: StatusLineCommandIdentity) -> AppEvent {
    match event {
        AppEvent::StatusLineCommandOutput {
            runtime,
            generation,
            effect,
            ..
        } => {
            let display = effect.display.as_ref().map(|display| match display {
                StatusLineCommandDisplay::Command(line) => {
                    StatusLineCommandDisplay::Command(line.clone())
                }
                StatusLineCommandDisplay::BuiltIn => StatusLineCommandDisplay::BuiltIn,
            });
            AppEvent::StatusLineCommandOutput {
                identity,
                runtime: *runtime,
                generation: *generation,
                effect: StatusLineCommandEffect {
                    display,
                    warning: effect.warning,
                    request_refresh: effect.request_refresh,
                },
            }
        }
        AppEvent::StatusLineCommandTick { runtime, epoch, .. } => AppEvent::StatusLineCommandTick {
            identity,
            runtime: *runtime,
            epoch: *epoch,
        },
        _ => panic!("only captured command events may be identity-rewritten"),
    }
}

fn draw_options(
    chat: &ChatWidget,
    width: u16,
    options: crate::bottom_pane::ComposerRenderOptions<'_>,
) -> Buffer {
    let view = chat.bottom_pane.as_renderable_with_options(options);
    let area = Rect::new(0, 0, width, view.desired_height(width).max(1));
    let mut buffer = Buffer::empty(area);
    view.render(area, &mut buffer);
    buffer
}

/// Independent black-box oracle: with the command disabled, fill the existing
/// built-in status setter until the actual renderer no longer fits the complete
/// prefix and suffix. No command request, width API, or layout arithmetic enters
/// the answer. Probing all lengths also covers the full-to-compact mode switch.
fn footer_budget(
    chat: &mut ChatWidget,
    width: u16,
    options: crate::bottom_pane::ComposerRenderOptions<'_>,
) -> usize {
    assert!(chat.local_settings.status_line_command.config.is_none());
    chat.bottom_pane.set_status_line_enabled(true);
    let mut maximum = 0;
    for columns in 1..=usize::from(width) {
        chat.set_status_line(Some(Line::from("Z".repeat(columns))));
        let buffer = draw_options(chat, width, options);
        let marker_rows = buffer
            .content
            .chunks(usize::from(width))
            .filter(|row| row.iter().any(|cell| cell.symbol() == "Z"));
        for row in marker_rows {
            let visible = row.iter().filter(|cell| cell.symbol() == "Z").count();
            let truncated = row.iter().any(|cell| cell.symbol().contains('\u{2026}'));
            if visible == columns && !truncated {
                maximum = maximum.max(columns);
            }
        }
    }
    chat.refresh_status_line();
    maximum
}

impl Harness {
    async fn new() -> Self {
        let (mut chat, _sender, events, ops) = make_chatwidget_manual_with_sender().await;
        chat.local_settings.tui.status_line = Some(vec!["model-name".into()]);
        chat.local_settings.tui.status_line_use_colors = false;
        chat.local_settings.tui.terminal_title = Some(Vec::new());
        chat.thread_id =
            Some(ThreadId::from_string("00000000-0000-0000-0000-000000000007").unwrap());
        chat.refresh_status_line();
        let (tx, starts) = mpsc::unbounded_channel();
        let runner: StatusLineCommandRunFn = Arc::new(move |request, mut cancellation| {
            let (finish, finished) = oneshot::channel();
            let (cancelled, cancellation_seen) = oneshot::channel();
            let (cleanup, cleanup_allowed) = oneshot::channel();
            tx.send(Started {
                request,
                at: tokio::time::Instant::now(),
                finish,
                cancelled: cancellation_seen,
                cleanup,
            })
            .expect("widget runner remains observed");
            Box::pin(async move {
                tokio::select! {
                    result = finished => result.unwrap_or(Err(StatusLineCommandError::Cancelled)),
                    _ = &mut cancellation => {
                        let _ = cancelled.send(());
                        let _ = cleanup_allowed.await;
                        Err(StatusLineCommandError::Cancelled)
                    }
                }
            })
        });
        chat.set_status_line_command_runner(runner);
        let mut harness = Self {
            chat,
            events,
            _ops: ops,
            starts,
            history: Vec::new(),
            last_output: None,
        };
        harness.pump().await;
        harness.history.clear();
        harness
    }

    fn deliver(&mut self, event: AppEvent) {
        match event {
            AppEvent::StatusLineCommandOutput {
                identity,
                runtime,
                generation,
                effect,
            } => {
                self.last_output = Some((identity, runtime, generation));
                self.chat
                    .handle_status_line_command_output(identity, runtime, generation, effect);
            }
            AppEvent::StatusLineCommandTick {
                identity,
                runtime,
                epoch,
            } => {
                self.chat
                    .handle_status_line_command_tick(identity, runtime, epoch);
            }
            AppEvent::InsertHistoryCell(cell) => {
                self.history
                    .extend(cell.display_lines(120).iter().map(ToString::to_string));
            }
            _ => {}
        }
    }

    async fn pump(&mut self) {
        for _ in 0..8 {
            settle().await;
            while let Ok(event) = self.events.try_recv() {
                self.deliver(event);
            }
        }
    }

    /// Capture a genuine actor event before its widget handler consumes it.
    /// Finite yield rounds fail normally under the inert scaffold.
    async fn capture(&mut self, want_tick: bool) -> AppEvent {
        for _ in 0..8 {
            settle().await;
            while let Ok(event) = self.events.try_recv() {
                let wanted = if want_tick {
                    matches!(&event, AppEvent::StatusLineCommandTick { .. })
                } else {
                    matches!(&event, AppEvent::StatusLineCommandOutput { effect, .. }
                        if matches!(effect.display.as_ref(), Some(StatusLineCommandDisplay::Command(_))))
                };
                if wanted {
                    return event;
                }
                self.deliver(event);
            }
        }
        panic!("actual widget actor did not emit the requested command event");
    }

    async fn queued_output(&mut self, run: Started, value: &str) -> AppEvent {
        run.finish
            .send(Ok(styled(value)))
            .expect("owned runner awaits completion");
        self.capture(false).await
    }

    fn configure(&mut self, interval: u64) {
        self.chat.set_status_line_command_config(command(interval));
        self.redraw(80);
        self.chat.refresh_status_line();
    }

    fn redraw(&mut self, width: u16) -> Buffer {
        self.chat.on_terminal_resize(width);
        let buffer = draw(&self.chat, width);
        self.chat.pre_draw_tick();
        buffer
    }

    async fn start(&mut self) -> Started {
        self.pump().await;
        self.starts
            .try_recv()
            .expect("actual ChatWidget refresh must launch the configured command")
    }

    async fn complete(
        &mut self,
        start: Started,
        result: Result<Line<'static>, StatusLineCommandError>,
    ) {
        start
            .finish
            .send(result)
            .expect("owned runner awaits completion");
        self.pump().await;
    }

    async fn next(&mut self) -> Started {
        tokio::time::advance(SPACING).await;
        self.chat.refresh_status_line();
        self.start().await
    }

    async fn no_start(&mut self) {
        self.pump().await;
        assert!(
            matches!(
                self.starts.try_recv(),
                Err(mpsc::error::TryRecvError::Empty)
            ),
            "unexpected widget command launch"
        );
    }

    fn line(&self) -> String {
        self.chat.status_line_text().unwrap_or_default()
    }

    fn warnings(&self) -> usize {
        self.history
            .iter()
            .filter(|line| {
                line.to_lowercase().contains("status") && line.to_lowercase().contains("command")
            })
            .count()
    }
}

fn turn(id: &str, status: TurnStatus) -> Turn {
    Turn {
        id: id.into(),
        root_turn_id: None,
        items_view: TurnItemsView::Full,
        items: Vec::new(),
        status,
        error: None,
        started_at: None,
        completed_at: None,
        duration_ms: None,
    }
}

fn begin(chat: &mut ChatWidget, id: &str, replay: Option<ReplayKind>) {
    chat.handle_server_notification(
        ServerNotification::TurnStarted(TurnStartedNotification {
            thread_id: chat.thread_id.unwrap().to_string(),
            turn: turn(id, TurnStatus::InProgress),
        }),
        replay,
    );
}

fn end(chat: &mut ChatWidget, id: &str, status: TurnStatus, replay: Option<ReplayKind>) {
    chat.handle_server_notification(
        ServerNotification::TurnCompleted(TurnCompletedNotification {
            thread_id: chat.thread_id.unwrap().to_string(),
            turn: turn(id, status),
        }),
        replay,
    );
}

fn compaction(chat: &mut ChatWidget, id: &str, completed: bool, replay: Option<ReplayKind>) {
    let item = ThreadItem::ContextCompaction { id: id.into() };
    let thread_id = chat.thread_id.unwrap().to_string();
    let event = if completed {
        ServerNotification::ItemCompleted(ItemCompletedNotification {
            thread_id,
            turn_id: "live".into(),
            completed_at_ms: 0,
            item,
        })
    } else {
        ServerNotification::ItemStarted(ItemStartedNotification {
            thread_id,
            turn_id: "live".into(),
            started_at_ms: 0,
            item,
        })
    };
    chat.handle_server_notification(event, replay);
}

fn tokens(chat: &mut ChatWidget, input: i64, output: i64) {
    let usage = TokenUsage {
        input_tokens: input,
        cached_input_tokens: input / 2,
        output_tokens: output,
        reasoning_output_tokens: output / 2,
        total_tokens: input + output,
    };
    chat.set_token_info(Some(TokenUsageInfo {
        total_token_usage: usage.clone(),
        last_token_usage: usage,
        model_context_window: Some(100_000),
    }));
}

fn resume(chat: &mut ChatWidget) {
    let cwd = chat.config.cwd.clone();
    chat.handle_thread_session_quiet(crate::session_state::ThreadSessionState {
        daybreak_enabled: false,
        windows_sandbox_host: crate::app::WindowsSandboxHost::Local,
        thread_id: chat.thread_id.unwrap(),
        forked_from_id: None,
        fork_parent_title: None,
        thread_name: Some("Synthetic resumed thread".into()),
        model: chat.current_model().into(),
        model_provider_id: "openai".into(),
        service_tier: None,
        approval_policy: codex_app_server_protocol::AskForApproval::Never,
        approvals_reviewer: codex_protocol::config_types::ApprovalsReviewer::User,
        permission_profile: codex_protocol::models::PermissionProfile::read_only(),
        active_permission_profile: None,
        cwd: cwd.clone(),
        runtime_workspace_roots: vec![cwd],
        instruction_source_paths: Vec::new(),
        reasoning_effort: None,
        collaboration_mode: None,
        message_history: None,
        network_proxy: None,
        rollout_path: None,
    });
}

fn failures() -> Vec<StatusLineCommandError> {
    vec![
        StatusLineCommandError::Unsupported,
        StatusLineCommandError::InvalidCommand,
        StatusLineCommandError::JobCreate,
        StatusLineCommandError::Spawn,
        StatusLineCommandError::JobAssign,
        StatusLineCommandError::Resume,
        StatusLineCommandError::StdinWrite,
        StatusLineCommandError::StdoutRead,
        StatusLineCommandError::OutputCap,
        StatusLineCommandError::Wait,
        StatusLineCommandError::ExitFailure,
        StatusLineCommandError::EmptyOutput,
        StatusLineCommandError::Cancelled,
        StatusLineCommandError::RunnerJoin,
        StatusLineCommandError::Cleanup {
            primary: None,
            terminate: Some(std::io::Error::other("synthetic cleanup")),
            reap: None,
            timed_out: false,
        },
    ]
}

#[tokio::test(start_paused = true)]
async fn no_command_preserves_builtin_footer() {
    let mut h = Harness::new().await;
    let expected = h.line();
    assert_eq!(expected, h.chat.model_display_name());
    let before = draw(&h.chat, 80);
    h.chat.refresh_status_line();
    tokio::time::advance(Duration::from_secs(60)).await;
    h.no_start().await;
    assert_eq!(h.line(), expected);
    assert_eq!(draw(&h.chat, 80), before);
    assert_eq!(h.warnings(), 0);
}

#[tokio::test(start_paused = true)]
async fn success_replaces_footer_with_sgr_styles() {
    let mut h = Harness::new().await;
    h.configure(0);
    let first = h.start().await;
    h.chat
        .set_status_line_hyperlink(Some("https://example.invalid/synthetic-pr".into()));
    h.complete(
        first,
        Ok(styled("\x1b[1;4;38;5;196mRED\x1b[0m \x1b[38;2;1;2;3mRGB")),
    )
    .await;
    assert_eq!(h.line(), "RED RGB");
    let buffer = draw(&h.chat, 80);
    assert!(!text(&buffer).contains("https://example.invalid/synthetic-pr"));
    assert!(buffer.content.iter().any(|cell| cell.symbol() == "R"
        && cell.fg == Color::Indexed(196)
        && cell.modifier.contains(Modifier::BOLD)));
    assert!(
        buffer
            .content
            .iter()
            .any(|cell| cell.symbol() == "G" && cell.fg == Color::Rgb(1, 2, 3))
    );
}

#[tokio::test(start_paused = true)]
async fn command_works_with_empty_builtin_items() {
    let mut h = Harness::new().await;
    h.chat.local_settings.tui.status_line = Some(Vec::new());
    h.configure(0);
    let first = h.start().await;
    h.complete(first, Ok(styled("command only"))).await;
    assert!(text(&draw(&h.chat, 80)).contains("command only"));
    h.chat.set_status_line_command_config(Default::default());
    h.pump().await;
    assert_eq!(h.chat.status_line_text(), None);
}

#[tokio::test(start_paused = true)]
async fn failures_restore_builtin_and_warn_once() {
    for (error, repeated) in failures().into_iter().zip(failures()) {
        let mut h = Harness::new().await;
        let builtin = h.line();
        h.configure(0);
        let first = h.start().await;
        let blocks_cleanup = matches!(
            &error,
            StatusLineCommandError::RunnerJoin | StatusLineCommandError::Cleanup { .. }
        );
        h.complete(first, Err(error)).await;
        assert_eq!(h.line(), builtin);
        assert_eq!(h.warnings(), 1);
        if blocks_cleanup {
            h.chat.refresh_status_line();
            tokio::time::advance(SPACING).await;
            h.no_start().await;
        } else {
            let next = h.next().await;
            h.complete(next, Err(repeated)).await;
        }
        assert_eq!(h.warnings(), 1);
        assert!(text(&draw(&h.chat, 80)).contains(&builtin));
    }
}

#[tokio::test(start_paused = true)]
async fn timeout_retains_only_same_runtime_last_good() {
    let mut h = Harness::new().await;
    let builtin = h.line();
    h.configure(0);
    let first = h.start().await;
    h.complete(first, Err(StatusLineCommandError::Timeout))
        .await;
    assert_eq!(h.line(), builtin);
    let next = h.next().await;
    h.complete(next, Ok(styled("last good"))).await;
    let next = h.next().await;
    h.complete(next, Err(StatusLineCommandError::Timeout)).await;
    assert_eq!(h.line(), "last good");
    resume(&mut h.chat);
    let next = h.next().await;
    h.complete(next, Err(StatusLineCommandError::Timeout)).await;
    assert_ne!(h.line(), "last good");
}

#[tokio::test(start_paused = true)]
async fn non_timeout_failure_never_retains_last_good() {
    for error in failures() {
        let mut h = Harness::new().await;
        let builtin = h.line();
        h.configure(0);
        let first = h.start().await;
        h.complete(first, Ok(styled("old success"))).await;
        let next = h.next().await;
        h.complete(next, Err(error)).await;
        assert_eq!(h.line(), builtin);
    }
}

#[tokio::test(start_paused = true)]
async fn warning_dedupe_resets_per_session() {
    let mut h = Harness::new().await;
    h.configure(0);
    for index in 0..3 {
        let run = if index == 0 {
            h.start().await
        } else {
            h.next().await
        };
        h.complete(run, Err(StatusLineCommandError::Spawn)).await;
    }
    assert_eq!(h.warnings(), 1);
    let run = h.next().await;
    h.complete(run, Err(StatusLineCommandError::EmptyOutput))
        .await;
    assert_eq!(h.warnings(), 2);
    h.configure(1);
    let run = h.next().await;
    h.complete(run, Err(StatusLineCommandError::Spawn)).await;
    assert_eq!(h.warnings(), 2);
    resume(&mut h.chat);
    let run = h.next().await;
    h.complete(run, Err(StatusLineCommandError::Spawn)).await;
    assert_eq!(h.warnings(), 3);
}

#[tokio::test(start_paused = true)]
async fn dirty_refreshes_coalesce_and_respect_300ms() {
    let mut h = Harness::new().await;
    h.configure(0);
    let first = h.start().await;
    let first_at = first.at;
    for index in 1..10 {
        h.chat.thread_name = Some(format!("revision {index}"));
        h.chat.refresh_status_line();
    }
    h.no_start().await;
    h.complete(first, Ok(styled("first"))).await;
    tokio::time::advance(Duration::from_millis(299)).await;
    h.no_start().await;
    tokio::time::advance(Duration::from_millis(1)).await;
    let second = h.start().await;
    assert!(second.at.duration_since(first_at) >= SPACING);
    assert_eq!(second.request.payload["codex"]["thread_name"], "revision 9");
    h.complete(second, Ok(styled("second"))).await;
    tokio::time::advance(Duration::from_secs(2)).await;
    h.no_start().await;
}

#[tokio::test(start_paused = true)]
async fn periodic_tick_captures_fresh_widget_state() {
    let mut h = Harness::new().await;
    h.configure(2);
    let first = h.start().await;
    h.complete(first, Ok(styled("first"))).await;
    h.chat.thread_name = Some("changed between ticks".into());
    tokens(&mut h.chat, 500, 90);
    tokio::time::advance(Duration::from_secs(2)).await;
    let next = h.start().await;
    assert_eq!(
        next.request.payload["codex"]["thread_name"],
        "changed between ticks"
    );
    assert_eq!(next.request.payload["codex"]["tokens"]["input"], 500);
    h.complete(next, Ok(styled("fresh"))).await;
}

#[tokio::test(start_paused = true)]
async fn zero_interval_disables_periodic_ticks() {
    let mut h = Harness::new().await;
    h.configure(0);
    let first = h.start().await;
    h.complete(first, Ok(styled("once"))).await;
    tokio::time::advance(Duration::from_secs(100)).await;
    h.no_start().await;
    let next = h.next().await;
    h.complete(next, Ok(styled("manual"))).await;
    assert_eq!(h.line(), "manual");
}

#[tokio::test(start_paused = true)]
async fn interval_replacement_rejects_old_tick() {
    let mut h = Harness::new().await;
    h.configure(2);
    let first = h.start().await;
    h.complete(first, Ok(styled("first"))).await;
    tokio::time::advance(Duration::from_secs(2)).await;
    let old_tick = h.capture(true).await;
    h.configure(7);
    tokio::time::advance(SPACING).await;
    let replacement = h.start().await;
    h.complete(replacement, Ok(styled("replacement"))).await;
    h.deliver(old_tick);
    tokio::time::advance(Duration::from_secs(2)).await;
    h.no_start().await;
    tokio::time::advance(Duration::from_secs(5)).await;
    let next = h.start().await;
    h.complete(next, Ok(styled("new timer"))).await;
}

#[tokio::test(start_paused = true)]
async fn config_change_waits_for_cleanup() {
    let mut h = Harness::new().await;
    h.configure(0);
    let mut first = h.start().await;
    let old = h.chat.status_line_command_identity();
    let mut replacement = command(0);
    replacement.config.as_mut().unwrap().command = "replacement".into();
    replacement.config.as_mut().unwrap().timeout_ms = 750;
    h.chat.set_status_line_command_config(replacement);
    assert_ne!(
        h.chat.status_line_command_identity(),
        old,
        "invalidate synchronously"
    );
    h.pump().await;
    assert_eq!(first.cancelled.try_recv(), Ok(()));
    tokio::time::advance(SPACING).await;
    h.no_start().await;
    first.cleanup.send(()).unwrap();
    let next = h.start().await;
    assert_eq!(next.request.config.command, "replacement");
    assert_eq!(next.request.config.timeout_ms, 750);
    h.complete(next, Ok(styled("replacement"))).await;
}

#[tokio::test(start_paused = true)]
async fn disable_cancels_pending_delay() {
    let mut h = Harness::new().await;
    h.configure(0);
    let first = h.start().await;
    h.complete(first, Ok(styled("first"))).await;
    h.chat.refresh_status_line();
    h.chat.set_status_line_command_config(Default::default());
    tokio::time::advance(Duration::from_secs(20)).await;
    h.no_start().await;
    assert_ne!(h.line(), "first");
}

#[tokio::test(start_paused = true)]
async fn session_reset_cancels_pending_delay() {
    let mut h = Harness::new().await;
    h.configure(0);
    let first = h.start().await;
    h.complete(first, Ok(styled("old session"))).await;
    h.chat.thread_name = Some("obsolete".into());
    h.chat.refresh_status_line();
    resume(&mut h.chat);
    tokio::time::advance(SPACING).await;
    let next = h.start().await;
    assert_ne!(next.request.payload["codex"]["thread_name"], "obsolete");
    h.complete(next, Ok(styled("new session"))).await;
    h.no_start().await;
}

#[tokio::test(start_paused = true)]
async fn stale_output_is_inert_before_actor_update() {
    for transition in ["config", "same-thread-resume", "disable"] {
        let mut h = Harness::new().await;
        h.configure(0);
        let run = h.start().await;
        let old = h.chat.status_line_command_identity();
        let queued = h.queued_output(run, "previous session output").await;
        match transition {
            "config" => h.chat.set_status_line_command_config(command(3)),
            "same-thread-resume" => resume(&mut h.chat),
            "disable" => h.chat.set_status_line_command_config(Default::default()),
            _ => unreachable!(),
        }
        assert_ne!(h.chat.status_line_command_identity(), old, "{transition}");
        let builtin = h.line();
        // Real old event, queued before the synchronous transition. No actor
        // pumping occurs between invalidation and delivery of this callback.
        h.deliver(queued);
        assert_eq!(h.line(), builtin, "queued previous identity: {transition}");
        if transition == "disable" {
            h.configure(0);
        }
        let run = h.next().await;
        let current = h.queued_output(run, "current session output").await;
        h.deliver(with_identity(&current, old));
        assert_eq!(
            h.line(),
            builtin,
            "valid runtime plus previous UI identity: {transition}"
        );
        // Deliver the untouched original only AFTER the negative case. Its
        // runtime/generation must be accepted, proving identity caused rejection.
        h.deliver(current);
        assert_eq!(
            h.line(),
            "current session output",
            "positive control: {transition}"
        );
        assert_eq!(h.warnings(), 0);
    }
}

#[tokio::test(start_paused = true)]
async fn stale_tick_is_inert_before_actor_update() {
    for transition in ["config", "same-thread-resume", "disable"] {
        let mut h = Harness::new().await;
        h.configure(1);
        let run = h.start().await;
        h.complete(run, Ok(styled("previous"))).await;
        let old = h.chat.status_line_command_identity();
        tokio::time::advance(Duration::from_secs(1)).await;
        let queued = h.capture(true).await;
        match transition {
            "config" => h.chat.set_status_line_command_config(command(2)),
            "same-thread-resume" => resume(&mut h.chat),
            "disable" => h.chat.set_status_line_command_config(Default::default()),
            _ => unreachable!(),
        }
        assert_ne!(h.chat.status_line_command_identity(), old, "{transition}");
        h.deliver(queued);
        if transition == "disable" {
            h.no_start().await;
            h.configure(1);
        }
        let replacement = h.start().await;
        h.complete(replacement, Ok(styled("current"))).await;
        let interval = if transition == "config" { 2 } else { 1 };
        tokio::time::advance(Duration::from_secs(interval)).await;
        let current = h.capture(true).await;
        h.chat.thread_name = Some(format!("fresh {transition}"));
        h.deliver(with_identity(&current, old));
        h.no_start().await;
        h.deliver(current);
        let refreshed = h.start().await;
        assert_eq!(
            refreshed.request.payload["codex"]["thread_name"],
            format!("fresh {transition}")
        );
        h.complete(refreshed, Ok(styled("positive tick control")))
            .await;
    }
}

#[tokio::test(start_paused = true)]
async fn duplicate_and_out_of_order_output_is_inert() {
    let mut h = Harness::new().await;
    h.configure(0);
    let first = h.start().await;
    h.complete(first, Ok(styled("accepted"))).await;
    let (identity, runtime, generation) = h.last_output.expect("actual actor output metadata");
    for old_generation in [generation.saturating_sub(1), generation] {
        h.deliver(AppEvent::StatusLineCommandOutput {
            identity,
            runtime,
            generation: old_generation,
            effect: StatusLineCommandEffect {
                display: Some(StatusLineCommandDisplay::Command(styled("replayed output"))),
                ..Default::default()
            },
        });
    }
    assert_eq!(h.line(), "accepted");
    assert_eq!(h.warnings(), 0);
}

#[tokio::test(start_paused = true)]
async fn replacement_widget_rejects_previous_owner_events() {
    let mut old = Harness::new().await;
    let mut next = Harness::new().await;
    old.configure(1);
    next.configure(1);
    assert_eq!(old.chat.thread_id, next.chat.thread_id);
    assert_ne!(
        old.chat.status_line_command_identity(),
        next.chat.status_line_command_identity()
    );
    let old_identity = old.chat.status_line_command_identity();
    let old_run = old.start().await;
    let old_output = old.queued_output(old_run, "previous owner").await;
    let next_run = next.start().await;
    let current = next.queued_output(next_run, "replacement owner").await;
    let builtin = next.line();
    // Route the genuine previous owner's callback through the replacement's
    // app channel, as occurs when App changes the visible widget owner.
    next.chat.app_event_tx.send(old_output);
    next.pump().await;
    assert_eq!(next.line(), builtin);
    next.deliver(with_identity(&current, old_identity));
    assert_eq!(next.line(), builtin);
    next.deliver(current);
    assert_eq!(next.line(), "replacement owner");
    tokio::time::advance(Duration::from_secs(1)).await;
    let old_tick = old.capture(true).await;
    let current_tick = next.capture(true).await;
    next.chat.app_event_tx.send(old_tick);
    next.pump().await;
    next.deliver(with_identity(&current_tick, old_identity));
    next.no_start().await;
    next.deliver(current_tick);
    let refreshed = next.start().await;
    next.complete(refreshed, Ok(styled("replacement tick control")))
        .await;
    assert_eq!(next.line(), "replacement tick control");
}

#[tokio::test(start_paused = true)]
async fn shutdown_awaits_cleanup_and_stops_work() {
    let mut h = Harness::new().await;
    h.configure(1);
    let mut first = h.start().await;
    h.chat.refresh_status_line();
    let shutdown = h.chat.shutdown_status_line_command();
    tokio::pin!(shutdown);
    tokio::select! {
        _ = &mut shutdown => panic!("shutdown returned before runner cleanup acknowledgement"),
        _ = settle() => {}
    }
    assert_eq!(first.cancelled.try_recv(), Ok(()));
    first.cleanup.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .expect("shutdown must finish after cleanup acknowledgement");
    tokio::time::advance(Duration::from_secs(10)).await;
    // The borrow from the pinned shutdown future ends before pumping the widget.
    assert!(h.starts.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn drop_cancels_owned_runner() {
    let mut h = Harness::new().await;
    h.configure(1);
    let mut first = h.start().await;
    drop(h.chat);
    settle().await;
    assert_eq!(first.cancelled.try_recv(), Ok(()));
    first.cleanup.send(()).unwrap();
    settle().await;
    assert!(h.starts.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn width_uses_inline_footer_budget() {
    let mut budgets = Vec::new();
    for warning_count in [0, 3] {
        let mut h = Harness::new().await;
        let options = crate::bottom_pane::ComposerRenderOptions {
            warning_count,
            ..Default::default()
        };
        let expected_budget = footer_budget(&mut h.chat, 40, options);
        assert!(expected_budget > 0);
        budgets.push(expected_budget);
        h.configure(0);
        draw_options(&h.chat, 40, options);
        h.chat.note_rendered_width(40);
        h.chat.pre_draw_tick();
        let first = h.start().await;
        assert_eq!(
            first.request.width, expected_budget,
            "independent inline oracle; warnings={warning_count}"
        );
        h.complete(first, Ok(styled(&"Z".repeat(expected_budget))))
            .await;
        let buffer = draw_options(&h.chat, 40, options);
        assert_eq!(
            buffer
                .content
                .iter()
                .filter(|cell| cell.symbol() == "Z")
                .count(),
            expected_budget
        );
        assert!(!text(&buffer).contains('\u{2026}'));
        if warning_count > 0 {
            assert!(text(&buffer).contains('3'));
        }
    }
    assert!(
        budgets[1] < budgets[0],
        "real warning reservation must reduce the command budget"
    );
}

#[tokio::test(start_paused = true)]
async fn width_uses_persistent_footer_budget() {
    let mut budgets = Vec::new();
    for label in [None, Some("Worker")] {
        let mut h = Harness::new().await;
        h.chat.set_active_agent_label(label.map(str::to_owned));
        let options = crate::bottom_pane::ComposerRenderOptions {
            separate_status_line: true,
            ..Default::default()
        };
        let expected_budget = footer_budget(&mut h.chat, 48, options);
        assert!(expected_budget > 0);
        budgets.push(expected_budget);
        h.configure(0);
        draw_options(&h.chat, 48, options);
        h.chat.note_rendered_width(48);
        h.chat.pre_draw_tick();
        let first = h.start().await;
        assert_eq!(
            first.request.width, expected_budget,
            "independent persistent oracle; agent={label:?}"
        );
        h.complete(first, Ok(styled(&"Z".repeat(expected_budget))))
            .await;
        let buffer = draw_options(&h.chat, 48, options);
        assert_eq!(
            buffer
                .content
                .iter()
                .filter(|cell| cell.symbol() == "Z")
                .count(),
            expected_budget
        );
        assert!(!text(&buffer).contains('\u{2026}'));
        if let Some(label) = label {
            assert!(text(&buffer).contains(label));
        }
    }
    assert!(
        budgets[1] < budgets[0],
        "real agent suffix must reduce command budget"
    );
}

#[tokio::test(start_paused = true)]
async fn resize_refits_pending_result_and_refreshes() {
    let mut oracle = Harness::new().await;
    let resized_budget = footer_budget(&mut oracle.chat, 24, Default::default());
    assert!(resized_budget > 0);
    let mut h = Harness::new().await;
    h.configure(0);
    let first = h.start().await;
    let old_width = first.request.width;
    h.redraw(24);
    h.complete(first, Ok(styled(&"\u{754c}".repeat(60)))).await;
    assert!(unicode_width::UnicodeWidthStr::width(h.line().as_str()) <= resized_budget);
    tokio::time::advance(SPACING).await;
    let next = h.start().await;
    assert!(next.request.width < old_width);
    assert_eq!(
        next.request.width, resized_budget,
        "independent resized footer oracle"
    );
    h.complete(next, Ok(styled("narrow"))).await;
}

#[tokio::test(start_paused = true)]
async fn unicode_and_zero_width_are_safe() {
    let mut h = Harness::new().await;
    h.configure(0);
    let first = h.start().await;
    let expected = "\u{1f469}\u{200d}\u{1f4bb} \u{1f1f9}\u{1f1ed} e\u{301} \u{754c} \u{e0b0}";
    h.complete(first, Ok(styled(&format!("\x1b[32m{expected}"))))
        .await;
    assert_eq!(h.line(), expected);
    h.chat.on_terminal_resize(0);
    h.chat.refresh_status_line();
    h.pump().await;
    assert!(
        h.chat
            .status_line_text()
            .is_none_or(|line| !line.contains('\u{1f469}'))
    );
    h.no_start().await;
}

#[tokio::test(start_paused = true)]
async fn payload_reads_actual_widget_state() {
    let mut h = Harness::new().await;
    h.chat.thread_name = Some("Synthetic thread".into());
    h.chat
        .set_reasoning_effort(Some(ReasoningEffortConfig::High));
    h.chat.rate_limit_snapshots_by_limit_id.insert(
        "codex".into(),
        crate::status::RateLimitSnapshotDisplay {
            limit_name: "codex".into(),
            normal_model_slug: None,
            captured_at: chrono::Local::now(),
            primary: Some(crate::status::RateLimitWindowDisplay {
                used_percent: 12.5,
                resets_at: Some("human reset remains unchanged".into()),
                resets_at_unix: Some(1_791_544_719),
                window_minutes: Some(300),
            }),
            secondary: Some(crate::status::RateLimitWindowDisplay {
                used_percent: 25.0,
                resets_at: None,
                resets_at_unix: Some(1_791_600_000),
                window_minutes: Some(10_080),
            }),
            credits: None,
            individual_limit: None,
        },
    );
    tokens(&mut h.chat, 400, 90);
    h.configure(0);
    let first = h.start().await;
    let p = &first.request.payload;
    assert_eq!(p["hook_event_name"], "Status");
    assert_eq!(p["session_id"], h.chat.thread_id.unwrap().to_string());
    assert_eq!(p["cwd"], h.chat.config.cwd.display().to_string());
    assert_eq!(p["model"]["id"], h.chat.current_model());
    assert_eq!(p["model"]["display_name"], h.chat.model_display_name());
    assert_eq!(p["effort"]["level"], "high");
    assert_eq!(p["version"], CODEX_CLI_VERSION);
    assert!(p["output_style"]["name"].is_string());
    assert!(p["codex"]["approval_mode"].is_string());
    assert!(p["codex"]["sandbox"].is_string());
    assert_eq!(p["workspace"]["current_dir"], p["cwd"]);
    assert_eq!(p["workspace"]["project_dir"], p["cwd"]);
    assert_eq!(p["rate_limits"]["five_hour"]["used_percentage"], 12.5);
    assert_eq!(p["rate_limits"]["five_hour"]["resets_at"], 1_791_544_719);
    assert_eq!(p["rate_limits"]["seven_day"]["used_percentage"], 25.0);
    assert_eq!(p["codex"]["rate_limits"].as_array().unwrap().len(), 2);
    assert_eq!(
        h.chat.rate_limit_snapshots_by_limit_id["codex"]
            .primary
            .as_ref()
            .unwrap()
            .resets_at
            .as_deref(),
        Some("human reset remains unchanged")
    );
    assert_eq!(p["codex"]["thread_name"], "Synthetic thread");
    assert_eq!(p["codex"]["tokens"]["input"], 400);
    assert_eq!(p["codex"]["tokens"]["cached_input"], 200);
    assert_eq!(p["context_window"]["current_usage"]["input_tokens"], 200);
    assert_eq!(
        p["context_window"]["current_usage"]["cache_read_input_tokens"],
        200
    );
    assert_eq!(p["codex"]["schema"], 1);
    assert!(p.get("transcript_path").is_none());
    assert!(p["cost"].get("total_cost_usd").is_none());
    h.complete(first, Ok(styled("payload"))).await;
    h.chat
        .rate_limit_snapshots_by_limit_id
        .get_mut("codex")
        .unwrap()
        .primary
        .as_mut()
        .unwrap()
        .window_minutes = Some(299);
    let nonstandard = h.chat.status_line_command_payload();
    assert!(nonstandard["rate_limits"].get("five_hour").is_none());
    assert_eq!(
        nonstandard["codex"]["rate_limits"][0]["window_minutes"],
        299
    );
    h.chat.set_token_info(None);
    let missing = h.chat.status_line_command_payload();
    assert!(missing["codex"].get("tokens").is_none());
    assert!(missing["context_window"].get("used_percentage").is_none());
}

#[tokio::test(start_paused = true)]
async fn running_turn_includes_tool_and_approval_waits() {
    let mut h = Harness::new().await;
    tokens(&mut h.chat, 100, 10);
    begin(&mut h.chat, "live", None);
    tokio::time::advance(Duration::from_secs(2)).await;
    let tool: ThreadItem = serde_json::from_value(json!({
        "type": "mcpToolCall", "id": "tool-wait", "server": "synthetic", "tool": "wait",
        "status": "inProgress", "arguments": {}, "result": null, "durationMs": null
    }))
    .expect("synthetic tool notification");
    h.chat.handle_server_notification(
        ServerNotification::ItemStarted(ItemStartedNotification {
            thread_id: h.chat.thread_id.unwrap().to_string(),
            turn_id: "live".into(),
            started_at_ms: 0,
            item: tool,
        }),
        None,
    );
    tokio::time::advance(Duration::from_secs(3)).await;
    h.chat.on_exec_approval_request(
        "approval".into(),
        crate::approval_events::ExecApprovalRequestEvent {
            kind: Default::default(),
            call_id: "call".into(),
            approval_id: Some("approval".into()),
            turn_id: "live".into(),
            environment_id: None,
            command: vec!["echo".into(), "synthetic".into()],
            cwd: h.chat.config.cwd.clone(),
            reason: None,
            network_approval_context: None,
            proposed_execpolicy_amendment: None,
            proposed_network_policy_amendments: None,
            additional_permissions: None,
            available_decisions: None,
        },
    );
    tokio::time::advance(Duration::from_secs(4)).await;
    let snapshot = h.chat.status_line_command_payload();
    assert_eq!(snapshot["codex"]["turn_wall_duration_ms"], 9_000);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(
        h.chat.status_line_command_payload()["codex"]["turn_wall_duration_ms"],
        10_000
    );
}

#[tokio::test(start_paused = true)]
async fn completion_counts_matching_live_turn_once() {
    for status in [
        TurnStatus::Completed,
        TurnStatus::Interrupted,
        TurnStatus::Failed,
    ] {
        let mut h = Harness::new().await;
        tokens(&mut h.chat, 100, 10);
        begin(&mut h.chat, "live", None);
        tokio::time::advance(Duration::from_secs(2)).await;
        end(&mut h.chat, "other", TurnStatus::Completed, None);
        end(
            &mut h.chat,
            "live",
            TurnStatus::Completed,
            Some(ReplayKind::ThreadSnapshot),
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        end(&mut h.chat, "live", status, None);
        end(&mut h.chat, "live", TurnStatus::Completed, None);
        tokio::time::advance(Duration::from_secs(10)).await;
        assert_eq!(
            h.chat.status_line_command_payload()["codex"]["turn_wall_duration_ms"],
            3_000
        );
    }
}

#[tokio::test(start_paused = true)]
async fn failed_start_and_replay_add_no_time() {
    let mut h = Harness::new().await;
    tokens(&mut h.chat, 100, 10);
    h.chat.input_queue.user_turn_pending_start = true;
    assert!(
        h.chat
            .handle_turn_start_rejection("Synthetic rejected start".into())
    );
    for replay in [
        ReplayKind::ResumeInitialMessages,
        ReplayKind::ThreadSnapshot,
    ] {
        begin(&mut h.chat, "replay", Some(replay));
        tokio::time::advance(Duration::from_secs(5)).await;
        end(&mut h.chat, "replay", TurnStatus::Completed, Some(replay));
    }
    h.chat.replay_thread_turns(
        vec![turn("old-running", TurnStatus::InProgress)],
        ReplayKind::ThreadSnapshot,
    );
    tokio::time::advance(Duration::from_secs(5)).await;
    assert_eq!(
        h.chat.status_line_command_payload()["codex"]["turn_wall_duration_ms"],
        0
    );
}

#[tokio::test(start_paused = true)]
async fn late_baseline_pairs_tokens_and_active_time() {
    let mut h = Harness::new().await;
    begin(&mut h.chat, "live", None);
    tokio::time::advance(Duration::from_secs(5)).await;
    assert!(
        h.chat.status_line_command_payload()["codex"]
            .get("speed_tokens")
            .is_none()
    );
    tokens(&mut h.chat, 100, 10);
    tokio::time::advance(Duration::from_secs(2)).await;
    tokens(&mut h.chat, 140, 30);
    let payload = h.chat.status_line_command_payload();
    assert_eq!(payload["codex"]["turn_wall_duration_ms"], 2_000);
    assert_eq!(payload["codex"]["speed_tokens"]["total"], 60);
    assert_eq!(payload["cost"]["total_duration_ms"], 7_000);
}

#[tokio::test(start_paused = true)]
async fn token_reset_rebaselines_without_resetting_session() {
    let mut h = Harness::new().await;
    tokens(&mut h.chat, 500, 100);
    begin(&mut h.chat, "live", None);
    tokio::time::advance(Duration::from_secs(5)).await;
    tokens(&mut h.chat, 10, 2);
    tokio::time::advance(Duration::from_secs(3)).await;
    tokens(&mut h.chat, 30, 8);
    let payload = h.chat.status_line_command_payload();
    assert_eq!(payload["codex"]["turn_wall_duration_ms"], 3_000);
    assert_eq!(payload["codex"]["speed_tokens"]["total"], 26);
    assert_eq!(payload["codex"]["tokens"]["total"], 38);
    assert_eq!(payload["cost"]["total_duration_ms"], 8_000);
}

#[tokio::test(start_paused = true)]
async fn resume_resets_launch_local_state() {
    let mut h = Harness::new().await;
    tokens(&mut h.chat, 100, 10);
    begin(&mut h.chat, "live", None);
    compaction(&mut h.chat, "compact", false, None);
    tokio::time::advance(Duration::from_secs(5)).await;
    let old_identity = h.chat.status_line_command_identity();
    resume(&mut h.chat);
    assert_ne!(h.chat.status_line_command_identity(), old_identity);
    let payload = h.chat.status_line_command_payload();
    assert_eq!(payload["cost"]["total_duration_ms"], 0);
    assert_eq!(payload["codex"]["turn_wall_duration_ms"], 0);
    assert_eq!(payload["codex"]["compactions"], 0);
    assert!(payload["codex"].get("speed_tokens").is_none());
    tokens(&mut h.chat, 100, 10);
    begin(&mut h.chat, "resumed-live", None);
    tokio::time::advance(Duration::from_secs(2)).await;
    tokens(&mut h.chat, 140, 30);
    let later = h.chat.status_line_command_payload();
    assert_eq!(later["codex"]["turn_wall_duration_ms"], 2_000);
    assert_eq!(later["codex"]["speed_tokens"]["total"], 60);
}

#[tokio::test(start_paused = true)]
async fn compaction_counts_unique_live_starts() {
    let mut h = Harness::new().await;
    compaction(&mut h.chat, "without-turn", false, None);
    begin(&mut h.chat, "live", None);
    for _ in 0..2 {
        compaction(&mut h.chat, "one", false, None);
    }
    for _ in 0..2 {
        compaction(&mut h.chat, "one", true, None);
    }
    compaction(&mut h.chat, "old", false, Some(ReplayKind::ThreadSnapshot));
    compaction(&mut h.chat, "old", true, Some(ReplayKind::ThreadSnapshot));
    compaction(&mut h.chat, "one", false, None);
    compaction(&mut h.chat, "two", false, None);
    assert_eq!(
        h.chat.status_line_command_payload()["codex"]["compactions"],
        2
    );
}

#[tokio::test(start_paused = true)]
async fn trusted_config_warning_is_visible_once() {
    let mut h = Harness::new().await;
    let directory = tempfile::tempdir().unwrap();
    let path =
        codex_utils_absolute_path::AbsolutePathBuf::from_absolute_path(directory.path()).unwrap();
    let layers = codex_config::ConfigLayerStack::new(
        vec![
            codex_config::ConfigLayerEntry::new(
                codex_config::ConfigLayerSource::User {
                    file: path.join("config.toml"),
                    profile: None,
                },
                toml::from_str("[tui.status_line_command]\ncommand = 7\n").unwrap(),
            ),
            codex_config::ConfigLayerEntry::new(
                codex_config::ConfigLayerSource::Project {
                    dot_codex_folder: path.join("project/.codex"),
                },
                toml::from_str("[tui.status_line_command]\ncommand = 'untrusted'\n").unwrap(),
            ),
        ],
        codex_config::ConfigRequirements::default(),
        codex_config::ConfigRequirementsToml::default(),
    )
    .unwrap();
    let resolution = StatusLineCommandResolution::from_layers(&layers);
    assert!(resolution.config.is_none());
    assert_eq!(resolution.warnings.len(), 2);
    h.chat.set_status_line_command_config(resolution);
    h.chat.refresh_status_line();
    h.chat.refresh_status_line();
    h.no_start().await;
    assert_eq!(h.warnings(), 2);
}

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        TerminateProcess, WaitForSingleObject,
    };

    struct ExactProcess(HANDLE);

    impl ExactProcess {
        fn from_record(path: &std::path::Path) -> Option<Self> {
            let record = std::fs::read_to_string(path).ok()?;
            let (pid, ticks) = record.trim().split_once(',')?;
            let pid = pid.parse().ok()?;
            let expected: u64 = ticks.parse().ok()?;
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | 0x0010_0000,
                    0,
                    pid,
                )
            };
            if handle.is_null() {
                return None;
            }
            let mut created = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let mut exited = created;
            let mut kernel = created;
            let mut user = created;
            let ok = unsafe {
                GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
            };
            let actual =
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            if ok == 0 || actual != expected {
                unsafe { CloseHandle(handle) };
                return None;
            }
            Some(Self(handle))
        }

        fn is_gone(&self) -> bool {
            unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
        }

        /// Explicit checked fallback, separate from the observation that the
        /// widget itself cleaned up. A process can exit between the first poll
        /// and TerminateProcess; a signaled handle makes that race successful.
        fn cleanup(&self) -> std::io::Result<()> {
            if self.is_gone() {
                return Ok(());
            }
            let terminated = unsafe { TerminateProcess(self.0, 1) };
            let terminate_error = (terminated == 0).then(std::io::Error::last_os_error);
            let waited = unsafe { WaitForSingleObject(self.0, 5_000) };
            if waited == WAIT_OBJECT_0 {
                return Ok(());
            }
            Err(std::io::Error::other(format!(
                "exact process cleanup failed: terminate={terminate_error:?}, wait={waited}"
            )))
        }
    }

    impl Drop for ExactProcess {
        fn drop(&mut self) {
            // Never assert during unwinding. The normal test body checks both
            // cleanup Results; this fallback only records a diagnostic and
            // always attempts to close the verified handle.
            let cleanup = self.cleanup();
            let closed = unsafe { CloseHandle(self.0) };
            if let Err(error) = cleanup {
                tracing::error!(%error, "exact-process fallback cleanup failed");
            }
            if closed == 0 {
                tracing::error!(error = %std::io::Error::last_os_error(), "exact-process handle close failed");
            }
        }
    }

    #[tokio::test]
    async fn widget_shutdown_reaps_exact_windows_tree() {
        for explicit in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let root_path = directory.path().join("root.pid");
            let child_path = directory.path().join("child.pid");
            let quote = |path: &std::path::Path| {
                format!("'{}'", path.display().to_string().replace('\'', "''"))
            };
            let script = format!(
                "$p = Get-Process -Id $PID; Set-Content -LiteralPath {} -Value ($PID.ToString() + ',' + $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()); $c = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath {} -Value ($c.Id.ToString() + ',' + $c.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()); Start-Sleep -Seconds 30",
                quote(&root_path),
                quote(&child_path)
            );
            let file = directory.path().join("widget command.cmd");
            std::fs::write(&file, format!("@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"{script}\"\r\n")).unwrap();
            let (mut chat, _sender, _events, _ops) = make_chatwidget_manual_with_sender().await;
            chat.config.cwd =
                codex_utils_absolute_path::AbsolutePathBuf::from_absolute_path(directory.path())
                    .unwrap();
            chat.current_cwd = Some(directory.path().to_path_buf());
            chat.local_settings.tui.terminal_title = Some(Vec::new());
            chat.thread_id =
                Some(ThreadId::from_string("00000000-0000-0000-0000-000000000034").unwrap());
            chat.local_settings.tui.status_line = Some(vec!["model-name".into()]);
            chat.set_status_line_command_config(StatusLineCommandResolution {
                config: Some(StatusLineCommandConfig {
                    command: format!("\"{}\"", file.display()),
                    refresh_interval_secs: 0,
                    timeout_ms: 20_000,
                }),
                warnings: Vec::new(),
            });
            draw(&chat, 80);
            chat.pre_draw_tick();
            chat.refresh_status_line();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            let root = loop {
                if let Some(root) = ExactProcess::from_record(&root_path) {
                    break root;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "actual ChatWidget failed to launch its configured contained command"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            let child = loop {
                if let Some(child) = ExactProcess::from_record(&child_path) {
                    break child;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "widget command did not create descendant"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            if explicit {
                tokio::time::timeout(Duration::from_secs(5), chat.shutdown_status_line_command())
                    .await
                    .expect("widget shutdown cleanup watchdog");
            }
            drop(chat);
            let cleanup_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while (!root.is_gone() || !child.is_gone())
                && tokio::time::Instant::now() < cleanup_deadline
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let widget_reaped_tree = root.is_gone() && child.is_gone();
            // Observe widget cleanup BEFORE forcing anything, then complete
            // both fallible fallback paths before a normal test-body assertion.
            let child_cleanup = child.cleanup();
            let root_cleanup = root.cleanup();
            assert!(
                widget_reaped_tree && child_cleanup.is_ok() && root_cleanup.is_ok(),
                "widget_reaped_tree={widget_reaped_tree}; checked child cleanup={child_cleanup:?}; checked root cleanup={root_cleanup:?}"
            );
        }
    }
}

#[tokio::test(start_paused = true)]
async fn closed_input_never_launches_unseen_initial_or_same_identity_refresh() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    for same_identity_refresh in [false, true] {
        for stop in ["keep", "shutdown", "drop"] {
            let mut h = Harness::new().await;
            let starts = Arc::new(AtomicUsize::new(0));
            let observed_starts = starts.clone();
            // Count invocation, not future polling: even a launch immediately
            // followed by cancellation must remain observable. Cleanup cannot hang.
            h.chat.set_status_line_command_runner(Arc::new(move |_, _| {
                observed_starts.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(styled("observable launch")) })
            }));
            h.configure(0);
            let previous_starts = if same_identity_refresh {
                h.pump().await;
                assert_eq!(starts.load(Ordering::SeqCst), 1);
                tokio::time::advance(SPACING).await;
                let identity = h.chat.status_line_command_identity();
                h.chat.refresh_status_line();
                assert_eq!(h.chat.status_line_command_identity(), identity);
                1
            } else {
                0
            };
            // No yield after the final enabled submission: the actor has not
            // observed it when shutdown/Drop closes the watch sender.
            assert_eq!(starts.load(Ordering::SeqCst), previous_starts);
            match stop {
                "keep" => {
                    h.pump().await;
                    assert_eq!(
                        starts.load(Ordering::SeqCst),
                        previous_starts + 1,
                        "positive control: queued work must launch while input stays open"
                    );
                    assert_eq!(h.line(), "observable launch");
                }
                "shutdown" => {
                    tokio::time::timeout(
                        Duration::from_secs(5),
                        h.chat.shutdown_status_line_command(),
                    )
                    .await
                    .expect("an unseen submission must not delay shutdown");
                    h.pump().await;
                    assert_eq!(
                        starts.load(Ordering::SeqCst),
                        previous_starts,
                        "shutdown must discard unseen work; refresh={same_identity_refresh}"
                    );
                }
                "drop" => {
                    drop(h.chat);
                    settle().await;
                    assert_eq!(
                        starts.load(Ordering::SeqCst),
                        previous_starts,
                        "Drop must discard unseen work; refresh={same_identity_refresh}"
                    );
                }
                _ => unreachable!(),
            }
        }
    }
}

#[tokio::test(start_paused = true)]
async fn resize_without_draw_does_not_defer_config_or_session_cancellation() {
    for transition in ["config", "same-thread-resume"] {
        for active in [false, true] {
            let mut h = Harness::new().await;
            h.configure(0);
            let first = h.start().await;
            let old_width = first.request.width;
            let mut running = if active {
                Some(first)
            } else {
                h.complete(first, Ok(styled("old last good"))).await;
                h.chat.refresh_status_line();
                h.no_start().await; // The real scheduler now owns a 300 ms delay.
                None
            };
            let old_identity = h.chat.status_line_command_identity();
            h.chat.on_terminal_resize(40); // Deliberately do not draw yet.
            h.pump().await;
            assert_eq!(h.chat.status_line_command_identity(), old_identity);
            if let Some(run) = running.as_mut() {
                assert_eq!(
                    run.cancelled.try_recv(),
                    Err(oneshot::error::TryRecvError::Empty),
                    "resize alone must preserve the in-flight run"
                );
            }
            match transition {
                "config" => {
                    let mut replacement = command(0);
                    replacement.config.as_mut().unwrap().command =
                        "replacement after resize".into();
                    h.chat.set_status_line_command_config(replacement);
                }
                "same-thread-resume" => resume(&mut h.chat),
                _ => unreachable!(),
            }
            assert_ne!(h.chat.status_line_command_identity(), old_identity);
            h.pump().await;
            if let Some(mut run) = running.take() {
                let cancellation = run.cancelled.try_recv();
                h.no_start().await;
                // Release cleanup before asserting so either implementation can
                // unwind without leaving the injected runner waiting for an ack.
                let _ = run.cleanup.send(());
                drop(run.finish);
                assert_eq!(
                    cancellation,
                    Ok(()),
                    "old active work must cancel before a new measurement: {transition}"
                );
            }
            tokio::time::advance(SPACING).await;
            h.no_start().await;
            assert_ne!(h.line(), "old last good");

            // Positive control: once the actual renderer supplies the new width,
            // the replacement can launch through the same real scheduler.
            h.redraw(40);
            let replacement = h.start().await;
            assert!(replacement.request.width < old_width);
            match transition {
                "config" => assert_eq!(
                    replacement.request.config.command,
                    "replacement after resize"
                ),
                "same-thread-resume" => assert_eq!(
                    replacement.request.payload["codex"]["thread_name"],
                    "Synthetic resumed thread"
                ),
                _ => unreachable!(),
            }
            h.complete(replacement, Ok(styled("new measured footer")))
                .await;
            h.no_start().await;
        }
    }
}
