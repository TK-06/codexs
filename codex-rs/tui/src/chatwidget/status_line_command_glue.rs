//! Callable integration boundary for the test-first ChatWidget command scaffold.
//!
//! This stage deliberately keeps the built-in footer and does not start an actor.
//! Hosted behavioral RED must precede implementation of scheduling, rendering,
//! snapshot extraction, lifecycle metrics, and identity fencing.

use super::ChatWidget;
use crate::status_line_command::StatusLineCommandEffect;
#[cfg(test)]
use crate::status_line_command::StatusLineCommandEvent;
use crate::status_line_command::StatusLineCommandResolution;
#[cfg(test)]
use crate::status_line_command::StatusLineCommandRunFn;
use crate::status_line_command::StatusLineCommandRuntimeId;
#[cfg(test)]
use crate::status_line_command::StatusLineCommandScheduler;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct StatusLineCommandIdentity {
    pub(crate) widget: u64,
    pub(crate) revision: u64,
    pub(crate) session: u64,
}

#[derive(Default)]
pub(super) struct StatusLineCommandWidgetState {
    identity: StatusLineCommandIdentity,
    // Inject the existing scheduler, not a fake copy of its transitions. It is
    // owned here but intentionally not driven until the hosted RED gate passes.
    #[cfg(test)]
    scheduler: Option<StatusLineCommandScheduler>,
    #[cfg(test)]
    events: Option<tokio::sync::mpsc::UnboundedReceiver<StatusLineCommandEvent>>,
}

impl ChatWidget {
    pub(crate) fn set_status_line_command_config(
        &mut self,
        resolution: StatusLineCommandResolution,
    ) {
        self.local_settings.status_line_command = resolution;
        self.refresh_status_line();
    }

    pub(super) fn refresh_status_line_command(&mut self) {}

    pub(crate) fn handle_status_line_command_output(
        &mut self,
        _identity: StatusLineCommandIdentity,
        _runtime: StatusLineCommandRuntimeId,
        _generation: u64,
        _effect: StatusLineCommandEffect,
    ) {
    }

    pub(crate) fn handle_status_line_command_tick(
        &mut self,
        _identity: StatusLineCommandIdentity,
        _runtime: StatusLineCommandRuntimeId,
        _epoch: u64,
    ) {
    }

    pub(crate) async fn shutdown_status_line_command(&mut self) {}

    pub(super) fn status_line_command_payload(&mut self) -> serde_json::Value {
        serde_json::json!({})
    }

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
