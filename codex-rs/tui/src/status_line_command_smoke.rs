use std::path::PathBuf;

/// Exercise the real footer runner with owned synthetic settings, without normal CLI startup.
pub async fn run_codexs_smoke(node: PathBuf, formatter: PathBuf) -> color_eyre::Result<()> {
    #[cfg(windows)]
    {
        use std::time::Duration;

        if !node.is_absolute() || !formatter.is_absolute() || !node.is_file() || !formatter.is_file() {
            color_eyre::eyre::bail!("SMOKE_ARGS");
        }
        // Reserve the runner's five-second cleanup and two-second drop fallback inside ten seconds.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        supervise_probe(node, formatter, tokio::time::sleep_until(deadline)).await
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
) -> color_eyre::Result<()> {
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
                .map_err(|_| color_eyre::eyre::eyre!("SMOKE_RUNNER"))?;
            if let Err(error) = result
                && error.to_string() == "SMOKE_CLEANUP"
            {
                return Err(error);
            }
            color_eyre::eyre::bail!("SMOKE_TIMEOUT")
        }
        result = &mut supervisor => {
            result.map_err(|_| color_eyre::eyre::eyre!("SMOKE_RUNNER"))?
        }
    }
}

#[cfg(windows)]
async fn run_probe(
    node: PathBuf,
    formatter: PathBuf,
    mut cancellation: tokio::sync::oneshot::Receiver<()>,
) -> color_eyre::Result<()> {
    use crate::status_line_command::StatusLineCommandConfig;
    use crate::status_line_command::StatusLineCommandError;
    use crate::status_line_command::StatusLineCommandRequest;
    use crate::status_line_command::run_status_line_command;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;

    fn encoded_path(path: &std::path::Path) -> color_eyre::Result<String> {
        let text = path
            .to_str()
            .ok_or_else(|| color_eyre::eyre::eyre!("SMOKE_ARGS"))?;
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        Ok(STANDARD.encode(bytes))
    }

    let root = tempfile::Builder::new()
        .prefix("codexs-smoke-")
        .tempdir()
        .map_err(|_| color_eyre::eyre::eyre!("SMOKE_IO"))?;
    let settings = root.path().join("settings.json");
    std::fs::write(
        &settings,
        br#"{"version":4,"lines":[[{"id":"smoke","type":"custom-text","customText":"codexs-smoke-ok"}]],"colorLevel":0,"defaultPadding":""}"#,
    )
    .map_err(|_| color_eyre::eyre::eyre!("SMOKE_IO"))?;

    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or_else(|| color_eyre::eyre::eyre!("SMOKE_ENV"))?;
    let powershell = system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let shell_text = powershell
        .to_str()
        .ok_or_else(|| color_eyre::eyre::eyre!("SMOKE_ENV"))?;
    // Only the OS executable is command syntax. All caller/temporary paths travel as encoded data.
    if !powershell.is_absolute()
        || !powershell.is_file()
        || shell_text.contains(['"', '%', '!', '&', '|', '<', '>', '^', '\r', '\n'])
    {
        color_eyre::eyre::bail!("SMOKE_ENV");
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
        encoded_path(root.path())?,
        encoded_path(&system_root)?,
    );
    let script_path = root.path().join("probe.ps1");
    std::fs::write(&script_path, script)
        .map_err(|_| color_eyre::eyre::eyre!("SMOKE_IO"))?;
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
            timeout_ms: 2000,
        },
        payload: serde_json::json!({
            "codex": { "schema": 1 },
            "session_id": "codexs-smoke-synthetic",
            "cwd": root.path(),
            "workspace": { "current_dir": root.path() }
        }),
        cwd: root.path().to_path_buf(),
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
    // A failed directory cleanup is also a failed smoke, even if visible output was correct.
    root.close()
        .map_err(|_| color_eyre::eyre::eyre!("SMOKE_CLEANUP"))?;
    let line = result.map_err(|error| {
        color_eyre::eyre::eyre!(match error {
            StatusLineCommandError::Timeout => "SMOKE_TIMEOUT",
            StatusLineCommandError::EmptyOutput => "SMOKE_OUTPUT",
            StatusLineCommandError::Cleanup { .. } => "SMOKE_CLEANUP",
            StatusLineCommandError::Cancelled => "SMOKE_CANCELLED",
            _ => "SMOKE_RUNNER",
        })
    })?;
    let visible: String = line.spans.iter().map(|span| span.content.as_ref()).collect();
    if visible != "codexs-smoke-ok" {
        color_eyre::eyre::bail!("SMOKE_OUTPUT");
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::run_codexs_smoke;
    use super::supervise_probe;
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
function record(file) {{
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const query = '(Get-Process -Id ' + process.pid + ').StartTime.ToUniversalTime().ToFileTimeUtc()';
  const p = spawnSync(ps, ['-NoProfile','-NonInteractive','-Command',query], {{encoding:'utf8', windowsHide:true}});
  if (p.status !== 0 || !/^[0-9]+$/.test(p.stdout.trim())) process.exit(71);
  fs.writeFileSync(file, process.pid + ' ' + p.stdout.trim());
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
  if (process.argv.length !== 4 || process.argv[2] !== '--config') process.exit(73);
  const config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  if (config.version !== 4 || config.colorLevel !== 0 || config.lines[0][0].customText !== 'codexs-smoke-ok') process.exit(74);
  for (const key of ['CODEX_HOME', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
    if (!process.env[key] || !fs.existsSync(process.env[key])) process.exit(75);
  }
  for (const key of Object.keys(process.env)) {
    if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SIGNING_KEY)$/.test(key)) process.exit(76);
  }
  process.stdout.write('codexs-smoke-ok\n');
});"#,
        );
        run_codexs_smoke(fixture.node.clone(), fixture.formatter.clone())
            .await
            .expect("isolated synthetic formatter should render");
    }

    #[tokio::test]
    async fn smoke_rejects_wrong_output() {
        for body in [
            "process.stdout.write('wrong-visible-footer\\n');",
            "process.stdout.write('');",
        ] {
            let fixture = Fixture::new(body);
            let error = run_codexs_smoke(fixture.node.clone(), fixture.formatter.clone())
                .await
                .expect_err("wrong or empty output must fail");
            assert_eq!(error.to_string(), "SMOKE_OUTPUT");
        }
    }

    #[test]
    fn smoke_deadline_waits_for_cleanup_before_runtime_shutdown() {
        let fixture = Fixture::new(
            r#"fs.writeFileSync(__filename.replace(/\.cjs$/, '.owned'), process.env.CODEX_HOME);
const childCode = '(' + record.toString() + ')(' + JSON.stringify(__filename.replace(/\.cjs$/, '.child')) + '); setInterval(() => {}, 1000);';
spawn(process.execPath, ['-e', "const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');" + childCode], {stdio:'ignore', windowsHide:true});
record(__filename.replace(/\.cjs$/, '.root'));
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
            while started.elapsed() < Duration::from_secs(9) && !task.is_finished() {
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
            assert_eq!(error.to_string(), "SMOKE_TIMEOUT");
            (root, child, owned)
        });
        // The standalone CLI drops its runtime immediately after block_on returns.
        drop(runtime);
        root.assert_gone();
        child.assert_gone();
        assert!(!owned.exists(), "owned directory removed before runtime shutdown");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn smoke_bounds_timeout_and_cleans_descendants() {
        for cancel in [false, true] {
            let fixture = Fixture::new(
                r#"const childCode = '(' + record.toString() + ')(' + JSON.stringify(__filename.replace(/\.cjs$/, '.child')) + '); setInterval(() => {}, 1000);';
spawn(process.execPath, ['-e', "const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');" + childCode], {stdio:'ignore', windowsHide:true});
record(__filename.replace(/\.cjs$/, '.root'));
setInterval(() => {}, 1000);"#,
            );
            let started = Instant::now();
            let task = tokio::spawn(run_codexs_smoke(
                fixture.node.clone(),
                fixture.formatter.clone(),
            ));
            let mut root = None;
            let mut child = None;
            while started.elapsed() < Duration::from_secs(9) && !task.is_finished() {
                root = root
                    .or_else(|| ExactProcess::read(&fixture.formatter.with_extension("root")));
                child = child
                    .or_else(|| ExactProcess::read(&fixture.formatter.with_extension("child")));
                if root.is_some() && child.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
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
            assert!(started.elapsed() < Duration::from_secs(10));
            // The contract includes cleanup when the future is dropped, not just process exit.
            tokio::time::sleep(Duration::from_millis(50)).await;
            root.expect("formatter identity was recorded").assert_gone();
            child.expect("descendant identity was recorded").assert_gone();
        }
    }
}
