use std::path::PathBuf;

/// Offline release diagnostic. The RED scaffold intentionally fails until hosted assertions run.
pub async fn run_codexs_smoke(_node: PathBuf, _formatter: PathBuf) -> color_eyre::Result<()> {
    color_eyre::eyre::bail!("SMOKE_NOT_IMPLEMENTED")
}

#[cfg(all(test, windows))]
mod tests {
    use super::run_codexs_smoke;
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

    #[tokio::test]
    async fn smoke_bounds_timeout_and_cleans_descendants() {
        for cancel in [false, true] {
            let fixture = Fixture::new(
                r#"record(__filename.replace(/\.cjs$/, '.root'));
const childCode = '(' + record.toString() + ')(' + JSON.stringify(__filename.replace(/\.cjs$/, '.child')) + '); setInterval(() => {}, 1000);';
spawn(process.execPath, ['-e', "const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');" + childCode], {stdio:'ignore', windowsHide:true});
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
