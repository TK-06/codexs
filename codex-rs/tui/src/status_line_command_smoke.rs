use std::path::PathBuf;

#[cfg(windows)]
const SMOKE_RUNNER_TIMEOUT_MS: u64 = 10_000;
#[cfg(windows)]
const SMOKE_SUPERVISOR_CUTOFF_MS: u64 = 11_000;
#[cfg(all(test, windows))]
const SMOKE_CONTRACT_BUDGET_MS: u64 = 20_000;

#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SmokePrimary {
    Args,
    Io,
    Env,
    Timeout,
    Output,
    Cancelled,
    Runner,
}

#[cfg(windows)]
impl SmokePrimary {
    fn label(self) -> &'static str {
        match self {
            Self::Args => "ARGS",
            Self::Io => "IO",
            Self::Env => "ENV",
            Self::Timeout => "TIMEOUT",
            Self::Output => "OUTPUT",
            Self::Cancelled => "CANCELLED",
            Self::Runner => "RUNNER",
        }
    }
}

#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
struct SmokeFailure {
    primary: Option<SmokePrimary>,
    runner_cleanup: bool,
    directory_cleanup: bool,
}

#[cfg(windows)]
impl SmokeFailure {
    fn new(primary: SmokePrimary) -> Self {
        Self {
            primary: Some(primary),
            runner_cleanup: false,
            directory_cleanup: false,
        }
    }

    fn from_runner(error: crate::status_line_command::StatusLineCommandError) -> Self {
        use crate::status_line_command::StatusLineCommandError;

        match error {
            StatusLineCommandError::Cleanup { primary, .. } => {
                let mut failure = primary
                    .map(|primary| Self::from_runner(*primary))
                    .unwrap_or(Self {
                        primary: None,
                        runner_cleanup: false,
                        directory_cleanup: false,
                    });
                failure.runner_cleanup = true;
                failure
            }
            StatusLineCommandError::Timeout => Self::new(SmokePrimary::Timeout),
            StatusLineCommandError::EmptyOutput => Self::new(SmokePrimary::Output),
            StatusLineCommandError::Cancelled => Self::new(SmokePrimary::Cancelled),
            _ => Self::new(SmokePrimary::Runner),
        }
    }

    fn has_cleanup_failure(&self) -> bool {
        self.runner_cleanup || self.directory_cleanup
    }

    // A finite product of private enums/flags: no OS error text or paths can reach the CLI.
    fn code(&self) -> String {
        let cleanup = match (self.runner_cleanup, self.directory_cleanup) {
            (false, false) => "",
            (true, false) => "RUNNER_CLEANUP",
            (false, true) => "DIRECTORY_CLEANUP",
            (true, true) => "RUNNER_AND_DIRECTORY_CLEANUP",
        };
        match (self.primary, cleanup) {
            (Some(primary), "") => format!("SMOKE_{}", primary.label()),
            (Some(primary), cleanup) => format!("SMOKE_{}_{cleanup}", primary.label()),
            (None, "") => "SMOKE_RUNNER".to_string(),
            (None, cleanup) => format!("SMOKE_{cleanup}"),
        }
    }
}

#[cfg(windows)]
fn finish_probe(
    result: Result<(), SmokeFailure>,
    directory_cleanup_failed: bool,
) -> Result<(), SmokeFailure> {
    if !directory_cleanup_failed {
        return result;
    }
    let mut failure = result.err().unwrap_or(SmokeFailure {
        primary: None,
        runner_cleanup: false,
        directory_cleanup: false,
    });
    failure.directory_cleanup = true;
    Err(failure)
}

#[cfg(windows)]
fn expired_probe(result: Result<(), SmokeFailure>) -> Result<(), SmokeFailure> {
    match result {
        Err(failure) if failure.has_cleanup_failure() => Err(failure),
        _ => Err(SmokeFailure::new(SmokePrimary::Timeout)),
    }
}

/// Exercise the real footer runner with owned synthetic settings, without normal CLI startup.
pub async fn run_codexs_smoke(node: PathBuf, formatter: PathBuf) -> color_eyre::Result<()> {
    #[cfg(windows)]
    {
        use std::time::Duration;

        if !node.is_absolute() || !formatter.is_absolute() || !node.is_file() || !formatter.is_file() {
            color_eyre::eyre::bail!("SMOKE_ARGS");
        }
        // Diagnostic only: reserve the runner's five-second cleanup and two-second Drop fallback
        // after cancellation inside the 20-second contract. Synchronous OS calls are not preempted.
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(SMOKE_SUPERVISOR_CUTOFF_MS);
        supervise_probe(node, formatter, tokio::time::sleep_until(deadline))
            .await
            .map_err(|failure| color_eyre::eyre::eyre!(failure.code()))
    }
    #[cfg(not(windows))]
    {
        let _ = (node, formatter);
        color_eyre::eyre::bail!("SMOKE_UNSUPPORTED")
    }
}

#[cfg(windows)]
async fn supervise_probe(
    node: PathBuf,
    formatter: PathBuf,
    deadline: impl std::future::Future<Output = ()>,
) -> Result<(), SmokeFailure> {
    let (cancel, cancellation) = tokio::sync::oneshot::channel();
    // Dropping this caller also closes cancellation. The supervisor keeps the owned directory
    // until runner cleanup finishes; a deadline must await it before the CLI drops its runtime.
    let mut supervisor = tokio::spawn(run_probe(node, formatter, cancellation));
    tokio::pin!(deadline);
    tokio::select! {
        biased;
        _ = &mut deadline => {
            let _ = cancel.send(());
            let result = supervisor.await
                .map_err(|_| SmokeFailure::new(SmokePrimary::Runner))?;
            expired_probe(result)
        }
        result = &mut supervisor => {
            result.map_err(|_| SmokeFailure::new(SmokePrimary::Runner))?
        }
    }
}

#[cfg(windows)]
async fn run_probe(
    node: PathBuf,
    formatter: PathBuf,
    cancellation: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), SmokeFailure> {
    let root = tempfile::Builder::new()
        .prefix("codexs-smoke-")
        .tempdir()
        .map_err(|_| SmokeFailure::new(SmokePrimary::Io))?;
    let result = run_owned_probe(node, formatter, root.path(), cancellation).await;
    // Close only after runner cleanup, including on setup errors. Do not retry arbitrary I/O
    // errors: no transient directory-deletion error has been demonstrated.
    finish_probe(result, root.close().is_err())
}

#[cfg(windows)]
async fn run_owned_probe(
    node: PathBuf,
    formatter: PathBuf,
    owned: &std::path::Path,
    mut cancellation: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), SmokeFailure> {
    use crate::status_line_command::StatusLineCommandConfig;
    use crate::status_line_command::StatusLineCommandRequest;
    use crate::status_line_command::run_status_line_command;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;

    fn encoded_path(path: &std::path::Path) -> Result<String, SmokeFailure> {
        let text = path
            .to_str()
            .ok_or_else(|| SmokeFailure::new(SmokePrimary::Args))?;
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        Ok(STANDARD.encode(bytes))
    }

    let settings = owned.join("settings.json");
    std::fs::write(
        &settings,
        br#"{"version":4,"lines":[[{"id":"smoke","type":"custom-text","customText":"codexs-smoke-ok"}]],"colorLevel":0,"defaultPadding":""}"#,
    )
    .map_err(|_| SmokeFailure::new(SmokePrimary::Io))?;

    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or_else(|| SmokeFailure::new(SmokePrimary::Env))?;
    let powershell = system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let shell_text = powershell
        .to_str()
        .ok_or_else(|| SmokeFailure::new(SmokePrimary::Env))?;
    // Only the OS executable is command syntax. All caller/temporary paths travel as encoded data.
    if !powershell.is_absolute()
        || !powershell.is_file()
        || shell_text.contains(['"', '%', '!', '&', '|', '<', '>', '^', '\r', '\n'])
    {
        return Err(SmokeFailure::new(SmokePrimary::Env));
    }
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Decode([string]$value) {{ [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($value)) }}
$node = Decode '{}'
$formatter = Decode '{}'
$settings = Decode '{}'
$owned = Decode '{}'
$system = Decode '{}'
foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {{
    [Environment]::SetEnvironmentVariable([string]$key, $null, 'Process')
}}
foreach ($key in @('SystemRoot','WINDIR')) {{ [Environment]::SetEnvironmentVariable($key, $system, 'Process') }}
$env:COMSPEC = [IO.Path]::Combine($system, 'System32\cmd.exe')
$env:PATH = [IO.Path]::Combine($system, 'System32')
$env:PATHEXT = '.EXE;.COM'
foreach ($key in @('CODEX_HOME','HOME','USERPROFILE','TEMP','TMP','APPDATA','LOCALAPPDATA')) {{
    [Environment]::SetEnvironmentVariable($key, $owned, 'Process')
}}
$env:CCSTATUSLINE_WIDTH = '80'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$payload = [Console]::In.ReadToEnd()
$arguments = @($formatter, '--config', $settings)
$payload | & $node @arguments
exit $LASTEXITCODE
"#,
        encoded_path(&node)?,
        encoded_path(&formatter)?,
        encoded_path(&settings)?,
        encoded_path(owned)?,
        encoded_path(&system_root)?,
    );
    let script_path = owned.join("probe.ps1");
    std::fs::write(&script_path, script)
        .map_err(|_| SmokeFailure::new(SmokePrimary::Io))?;
    // Keep the cmd.exe command below its length limit even when the supplied paths are long.
    let bootstrap = format!(
        "& ([scriptblock]::Create([IO.File]::ReadAllText([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{}')))))",
        encoded_path(&script_path)?
    );
    let bytes: Vec<u8> = bootstrap.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let request = StatusLineCommandRequest {
        config: StatusLineCommandConfig {
            command: format!(
                "\"{shell_text}\" -NoProfile -NonInteractive -EncodedCommand {}",
                STANDARD.encode(bytes)
            ),
            refresh_interval_secs: 10,
            timeout_ms: SMOKE_RUNNER_TIMEOUT_MS,
        },
        payload: serde_json::json!({
            "codex": { "schema": 1 },
            "session_id": "codexs-smoke-synthetic",
            "cwd": owned,
            "workspace": { "current_dir": owned }
        }),
        cwd: owned.to_path_buf(),
        width: 80,
    };
    let (cancel, runner_cancellation) = tokio::sync::oneshot::channel();
    let run = run_status_line_command(request, runner_cancellation);
    tokio::pin!(run);
    let result = tokio::select! {
        biased;
        _ = &mut cancellation => {
            let _ = cancel.send(());
            run.await
        }
        result = &mut run => result,
    };
    let line = result.map_err(SmokeFailure::from_runner)?;
    let visible: String = line.spans.iter().map(|span| span.content.as_ref()).collect();
    if visible != "codexs-smoke-ok" {
        return Err(SmokeFailure::new(SmokePrimary::Output));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::SMOKE_CONTRACT_BUDGET_MS;
    use super::SMOKE_RUNNER_TIMEOUT_MS;
    use super::SmokeFailure;
    use super::SmokePrimary;
    use super::expired_probe;
    use super::finish_probe;
    use super::run_codexs_smoke;
    use super::supervise_probe;
    use crate::status_line_command::StatusLineCommandError;
    use std::fs;
    use std::path::Path;
    use std::path::PathBuf;
    use std::time::Duration;
    use std::time::Instant;
    use tempfile::TempDir;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
    use windows_sys::Win32::System::Threading::TerminateProcess;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    struct ExactProcess(HANDLE);

    impl ExactProcess {
        fn read(record: &Path) -> Option<Self> {
            let text = fs::read_to_string(record).ok()?;
            let mut fields = text.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let ticks: u64 = fields.next()?.parse().ok()?;
            if fields.next().is_some() {
                return None;
            }
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
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
            let actual =
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            if queried == 0 || actual != ticks {
                unsafe { CloseHandle(handle) };
                return None;
            }
            Some(Self(handle))
        }

        fn assert_gone(&self) {
            assert_eq!(unsafe { WaitForSingleObject(self.0, 0) }, WAIT_OBJECT_0);
        }

        fn assert_live(&self) {
            assert_eq!(unsafe { WaitForSingleObject(self.0, 0) }, WAIT_TIMEOUT);
        }

        async fn wait_gone_until(&self, deadline: Instant) {
            while unsafe { WaitForSingleObject(self.0, 0) } != WAIT_OBJECT_0
                && Instant::now() < deadline
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            self.assert_gone();
        }
    }

    impl Drop for ExactProcess {
        fn drop(&mut self) {
            // Failure cleanup uses the already verified handle, never a name or a reused PID.
            if unsafe { WaitForSingleObject(self.0, 0) } != WAIT_OBJECT_0 {
                unsafe { TerminateProcess(self.0, 1) };
                unsafe { WaitForSingleObject(self.0, 5_000) };
            }
            unsafe { CloseHandle(self.0) };
        }
    }

    struct Fixture {
        _root: TempDir,
        node: PathBuf,
        formatter: PathBuf,
    }

    impl Fixture {
        fn new(body: &str) -> Self {
            let root = tempfile::tempdir().expect("owned smoke fixture");
            let directory = root.path().join("space Unicode-ไทย % ! & ( ) ' fixture");
            fs::create_dir(&directory).expect("fixture directory");
            let formatter = directory.join("formatter % ! & ' probe.cjs");
            let script = format!(
                r#"const fs = require('node:fs');
const path = require('node:path');
const {{spawn, spawnSync}} = require('node:child_process');
function record(child) {{
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // One bounded query covers both exact processes; the Rust fixture verifies creation times
  // and retains handles before cancellation. Never fall back to killing by PID.
  const query = "$ErrorActionPreference='Stop'; foreach ($id in @(" + process.pid + ',' + child.pid + ")) {{ $p=[Diagnostics.Process]::GetProcessById($id); [Console]::WriteLine([string]$p.Id + ' ' + [string]$p.StartTime.ToUniversalTime().ToFileTimeUtc()) }}";
  const p = spawnSync(ps, ['-NoProfile','-NonInteractive','-Command',query], {{encoding:'utf8', windowsHide:true, timeout:6000}});
  const rows = (p.stdout || '').trim().split(/\r?\n/);
  if (p.status !== 0 || rows.length !== 2 || rows.some(row => !/^[0-9]+ [0-9]+$/.test(row))) process.exit(71);
  if (rows[0].split(' ')[0] !== String(process.pid) || rows[1].split(' ')[0] !== String(child.pid)) process.exit(71);
  fs.writeFileSync(__filename.replace(/\.cjs$/, '.root'), rows[0]);
  fs.writeFileSync(__filename.replace(/\.cjs$/, '.child'), rows[1]);
}}
{body}
"#
            );
            fs::write(&formatter, script).expect("synthetic formatter");
            let node = which::which("node.exe").expect("hosted Node prerequisite");
            Self {
                _root: root,
                node,
                formatter,
            }
        }
    }

    #[test]
    fn smoke_cleanup_codes_preserve_primary_and_scope() {
        let mut codes = std::collections::HashSet::new();
        for primary in [
            None,
            Some(SmokePrimary::Args),
            Some(SmokePrimary::Io),
            Some(SmokePrimary::Env),
            Some(SmokePrimary::Timeout),
            Some(SmokePrimary::Output),
            Some(SmokePrimary::Cancelled),
            Some(SmokePrimary::Runner),
        ] {
            for (runner_cleanup, directory_cleanup) in
                [(false, false), (true, false), (false, true), (true, true)]
            {
                if primary.is_none() && !runner_cleanup && !directory_cleanup {
                    continue;
                }
                let failure = SmokeFailure {
                    primary,
                    runner_cleanup,
                    directory_cleanup,
                };
                assert!(codes.insert(failure.code()));
            }
        }
        assert_eq!(codes.len(), 31, "different failures must not share a code");
        for (primary, label) in [
            (StatusLineCommandError::Timeout, "TIMEOUT"),
            (StatusLineCommandError::EmptyOutput, "OUTPUT"),
            (StatusLineCommandError::Cancelled, "CANCELLED"),
            (StatusLineCommandError::Spawn, "RUNNER"),
        ] {
            let failure = SmokeFailure::from_runner(StatusLineCommandError::Cleanup {
                primary: Some(Box::new(primary)),
                terminate: Some(std::io::Error::other("private synthetic error must not escape")),
                reap: None,
                timed_out: true,
            });
            assert_eq!(failure.code(), format!("SMOKE_{label}_RUNNER_CLEANUP"));
            let failure = finish_probe(Err(failure), true).expect_err("both cleanups failed");
            assert_eq!(
                failure.code(),
                format!("SMOKE_{label}_RUNNER_AND_DIRECTORY_CLEANUP")
            );
            assert_eq!(
                expired_probe(Err(failure))
                    .expect_err("deadline retains cleanup")
                    .code(),
                format!("SMOKE_{label}_RUNNER_AND_DIRECTORY_CLEANUP")
            );
        }
        let output = SmokeFailure::new(SmokePrimary::Output);
        assert_eq!(output.code(), "SMOKE_OUTPUT");
        let output = finish_probe(Err(output), true).expect_err("directory cleanup failed");
        assert_eq!(output.code(), "SMOKE_OUTPUT_DIRECTORY_CLEANUP");
        assert_eq!(
            expired_probe(Err(output))
                .expect_err("deadline retains directory cleanup")
                .code(),
            "SMOKE_OUTPUT_DIRECTORY_CLEANUP"
        );
        assert_eq!(
            finish_probe(Ok(()), true)
                .expect_err("directory cleanup failed")
                .code(),
            "SMOKE_DIRECTORY_CLEANUP"
        );
        let failure = SmokeFailure::from_runner(StatusLineCommandError::Cleanup {
            primary: None,
            terminate: None,
            reap: None,
            timed_out: true,
        });
        assert_eq!(failure.code(), "SMOKE_RUNNER_CLEANUP");
        assert_eq!(
            expired_probe(Err(failure))
                .expect_err("deadline retains runner cleanup")
                .code(),
            "SMOKE_RUNNER_CLEANUP"
        );
        assert_eq!(
            expired_probe(Ok(()))
                .expect_err("deadline cannot succeed")
                .code(),
            "SMOKE_TIMEOUT"
        );
        assert_eq!(
            expired_probe(Err(SmokeFailure::new(SmokePrimary::Cancelled)))
                .expect_err("deadline cancellation is timeout")
                .code(),
            "SMOKE_TIMEOUT"
        );
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            for suffix in ["root", "child"] {
                drop(ExactProcess::read(&self.formatter.with_extension(suffix)));
            }
        }
    }

    #[tokio::test]
    async fn smoke_renders_synthetic_footer_without_config() {
        let fixture = Fixture::new(
            r#"let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  if (!payload.codex || payload.codex.schema !== 1) process.exit(72);
  if (payload.cwd !== process.env.CODEX_HOME || payload.workspace.current_dir !== payload.cwd) process.exit(72);
  if (process.argv.length !== 4 || process.argv[2] !== '--config') process.exit(73);
  const config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  if (config.version !== 4 || config.colorLevel !== 0 || config.lines[0][0].customText !== 'codexs-smoke-ok') process.exit(74);
  for (const key of ['CODEX_HOME', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) {
    if (!process.env[key] || !fs.existsSync(process.env[key])) process.exit(75);
  }
  for (const key of Object.keys(process.env)) {
    if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SIGNING_KEY)$/.test(key)) process.exit(76);
  }
  process.stdout.write('codexs-smoke-ok\n');
});"#,
        );
        let started = Instant::now();
        run_codexs_smoke(fixture.node.clone(), fixture.formatter.clone())
            .await
            .expect("isolated synthetic formatter should render");
        assert!(started.elapsed() < Duration::from_millis(SMOKE_CONTRACT_BUDGET_MS));
    }

    #[tokio::test]
    async fn smoke_rejects_wrong_output() {
        for body in [
            "process.stdout.write('wrong-visible-footer\\n');",
            "process.stdout.write('');",
        ] {
            let fixture = Fixture::new(body);
            let started = Instant::now();
            let error = run_codexs_smoke(fixture.node.clone(), fixture.formatter.clone())
                .await
                .expect_err("wrong or empty output must fail");
            assert_eq!(error.to_string(), "SMOKE_OUTPUT");
            assert!(started.elapsed() < Duration::from_millis(SMOKE_CONTRACT_BUDGET_MS));
        }
    }

    #[test]
    fn smoke_deadline_waits_for_cleanup_before_runtime_shutdown() {
        let fixture = Fixture::new(
            r#"fs.writeFileSync(__filename.replace(/\.cjs$/, '.owned'), process.env.CODEX_HOME);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {stdio:'ignore', windowsHide:true});
record(child);
setInterval(() => {}, 1000);"#,
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("standalone smoke runtime");
        let started = Instant::now();
        let (root, child, owned) = runtime.block_on(async {
            let (expire, deadline) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(supervise_probe(
                fixture.node.clone(),
                fixture.formatter.clone(),
                async move { deadline.await.expect("test explicitly expires the deadline") },
            ));
            let mut root = None;
            let mut child = None;
            while started.elapsed() < Duration::from_millis(SMOKE_RUNNER_TIMEOUT_MS)
                && !task.is_finished()
            {
                root = root
                    .or_else(|| ExactProcess::read(&fixture.formatter.with_extension("root")));
                child = child
                    .or_else(|| ExactProcess::read(&fixture.formatter.with_extension("child")));
                if root.is_some() && child.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let root = root.expect("formatter identity was recorded before deadline");
            let child = child.expect("child identity was recorded before deadline");
            root.assert_live();
            child.assert_live();
            let owned = PathBuf::from(
                fs::read_to_string(fixture.formatter.with_extension("owned"))
                    .expect("diagnostic recorded its owned directory"),
            );
            assert!(owned.is_dir());
            assert!(!task.is_finished(), "force the outer deadline on a live probe");
            expire.send(()).expect("deadline receiver is live");
            let error = task
                .await
                .expect("deadline supervisor joins")
                .expect_err("expired deadline must fail");
            assert_eq!(error.code(), "SMOKE_TIMEOUT");
            // No delay: a completed supervisor must have finished cleanup before runtime drop.
            root.assert_gone();
            child.assert_gone();
            assert!(!owned.exists(), "owned directory removed before supervisor return");
            (root, child, owned)
        });
        // The standalone CLI drops its runtime immediately after block_on returns.
        drop(runtime);
        root.assert_gone();
        child.assert_gone();
        assert!(!owned.exists(), "owned directory removed before runtime shutdown");
        assert!(started.elapsed() < Duration::from_millis(SMOKE_CONTRACT_BUDGET_MS));
    }

    #[tokio::test]
    async fn smoke_bounds_timeout_and_cleans_descendants() {
        for cancel in [false, true] {
            let fixture = Fixture::new(
                r#"fs.writeFileSync(__filename.replace(/\.cjs$/, '.owned'), process.env.CODEX_HOME);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {stdio:'ignore', windowsHide:true});
record(child);
setInterval(() => {}, 1000);"#,
            );
            let started = Instant::now();
            let deadline = started + Duration::from_millis(SMOKE_CONTRACT_BUDGET_MS);
            let task = tokio::spawn(run_codexs_smoke(
                fixture.node.clone(),
                fixture.formatter.clone(),
            ));
            let mut root = None;
            let mut child = None;
            while started.elapsed() < Duration::from_millis(SMOKE_RUNNER_TIMEOUT_MS)
                && !task.is_finished()
            {
                root = root
                    .or_else(|| ExactProcess::read(&fixture.formatter.with_extension("root")));
                child = child
                    .or_else(|| ExactProcess::read(&fixture.formatter.with_extension("child")));
                if root.is_some() && child.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let root = root.expect("formatter identity was recorded");
            let child = child.expect("descendant identity was recorded");
            root.assert_live();
            child.assert_live();
            let owned = PathBuf::from(
                fs::read_to_string(fixture.formatter.with_extension("owned"))
                    .expect("diagnostic recorded its owned directory"),
            );
            assert!(owned.is_dir());
            if cancel {
                task.abort();
                let error = task.await.expect_err("aborted smoke should cancel");
                assert!(error.is_cancelled());
            } else {
                let error = task
                    .await
                    .expect("smoke task should join")
                    .expect_err("hanging formatter must time out");
                assert_eq!(error.to_string(), "SMOKE_TIMEOUT");
            }
            // Caller abort leaves the supervisor running. Poll verified handles against one
            // shared absolute deadline instead of assuming cleanup finishes in 50 milliseconds.
            root.wait_gone_until(deadline).await;
            child.wait_gone_until(deadline).await;
            while owned.exists() && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!owned.exists(), "owned directory removed after cancellation");
            assert!(started.elapsed() < Duration::from_millis(SMOKE_CONTRACT_BUDGET_MS));
        }
    }
}
