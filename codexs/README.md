# codexs: normal launch and status-line configuration

`codexs` opens the modified Codex CLI with the local ccstatusline footer.
`codexs-statusline` opens the **existing ccstatusline configuration TUI** for a separate Codex config: the same item editor, colors, gradients, separators, labels, number formats, Powerline controls and import/export screens.

The interactive Codex editor requests the terminal tab title `codexs-statusline`; its visible header remains `codexs-statusline | v1.0.0`. The title request is limited to interactive Codex output, so normal Claude output, piped formatter output and version diagnostics retain their existing behavior.

Multiline footer support is explicitly deferred to the next task. The current native binary keeps the first nonempty rendered line. Extra configured lines stay saved and editable for that future task; their absence from the live footer does not indicate lost settings.
Both commands are intended to work from any directory for the current Windows user once their shim directory is on the user PATH. Neither changes the starting directory. The official `codex` command remains independent.

## Current preparation state

The planned first product prototype is **codexs v1.0.0**. Track three independent versions: product `1.0.0`, native Codex CLI `0.162.1`, and upstream formatter `2.2.32`. Product identity comes from the formatter's canonical `CODEXS_VERSION` export through its `--codex --version` diagnostic; package.json, Cargo and lock versions remain upstream identities. A planned version is not an accepted release or a tested Git tag.

The installer invokes the supplied Node executable and formatter with `--codex --version` before staging. It requires exactly `codexs-statusline <semver>` and a successful exit, rejecting older formatters and malformed diagnostics. `launch.json` records the parsed `product_version` independently of native `version` and `source_sha`; the source SHA describes native artifact provenance, not the identity of uncommitted product changes.

Standalone `codexs --version` or `codexs -V` prints `codexs 1.0.0 (Codex CLI 0.162.1)` from that manifest without starting Codex. `codexs-statusline --version` or `-V` forwards to the formatter with `--codex` and prints `codexs-statusline 1.0.0`. These version-only commands need no settings file or interactive terminal. Normal launches still require settings and preserve forwarded arguments and exit codes.

The fork is0.162.1; official npm Codex may be newer. A0.165.0 official installation is not a matching helper source for this binary. The installer uses explicit, matching package inputs and never downgrades/replaces the official installation.

The footer is one line: Codex displays the first nonempty rendered output line. Extra imported lines remain saved, and the editor explains this limit. Preview values are synthetic examples; live statistics appear in Codex itself. The Codex copy initially uses `full` width, rather than reserving40 extra columns; later width choices are respected.

The editor inventories92 widget/layout entries:69 are available when their native or local inputs exist, and23 remain unavailable. It explains and blocks unavailable entries while retaining imported settings. The nine Task10 mappings are implemented: cached/total tokens, cache-hit rate/cache reads, input/output/total speed, session name and compaction count. Cache ratios use the selected current-prompt or session scope. Speeds use matching launch-local token deltas and active-turn wall time; windowed speed samples and compaction trigger/reclaimed details are unavailable. Missing native context capacity stays unknown. Claude account/status/cost and unsupported options are not replaced with invented Codex values. Existing configured local commands run only as the user has configured them; the editor preview does not execute them.

## Verify the preparation without installing

From the Codex checkout root, Windows PowerShell5.1:

```powershell
& ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path (Get-Location) 'codexs/install.Tests.ps1'))))
```

These built-in assertions use owned temporary directories and synthetic package/version/disk/process probes. One small C# console probe checks actual shim argument/environment/exit behavior; it is not Codex and performs no network/authentication work. No Rust/Cargo compilation or actual Codex execution occurs. No Pester installation or execution-policy change is needed. Tests finish with native exit status0 only after their assertions pass, including expected nonzero child exits.

## Inputs required before a real installation

Do not run the real installer until the existing preview has passed the remaining Task7 manual checks, the candidate checks have passed, and the user has approved the exact installation/config/shim/PATH changes.

Prepare these explicit inputs:

- `SourceRoot`: the pinned Codex checkout. Its HEAD must match the reviewed CI source SHA, with no tracked changes under `codex-rs`. A later source revision requires matching hosted evidence/binary; the installer does not fetch, switch or rebuild it.
- `BinaryPath`: the release `codex.exe` downloaded from that exact successful hosted run. No local Rust build is required.
- `MainPackageRoot`: a pre-extracted `@openai/codex`0.162.1 package root containing its package.json.
- `HelperPackageRoot`: its declared optional Windows x64 platform package root. Its version must be0.162.1-win32-x64; the npm registry package is `@openai/codex@0.162.1-win32-x64`. Keep its whole vendor tree, including `bin`, `codex-path` and `codex-resources`.
- `NodePath`: an explicit `node.exe`; `FormatterPath`: the tested local ccstatusline `dist/ccstatusline.js`; `SettingsPath`: the separate Codex JSON file. The normal launcher requires these files to remain available.
- `EvidencePath`: a reviewed local JSON record with the actual hosted run references/results and downloaded binary SHA256. This is an input record, not a signed CI attestation; its provenance must be reviewed before installation. Do not generate success counts from guesses or edit evidence to bypass a failed run.

Matching npm packages can be downloaded into a controlled task directory with `npm.cmd pack --ignore-scripts`, then extracted after reviewing archive paths/integrity. That is a separate authorized network/preparation step, not a global install. Do not use the newer global package's helper files. The installer deliberately does not download packages or run npm scripts itself.

Evidence shape (all values below are placeholders to replace from verified CI):

```json
{
  "source_sha": "<full verified source SHA>",
  "version": "0.162.1",
  "target": "x86_64-pc-windows-msvc",
  "binary_sha256": "<SHA256 of the downloaded codex.exe>",
  "feature_run": "<successful feature run ID>",
  "acceptance_run": "<successful full/config/build run ID>",
  "feature": { "exit": 0, "passed": 144, "failed": 0 },
  "full": { "exit": 0, "passed": 5789, "failed": 0 },
  "config": { "exit": 0, "passed": 366, "failed": 0 },
  "build_exit": 0
}
```

The numbers shown describe the last verified0.162.1 source; replace them with the actual results for a different source, not minimum targets. Keep real payloads, session IDs, credentials, personal paths and user settings out of the repository. Optional captures are private local evidence only.

### Exact source policy and remaining gates

The current checkout HEAD is `4beaeb1faff11bdb62613e8acb837f0ec85350a5`. The prepared native artifact/evidence must name this full revision and match the downloaded binary's independently verified SHA256. Reconfirm those local inputs before use; synthetic assertions do not authenticate hosted evidence.

The installer deliberately compares evidence `source_sha` to **HEAD**, after rejecting tracked native-source changes. Even a later installer-only commit changes HEAD and makes the existing artifact fail this check. Comparing only Cargo versions or accepting a matching `codex-rs` diff would weaken provenance: build dependencies and workflow/toolchain inputs can live outside that directory. This prototype introduces no such bypass or alternate revision flag.

To install from a later committed checkout under the existing policy, obtain a new hosted artifact and successful feature/full/config/build evidence at that exact HEAD, even if native files are unchanged. Reusing the older artifact is possible only with a separately supplied clean source checkout still pinned to its exact reviewed revision, with the same package, binary-hash and evidence checks; creating or switching that checkout requires the user's Git authorization. Installer/formatter identity remains separately reviewed. A future tree-based reuse policy would need an explicit complete build-input inventory and CI attestation, rather than a guessed list of native paths.

Outstanding real-install inputs/gates are concrete:

- Reviewed, extracted main package `@openai/codex@0.162.1` and its declared helper `@openai/codex@0.162.1-win32-x64`, including the entire Windows x64 vendor tree; verify package integrity and archive paths during separately approved preparation.
- Exact-source hosted release binary and reviewed feature/full/config/build evidence, run references and matching SHA256; no evidence counts may be inferred from these synthetic tests.
- Built and tested formatter diagnostic `codexs-statusline 1.0.0`, explicit Node/formatter paths, and reviewed separate Codex settings.
- Remaining manual application/editor acceptance, free-space/process/lock checks, and approval of the concrete installation/shim/config inputs. Review PATH separately if the shim directory is absent.
- After acceptance, a separately authorized product release/tag and future tracking record containing product version, native version, formatter version, native source SHA, binary SHA256 and hosted evidence references. Do not label an old SHA as the identity of uncommitted product code.

## Approved real installation, later

After the separate real-install approval, load `install.ps1` as a scriptblock and pass `-Install` plus the eight input paths. For example, with `$inputs` already populated with the reviewed named inputs:

```powershell
$installer = Join-Path (Get-Location) 'codexs/install.ps1'
& ([scriptblock]::Create([IO.File]::ReadAllText($installer))) -Install @inputs
```

The standalone entry accepts no injectable test operations or alternative production destination. It installs under `%LOCALAPPDATA%\codexs`, and writes the two managed command shims under `%USERPROFILE%\.local\bin`. It does not edit `~/.codex/config.toml`, Claude settings, global npm packages, execution policy or PATH. The footer command is supplied through launch arguments, preserving the normal Codex config/authentication behavior without copying credentials.

Before writing, it validates source/package/helper versions, Windows x64 PE architecture, binary hash/version, nonzero successful hosted evidence, raw disk headroom of at least8GiB, required helper files, destination paths, running/locked files and shim ownership. It stages the complete vendor, replaces only staged `bin/codex.exe`, validates again, then renames old installation to a unique backup and stage to destination. These are sequential renames, not an atomic multi-directory transaction.

Copy/preflight failures leave the old installation. Later failures attempt to restore both old installation and old shims. Rollback failures name the retained backup for recovery. Existing backups are never deleted at start; failed new trees are retained for diagnosis. No user processes are forcibly terminated. Close active codexs processes before installing.

## Command discovery and everyday use

The final installation review must check whether `%USERPROFILE%\.local\bin` is already on the **user PATH**. If absent, adding that exact directory needs the user's separate approval. Do not add the source checkout or current directory to PATH. A user PATH entry makes both commands discoverable from any directory in newly opened terminals; an already running terminal keeps its previous PATH until refreshed.

After installation and any approved PATH update, open a fresh terminal:

```powershell
Get-Command codexs.cmd, codexs-statusline.cmd
codexs --version
codexs
```

In another terminal, `codexs-statusline` opens the editor. Save with Ctrl+S or Save & Exit. The next footer refresh reads the saved configuration. Changing settings in the editor must not alter your Claude configuration or trigger Claude/global install/update actions. Keep both original commands as fallbacks while manual checks are completed.

The editor requires an interactive terminal; piped stdin is rejected. Codex rendering also requires its separate config, so accidentally pointing it at Claude settings is rejected before migration or save. With PowerShell5.1 native quoting, use `'""'` for an empty argument, `'literal\"quote'` for a literal quote, and `-c "key='value with spaces'"` for a TOML string containing spaces. User `-c` arguments follow the launcher's default footer override and retain Codex's normal precedence; a deliberate later override can replace the footer command.

Validate from an unrelated directory too: starting directory, quoted/Unicode arguments, normal interactive input, shutdown/Ctrl+C, status updates, resize, fallback/warnings, loaded project-config rejection and exact child cleanup. Synthetic launcher tests do not replace these actual application checks.

## Updates and rollback

The user handles Git operations. Select the desired upstream version in a separately scoped update, run hosted acceptance/build and obtain matching platform packages/evidence before rerunning this installer. Never mix a newer official package with an older fork.

For manual recovery after closing codexs, review the exact destination/backup/shim paths first. Preserve a failed tree by renaming it aside, restore the recorded backup to the destination, and restore the corresponding managed shims. Do not recursively delete a computed path or a previous backup to make room without checking the resolved path and obtaining approval. Retain known-good backups until a later installation has been verified in use.
