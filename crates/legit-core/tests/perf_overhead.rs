//! Local measurements, never part of a normal test run: every test here is
//! `#[ignore]` and prints a table instead of asserting. Run through
//! `scripts/perf.ps1`, which sets the environment below.
//!
//! - `LEGIT_PERF_REPO`: the repository to measure against (required).
//! - `LEGIT_PERF_GIT`: `;`-separated git binaries to compare (default `git`).
//! - `LEGIT_PERF_ROUNDS`: samples per cell (default 40).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use legit_core::runner::GitRequest;
use legit_core::{GitBackend, GitCliBackend, GitRunner, LocalFs};

const WARMUP_ROUNDS: usize = 3;

fn repo() -> PathBuf {
    PathBuf::from(std::env::var("LEGIT_PERF_REPO").expect("set LEGIT_PERF_REPO to a repository path"))
}

fn git_binaries() -> Vec<String> {
    std::env::var("LEGIT_PERF_GIT")
        .unwrap_or_else(|_| "git".to_string())
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect()
}

fn rounds() -> usize {
    std::env::var("LEGIT_PERF_ROUNDS").ok().and_then(|v| v.parse().ok()).unwrap_or(40)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn percentile(samples: &mut [f64], p: f64) -> f64 {
    samples.sort_by(|a, b| a.total_cmp(b));
    let idx = ((samples.len() as f64 - 1.0) * p).round() as usize;
    samples[idx]
}

fn bare(git: &str, cwd: &Path, args: &[&str]) -> Duration {
    let started = Instant::now();
    let out = Command::new(git)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .expect("spawn git");
    std::hint::black_box(out.stdout.len());
    started.elapsed()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "local measurement, run through scripts/perf.ps1"]
async fn wrapper_overhead() {
    let repo = repo();
    let rounds = rounds();
    let commands: [&[&str]; 4] = [
        &["rev-parse", "HEAD"],
        &["log", "-1", "--format=%H"],
        &["status", "--porcelain=v2", "-z"],
        &["for-each-ref", "--format=%(refname)"],
    ];

    println!("\n## Wrapper overhead ({rounds} rounds, median / p90 in ms)\n");
    println!("| git binary | command | bare | through GitRunner | overhead | overhead % |");
    println!("|---|---|---|---|---|---|");
    for git in git_binaries() {
        let runner = GitRunner::for_repo(&git, &repo);
        for args in commands {
            let mut bare_ms = Vec::with_capacity(rounds);
            let mut wrapped_ms = Vec::with_capacity(rounds);
            for round in 0..rounds + WARMUP_ROUNDS {
                let b = bare(&git, &repo, args);
                let started = Instant::now();
                let out = runner.execute(GitRequest::new(args)).await.expect("runner");
                let w = started.elapsed();
                std::hint::black_box(out.stdout.len());
                if round >= WARMUP_ROUNDS {
                    bare_ms.push(ms(b));
                    wrapped_ms.push(ms(w));
                }
            }
            let (b50, b90) = (percentile(&mut bare_ms, 0.5), percentile(&mut bare_ms, 0.9));
            let (w50, w90) = (percentile(&mut wrapped_ms, 0.5), percentile(&mut wrapped_ms, 0.9));
            println!(
                "| {git} | {} | {b50:.1} / {b90:.1} | {w50:.1} / {w90:.1} | {:+.1} | {:+.0}% |",
                args.join(" "),
                w50 - b50,
                (w50 - b50) / b50 * 100.0,
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "local measurement, run through scripts/perf.ps1"]
async fn refresh_costs() {
    let repo = repo();
    let rounds = rounds().min(15);
    let git = git_binaries().remove(0);
    let runner = GitRunner::for_repo(&git, &repo);
    let backend = GitCliBackend::new(
        Arc::new(tokio::sync::RwLock::new(Arc::new(runner))),
        Arc::new(LocalFs),
    );

    let mut bare_status = Vec::new();
    let mut status = Vec::new();
    let mut counts = Vec::new();
    let mut entries = 0;
    for round in 0..rounds + 1 {
        let b = bare(&git, &repo, &["status", "--porcelain=v2", "-z"]);
        let started = Instant::now();
        entries = backend.status().await.expect("status").len();
        let s = started.elapsed();
        let started = Instant::now();
        backend.status_with_counts().await.expect("status_with_counts");
        let c = started.elapsed();
        if round >= 1 {
            bare_status.push(ms(b));
            status.push(ms(s));
            counts.push(ms(c));
        }
    }

    println!("\n## Refresh cost on {} ({entries} status entries, {rounds} rounds, median / p90 in ms)\n", repo.display());
    println!("| what | median | p90 |");
    println!("|---|---|---|");
    for (name, mut samples) in [
        ("bare `git status`", bare_status),
        ("backend `status()`", status),
        ("backend `status_with_counts()`", counts),
    ] {
        println!("| {name} | {:.1} | {:.1} |", percentile(&mut samples, 0.5), percentile(&mut samples, 0.9));
    }
}

/// Where the wrapper's per-call cost comes from: the same bare spawn under
/// each process-creation mode the runner could use.
#[cfg(windows)]
#[test]
#[ignore = "local measurement, run through scripts/perf.ps1"]
fn spawn_cost_breakdown() {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    let repo = repo();
    let rounds = rounds();
    let args = ["rev-parse", "HEAD"];
    let modes: [(&str, u32); 3] = [
        ("inherited console", 0),
        ("CREATE_NO_WINDOW", CREATE_NO_WINDOW),
        ("DETACHED_PROCESS", DETACHED_PROCESS),
    ];

    println!("\n## Spawn cost by creation mode (`rev-parse HEAD`, {rounds} rounds, ms)\n");
    println!("| git binary | mode | median | p90 |");
    println!("|---|---|---|---|");
    for git in git_binaries() {
        let mut samples: Vec<Vec<f64>> = vec![Vec::new(); modes.len()];
        for round in 0..rounds + WARMUP_ROUNDS {
            for (i, (_, flags)) in modes.iter().enumerate() {
                let started = Instant::now();
                let out = Command::new(&git)
                    .args(args)
                    .current_dir(&repo)
                    .stdin(Stdio::null())
                    .creation_flags(*flags)
                    .output()
                    .expect("spawn git");
                assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
                if round >= WARMUP_ROUNDS {
                    samples[i].push(ms(started.elapsed()));
                }
            }
        }
        for (i, (name, _)) in modes.iter().enumerate() {
            println!(
                "| {git} | {name} | {:.1} | {:.1} |",
                percentile(&mut samples[i], 0.5),
                percentile(&mut samples[i], 0.9)
            );
        }
    }
}

/// The runner with the shared console must cost about a bare spawn.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "local measurement, run through scripts/perf.ps1"]
async fn wrapper_overhead_with_shared_console() {
    assert!(legit_core::runner::ensure_shared_console());
    let repo = repo();
    let rounds = rounds();
    let args = ["rev-parse", "HEAD"];
    println!("\n## Wrapper overhead with the shared console (`rev-parse HEAD`, {rounds} rounds, ms)\n");
    println!("| git binary | bare | through GitRunner | overhead |");
    println!("|---|---|---|---|");
    for git in git_binaries() {
        let runner = GitRunner::for_repo(&git, &repo);
        let (mut b, mut w) = (Vec::new(), Vec::new());
        for round in 0..rounds + WARMUP_ROUNDS {
            let bare_time = bare(&git, &repo, &args);
            let started = Instant::now();
            runner.execute(GitRequest::new(&args)).await.expect("runner");
            let wrapped = started.elapsed();
            if round >= WARMUP_ROUNDS {
                b.push(ms(bare_time));
                w.push(ms(wrapped));
            }
        }
        let (b50, w50) = (percentile(&mut b, 0.5), percentile(&mut w, 0.5));
        println!("| {git} | {b50:.1} | {w50:.1} | {:+.1} |", w50 - b50);
    }
}
