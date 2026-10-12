//! Trusted TUI-only command configuration.

use codex_config::ConfigLayerStack;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StatusLineCommandConfig {
    pub(crate) command: String,
    pub(crate) refresh_interval_secs: u64,
    pub(crate) timeout_ms: u64,
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
    pub(crate) fn from_layers(_layers: &ConfigLayerStack) -> Self {
        Self::default()
    }
}

#[cfg(test)]
#[path = "status_line_command_tests.rs"]
mod tests;
