//! Starting a program detached on the app machine. Windows needs care:
//! `.cmd`/`.bat` shims (VS Code's `code`, ...) cannot be started directly by
//! CreateProcess, and a PATH lookup must honour PATHEXT.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::HostError;

/// Resolve a program name against a PATH directory list. A name containing a
/// path separator is used as-is. Otherwise each directory is tried with the
/// name verbatim and with each extension in `exts` appended (Windows PATHEXT;
/// empty elsewhere). `exists` is injected so the search logic is testable.
fn find_in_path(
    prog: &str,
    dirs: &[PathBuf],
    exts: &[String],
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if prog.contains('/') || prog.contains('\\') {
        let p = PathBuf::from(prog);
        return exists(&p).then_some(p);
    }
    for dir in dirs {
        let candidate = dir.join(prog);
        if exists(&candidate) {
            return Some(candidate);
        }
        for ext in exts {
            let with_ext = dir.join(format!("{prog}{ext}"));
            if exists(&with_ext) {
                return Some(with_ext);
            }
        }
    }
    None
}

/// The OS-specific extension list for PATH lookups: PATHEXT on Windows
/// (lower-cased, e.g. `.com;.exe;.bat;.cmd`), empty elsewhere.
fn path_extensions() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_lowercase())
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

/// Resolve the template's program against the real PATH, giving a clear
/// "not found" error instead of a raw spawn failure.
pub(crate) fn resolve_program(prog: &str) -> Result<PathBuf, HostError> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    find_in_path(prog, &dirs, &path_extensions(), &|p| p.is_file())
        .ok_or_else(|| HostError::ProgramNotFound(prog.to_string()))
}

/// Quote one argument for `cmd.exe`'s command line.
///
/// `cmd` is a shell: it re-parses `&`, `|`, `<`, `>`, `^`, `(`, `)` in the
/// command line it is handed. Rust's `Command` quotes an argument only when it
/// contains a space, a tab or a quote (MSVCRT rules), so `C:\r\a&calc.txt`
/// would reach `cmd` unquoted and the `&` would start a second command. Rust's
/// own batch-file escaping (1.77.2, CVE-2024-24576) does not help here: it
/// applies when the PROGRAM is the `.bat`/`.cmd` file, not when `cmd` is
/// invoked explicitly.
///
/// Wrapping in double quotes is what neutralizes the metacharacters - `cmd`
/// does not interpret them inside quotes. An argument that itself contains a
/// double quote cannot be quoted safely, so it is refused; Windows forbids `"`
/// in path names, so no real file hits that. `%VAR%` still expands (quotes do
/// not stop `cmd`'s variable expansion) - that can pick the wrong path for a
/// file literally named `%…%`, but it cannot start a command.
/// (Windows-only in effect, but compiled everywhere so its unit tests run on
/// every platform - CI is Linux.)
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn quote_for_cmd(arg: &str) -> Result<String, HostError> {
    if arg.contains('"') || arg.contains('\n') || arg.contains('\r') {
        return Err(HostError::Spawn {
            program: "cmd".to_string(),
            message: format!("cannot pass {arg:?} to a .cmd/.bat program: it contains a quote or newline"),
        });
    }
    Ok(format!("\"{arg}\""))
}

/// The full `cmd /S /C "…"` command line for a batch-shim editor.
///
/// `/S` makes `cmd` strip exactly the outer pair of quotes and take the rest
/// verbatim, which is the documented way to hand it an already-quoted command
/// line. Every token (the shim path included) is quoted by `quote_for_cmd`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn build_cmd_command_line(program: &Path, args: &[String]) -> Result<String, HostError> {
    let mut line = quote_for_cmd(&program.to_string_lossy())?;
    for a in args {
        line.push(' ');
        line.push_str(&quote_for_cmd(a)?);
    }
    Ok(format!("\"{line}\""))
}

/// Spawn `program` detached on the app machine (fire-and-forget: only a
/// failure to start is reported). On Windows, `.cmd`/`.bat` shims (VS Code's `code`, etc.) cannot
/// be spawned directly by CreateProcess - they run through `cmd /S /C`, whose
/// command line is built and quoted by hand (see `quote_for_cmd`: the paths
/// come from the working tree, so a file name can carry shell metacharacters).
pub(crate) fn spawn_detached(program: &str, args: &[String], cwd: Option<&Path>) -> Result<(), HostError> {
    let name = program;
    let program = resolve_program(program)?;

    #[allow(unused_mut)]
    let mut cmd;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let is_batch = program
            .extension()
            .map(|e| {
                let e = e.to_string_lossy().to_lowercase();
                e == "cmd" || e == "bat"
            })
            .unwrap_or(false);
        if is_batch {
            cmd = Command::new("cmd");
            // raw_arg: the line is already quoted for `cmd`; letting Rust
            // re-quote it would break the `/S` contract.
            cmd.arg("/S")
                .arg("/C")
                .raw_arg(build_cmd_command_line(&program, args)?);
        } else {
            cmd = Command::new(&program);
            cmd.args(args);
        }
        // No console flash for the wrapper; the editor's own window still shows.
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(target_os = "windows"))]
    {
        cmd = Command::new(&program);
        cmd.args(args);
    }

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| HostError::Spawn { program: name.to_string(), message: e.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_in_path_tries_extensions_in_order() {
        let dirs = vec![PathBuf::from("/bin"), PathBuf::from("/usr/bin")];
        let exts = vec![".exe".to_string(), ".cmd".to_string()];
        let existing = PathBuf::from("/usr/bin/code.cmd");
        let found = find_in_path("code", &dirs, &exts, &|p| p == existing);
        assert_eq!(found, Some(existing));
    }

    #[test]
    fn find_in_path_prefers_verbatim_name() {
        let dirs = vec![PathBuf::from("/bin")];
        let found = find_in_path("ed", &dirs, &[], &|p| p == Path::new("/bin/ed"));
        assert_eq!(found, Some(PathBuf::from("/bin/ed")));
    }

    #[test]
    fn find_in_path_uses_explicit_paths_verbatim() {
        // A name with a separator is not searched, just checked.
        assert_eq!(
            find_in_path("/opt/ed", &[PathBuf::from("/bin")], &[], &|p| p
                == Path::new("/opt/ed")),
            Some(PathBuf::from("/opt/ed"))
        );
        assert_eq!(
            find_in_path("/missing/ed", &[PathBuf::from("/bin")], &[], &|_| false),
            None
        );
    }

    #[test]
    fn find_in_path_misses_cleanly() {
        assert_eq!(find_in_path("nope", &[PathBuf::from("/bin")], &[], &|_| false), None);
    }

    /// The injection this guards: working-tree file names reach the editor as
    /// arguments, `&` is legal in a Windows file name, and Rust quotes an
    /// argument only if it contains a space/tab/quote - so `a&calc.txt` used
    /// to arrive at `cmd` unquoted, where `&` starts a second command. Every
    /// argument must come back wrapped in quotes, metacharacters or not.
    #[test]
    fn cmd_quoting_neutralizes_shell_metacharacters() {
        for evil in [
            r"C:\repo\a&calc.txt",
            r"C:\repo\a|calc.txt",
            r"C:\repo\a^calc.txt",
            r"C:\repo\a>out.txt",
            r"C:\repo\a<in.txt",
            r"C:\repo\(a).txt",
            // No metacharacter and no space: the case Rust leaves unquoted.
            r"C:\repo\plain.txt",
        ] {
            let quoted = quote_for_cmd(evil).expect("quotable");
            assert_eq!(quoted, format!("\"{evil}\""), "must be wrapped in quotes");
        }
    }

    /// A quote cannot be escaped for `cmd` safely, so it is refused rather
    /// than passed through (Windows forbids `"` in path names anyway).
    #[test]
    fn cmd_quoting_refuses_unquotable_arguments() {
        assert!(quote_for_cmd(r#"a"b"#).is_err());
        assert!(quote_for_cmd("a\nb").is_err());
        assert!(quote_for_cmd("a\rb").is_err());
    }

    /// `/S` strips exactly the OUTER quote pair, so the whole line is wrapped
    /// once and every token inside it is quoted individually.
    #[test]
    fn cmd_command_line_wraps_program_and_args() {
        let line = build_cmd_command_line(
            Path::new(r"C:\Program Files\Microsoft VS Code\bin\code.cmd"),
            &[r"C:\repo".to_string(), r"C:\repo\a&calc.txt".to_string()],
        )
        .expect("line");
        assert_eq!(
            line,
            r#"""C:\Program Files\Microsoft VS Code\bin\code.cmd" "C:\repo" "C:\repo\a&calc.txt"""#
        );
    }
}
