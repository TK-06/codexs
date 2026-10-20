//! Widget snapshots and synchronous fences around one owned scheduler actor.

use super::ChatWidget;
use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::status_line_command::StatusLineCommandDisplay;
use crate::status_line_command::StatusLineCommandEffect;
use crate::status_line_command::StatusLineCommandEvent;
use crate::status_line_command::StatusLineCommandFailureKind;
use crate::status_line_command::StatusLineCommandResolution;
#[cfg(test)]
use crate::status_line_command::StatusLineCommandRunFn;
use crate::status_line_command::StatusLineCommandRuntimeId;
use crate::status_line_command::StatusLineCommandScheduler;
use crate::status_line_command::StatusLineCommandSnapshot;
use crate::status_line_command::StatusLineCommandWarning;
use crate::status_line_command::StatusLineLaunchState;
use crate::status_line_command::StatusLinePayloadSnapshot;
use crate::status_line_command::StatusLineRateLimitWindow;
use crate::status_line_command::StatusLineTokenCounts;
use crate::status_line_command::build_status_line_payload;
use crate::status_line_command::refit_status_line_command_line;
use ratatui::text::Line;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::time::Instant;

static NEXT_WIDGET: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct StatusLineCommandIdentity {
    pub(crate) widget: u64,
    pub(crate) revision: u64,
    pub(crate) session: u64,
}

pub(super) struct StatusLineCommandWidgetState {
    identity: StatusLineCommandIdentity,
    actor: Option<Actor>,
    closed: bool,
    resolution: StatusLineCommandResolution,
    line: Option<Line<'static>>,
    accepted: Option<(StatusLineCommandRuntimeId, u64)>,
    measured: Option<(u16, usize)>,
    warned: HashSet<StatusLineCommandFailureKind>,
    config_warned: Vec<StatusLineCommandWarning>,
    launched_at: Instant,
    completed_wall_ms: i64,
    active_turn: Option<(String, Instant)>,
    seen_turns: HashSet<String>,
    compactions: HashSet<String>,
    launch: StatusLineLaunchState,
    token_session_ready: bool,
    #[cfg(test)]
    scheduler: Option<StatusLineCommandScheduler>,
    #[cfg(test)]
    events: Option<tokio::sync::mpsc::UnboundedReceiver<StatusLineCommandEvent>>,
}

impl Default for StatusLineCommandWidgetState {
    fn default() -> Self {
        Self {
            identity: StatusLineCommandIdentity {
                widget: NEXT_WIDGET.fetch_add(1, Ordering::Relaxed),
                ..Default::default()
            },
            actor: None,
            closed: false,
            resolution: Default::default(),
            line: None,
            accepted: None,
            measured: None,
            warned: HashSet::new(),
            config_warned: Vec::new(),
            launched_at: Instant::now(),
            completed_wall_ms: 0,
            active_turn: None,
            seen_turns: HashSet::new(),
            compactions: HashSet::new(),
            launch: Default::default(),
            token_session_ready: true,
            #[cfg(test)]
            scheduler: None,
            #[cfg(test)]
            events: None,
        }
    }
}

struct Submission {
    identity: StatusLineCommandIdentity,
    snapshot: StatusLineCommandSnapshot,
}

impl Submission {
    fn snapshot(&self, enabled: bool) -> StatusLineCommandSnapshot {
        StatusLineCommandSnapshot {
            // Same-thread resume must also reset the scheduler's session state.
            session_id: format!("{}:{}", self.identity.session, self.snapshot.session_id),
            config: enabled.then(|| self.snapshot.config.clone()).flatten(),
            payload: self.snapshot.payload.clone(),
            cwd: self.snapshot.cwd.clone(),
            width: self.snapshot.width,
        }
    }
}

#[derive(Default)]
struct ActorFence {
    revision: AtomicU64,
    timer_epoch: AtomicU64,
}

struct Actor {
    latest: watch::Sender<Option<Arc<Submission>>>,
    task: tokio::task::JoinHandle<()>,
    instance: u64,
    fence: Arc<ActorFence>,
}

fn publish_fence(scheduler: &StatusLineCommandScheduler, fence: &ActorFence) {
    fence
        .revision
        .store(scheduler.runtime_id().revision, Ordering::Release);
    fence
        .timer_epoch
        .store(scheduler.timer_epoch(), Ordering::Release);
}

/// Scheduler futures are always awaited to completion, including cancellation.
/// Closing the watch sender requests cleanup; the owning task is never aborted.
async fn run_actor(
    mut scheduler: StatusLineCommandScheduler,
    mut events: mpsc::UnboundedReceiver<StatusLineCommandEvent>,
    mut latest: watch::Receiver<Option<Arc<Submission>>>,
    fence: Arc<ActorFence>,
    app_events: AppEventSender,
) {
    let mut identity = None;
    loop {
        tokio::select! {
            biased;
            changed = latest.changed() => {
                if changed.is_err() { break; }
                let Some(mut submission) = latest.borrow_and_update().clone() else { continue; };
                let mut transition_warning = None;
                if identity.is_some_and(|old| old != submission.identity) {
                    // Coalesced disable/re-enable must cross a cleanup barrier,
                    // even when the final command and thread strings are equal.
                    let cleanup = scheduler.update(submission.snapshot(false)).await;
                    if let Some(kind) = cleanup.warning {
                        tracing::warn!(?kind, "status-line command transition cleanup failed");
                        transition_warning = Some((submission.identity, kind));
                    }
                    // Adopt updates received while cleanup was awaiting its runner.
                    if let Some(current) = latest.borrow_and_update().clone() { submission = current; }
                }
                // changed() can return an unseen final value after its sender
                // closes. Check closure on every path before enabling work,
                // including the initial submission and same-identity refreshes.
                if latest.has_changed().is_err() { break; }
                identity = Some(submission.identity);
                let effect = scheduler.update(submission.snapshot(true)).await;
                publish_fence(&scheduler, &fence);
                let warning = effect.warning.or_else(|| transition_warning
                    .filter(|(origin, _)| *origin == submission.identity).map(|(_, kind)| kind));
                if let Some(kind) = warning {
                    tracing::warn!(?kind, "status-line command update cleanup failed");
                    if latest.borrow().as_ref().is_some_and(|current| current.identity == submission.identity) {
                        app_events.send(AppEvent::StatusLineCommandOutput {
                            identity: submission.identity,
                            runtime: scheduler.runtime_id(),
                            generation: 0,
                            effect: StatusLineCommandEffect { warning: Some(kind), ..Default::default() },
                        });
                    }
                }
            }
            event = events.recv() => {
                let Some(event) = event else { break; };
                let metadata = match &event {
                    StatusLineCommandEvent::Finished { runtime, generation, .. } => Some((*runtime, *generation, false)),
                    StatusLineCommandEvent::Tick { runtime, epoch } => Some((*runtime, *epoch, true)),
                    StatusLineCommandEvent::DelayReady { .. } => None,
                };
                let effect = scheduler.handle_event(event).await;
                publish_fence(&scheduler, &fence);
                let Some(origin) = identity else { continue; };
                if !latest.borrow().as_ref().is_some_and(|current| current.identity == origin) { continue; }
                if let Some((runtime, sequence, tick)) = metadata {
                    if tick && effect.request_refresh {
                        app_events.send(AppEvent::StatusLineCommandTick { identity: origin, runtime, epoch: sequence });
                    } else if !tick && (effect.display.is_some() || effect.warning.is_some()) {
                        app_events.send(AppEvent::StatusLineCommandOutput { identity: origin, runtime, generation: sequence, effect });
                    }
                }
            }
        }
    }
    scheduler.shutdown().await;
    publish_fence(&scheduler, &fence);
}

impl ChatWidget {
    pub(crate) fn set_status_line_command_config(
        &mut self,
        resolution: StatusLineCommandResolution,
    ) {
        if self.status_line_command.resolution.config != resolution.config {
            self.invalidate_status_line_command();
        }
        self.status_line_command.resolution = resolution.clone();
        self.local_settings.status_line_command = resolution;
        self.refresh_status_line();
    }

    fn invalidate_status_line_command(&mut self) {
        let state = &mut self.status_line_command;
        state.identity.revision = state
            .identity
            .revision
            .checked_add(1)
            .expect("command revision overflow");
        state.line = None;
        state.accepted = None;
        state.measured = None;
    }

    pub(super) fn reset_status_line_command_session(&mut self, same_thread: bool) {
        self.invalidate_status_line_command();
        let total = same_thread
            .then(|| self.status_line_command_total_tokens())
            .flatten();
        let state = &mut self.status_line_command;
        state.identity.session = state
            .identity
            .session
            .checked_add(1)
            .expect("command session overflow");
        state.launched_at = Instant::now();
        state.completed_wall_ms = 0;
        state.active_turn = None;
        state.seen_turns.clear();
        state.compactions.clear();
        state.warned.clear();
        state.config_warned.clear();
        state.launch.resume(total);
        // A different thread may temporarily share the widget's previous token
        // cache. Wait for that thread's first actual token observation.
        state.token_session_ready = same_thread;
    }

    fn status_line_command_width(&self) -> Option<usize> {
        let (viewport, columns) = self.bottom_pane.status_line_command_width()?;
        (Some(viewport) == self.last_rendered_width.get() && viewport > 0).then_some(columns)
    }

    pub(super) fn refit_status_line_command(&self) -> Option<Line<'static>> {
        if self.local_settings.status_line_command.config.is_none()
            || self.status_line_command.resolution.config
                != self.local_settings.status_line_command.config
        {
            return None;
        }
        refit_status_line_command_line(
            self.status_line_command.line.as_ref()?,
            self.status_line_command_width()?,
        )
    }

    pub(super) fn status_line_command_pre_draw(&mut self) {
        let measured = self.bottom_pane.status_line_command_width();
        if self.local_settings.status_line_command.config.is_some()
            && self.status_line_command.measured != measured
        {
            self.status_line_command.measured = measured;
            self.refresh_status_line();
        }
    }

    pub(super) fn refresh_status_line_command(&mut self) {
        if self.status_line_command.closed {
            return;
        }
        let resolution = self.local_settings.status_line_command.clone();
        if self.status_line_command.resolution.config != resolution.config {
            self.invalidate_status_line_command();
        }
        self.status_line_command.resolution = resolution.clone();
        self.bottom_pane
            .observe_status_line_command_width(resolution.config.is_some());
        for warning in resolution.warnings {
            if !self.status_line_command.config_warned.contains(&warning) {
                self.status_line_command.config_warned.push(warning);
                self.add_warning_message(format!(
                    "Status line command configuration: {warning:?}."
                ));
            }
        }
        let invalidation_pending = self
            .status_line_command
            .actor
            .as_ref()
            .is_some_and(|actor| {
                actor.latest.borrow().as_ref().is_none_or(|submission| {
                    submission.identity != self.status_line_command.identity
                })
            });
        // Resize alone preserves in-flight work until it can be refitted. A
        // lifecycle change must still reach the existing actor immediately as
        // a disabled submission; only enabling its replacement waits for width.
        if resolution.config.is_some()
            && self.status_line_command_width().is_none()
            && self.last_rendered_width.get() != Some(0)
            && !invalidation_pending
        {
            return;
        }
        let width = self.status_line_command_width().unwrap_or(0);
        let enabled = resolution.config.is_some() && width > 0;
        if width == 0 {
            self.status_line_command.line = None;
        }
        if self.status_line_command.actor.is_none() {
            if !enabled {
                return;
            }
            let (tx, rx) = mpsc::unbounded_channel();
            let scheduler = StatusLineCommandScheduler::new(tx);
            #[cfg(test)]
            let (scheduler, rx) = match (
                self.status_line_command.scheduler.take(),
                self.status_line_command.events.take(),
            ) {
                (Some(scheduler), Some(events)) => (scheduler, events),
                _ => (scheduler, rx),
            };
            let instance = scheduler.runtime_id().instance;
            let fence = Arc::new(ActorFence::default());
            let (latest, snapshots) = watch::channel(None);
            let task = tokio::spawn(run_actor(
                scheduler,
                rx,
                snapshots,
                fence.clone(),
                self.app_event_tx.clone(),
            ));
            self.status_line_command.actor = Some(Actor {
                latest,
                task,
                instance,
                fence,
            });
        }
        let payload = self.status_line_command_payload();
        let submission = Submission {
            identity: self.status_line_command.identity,
            snapshot: StatusLineCommandSnapshot {
                session_id: self.thread_id.map(|id| id.to_string()).unwrap_or_default(),
                config: enabled.then_some(resolution.config).flatten(),
                payload,
                cwd: self.status_line_cwd().to_path_buf(),
                width,
            },
        };
        if let Some(actor) = &self.status_line_command.actor {
            actor.latest.send_replace(Some(Arc::new(submission)));
        }
    }

    fn accepts_status_line_command(
        &self,
        identity: StatusLineCommandIdentity,
        runtime: StatusLineCommandRuntimeId,
    ) -> bool {
        !self.status_line_command.closed
            && identity == self.status_line_command.identity
            && self.local_settings.status_line_command.config.is_some()
            && self
                .status_line_command
                .actor
                .as_ref()
                .is_some_and(|actor| {
                    runtime.instance == actor.instance
                        && runtime.revision == actor.fence.revision.load(Ordering::Acquire)
                })
    }

    pub(crate) fn handle_status_line_command_output(
        &mut self,
        identity: StatusLineCommandIdentity,
        runtime: StatusLineCommandRuntimeId,
        generation: u64,
        effect: StatusLineCommandEffect,
    ) {
        if !self.accepts_status_line_command(identity, runtime) {
            return;
        }
        if effect.display.is_some() {
            if self
                .status_line_command
                .accepted
                .is_some_and(|(old_runtime, old_generation)| {
                    old_runtime == runtime && generation <= old_generation
                })
            {
                return;
            }
            self.status_line_command.accepted = Some((runtime, generation));
        }
        if let Some(kind) = effect.warning
            && self.status_line_command.warned.insert(kind)
        {
            self.add_warning_message(format!("Status line command failed: {kind:?}."));
        }
        if let Some(display) = effect.display {
            self.status_line_command.line = match display {
                StatusLineCommandDisplay::Command(line) => Some(line),
                StatusLineCommandDisplay::BuiltIn => None,
            };
            self.refresh_status_line_command_display();
        }
    }

    pub(crate) fn handle_status_line_command_tick(
        &mut self,
        identity: StatusLineCommandIdentity,
        runtime: StatusLineCommandRuntimeId,
        epoch: u64,
    ) {
        if self.accepts_status_line_command(identity, runtime)
            && self
                .status_line_command
                .actor
                .as_ref()
                .is_some_and(|actor| actor.fence.timer_epoch.load(Ordering::Acquire) == epoch)
        {
            self.refresh_status_line();
        }
    }

    pub(super) fn stop_status_line_command(&mut self) -> Option<tokio::task::JoinHandle<()>> {
        self.invalidate_status_line_command();
        self.status_line_command.closed = true;
        self.status_line_command.actor.take().map(|actor| {
            drop(actor.latest);
            actor.task
        })
    }

    pub(crate) async fn shutdown_status_line_command(&mut self) {
        if let Some(task) = self.stop_status_line_command()
            && let Err(error) = task.await
        {
            tracing::error!(%error, "status-line command actor shutdown failed");
        }
    }

    pub(super) fn status_line_command_turn_started(&mut self, id: &str) {
        let state = &mut self.status_line_command;
        if state.active_turn.is_none() && state.seen_turns.insert(id.to_owned()) {
            state.active_turn = Some((id.to_owned(), Instant::now()));
        }
    }

    pub(super) fn status_line_command_turn_completed(&mut self, id: &str) {
        let state = &mut self.status_line_command;
        if state
            .active_turn
            .as_ref()
            .is_some_and(|(active, _)| active == id)
            && let Some((_, start)) = state.active_turn.take()
        {
            state.completed_wall_ms = state.completed_wall_ms.saturating_add(elapsed_ms(start));
        }
        self.observe_status_line_command_tokens();
    }

    pub(super) fn status_line_command_compaction(&mut self, turn_id: &str, id: &str) {
        let state = &mut self.status_line_command;
        if state
            .active_turn
            .as_ref()
            .is_some_and(|(active, _)| active == turn_id)
        {
            state.compactions.insert(id.to_owned());
        }
    }

    fn status_line_command_total_tokens(&self) -> Option<StatusLineTokenCounts> {
        if !self.status_line_command.token_session_ready {
            return None;
        }
        self.token_info
            .as_ref()
            .map(|info| token_counts(&info.total_token_usage))
    }

    pub(super) fn observe_status_line_command_tokens(&mut self) {
        let total = self.status_line_command_total_tokens();
        let state = &mut self.status_line_command;
        let running = state
            .active_turn
            .as_ref()
            .map_or(0, |(_, start)| elapsed_ms(*start));
        state
            .launch
            .observe_tokens(total, state.completed_wall_ms.saturating_add(running));
    }

    pub(super) fn status_line_command_tokens_changed(&mut self) {
        self.status_line_command.token_session_ready = true;
        self.observe_status_line_command_tokens();
    }

    pub(super) fn status_line_command_payload(&mut self) -> serde_json::Value {
        self.observe_status_line_command_tokens();
        let token_info = self
            .token_info
            .as_ref()
            .filter(|_| self.status_line_command.token_session_ready);
        let snapshot = StatusLinePayloadSnapshot {
            session_id: self.thread_id.map(|id| id.to_string()).unwrap_or_default(),
            cwd: self.status_line_cwd().display().to_string(),
            model_id: self.current_model().to_owned(),
            model_display_name: self.model_display_name().to_owned(),
            effort_level: self
                .effective_reasoning_effort()
                .map(|effort| effort.to_string()),
            version: super::CODEX_CLI_VERSION.to_owned(),
            mode: match self.active_mode_kind() {
                codex_protocol::config_types::ModeKind::Default => "default",
                codex_protocol::config_types::ModeKind::Plan => "plan",
            }
            .to_owned(),
            approval_mode: self.config.permissions.approval_policy.value().to_string(),
            sandbox: self.config.legacy_sandbox_policy().to_string(),
            thread_name: self.thread_name.clone(),
            compactions: i64::try_from(self.status_line_command.compactions.len())
                .unwrap_or(i64::MAX),
            context_window_size: if self.status_line_command.token_session_ready {
                self.status_line_context_window_size()
            } else {
                self.config.model_context_window
            },
            context_used_percentage: token_info
                .and_then(|_| self.status_line_context_used_percent())
                .map(|value| value as f64),
            context_remaining_percentage: token_info
                .and_then(|_| self.status_line_context_remaining_percent())
                .map(|value| value as f64),
            total_tokens: self.status_line_command_total_tokens(),
            last_tokens: token_info.map(|info| token_counts(&info.last_token_usage)),
            rate_limits: self
                .rate_limit_snapshots_by_limit_id
                .values()
                .flat_map(|limits| [limits.primary.as_ref(), limits.secondary.as_ref()])
                .flatten()
                .map(|window| StatusLineRateLimitWindow {
                    used_percent: window.used_percent,
                    resets_at: window.resets_at_unix,
                    window_minutes: window.window_minutes,
                })
                .collect(),
            session_wall_duration_ms: elapsed_ms(self.status_line_command.launched_at),
        };
        build_status_line_payload(&snapshot, &self.status_line_command.launch)
    }

    #[cfg(test)]
    pub(super) fn status_line_command_identity(&self) -> StatusLineCommandIdentity {
        self.status_line_command.identity
    }

    #[cfg(test)]
    pub(super) fn set_status_line_command_runner(&mut self, runner: StatusLineCommandRunFn) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        self.status_line_command.scheduler =
            Some(StatusLineCommandScheduler::with_runner(tx, runner));
        self.status_line_command.events = Some(rx);
    }
}

fn elapsed_ms(start: Instant) -> i64 {
    i64::try_from(start.elapsed().as_millis()).unwrap_or(i64::MAX)
}

fn token_counts(usage: &crate::token_usage::TokenUsage) -> StatusLineTokenCounts {
    StatusLineTokenCounts {
        input: usage.input_tokens,
        cached_input: usage.cached_input_tokens,
        output: usage.output_tokens,
        reasoning_output: usage.reasoning_output_tokens,
        total: usage.total_tokens,
    }
}
