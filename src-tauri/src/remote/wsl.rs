//! WSL transport plumbing: distro discovery, agent deploy, and process spawn.
//!
//! Everything `wsl.exe` prints ITSELF (`-l -q`, its own errors) is UTF-16LE;
//! bytes piped to/from the LINUX process inside are a plain byte pipe. All
//! spawns use the absolute System32 path (PATH shadowing) and
//! CREATE_NO_WINDOW (a GUI app must never flash consoles).
//!
//! Deploy: the agent binary is pushed by PIPING ITS BYTES over wsl.exe stdin
//! into `cat > tmp && chmod +x && mv -f` — never via `\\wsl.localhost\` (slow
//! 9P, historically flaky, cannot chmod). The install path is keyed by app
//! version, so presence == right version and upgrades are atomic renames;
//! concurrent app instances race harmlessly (same content, last rename wins).

use std::path::PathBuf;
use std::process::Stdio;

use crate::error::AppError;

/// One WSL distribution as shown in the picker.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct WslDistro {
    pub name: String,
    pub running: bool,
    pub is_default: bool,
}

/// Decode output written by wsl.exe itself. UTF-16LE (with or without BOM)
/// detected by the NUL pattern; plain UTF-8 passed through. `\r` and stray
/// NULs are stripped.
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    let utf16 = bytes.len() >= 2
        && (bytes.starts_with(&[0xFF, 0xFE])
            || bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count() * 4
                >= bytes.len());
    let s = if utf16 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    s.replace(['\u{FEFF}', '\r', '\0'], "")
}

/// Parse `wsl -l -q` output (one bare name per line).
pub fn parse_distro_list(decoded: &str) -> Vec<String> {
    decoded
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// The versioned agent path inside a distro (`~` is expanded by the login
/// shell that runs the deploy/spawn commands).
pub fn agent_install_dir(app_version: &str) -> String {
    format!("$HOME/.local/share/legit/agent/{app_version}")
}

pub fn agent_install_path(app_version: &str) -> String {
    format!("{}/legit-agent", agent_install_dir(app_version))
}

/// The shell command that receives the agent bytes on stdin and installs them
/// atomically. `$$`-suffixed temp name: never truncate a binary that might be
/// executing.
pub fn deploy_command(app_version: &str) -> String {
    let dir = agent_install_dir(app_version);
    let path = agent_install_path(app_version);
    format!("mkdir -p {dir} && cat > {path}.tmp.$$ && chmod +x {path}.tmp.$$ && mv -f {path}.tmp.$$ {path}")
}

/// The shell command that removes agent installs of OTHER versions (each
/// upgrade leaves the previous version-keyed dir behind). Tightly scoped:
/// only immediate subdirectories of the agent dir, never `bin/` or
/// `host-exe`, and never the version being kept.
pub fn prune_command(keep_version: &str) -> String {
    format!(
        "[ -d $HOME/.local/share/legit/agent ] && \
         find $HOME/.local/share/legit/agent -mindepth 1 -maxdepth 1 -type d \
         ! -name '{keep_version}' -exec rm -rf {{}} + || true"
    )
}

/// Remove stale (other-version) agent installs from `distro`. Best-effort:
/// callers log a failure, never fail the connection on it.
pub async fn prune_stale_agents(distro: &str, keep_version: &str) -> Result<(), AppError> {
    let out = wsl_command(Some(distro))
        .args(["--exec", "/bin/sh", "-c", &prune_command(keep_version)])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| AppError::Io(format!("wsl.exe: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Io(format!(
            "agent prune in '{distro}' failed: {}",
            decode_wsl_output(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// Convert a Windows path to its WSL-visible `/mnt/<drive>/...` form (for the
/// `legit .` launcher's host-exe file). Returns `None` for non-drive paths
/// (UNC etc.).
pub fn windows_path_to_wsl(win: &str) -> Option<String> {
    let mut chars = win.chars();
    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }
    let rest: String = chars.collect();
    let rest = rest.replace('\\', "/");
    let rest = rest.strip_prefix('/').unwrap_or(&rest);
    Some(format!(
        "/mnt/{}/{}",
        drive.to_ascii_lowercase(),
        rest
    ))
}

pub fn wsl_exe() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            return PathBuf::from(root).join("System32").join("wsl.exe");
        }
    }
    PathBuf::from("wsl.exe")
}

fn wsl_command(distro: Option<&str>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(wsl_exe());
    if let Some(d) = distro {
        cmd.arg("-d").arg(d);
    }
    #[cfg(windows)]
    // creation_flags is inherent on tokio's Command - no CommandExt needed.
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW (same as runner.rs)
    cmd.kill_on_drop(true);
    cmd
}

/// Enumerate distros: names via `-l -q`, running set via `-l -q --running`,
/// default from the registry (locale-proof, unlike parsing `-l -v` columns).
pub async fn list_distros() -> Result<Vec<WslDistro>, AppError> {
    let all = wsl_list(&["-l", "-q"]).await?;
    let running = wsl_list(&["-l", "-q", "--running"]).await.unwrap_or_default();
    let default = default_distro();
    Ok(all
        .into_iter()
        .map(|name| WslDistro {
            running: running.contains(&name),
            is_default: Some(&name) == default.as_ref(),
            name,
        })
        .collect())
}

async fn wsl_list(args: &[&str]) -> Result<Vec<String>, AppError> {
    let out = wsl_command(None)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| AppError::Io(format!("wsl.exe: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Io(format!(
            "wsl.exe {args:?} failed: {}",
            decode_wsl_output(&out.stderr).trim()
        )));
    }
    Ok(parse_distro_list(&decode_wsl_output(&out.stdout)))
}

/// Default distro from `HKCU\...\Lxss` (Windows only; `None` elsewhere or on
/// any lookup failure — the picker then simply preselects nothing).
pub fn default_distro() -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let lxss = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Lxss")
            .ok()?;
        let guid: String = lxss.get_value("DefaultDistribution").ok()?;
        let distro = lxss.open_subkey(&guid).ok()?;
        distro.get_value("DistributionName").ok()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Probe the distro's CPU architecture (`uname -m`) for picking the agent
/// build. Also serves as the "does this distro start at all?" check (any
/// command auto-starts a stopped distro; the first one may take seconds).
pub async fn distro_arch(distro: &str) -> Result<String, AppError> {
    let out = wsl_command(Some(distro))
        .args(["--exec", "uname", "-m"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| AppError::Io(format!("wsl.exe: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Io(format!(
            "could not start distro '{distro}': {}",
            decode_wsl_output(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Whether the version-keyed agent binary is already installed in `distro`.
pub async fn agent_installed(distro: &str, app_version: &str) -> Result<bool, AppError> {
    let path = agent_install_path(app_version);
    let status = wsl_command(Some(distro))
        .args(["--exec", "/bin/sh", "-c", &format!("test -x {path}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| AppError::Io(format!("wsl.exe: {e}")))?;
    Ok(status.success())
}

/// Install the agent bytes into `distro` (see module docs for the mechanism).
pub async fn deploy_agent(
    distro: &str,
    app_version: &str,
    agent_bytes: &[u8],
) -> Result<(), AppError> {
    use tokio::io::AsyncWriteExt;
    let mut child = wsl_command(Some(distro))
        .args(["--exec", "/bin/sh", "-c", &deploy_command(app_version)])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Io(format!("wsl.exe: {e}")))?;
    let mut stdin = child.stdin.take().expect("deploy stdin piped");
    stdin
        .write_all(agent_bytes)
        .await
        .map_err(|e| AppError::Io(format!("writing agent binary: {e}")))?;
    drop(stdin);
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Io(format!("wsl.exe: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Io(format!(
            "agent deploy into '{distro}' failed: {}",
            decode_wsl_output(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// Spawn the installed agent and return its stdio pipes plus the child (the
/// caller owns its lifetime). Login shell (`sh -l`) so the agent inherits the
/// user's profile env — `SSH_AUTH_SOCK`, PATH, proxies — which is what makes
/// agent-side git behave like the user's own terminal git. Banners a login
/// shell prints are discarded by the READY-line scan.
pub fn spawn_agent(
    distro: &str,
    app_version: &str,
) -> Result<(legit_host::AgentPipes, tokio::process::Child), AppError> {
    let path = agent_install_path(app_version);
    let mut child = wsl_command(Some(distro))
        .args([
            "--exec",
            "/bin/sh",
            "-lc",
            &format!("exec {path} --stdio"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::Io(format!("wsl.exe: {e}")))?;
    let pipes = legit_host::AgentPipes {
        writer: Box::new(child.stdin.take().expect("agent stdin piped")),
        reader: Box::new(child.stdout.take().expect("agent stdout piped")),
    };
    Ok((pipes, child))
}

/// The `legit` launcher script installed into the distro: `legit [dir]` opens
/// the directory's repo in the Windows app (WSL interop execs Windows exes
/// directly; the single-instance plugin forwards `--open` to a running app).
/// A plain POSIX script — arch-independent, auditable, survives agent
/// upgrades (it reads the CURRENT host-exe path at runtime).
pub fn launcher_script() -> &'static str {
    r#"#!/bin/sh
# LeGit launcher - open a repository from WSL in the LeGit app on Windows.
dir=${1:-.}
abs=$(cd "$dir" 2>/dev/null && pwd) || { echo "legit: no such directory: $dir" >&2; exit 1; }
exe_file="$HOME/.local/share/legit/host-exe"
[ -r "$exe_file" ] || { echo "legit: host app path unknown - open LeGit on Windows once to repair" >&2; exit 1; }
exe=$(cat "$exe_file")
[ -x "$exe" ] || { echo "legit: cannot run $exe (Windows interop disabled, or the app moved - open LeGit on Windows once to repair)" >&2; exit 1; }
exec "$exe" --open "wsl://${WSL_DISTRO_NAME}${abs}"
"#
}

/// The shell command that installs the launcher + host-exe file. Fed the
/// script on stdin (same byte-pipe mechanism as the agent deploy); the
/// host-exe path rides as `$0`-safe here-arg via env expansion — we pass it
/// pre-expanded in the command text, single-quoted.
fn launcher_install_command(host_exe_wsl_path: &str) -> String {
    let exe = host_exe_wsl_path.replace('\'', r"'\''");
    format!(
        "mkdir -p $HOME/.local/share/legit/bin && \
         cat > $HOME/.local/share/legit/bin/legit.tmp.$$ && \
         chmod +x $HOME/.local/share/legit/bin/legit.tmp.$$ && \
         mv -f $HOME/.local/share/legit/bin/legit.tmp.$$ $HOME/.local/share/legit/bin/legit && \
         printf '%s' '{exe}' > $HOME/.local/share/legit/host-exe && \
         if [ -d $HOME/.local/bin ]; then ln -sf $HOME/.local/share/legit/bin/legit $HOME/.local/bin/legit; fi",
        exe = exe
    )
}

/// Install/refresh the `legit` launcher and record the app exe's WSL-visible
/// path. Runs on every connect (self-heals after the app moves). Best-effort:
/// failures are the caller's to log, never to fail the connection on.
pub async fn install_launcher(distro: &str) -> Result<(), AppError> {
    use tokio::io::AsyncWriteExt;
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Io(format!("current_exe: {e}")))?
        .to_string_lossy()
        .into_owned();
    let Some(wsl_exe_path) = windows_path_to_wsl(&exe) else {
        // Non-drive path (or a Linux dev build): no interop launch possible.
        return Ok(());
    };
    let mut child = wsl_command(Some(distro))
        .args(["--exec", "/bin/sh", "-c", &launcher_install_command(&wsl_exe_path)])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Io(format!("wsl.exe: {e}")))?;
    let mut stdin = child.stdin.take().expect("launcher stdin piped");
    stdin
        .write_all(launcher_script().as_bytes())
        .await
        .map_err(|e| AppError::Io(format!("writing launcher: {e}")))?;
    drop(stdin);
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Io(format!("wsl.exe: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Io(format!(
            "launcher install into '{distro}' failed: {}",
            decode_wsl_output(&out.stderr).trim()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf16le_with_and_without_bom() {
        // "Ubuntu\r\ndebian\r\n" as UTF-16LE with BOM.
        let mut bytes = vec![0xFF, 0xFE];
        for u in "Ubuntu\r\ndebian\r\n".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_wsl_output(&bytes), "Ubuntu\ndebian\n");
        // Without BOM (what a pipe usually carries).
        assert_eq!(decode_wsl_output(&bytes[2..]), "Ubuntu\ndebian\n");
        // Plain UTF-8 (some environments): passed through.
        assert_eq!(decode_wsl_output(b"Ubuntu\r\n"), "Ubuntu\n");
    }

    #[test]
    fn parses_distro_lists() {
        assert_eq!(
            parse_distro_list("Ubuntu\n\ndebian \n"),
            vec!["Ubuntu".to_string(), "debian".to_string()]
        );
        assert!(parse_distro_list("").is_empty());
    }

    #[test]
    fn deploy_command_is_atomic_and_version_keyed() {
        let cmd = deploy_command("1.2.3");
        assert!(cmd.contains("$HOME/.local/share/legit/agent/1.2.3/legit-agent"));
        assert!(cmd.contains("mkdir -p"));
        assert!(cmd.contains(".tmp.$$"), "temp file must be pid-suffixed");
        assert!(cmd.contains("mv -f"), "install must be an atomic rename");
        // chmod happens BEFORE the rename, never on the live path.
        let chmod = cmd.find("chmod +x").unwrap();
        let mv = cmd.find("mv -f").unwrap();
        assert!(chmod < mv);
    }

    #[test]
    fn prune_command_is_scoped_to_other_agent_versions() {
        let cmd = prune_command("1.2.3");
        // Never the version being kept.
        assert!(cmd.contains("! -name '1.2.3'"));
        // Only immediate children of the agent dir — never bin/ or host-exe.
        assert!(cmd.contains("$HOME/.local/share/legit/agent"));
        assert!(cmd.contains("-mindepth 1"));
        assert!(cmd.contains("-maxdepth 1"));
        assert!(cmd.contains("-type d"));
        assert!(!cmd.contains("legit/bin"));
    }

    #[test]
    fn windows_paths_convert_to_wsl_mounts() {
        assert_eq!(
            windows_path_to_wsl(r"C:\Program Files\LeGit\legit.exe").as_deref(),
            Some("/mnt/c/Program Files/LeGit/legit.exe")
        );
        assert_eq!(
            windows_path_to_wsl(r"d:\x\y").as_deref(),
            Some("/mnt/d/x/y")
        );
        assert_eq!(windows_path_to_wsl(r"\\server\share\x"), None);
        assert_eq!(windows_path_to_wsl("relative"), None);
    }
}
