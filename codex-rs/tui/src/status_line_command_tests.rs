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

mod scheduler_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use std::time::Instant as WallInstant;
    use tokio::sync::mpsc;
    use tokio::sync::oneshot;

    const WALL_WATCHDOG: Duration = Duration::from_secs(2);
    const SPACING: Duration = Duration::from_millis(300);

    struct Start {
        request: StatusLineCommandRequest,
        at: tokio::time::Instant,
        finish: oneshot::Sender<Result<Line<'static>, StatusLineCommandError>>,
        cancelled: oneshot::Receiver<()>,
        allow_cleanup: oneshot::Sender<()>,
    }

    struct Harness {
        scheduler: StatusLineCommandScheduler,
        events: mpsc::UnboundedReceiver<StatusLineCommandEvent>,
        starts: mpsc::UnboundedReceiver<Start>,
    }

    fn harness() -> Harness {
        let (event_tx, events) = mpsc::unbounded_channel();
        let (start_tx, starts) = mpsc::unbounded_channel();
        let runner: StatusLineCommandRunFn = Arc::new(move |request, mut cancellation| {
            let (finish, finished) = oneshot::channel();
            let (cancelled, cancel_observed) = oneshot::channel();
            let (allow_cleanup, cleanup_released) = oneshot::channel();
            let start = Start {
                request,
                at: tokio::time::Instant::now(),
                finish,
                cancelled: cancel_observed,
                allow_cleanup,
            };
            assert!(
                start_tx.send(start).is_ok(),
                "scheduler starts remain observed"
            );
            Box::pin(async move {
                tokio::select! {
                    result = finished => result.unwrap_or(Err(StatusLineCommandError::Cancelled)),
                    _ = &mut cancellation => {
                        let _ = cancelled.send(());
                        let _ = cleanup_released.await;
                        Err(StatusLineCommandError::Cancelled)
                    }
                }
            })
        });
        Harness {
            scheduler: StatusLineCommandScheduler::with_runner(event_tx, runner),
            events,
            starts,
        }
    }

    fn config(command: &str, interval: u64, timeout_ms: u64) -> StatusLineCommandConfig {
        StatusLineCommandConfig {
            command: command.to_string(),
            refresh_interval_secs: interval,
            timeout_ms,
        }
    }

    fn snapshot(
        session_id: &str,
        config: Option<StatusLineCommandConfig>,
        marker: &str,
        width: usize,
    ) -> StatusLineCommandSnapshot {
        StatusLineCommandSnapshot {
            session_id: session_id.to_string(),
            config,
            payload: json!({"marker": marker}),
            cwd: std::env::temp_dir(),
            width,
        }
    }

    async fn receive<T>(receiver: &mut mpsc::UnboundedReceiver<T>) -> T {
        let deadline = WallInstant::now() + WALL_WATCHDOG;
        loop {
            match receiver.try_recv() {
                Ok(item) => return item,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    panic!("scheduler observation channel closed")
                }
                Err(mpsc::error::TryRecvError::Empty) => {
                    assert!(
                        WallInstant::now() < deadline,
                        "scheduler observation watchdog expired"
                    );
                    tokio::task::yield_now().await;
                }
            }
        }
    }

    async fn receive_cancelled(start: &mut Start) {
        let deadline = WallInstant::now() + WALL_WATCHDOG;
        loop {
            match start.cancelled.try_recv() {
                Ok(()) => return,
                Err(oneshot::error::TryRecvError::Closed) => {
                    panic!("runner exited without observing cancellation")
                }
                Err(oneshot::error::TryRecvError::Empty) => {
                    assert!(
                        WallInstant::now() < deadline,
                        "cancellation watchdog expired"
                    );
                    tokio::task::yield_now().await;
                }
            }
        }
    }

    async fn no_message<T>(receiver: &mut mpsc::UnboundedReceiver<T>) {
        settle().await;
        assert!(
            matches!(receiver.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
            "unexpected scheduler message"
        );
    }

    async fn settle() {
        for _ in 0..32 {
            tokio::task::yield_now().await;
        }
    }

    async fn next_effect(harness: &mut Harness) -> StatusLineCommandEffect {
        let event = receive(&mut harness.events).await;
        harness.scheduler.handle_event(event).await
    }

    async fn delayed_start(harness: &mut Harness) -> Start {
        let event = receive(&mut harness.events).await;
        assert!(matches!(&event, StatusLineCommandEvent::DelayReady { .. }));
        let effect = harness.scheduler.handle_event(event).await;
        assert!(effect.display.is_none());
        assert!(effect.warning.is_none());
        assert!(!effect.request_refresh);
        receive(&mut harness.starts).await
    }

    fn line(text: &str) -> Line<'static> {
        Line::from(text.to_string())
    }

    fn assert_command(effect: StatusLineCommandEffect, expected: &str) {
        match effect.display {
            Some(StatusLineCommandDisplay::Command(actual)) => assert_eq!(
                actual
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>(),
                expected
            ),
            other => panic!("expected command line {expected:?}, got {other:?}"),
        }
    }

    fn assert_builtin(effect: StatusLineCommandEffect) {
        assert!(matches!(
            effect.display,
            Some(StatusLineCommandDisplay::BuiltIn)
        ));
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn first_enabled_snapshot_starts_immediately_and_publishes_result() {
        let mut h = harness();
        let before = tokio::time::Instant::now();
        h.scheduler
            .update(snapshot(
                "session",
                Some(config("one", 0, 2000)),
                "first",
                42,
            ))
            .await;
        let start = receive(&mut h.starts).await;
        assert_eq!(start.at, before);
        assert_eq!(start.request.payload["marker"], "first");
        assert_eq!(start.request.width, 42);
        start
            .finish
            .send(Ok(line("ready")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "ready");
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn active_refreshes_coalesce_to_latest_snapshot_at_300_ms() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "a", 20))
            .await;
        let first = receive(&mut h.starts).await;
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "b", 21))
            .await;
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "c", 37))
            .await;
        first
            .finish
            .send(Ok(line("first")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "first");
        settle().await;
        tokio::time::advance(SPACING - Duration::from_millis(1)).await;
        no_message(&mut h.events).await;
        no_message(&mut h.starts).await;
        tokio::time::advance(Duration::from_millis(1)).await;
        let second = delayed_start(&mut h).await;
        assert_eq!(second.at.duration_since(first.at), SPACING);
        assert_eq!(second.request.payload["marker"], "c");
        assert_eq!(second.request.width, 37);
        no_message(&mut h.starts).await;
        second
            .finish
            .send(Ok(line("second")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "second");
        tokio::time::advance(SPACING * 2).await;
        no_message(&mut h.events).await;
        no_message(&mut h.starts).await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn pending_delay_keeps_original_deadline_when_more_updates_arrive() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "a", 20))
            .await;
        let first = receive(&mut h.starts).await;
        tokio::time::advance(Duration::from_millis(100)).await;
        first
            .finish
            .send(Ok(line("first")))
            .expect("finish accepted");
        next_effect(&mut h).await;
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "b", 20))
            .await;
        settle().await;
        tokio::time::advance(Duration::from_millis(150)).await;
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "c", 28))
            .await;
        settle().await;
        tokio::time::advance(Duration::from_millis(49)).await;
        no_message(&mut h.events).await;
        no_message(&mut h.starts).await;
        tokio::time::advance(Duration::from_millis(1)).await;
        let second = delayed_start(&mut h).await;
        assert_eq!(second.at.duration_since(first.at), SPACING);
        assert_eq!(second.request.payload["marker"], "c");
        assert_eq!(second.request.width, 28);
        second
            .finish
            .send(Ok(line("second")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "second");
        tokio::time::advance(SPACING * 2).await;
        no_message(&mut h.events).await;
        no_message(&mut h.starts).await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn consumed_delay_event_is_inert_during_newer_same_runtime_delay() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "first", 20))
            .await;
        let first = receive(&mut h.starts).await;
        first
            .finish
            .send(Ok(line("first")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "first");
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "second", 20))
            .await;
        settle().await;
        tokio::time::advance(SPACING).await;
        let old_ready = receive(&mut h.events).await;
        let (runtime, old_epoch) = match &old_ready {
            StatusLineCommandEvent::DelayReady { runtime, epoch } => (*runtime, *epoch),
            other => panic!("expected queued delay event, got {other:?}"),
        };
        h.scheduler.handle_event(old_ready).await;
        let second = receive(&mut h.starts).await;
        assert_eq!(second.request.payload["marker"], "second");
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "third", 35))
            .await;
        second
            .finish
            .send(Ok(line("second")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "second");
        settle().await;
        let stale = h
            .scheduler
            .handle_event(StatusLineCommandEvent::DelayReady {
                runtime,
                epoch: old_epoch,
            })
            .await;
        assert!(stale.display.is_none());
        assert!(stale.warning.is_none());
        assert!(!stale.request_refresh);
        no_message(&mut h.starts).await;
        tokio::time::advance(SPACING).await;
        let current_ready = receive(&mut h.events).await;
        match &current_ready {
            StatusLineCommandEvent::DelayReady {
                runtime: current_runtime,
                epoch,
            } => {
                assert_eq!(*current_runtime, runtime);
                assert_ne!(*epoch, old_epoch);
            }
            other => panic!("expected replacement delay event, got {other:?}"),
        }
        h.scheduler.handle_event(current_ready).await;
        let third = receive(&mut h.starts).await;
        assert_eq!(third.request.payload["marker"], "third");
        assert_eq!(third.request.width, 35);
        third
            .finish
            .send(Ok(line("third")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "third");
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn disable_cancels_pending_delay_and_clears_command_line() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "a", 20))
            .await;
        let first = receive(&mut h.starts).await;
        first.finish.send(Ok(line("old"))).expect("finish accepted");
        next_effect(&mut h).await;
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "b", 20))
            .await;
        let effect = h
            .scheduler
            .update(snapshot("s", None, "disabled", 20))
            .await;
        assert_builtin(effect);
        tokio::time::advance(Duration::from_secs(1)).await;
        while let Ok(event) = h.events.try_recv() {
            let effect = h.scheduler.handle_event(event).await;
            assert!(effect.display.is_none());
            assert!(!effect.request_refresh);
        }
        no_message(&mut h.starts).await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn replacement_waits_for_cancellation_cleanup_and_global_spacing() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "old", 20))
            .await;
        let mut first = receive(&mut h.starts).await;
        tokio::time::advance(Duration::from_millis(100)).await;
        let update = tokio::spawn(async move {
            h.scheduler
                .update(snapshot("s", Some(config("two", 0, 2000)), "new", 30))
                .await;
            h
        });
        receive_cancelled(&mut first).await;
        tokio::time::advance(SPACING).await;
        assert!(
            !update.is_finished(),
            "replacement advanced before cleanup acknowledgment"
        );
        first
            .allow_cleanup
            .send(())
            .expect("cleanup release accepted");
        let mut h = update.await.expect("scheduler update task");
        let second = receive(&mut h.starts).await;
        assert!(second.at.duration_since(first.at) >= SPACING);
        assert_eq!(second.request.config.command, "two");
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn config_replacement_before_deadline_does_not_burst() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "old", 20))
            .await;
        let mut first = receive(&mut h.starts).await;
        tokio::time::advance(Duration::from_millis(100)).await;
        let update = tokio::spawn(async move {
            h.scheduler
                .update(snapshot("s", Some(config("two", 0, 2000)), "new", 20))
                .await;
            h
        });
        receive_cancelled(&mut first).await;
        first
            .allow_cleanup
            .send(())
            .expect("cleanup release accepted");
        let mut h = update.await.expect("scheduler update task");
        no_message(&mut h.starts).await;
        tokio::time::advance(Duration::from_millis(199)).await;
        no_message(&mut h.events).await;
        no_message(&mut h.starts).await;
        tokio::time::advance(Duration::from_millis(1)).await;
        let second = delayed_start(&mut h).await;
        assert_eq!(second.at.duration_since(first.at), SPACING);
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn stale_generation_cannot_publish_warn_or_consume_dirty_refresh() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "old", 20))
            .await;
        let first = receive(&mut h.starts).await;
        let first_generation = h.scheduler.generation();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "new", 30))
            .await;
        let runtime = h.scheduler.runtime_id();
        let stale_generation = h.scheduler.generation().saturating_add(1);
        let stale = h
            .scheduler
            .handle_event(StatusLineCommandEvent::Finished {
                runtime,
                generation: stale_generation,
                result: Err(StatusLineCommandError::ExitFailure),
            })
            .await;
        assert!(stale.display.is_none());
        assert!(stale.warning.is_none());
        assert!(!stale.request_refresh);
        first
            .finish
            .send(Ok(line("valid")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "valid");
        settle().await;
        tokio::time::advance(SPACING).await;
        let second = delayed_start(&mut h).await;
        assert_eq!(second.request.payload["marker"], "new");
        assert!(h.scheduler.generation() > first_generation);
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "latest", 41))
            .await;
        for result in [Ok(line("stale")), Err(StatusLineCommandError::ExitFailure)] {
            let stale = h
                .scheduler
                .handle_event(StatusLineCommandEvent::Finished {
                    runtime,
                    generation: first_generation,
                    result,
                })
                .await;
            assert!(stale.display.is_none());
            assert!(stale.warning.is_none());
            assert!(!stale.request_refresh);
        }
        second
            .finish
            .send(Ok(line("current")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "current");
        settle().await;
        tokio::time::advance(SPACING).await;
        let third = delayed_start(&mut h).await;
        assert_eq!(third.request.payload["marker"], "latest");
        assert_eq!(third.request.width, 41);
        third
            .finish
            .send(Err(StatusLineCommandError::ExitFailure))
            .expect("finish accepted");
        assert_eq!(
            next_effect(&mut h).await.warning,
            Some(StatusLineCommandFailureKind::ExitFailure)
        );
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn old_runtime_and_old_scheduler_events_are_inert() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("old", Some(config("one", 0, 2000)), "old", 20))
            .await;
        let old_runtime = h.scheduler.runtime_id();
        let mut first = receive(&mut h.starts).await;
        let old_generation = h.scheduler.generation();
        let update = tokio::spawn(async move {
            h.scheduler
                .update(snapshot("new", Some(config("one", 0, 2000)), "new", 20))
                .await;
            h
        });
        receive_cancelled(&mut first).await;
        first
            .allow_cleanup
            .send(())
            .expect("cleanup release accepted");
        let mut h = update.await.expect("scheduler update task");
        assert_ne!(h.scheduler.runtime_id(), old_runtime);
        settle().await;
        tokio::time::advance(SPACING).await;
        let second = delayed_start(&mut h).await;
        assert_eq!(second.request.payload["marker"], "new");
        assert!(h.scheduler.generation() > old_generation);
        for event in [
            StatusLineCommandEvent::Tick {
                runtime: old_runtime,
                epoch: 0,
            },
            StatusLineCommandEvent::DelayReady {
                runtime: old_runtime,
                epoch: 0,
            },
            StatusLineCommandEvent::Finished {
                runtime: old_runtime,
                generation: 1,
                result: Err(StatusLineCommandError::ExitFailure),
            },
        ] {
            let effect = h.scheduler.handle_event(event).await;
            assert!(effect.display.is_none());
            assert!(effect.warning.is_none());
            assert!(!effect.request_refresh);
        }
        let (new_tx, _new_rx) = mpsc::unbounded_channel();
        let mut replacement = StatusLineCommandScheduler::new(new_tx);
        assert_ne!(replacement.runtime_id().instance, old_runtime.instance);
        let effect = replacement
            .handle_event(StatusLineCommandEvent::Tick {
                runtime: old_runtime,
                epoch: 0,
            })
            .await;
        assert!(!effect.request_refresh);
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn periodic_tick_requests_fresh_snapshot_before_running_again() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 1, 2000)), "old", 20))
            .await;
        let first = receive(&mut h.starts).await;
        first.finish.send(Ok(line("old"))).expect("finish accepted");
        next_effect(&mut h).await;
        let current = h.scheduler.runtime_id();
        for event in [
            StatusLineCommandEvent::Tick {
                runtime: current,
                epoch: u64::MAX,
            },
            StatusLineCommandEvent::DelayReady {
                runtime: current,
                epoch: u64::MAX,
            },
        ] {
            let effect = h.scheduler.handle_event(event).await;
            assert!(!effect.request_refresh);
            assert!(effect.display.is_none());
        }
        settle().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        let tick = receive(&mut h.events).await;
        let effect = h.scheduler.handle_event(tick).await;
        assert!(effect.request_refresh);
        no_message(&mut h.starts).await;
        h.scheduler
            .update(snapshot("s", Some(config("one", 1, 2000)), "fresh", 52))
            .await;
        let second = receive(&mut h.starts).await;
        assert_eq!(second.request.payload["marker"], "fresh");
        assert_eq!(second.request.width, 52);
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn interval_change_replaces_timer_and_zero_disables_it() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 1, 2000)), "old", 20))
            .await;
        let first = receive(&mut h.starts).await;
        first.finish.send(Ok(line("old"))).expect("finish accepted");
        next_effect(&mut h).await;
        settle().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        let old_tick = receive(&mut h.events).await;
        assert!(matches!(&old_tick, StatusLineCommandEvent::Tick { .. }));
        h.scheduler
            .update(snapshot("s", Some(config("one", 3, 2000)), "new", 20))
            .await;
        let second = receive(&mut h.starts).await;
        second
            .finish
            .send(Ok(line("new")))
            .expect("finish accepted");
        next_effect(&mut h).await;
        let stale = h.scheduler.handle_event(old_tick).await;
        assert!(stale.display.is_none());
        assert!(stale.warning.is_none());
        assert!(!stale.request_refresh);
        settle().await;
        tokio::time::advance(Duration::from_millis(2999)).await;
        no_message(&mut h.events).await;
        tokio::time::advance(Duration::from_millis(1)).await;
        let tick = receive(&mut h.events).await;
        assert!(h.scheduler.handle_event(tick).await.request_refresh);
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "zero", 20))
            .await;
        let third = receive(&mut h.starts).await;
        third
            .finish
            .send(Ok(line("zero")))
            .expect("finish accepted");
        next_effect(&mut h).await;
        tokio::time::advance(Duration::from_secs(4)).await;
        no_message(&mut h.events).await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn timeout_keeps_same_runtime_line_but_other_error_uses_builtin() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "one", 20))
            .await;
        let first = receive(&mut h.starts).await;
        first
            .finish
            .send(Ok(line("good")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "good");
        tokio::time::advance(SPACING).await;
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "two", 20))
            .await;
        let second = receive(&mut h.starts).await;
        second
            .finish
            .send(Err(StatusLineCommandError::Timeout))
            .expect("finish accepted");
        let timeout = next_effect(&mut h).await;
        assert_eq!(timeout.warning, Some(StatusLineCommandFailureKind::Timeout));
        assert_command(timeout, "good");
        tokio::time::advance(SPACING).await;
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "three", 20))
            .await;
        let third = receive(&mut h.starts).await;
        third
            .finish
            .send(Err(StatusLineCommandError::ExitFailure))
            .expect("finish accepted");
        let failure = next_effect(&mut h).await;
        assert_eq!(
            failure.warning,
            Some(StatusLineCommandFailureKind::ExitFailure)
        );
        assert_builtin(failure);
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn config_invalidation_clears_last_good_and_warning_dedup_is_per_session() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "one", 20))
            .await;
        let first = receive(&mut h.starts).await;
        first
            .finish
            .send(Ok(line("good")))
            .expect("finish accepted");
        next_effect(&mut h).await;
        tokio::time::advance(SPACING).await;
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 3000)), "two", 20))
            .await;
        let second = receive(&mut h.starts).await;
        second
            .finish
            .send(Err(StatusLineCommandError::Timeout))
            .expect("finish accepted");
        let timeout = next_effect(&mut h).await;
        assert_eq!(timeout.warning, Some(StatusLineCommandFailureKind::Timeout));
        assert_builtin(timeout);
        tokio::time::advance(SPACING).await;
        h.scheduler
            .update(snapshot("s", Some(config("two", 0, 3000)), "three", 20))
            .await;
        let third = receive(&mut h.starts).await;
        third
            .finish
            .send(Err(StatusLineCommandError::Timeout))
            .expect("finish accepted");
        assert_eq!(next_effect(&mut h).await.warning, None);
        tokio::time::advance(SPACING).await;
        h.scheduler
            .update(snapshot(
                "new-session",
                Some(config("two", 0, 3000)),
                "four",
                20,
            ))
            .await;
        let fourth = receive(&mut h.starts).await;
        fourth
            .finish
            .send(Err(StatusLineCommandError::Timeout))
            .expect("finish accepted");
        assert_eq!(
            next_effect(&mut h).await.warning,
            Some(StatusLineCommandFailureKind::Timeout)
        );
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn shutdown_awaits_cleanup_and_stops_future_events() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "one", 20))
            .await;
        let mut first = receive(&mut h.starts).await;
        let shutdown = tokio::spawn(async move {
            h.scheduler.shutdown().await;
            h
        });
        receive_cancelled(&mut first).await;
        assert!(!shutdown.is_finished());
        first
            .allow_cleanup
            .send(())
            .expect("cleanup release accepted");
        let mut h = shutdown.await.expect("shutdown task");
        tokio::time::advance(Duration::from_secs(2)).await;
        no_message(&mut h.starts).await;
        no_message(&mut h.events).await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn shutdown_cancels_pending_delay_and_periodic_timer() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 1, 2000)), "first", 20))
            .await;
        let first = receive(&mut h.starts).await;
        first
            .finish
            .send(Ok(line("first")))
            .expect("finish accepted");
        assert_command(next_effect(&mut h).await, "first");
        h.scheduler
            .update(snapshot("s", Some(config("one", 1, 2000)), "pending", 25))
            .await;
        h.scheduler.shutdown().await;
        tokio::time::advance(Duration::from_secs(2)).await;
        no_message(&mut h.starts).await;
        no_message(&mut h.events).await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn drop_sends_cancellation_to_owned_runner() {
        let mut h = harness();
        h.scheduler
            .update(snapshot("s", Some(config("one", 0, 2000)), "one", 20))
            .await;
        let mut second = receive(&mut h.starts).await;
        drop(h.scheduler);
        receive_cancelled(&mut second).await;
        second
            .allow_cleanup
            .send(())
            .expect("cleanup release accepted");
    }
}

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
    let line = rendered(b"a\x00\x01\x7f\xc2\x80\xc2\x91b", 20);
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

#[test]
fn render_c1_apc_discards_terminated_content_including_newlines() {
    let line = rendered("a\u{009f}hidden\ncontent\u{009c}b".as_bytes(), 20);
    assert_eq!(rendered_text(&line), "ab");
}

#[test]
fn render_unterminated_c1_apc_discards_the_remaining_content() {
    let line = rendered("a\u{009f}secret".as_bytes(), 20);
    assert_eq!(rendered_text(&line), "a");
}

#[test]
fn render_unterminated_escape_control_strings_discard_remaining_content() {
    for opener in ["\x1b]0;", "\x1bP", "\x1b_", "\x1b^"] {
        let output = format!("a{opener}hidden\ncontent");
        let line = rendered(output.as_bytes(), 20);
        assert_eq!(rendered_text(&line), "a");
    }
}

#[cfg(windows)]
mod runner_tests {
    use super::*;
    use std::fs;
    use std::io;
    use std::path::Path;
    use std::path::PathBuf;
    use std::pin::Pin;
    use std::task::Context;
    use std::task::Poll;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::io::AsyncRead;
    use tokio::io::AsyncWrite;
    use tokio::io::ReadBuf;
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
    use windows_sys::Win32::System::Threading::TerminateProcess;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    const WATCHDOG: Duration = Duration::from_secs(25);
    const PROCESS_SYNCHRONIZE: u32 = 0x0010_0000;

    struct Fixture {
        directory: TempDir,
        command: String,
        identity_files: Vec<&'static str>,
    }

    impl Fixture {
        fn new(script: &str) -> Self {
            let directory = tempfile::tempdir().expect("temporary fixture directory");
            let path = directory.path().join("status command with spaces.cmd");
            assert!(
                !script.contains('"'),
                "fixture script must use single quotes"
            );
            fs::write(
                &path,
                format!(
                    "@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"{script}\"\r\n"
                ),
            )
            .expect("write synthetic command fixture");
            Self {
                directory,
                command: format!("\"{}\"", path.display()),
                identity_files: Vec::new(),
            }
        }

        fn track_process(&mut self, identity_file: &'static str) {
            self.identity_files.push(identity_file);
        }

        fn path(&self, name: &str) -> PathBuf {
            self.directory.path().join(name)
        }

        fn request(
            &self,
            payload: serde_json::Value,
            width: usize,
            timeout_ms: u64,
        ) -> StatusLineCommandRequest {
            StatusLineCommandRequest {
                config: StatusLineCommandConfig {
                    command: self.command.clone(),
                    refresh_interval_secs: 10,
                    timeout_ms,
                },
                payload,
                cwd: self.directory.path().to_path_buf(),
                width,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // This runs after assertions and before TempDir removes identity files. A failed
            // assertion cannot strand a process that published its verified identity but was
            // not yet captured by wait_for_process. Never terminate an unverified/reused PID.
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut processes = Vec::new();
            for name in &self.identity_files {
                let path = self.path(name);
                loop {
                    if let Some((pid, creation_ticks)) = read_identity(&path) {
                        if let Some(process) = ExactProcess::try_capture(pid, creation_ticks) {
                            processes.push(process);
                        }
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            for process in processes.iter().rev() {
                if unsafe { WaitForSingleObject(process.handle, 0) } == WAIT_TIMEOUT {
                    unsafe { TerminateProcess(process.handle, 1) };
                    if unsafe { WaitForSingleObject(process.handle, 2_000) } != WAIT_OBJECT_0 {
                        eprintln!(
                            "fixture cleanup could not stop verified process {}",
                            process.pid
                        );
                    }
                }
            }
        }
    }

    fn read_identity(path: &Path) -> Option<(u32, u64)> {
        let text = fs::read_to_string(path).ok()?;
        let (pid, creation_ticks) = text.trim().split_once(',')?;
        Some((pid.parse().ok()?, creation_ticks.parse().ok()?))
    }

    fn ps_literal(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "''"))
    }

    fn tree_script(fixture: &Fixture, output: &str) -> String {
        format!(
            "$start = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToFileTimeUtc(); Set-Content -LiteralPath {} -Value ($PID.ToString() + ',' + $start.ToString()); $child = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru; $childStart = (Get-Process -Id $child.Id).StartTime.ToUniversalTime().ToFileTimeUtc(); Set-Content -LiteralPath {} -Value ($child.Id.ToString() + ',' + $childStart.ToString()); while (-not (Test-Path -LiteralPath {})) {{ Start-Sleep -Milliseconds 20 }}; [Console]::Out.Write('{}')",
            ps_literal(&fixture.path("root.pid")),
            ps_literal(&fixture.path("descendant.pid")),
            ps_literal(&fixture.path("release")),
            output,
        )
    }

    fn launch(
        request: StatusLineCommandRequest,
    ) -> (
        oneshot::Sender<()>,
        JoinHandle<Result<Line<'static>, StatusLineCommandError>>,
    ) {
        let (cancel, cancelled) = oneshot::channel();
        let task = tokio::spawn(run_status_line_command(request, cancelled));
        (cancel, task)
    }

    async fn result(
        task: JoinHandle<Result<Line<'static>, StatusLineCommandError>>,
    ) -> Result<Line<'static>, StatusLineCommandError> {
        tokio::time::timeout(WATCHDOG, task)
            .await
            .expect("runner watchdog expired")
            .expect("runner task panicked")
    }

    struct ExactProcess {
        handle: HANDLE,
        pid: u32,
    }

    impl ExactProcess {
        fn capture(pid: u32, expected_creation_ticks: u64) -> Self {
            Self::try_capture(pid, expected_creation_ticks)
                .unwrap_or_else(|| panic!("could not verify process identity for {pid}"))
        }

        fn try_capture(pid: u32, expected_creation_ticks: u64) -> Option<Self> {
            let handle = unsafe {
                OpenProcess(
                    PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
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
            let queried = unsafe {
                GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
            };
            let actual_creation_ticks =
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            if queried == 0 || actual_creation_ticks != expected_creation_ticks {
                unsafe { CloseHandle(handle) };
                return None;
            }
            Some(Self { handle, pid })
        }

        fn assert_running(&self) {
            assert_eq!(
                unsafe { WaitForSingleObject(self.handle, 0) },
                WAIT_TIMEOUT,
                "process {} exited before test trigger",
                self.pid
            );
        }

        fn assert_gone(&self) {
            assert_eq!(
                unsafe { WaitForSingleObject(self.handle, 5_000) },
                WAIT_OBJECT_0,
                "exact process {} survived runner cleanup",
                self.pid
            );
        }
    }

    impl Drop for ExactProcess {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    async fn wait_for_process(
        path: &Path,
        task: &JoinHandle<Result<Line<'static>, StatusLineCommandError>>,
    ) -> ExactProcess {
        let deadline = tokio::time::Instant::now() + WATCHDOG;
        loop {
            if let Some((pid, creation_ticks)) = read_identity(path) {
                return ExactProcess::capture(pid, creation_ticks);
            }
            assert!(
                !task.is_finished(),
                "runner ended before fixture recorded {}",
                path.display()
            );
            assert!(
                tokio::time::Instant::now() < deadline,
                "fixture did not record {}",
                path.display()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn tree_fixture() -> (
        Fixture,
        oneshot::Sender<()>,
        JoinHandle<Result<Line<'static>, StatusLineCommandError>>,
        ExactProcess,
        ExactProcess,
    ) {
        // The script is constructed after temp paths exist; replacing the initial script is
        // limited to this generated fixture and never executes during scaffold preparation.
        let mut fixture = Fixture::new("[Console]::Out.Write('initial')");
        fixture.track_process("root.pid");
        fixture.track_process("descendant.pid");
        let script = tree_script(&fixture, "tree done");
        let path = fixture.path("status command with spaces.cmd");
        fs::write(
            &path,
            format!(
                "@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"{script}\"\r\n"
            ),
        )
        .expect("write tree fixture");
        let (cancel, task) = launch(fixture.request(json!({"kind": "synthetic"}), 30, 10_000));
        let root = wait_for_process(&fixture.path("root.pid"), &task).await;
        let descendant = wait_for_process(&fixture.path("descendant.pid"), &task).await;
        root.assert_running();
        descendant.assert_running();
        (fixture, cancel, task, root, descendant)
    }

    #[tokio::test]
    async fn runner_writes_json_stdin_and_recomputes_width() {
        let fixture = Fixture::new(
            "[Console]::Out.Write($env:CCSTATUSLINE_WIDTH + '|' + [Console]::In.ReadToEnd())",
        );
        let payload = json!({"kind": "synthetic"});
        let (_cancel, wide_task) = launch(fixture.request(payload.clone(), 80, 15_000));
        let wide = result(wide_task)
            .await
            .expect("JSON fixture should succeed");
        assert_eq!(
            wide.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>(),
            format!("80|{payload}")
        );
        let (_cancel, narrow_task) = launch(fixture.request(payload, 6, 15_000));
        let narrow = result(narrow_task)
            .await
            .expect("resized fixture should succeed");
        assert_eq!(narrow.width(), 6);
        assert!(narrow.spans[0].content.starts_with("6|"));
        assert!(
            narrow
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
                .ends_with('…')
        );
    }

    #[tokio::test]
    async fn runner_accepts_quoted_command_path_with_spaces() {
        let fixture = Fixture::new("[Console]::Out.Write('quoted ok')");
        let (_cancel, task) = launch(fixture.request(json!({}), 20, 15_000));
        let line = result(task).await.expect("quoted cmd path should execute");
        assert_eq!(
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>(),
            "quoted ok"
        );
    }

    #[tokio::test]
    async fn runner_preserves_quoted_argument_path_with_spaces() {
        let fixture = Fixture::new("[Console]::Out.Write('initial')");
        let argument = fixture.path("quoted argument with spaces.txt");
        fs::write(&argument, b"quoted argument ok").expect("write argument fixture");
        fs::write(
            fixture.path("status command with spaces.cmd"),
            b"@echo off\r\ntype \"%~1\"\r\n",
        )
        .expect("write argument-reading command fixture");
        let mut request = fixture.request(json!({}), 30, 15_000);
        request.config.command = format!("{} \"{}\"", fixture.command, argument.display());
        let (_cancel, task) = launch(request);
        let line = result(task)
            .await
            .expect("quoted argument should reach cmd intact");
        assert_eq!(
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>(),
            "quoted argument ok"
        );
    }

    #[tokio::test]
    async fn runner_uses_explicit_child_working_directory() {
        let fixture = Fixture::new(
            "[Console]::Out.Write((Get-Location).Path + '|' + (Get-Content -LiteralPath 'cwd-only.marker' -Raw).Trim())",
        );
        let cwd = fixture.path("working directory distinct from executable");
        fs::create_dir(&cwd).expect("create working directory fixture");
        fs::write(cwd.join("cwd-only.marker"), b"requested cwd")
            .expect("write marker only in requested cwd");
        let command_path = fixture.path("status command with spaces.cmd");
        assert_ne!(
            fs::canonicalize(&cwd).expect("canonical requested cwd"),
            fs::canonicalize(command_path.parent().expect("command parent"))
                .expect("canonical command directory")
        );
        let mut request = fixture.request(json!({}), 4096, 15_000);
        request.cwd = cwd.clone();
        let (_cancel, task) = launch(request);
        let line = result(task)
            .await
            .expect("working directory fixture should succeed");
        let actual = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        let (reported_cwd, marker) = actual
            .split_once('|')
            .expect("fixture should report cwd and relative marker");
        assert_eq!(marker, "requested cwd");
        assert_eq!(
            fs::canonicalize(reported_cwd).expect("canonical reported cwd"),
            fs::canonicalize(&cwd).expect("canonical requested cwd")
        );
    }

    #[tokio::test]
    async fn runner_accepts_success_and_retains_safe_color() {
        let fixture = Fixture::new(
            "[Console]::Out.Write(([char]27).ToString() + '[31mred' + ([char]27).ToString() + '[0m')",
        );
        let (_cancel, task) = launch(fixture.request(json!({}), 20, 15_000));
        let line = result(task).await.expect("color fixture should succeed");
        assert_eq!(
            line.spans,
            vec![Span::styled("red", Style::default().fg(Color::Red))]
        );
    }

    #[tokio::test]
    async fn runner_missing_command_fails() {
        let fixture = Fixture::new("[Console]::Out.Write('unused')");
        let mut request = fixture.request(json!({}), 20, 15_000);
        request.config.command = "codexs_definitely_missing_fixture_executable_4891".to_string();
        let (_cancel, task) = launch(request);
        assert!(matches!(
            result(task).await,
            Err(StatusLineCommandError::ExitFailure)
        ));
    }

    #[tokio::test]
    async fn runner_nonzero_exit_discards_visible_stdout() {
        let fixture = Fixture::new("[Console]::Out.Write('must not render'); exit 7");
        let (_cancel, task) = launch(fixture.request(json!({}), 20, 15_000));
        assert!(matches!(
            result(task).await,
            Err(StatusLineCommandError::ExitFailure)
        ));
    }

    #[tokio::test]
    async fn runner_empty_output_fails() {
        let fixture = Fixture::new("[Console]::Out.Write('   ')");
        let (_cancel, task) = launch(fixture.request(json!({}), 20, 15_000));
        assert!(matches!(
            result(task).await,
            Err(StatusLineCommandError::EmptyOutput)
        ));
    }

    #[tokio::test]
    async fn runner_rejects_blank_command_before_spawn() {
        let fixture = Fixture::new("[Console]::Out.Write('unused')");
        let mut request = fixture.request(json!({}), 20, 15_000);
        request.config.command = "  ".to_string();
        let (_cancel, task) = launch(request);
        assert!(matches!(
            result(task).await,
            Err(StatusLineCommandError::InvalidCommand)
        ));
    }

    #[tokio::test]
    async fn runner_accepts_exact_stdout_cap_without_truncating_success() {
        let fixture = Fixture::new("[Console]::Out.Write('x' * 65536)");
        let (_cancel, task) = launch(fixture.request(json!({}), 8, 15_000));
        let line = result(task).await.expect("exact cap should succeed");
        assert_eq!(line.width(), 8);
    }

    #[tokio::test]
    async fn runner_aborts_at_stdout_cap_without_pipe_deadlock() {
        let mut fixture = Fixture::new("[Console]::Out.Write('initial')");
        fixture.track_process("producer.pid");
        let script = format!(
            "$start = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToFileTimeUtc(); Set-Content -LiteralPath {} -Value ($PID.ToString() + ',' + $start.ToString()); while (-not (Test-Path -LiteralPath {})) {{ Start-Sleep -Milliseconds 20 }}; while ($true) {{ [Console]::Out.Write('x' * 8192) }}",
            ps_literal(&fixture.path("producer.pid")),
            ps_literal(&fixture.path("release")),
        );
        fs::write(
            fixture.path("status command with spaces.cmd"),
            format!(
                "@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"{script}\"\r\n"
            ),
        )
        .expect("write capped producer fixture");
        // A serial write-then-read runner blocks on stdin while the child blocks on stdout.
        let payload = json!({"blob": "x".repeat(2 * 1024 * 1024)});
        let (_cancel, task) = launch(fixture.request(payload, 8, 15_000));
        let producer = wait_for_process(&fixture.path("producer.pid"), &task).await;
        producer.assert_running();
        fs::write(fixture.path("release"), b"go").expect("release capped producer");
        assert!(matches!(
            result(task).await,
            Err(StatusLineCommandError::OutputCap)
        ));
        producer.assert_gone();
    }

    #[tokio::test]
    async fn runner_reports_stdin_pipe_failure() {
        let fixture = Fixture::new("[Console]::In.Close(); Start-Sleep -Milliseconds 100; exit 0");
        let payload = json!({"blob": "x".repeat(2 * 1024 * 1024)});
        let (_cancel, task) = launch(fixture.request(payload, 20, 15_000));
        assert!(matches!(
            result(task).await,
            Err(StatusLineCommandError::StdinWrite)
        ));
    }

    struct FailingReader;

    impl AsyncRead for FailingReader {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Ready(Err(io::Error::other("synthetic read error")))
        }
    }

    struct FailingWriter;

    impl AsyncWrite for FailingWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Err(io::Error::other("synthetic write error")))
        }

        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn runner_read_adapter_reports_stdout_error() {
        assert!(matches!(
            read_status_line_stdout(&mut FailingReader).await,
            Err(StatusLineCommandError::StdoutRead)
        ));
    }

    #[tokio::test]
    async fn runner_write_adapter_reports_stdin_error() {
        assert!(matches!(
            write_status_line_stdin(&mut FailingWriter, b"synthetic").await,
            Err(StatusLineCommandError::StdinWrite)
        ));
    }

    #[test]
    fn runner_wait_adapter_reports_wait_error() {
        assert!(matches!(
            classify_status_line_wait(Err(io::Error::other("synthetic wait error"))),
            Err(StatusLineCommandError::Wait)
        ));
    }

    #[tokio::test]
    async fn runner_normal_completion_terminates_exact_descendant() {
        let (fixture, _cancel, task, root, descendant) = tree_fixture().await;
        fs::write(fixture.path("release"), b"go").expect("release fixture");
        let line = result(task).await.expect("tree fixture should succeed");
        assert_eq!(
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>(),
            "tree done"
        );
        root.assert_gone();
        descendant.assert_gone();
    }

    #[tokio::test]
    async fn runner_timeout_terminates_exact_tree() {
        let (_fixture, _cancel, task, root, descendant) = tree_fixture().await;
        assert!(matches!(
            result(task).await,
            Err(StatusLineCommandError::Timeout)
        ));
        root.assert_gone();
        descendant.assert_gone();
    }

    #[tokio::test]
    async fn runner_explicit_cancel_terminates_exact_tree() {
        let (_fixture, cancel, task, root, descendant) = tree_fixture().await;
        cancel.send(()).expect("runner should still be listening");
        assert!(matches!(
            result(task).await,
            Err(StatusLineCommandError::Cancelled)
        ));
        root.assert_gone();
        descendant.assert_gone();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn runner_caller_abort_still_terminates_exact_tree() {
        let (_fixture, _cancel, task, root, descendant) = tree_fixture().await;
        task.abort();
        let join = tokio::time::timeout(WATCHDOG, task)
            .await
            .expect("aborted task watchdog");
        assert!(
            join.expect_err("aborted caller should be cancelled")
                .is_cancelled()
        );
        root.assert_gone();
        descendant.assert_gone();
    }

    #[test]
    fn runner_runtime_shutdown_terminates_exact_tree() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let (fixture, _cancel, task, root, descendant) = runtime.block_on(tree_fixture());
        runtime.shutdown_timeout(Duration::from_secs(5));
        assert!(
            task.is_finished(),
            "supervisor should have stopped on runtime shutdown"
        );
        root.assert_gone();
        descendant.assert_gone();
        drop(fixture);
    }

    mod native_fault_tests {
        use super::*;
        use std::future::Future;
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::io::FromRawHandle;
        use std::os::windows::io::OwnedHandle;
        use std::os::windows::io::RawHandle;
        use std::sync::Arc;
        use std::sync::Mutex;
        use std::sync::atomic::AtomicBool;
        use std::sync::atomic::Ordering;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
        use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
        use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
        use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        use windows_sys::Win32::System::Threading::GetProcessId;

        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn NtResumeProcess(process: HANDLE) -> i32;
        }

        #[derive(Clone, Copy, PartialEq, Eq)]
        enum Fault {
            Create,
            Assign,
            Resume,
            TerminateBefore,
            TerminateAfter,
            ReapAfter,
        }

        struct RecordedProcess {
            handle: OwnedHandle,
            pid: u32,
            creation_ticks: u64,
        }

        impl RecordedProcess {
            fn capture(process: RawHandle) -> io::Result<Self> {
                let pid = unsafe { GetProcessId(process.cast()) };
                if pid == 0 {
                    return Err(io::Error::last_os_error());
                }
                let expected_creation_ticks = Self::creation_ticks(process)?;
                let handle = unsafe {
                    OpenProcess(
                        PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                        0,
                        pid,
                    )
                };
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let handle = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
                let creation_ticks = Self::creation_ticks(handle.as_raw_handle())?;
                if creation_ticks != expected_creation_ticks {
                    return Err(io::Error::other(
                        "process identity changed while opening handle",
                    ));
                }
                Ok(Self {
                    handle,
                    pid,
                    creation_ticks,
                })
            }

            fn creation_ticks(handle: RawHandle) -> io::Result<u64> {
                let mut created = FILETIME {
                    dwLowDateTime: 0,
                    dwHighDateTime: 0,
                };
                let mut exited = created;
                let mut kernel = created;
                let mut user = created;
                if unsafe {
                    GetProcessTimes(
                        handle.cast(),
                        &mut created,
                        &mut exited,
                        &mut kernel,
                        &mut user,
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
            }

            fn assert_gone(&self) {
                assert_eq!(
                    unsafe { WaitForSingleObject(self.handle.as_raw_handle().cast(), 5_000) },
                    WAIT_OBJECT_0,
                    "recorded process {} ({}) survived cleanup",
                    self.pid,
                    self.creation_ticks
                );
            }
        }

        impl Drop for RecordedProcess {
            fn drop(&mut self) {
                if unsafe { WaitForSingleObject(self.handle.as_raw_handle().cast(), 0) }
                    == WAIT_TIMEOUT
                {
                    unsafe { TerminateProcess(self.handle.as_raw_handle().cast(), 1) };
                    let _ =
                        unsafe { WaitForSingleObject(self.handle.as_raw_handle().cast(), 2_000) };
                }
            }
        }

        #[derive(Default)]
        struct Observed {
            process: Mutex<Option<RecordedProcess>>,
            waited: AtomicBool,
        }

        impl Observed {
            fn assert_reaped(&self) {
                assert!(
                    self.waited.load(Ordering::SeqCst),
                    "actual Child.wait was not completed"
                );
                self.process
                    .lock()
                    .expect("observed process lock")
                    .as_ref()
                    .expect("native operations never received suspended process")
                    .assert_gone();
            }
        }

        struct FaultOps {
            fault: Fault,
            observed: Arc<Observed>,
        }

        impl FaultOps {
            fn injected(&self, step: &str) -> io::Error {
                io::Error::other(format!("injected {step} failure"))
            }

            fn stop_unrecorded_child(child: &mut tokio::process::Child) {
                let _ = child.start_kill();
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => return,
                        Ok(None) if std::time::Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        result => {
                            eprintln!(
                                "could not reap child after identity capture failed: {result:?}"
                            );
                            return;
                        }
                    }
                }
            }
        }

        impl WindowsNativeOps for FaultOps {
            fn create_job(&self) -> io::Result<OwnedHandle> {
                if self.fault == Fault::Create {
                    return Err(self.injected("job create"));
                }
                let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                    unsafe { std::mem::zeroed() };
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if unsafe {
                    SetInformationJobObject(
                        job.as_raw_handle().cast(),
                        JobObjectExtendedLimitInformation,
                        (&raw const limits).cast(),
                        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }

            fn spawn(
                &self,
                command: &mut tokio::process::Command,
            ) -> io::Result<tokio::process::Child> {
                command.kill_on_drop(true);
                let mut child = command.spawn()?;
                let captured = child
                    .raw_handle()
                    .ok_or_else(|| io::Error::other("spawned child lacks a process handle"))
                    .and_then(RecordedProcess::capture);
                let captured = match captured {
                    Ok(captured) => captured,
                    Err(error) => {
                        Self::stop_unrecorded_child(&mut child);
                        return Err(error);
                    }
                };
                let mut slot = self.observed.process.lock().expect("observed process lock");
                if slot.is_some() {
                    drop(slot);
                    Self::stop_unrecorded_child(&mut child);
                    return Err(io::Error::other("native wrapper saw a second spawn"));
                }
                *slot = Some(captured);
                Ok(child)
            }

            fn assign(&self, job: &OwnedHandle, process: RawHandle) -> io::Result<()> {
                let pid = unsafe { GetProcessId(process.cast()) };
                let creation_ticks = RecordedProcess::creation_ticks(process)?;
                let slot = self.observed.process.lock().expect("observed process lock");
                let spawned = slot
                    .as_ref()
                    .ok_or_else(|| io::Error::other("assign preceded spawn"))?;
                if pid != spawned.pid || creation_ticks != spawned.creation_ticks {
                    return Err(io::Error::other("assign targeted a different child"));
                }
                drop(slot);
                if self.fault == Fault::Assign {
                    return Err(self.injected("job assignment"));
                }
                if unsafe { AssignProcessToJobObject(job.as_raw_handle().cast(), process.cast()) }
                    == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }

            fn resume(&self, process: RawHandle) -> io::Result<()> {
                if self.fault == Fault::Resume {
                    return Err(self.injected("resume"));
                }
                let status = unsafe { NtResumeProcess(process.cast()) };
                if status < 0 {
                    return Err(io::Error::other(format!(
                        "NtResumeProcess status {status:#x}"
                    )));
                }
                Ok(())
            }

            fn terminate(&self, job: &OwnedHandle) -> io::Result<()> {
                if self.fault == Fault::TerminateBefore {
                    return Err(self.injected("terminate before call"));
                }
                if unsafe { TerminateJobObject(job.as_raw_handle().cast(), 1) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                if self.fault == Fault::TerminateAfter {
                    return Err(self.injected("terminate after call"));
                }
                Ok(())
            }

            fn wait<'a>(
                &'a self,
                child: &'a mut tokio::process::Child,
            ) -> Pin<Box<dyn Future<Output = io::Result<std::process::ExitStatus>> + Send + 'a>>
            {
                Box::pin(async move {
                    let status = child.wait().await?;
                    self.observed.waited.store(true, Ordering::SeqCst);
                    if self.fault == Fault::ReapAfter {
                        Err(self.injected("post-reap"))
                    } else {
                        Ok(status)
                    }
                })
            }
        }

        fn launch_fault(
            request: StatusLineCommandRequest,
            fault: Fault,
        ) -> (
            oneshot::Sender<()>,
            JoinHandle<Result<Line<'static>, StatusLineCommandError>>,
            Arc<Observed>,
        ) {
            let observed = Arc::new(Observed::default());
            let (cancel, cancelled) = oneshot::channel();
            let ops = FaultOps {
                fault,
                observed: Arc::clone(&observed),
            };
            let task = tokio::spawn(run_status_line_command_with_ops(request, cancelled, ops));
            (cancel, task, observed)
        }

        fn assert_no_marker(fixture: &Fixture) {
            assert!(
                !fixture.path("ran.marker").exists(),
                "suspended fixture executed before containment"
            );
        }

        #[tokio::test]
        async fn native_job_create_error_prevents_fixture_launch() {
            let fixture = Fixture::new("Set-Content -LiteralPath 'ran.marker' -Value ran");
            let (_cancel, task, observed) =
                launch_fault(fixture.request(json!({}), 20, 15_000), Fault::Create);
            assert!(matches!(
                result(task).await,
                Err(StatusLineCommandError::JobCreate)
            ));
            assert_no_marker(&fixture);
            assert!(
                observed
                    .process
                    .lock()
                    .expect("observed process lock")
                    .is_none()
            );
        }

        #[tokio::test]
        async fn native_job_assignment_error_reaps_suspended_root_without_executing_it() {
            let fixture = Fixture::new("Set-Content -LiteralPath 'ran.marker' -Value ran");
            let (_cancel, task, observed) =
                launch_fault(fixture.request(json!({}), 20, 15_000), Fault::Assign);
            assert!(matches!(
                result(task).await,
                Err(StatusLineCommandError::JobAssign)
            ));
            observed.assert_reaped();
            assert_no_marker(&fixture);
        }

        #[tokio::test]
        async fn native_resume_error_reaps_suspended_root_without_executing_it() {
            let fixture = Fixture::new("Set-Content -LiteralPath 'ran.marker' -Value ran");
            let (_cancel, task, observed) =
                launch_fault(fixture.request(json!({}), 20, 15_000), Fault::Resume);
            assert!(matches!(
                result(task).await,
                Err(StatusLineCommandError::Resume)
            ));
            observed.assert_reaped();
            assert_no_marker(&fixture);
        }

        async fn cancel_fault_tree(
            fault: Fault,
        ) -> (
            Fixture,
            StatusLineCommandError,
            Arc<Observed>,
            ExactProcess,
            ExactProcess,
        ) {
            let mut fixture = Fixture::new("[Console]::Out.Write('initial')");
            fixture.track_process("root.pid");
            fixture.track_process("descendant.pid");
            let script = tree_script(&fixture, "unreachable");
            fs::write(
                fixture.path("status command with spaces.cmd"),
                format!("@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"{script}\"\r\n"),
            ).expect("write native fault fixture");
            let (cancel, task, observed) =
                launch_fault(fixture.request(json!({}), 20, 10_000), fault);
            let root = wait_for_process(&fixture.path("root.pid"), &task).await;
            let descendant = wait_for_process(&fixture.path("descendant.pid"), &task).await;
            root.assert_running();
            descendant.assert_running();
            cancel.send(()).expect("runner should still be listening");
            let error = result(task)
                .await
                .expect_err("cancellation with cleanup fault should fail");
            (fixture, error, observed, root, descendant)
        }

        #[tokio::test]
        async fn native_terminate_error_after_actual_termination_preserves_cancel_primary() {
            let (_fixture, error, observed, root, descendant) =
                cancel_fault_tree(Fault::TerminateAfter).await;
            assert!(
                matches!(error, StatusLineCommandError::Cleanup { primary: Some(primary), terminate: Some(_), reap: None, timed_out: false } if matches!(*primary, StatusLineCommandError::Cancelled))
            );
            observed.assert_reaped();
            root.assert_gone();
            descendant.assert_gone();
        }

        #[tokio::test]
        async fn native_terminate_error_before_call_uses_fallback_and_preserves_cancel_primary() {
            let (_fixture, error, observed, root, descendant) =
                cancel_fault_tree(Fault::TerminateBefore).await;
            assert!(
                matches!(error, StatusLineCommandError::Cleanup { primary: Some(primary), terminate: Some(_), reap: None, timed_out: false } if matches!(*primary, StatusLineCommandError::Cancelled))
            );
            observed.assert_reaped();
            root.assert_gone();
            descendant.assert_gone();
        }

        #[tokio::test]
        async fn native_post_reap_error_preserves_cancel_primary_and_exact_tree_cleanup() {
            let (_fixture, error, observed, root, descendant) =
                cancel_fault_tree(Fault::ReapAfter).await;
            assert!(
                matches!(error, StatusLineCommandError::Cleanup { primary: Some(primary), terminate: None, reap: Some(_), timed_out: false } if matches!(*primary, StatusLineCommandError::Cancelled))
            );
            observed.assert_reaped();
            root.assert_gone();
            descendant.assert_gone();
        }

        #[tokio::test]
        async fn runner_captures_inherited_descendant_stdout_then_closes_tree_after_root_exit() {
            let mut fixture = Fixture::new("[Console]::Out.Write('unused')");
            fixture.track_process("root.pid");
            fixture.track_process("descendant.pid");
            let child_script = format!(
                "$start = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToFileTimeUtc(); Set-Content -LiteralPath {} -Value ($PID.ToString() + ',' + $start.ToString()); [Console]::Out.Write('inherited marker'); [Console]::Out.Flush(); Set-Content -LiteralPath {} -Value ready; while (-not (Test-Path -LiteralPath {})) {{ Start-Sleep -Milliseconds 20 }}",
                ps_literal(&fixture.path("descendant.pid")),
                ps_literal(&fixture.path("child.ready")),
                ps_literal(&fixture.path("child.hold")),
            );
            let encoded_child = format!("'{}'", child_script.replace('\'', "''"));
            let script = format!(
                "$start = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToFileTimeUtc(); Set-Content -LiteralPath {} -Value ($PID.ToString() + ',' + $start.ToString()); $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes({encoded_child})); $info = New-Object System.Diagnostics.ProcessStartInfo; $info.FileName = Join-Path (Join-Path $env:SystemRoot 'System32') 'WindowsPowerShell\\v1.0\\powershell.exe'; $info.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + $encoded; $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $false; $info.RedirectStandardError = $false; $child = [System.Diagnostics.Process]::Start($info); $child.StandardInput.Close(); while (-not (Test-Path -LiteralPath {})) {{ Start-Sleep -Milliseconds 20 }}; while (-not (Test-Path -LiteralPath {})) {{ Start-Sleep -Milliseconds 20 }}",
                ps_literal(&fixture.path("root.pid")),
                ps_literal(&fixture.path("child.ready")),
                ps_literal(&fixture.path("root.release")),
            );
            fs::write(
                fixture.path("status command with spaces.cmd"),
                format!("@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"{script}\"\r\n"),
            ).expect("write inherited stdout fixture");
            let (_cancel, task) = launch(fixture.request(json!({}), 30, 15_000));
            let root = wait_for_process(&fixture.path("root.pid"), &task).await;
            let descendant = wait_for_process(&fixture.path("descendant.pid"), &task).await;
            let ready_deadline = tokio::time::Instant::now() + WATCHDOG;
            while !fixture.path("child.ready").exists() {
                assert!(
                    !task.is_finished(),
                    "runner exited before descendant flushed stdout"
                );
                assert!(
                    tokio::time::Instant::now() < ready_deadline,
                    "descendant did not flush stdout"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            descendant.assert_running();
            fs::write(fixture.path("root.release"), b"go").expect("release root");
            let line = result(task).await.expect("inherited stdout should succeed");
            assert_eq!(
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>(),
                "inherited marker"
            );
            root.assert_gone();
            descendant.assert_gone();
        }

        async fn scheduler_process_record(path: &Path) -> ExactProcess {
            let deadline = std::time::Instant::now() + WATCHDOG;
            loop {
                if let Some((pid, creation_ticks)) = read_identity(path) {
                    return ExactProcess::capture(pid, creation_ticks);
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "scheduler did not start fixture process at {}",
                    path.display()
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        async fn scheduler_assert_gone(process: &ExactProcess) {
            let deadline = std::time::Instant::now() + WATCHDOG;
            while unsafe { WaitForSingleObject(process.handle, 0) } != WAIT_OBJECT_0 {
                assert!(
                    std::time::Instant::now() < deadline,
                    "scheduler left exact process {} running",
                    process.pid
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            process.assert_gone();
        }

        async fn scheduler_tree() -> (
            Fixture,
            StatusLineCommandScheduler,
            tokio::sync::mpsc::UnboundedReceiver<StatusLineCommandEvent>,
            ExactProcess,
            ExactProcess,
        ) {
            let mut fixture = Fixture::new("[Console]::Out.Write('initial')");
            fixture.track_process("root.pid");
            fixture.track_process("descendant.pid");
            let script = tree_script(&fixture, "unused");
            fs::write(
                fixture.path("status command with spaces.cmd"),
                format!("@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"{script}\"\r\n"),
            )
            .expect("write scheduler tree fixture");
            let (events, event_rx) = tokio::sync::mpsc::unbounded_channel();
            let mut scheduler = StatusLineCommandScheduler::new(events);
            let request = fixture.request(json!({"kind": "scheduler synthetic"}), 30, 10_000);
            scheduler
                .update(StatusLineCommandSnapshot {
                    session_id: "scheduler-session".to_string(),
                    config: Some(request.config),
                    payload: request.payload,
                    cwd: request.cwd,
                    width: request.width,
                })
                .await;
            let root = scheduler_process_record(&fixture.path("root.pid")).await;
            let descendant = scheduler_process_record(&fixture.path("descendant.pid")).await;
            root.assert_running();
            descendant.assert_running();
            (fixture, scheduler, event_rx, root, descendant)
        }

        #[tokio::test]
        async fn scheduler_disable_cancels_and_reaps_exact_process_tree() {
            let (_fixture, mut scheduler, _events, root, descendant) = scheduler_tree().await;
            let effect = scheduler
                .update(StatusLineCommandSnapshot {
                    session_id: "scheduler-session".to_string(),
                    config: None,
                    payload: json!({"kind": "disabled"}),
                    cwd: std::env::temp_dir(),
                    width: 30,
                })
                .await;
            assert!(matches!(
                effect.display,
                Some(StatusLineCommandDisplay::BuiltIn)
            ));
            scheduler_assert_gone(&root).await;
            scheduler_assert_gone(&descendant).await;
        }

        #[tokio::test]
        async fn scheduler_drop_cancels_and_reaps_exact_process_tree() {
            let (_fixture, scheduler, _events, root, descendant) = scheduler_tree().await;
            drop(scheduler);
            scheduler_assert_gone(&root).await;
            scheduler_assert_gone(&descendant).await;
        }
    }
}
