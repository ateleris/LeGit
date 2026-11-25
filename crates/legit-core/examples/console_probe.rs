//! Local measurement: what a git spawn costs from a windowed process (no
//! console of its own), with a per-call hidden console versus one shared
//! hidden console. Writes its table to the file given as the third argument.
//!
//!   console_probe.exe <git> <repo> <report-file> [rounds]
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn main() {
    use std::fmt::Write as _;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    use windows_sys::Win32::System::Console::{GetConsoleCP, GetConsoleWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let args: Vec<String> = std::env::args().collect();
    let (git, repo, report) = (&args[1], &args[2], &args[3]);
    let rounds: usize = args.get(4).and_then(|v| v.parse().ok()).unwrap_or(40);

    let spawn = |flags: u32| {
        let started = Instant::now();
        let out = Command::new(git)
            .args(["rev-parse", "HEAD"])
            .current_dir(repo)
            .stdin(Stdio::null())
            .creation_flags(flags)
            .output()
            .expect("spawn git");
        assert!(out.status.success());
        started.elapsed().as_secs_f64() * 1000.0
    };
    let median = |mut v: Vec<f64>| {
        v.sort_by(|a, b| a.total_cmp(b));
        (v[v.len() / 2], v[v.len() * 9 / 10])
    };

    let mut out = String::new();
    let had_console = unsafe { GetConsoleCP() } != 0;
    writeln!(out, "started with a console: {had_console}").unwrap();

    for _ in 0..3 {
        spawn(CREATE_NO_WINDOW);
    }
    let per_call = median((0..rounds).map(|_| spawn(CREATE_NO_WINDOW)).collect());

    let attach_started = Instant::now();
    let shared = legit_core::runner::ensure_shared_console();
    let attach_ms = attach_started.elapsed().as_secs_f64() * 1000.0;
    let window = unsafe { GetConsoleWindow() };
    let visible = !window.is_null() && unsafe { IsWindowVisible(window) } != 0;
    writeln!(out, "shared console created: {shared} in {attach_ms:.1} ms, window visible: {visible}").unwrap();

    for _ in 0..3 {
        spawn(0);
    }
    let inherited = median((0..rounds).map(|_| spawn(0)).collect());
    let again = median((0..rounds).map(|_| spawn(CREATE_NO_WINDOW)).collect());

    writeln!(out, "\n| mode | median ms | p90 ms |\n|---|---|---|").unwrap();
    writeln!(out, "| per-call hidden console (today) | {:.1} | {:.1} |", per_call.0, per_call.1).unwrap();
    writeln!(out, "| shared hidden console | {:.1} | {:.1} |", inherited.0, inherited.1).unwrap();
    writeln!(out, "| per-call hidden console, measured again | {:.1} | {:.1} |", again.0, again.1).unwrap();
    std::fs::write(report, out).expect("write report");
}
