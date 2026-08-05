//! Git Console command (DESIGN.md §7.4).
//!
//! Runs user-typed args against the active repo through the *same*
//! `GitRunner` every other panel will use. The args are tokenized with
//! `shlex`, validated against a small blocklist (`-C`, `--git-dir`,
//! `--work-tree`), and streamed through Tauri events keyed by `op_id`.
//!
//! Output events are BATCHED (`pump_console_events`): the runner's
//! line-per-event stream is coalesced into one Tauri emit per flush window.
//! One IPC event per line melted the frontend on large outputs (`git log`
//! dumps a whole history in milliseconds), and - worse - made cancellation
//! look broken: the process died but the already-queued backlog kept
//! flooding the panel. Cancelling sets a per-op flag that drops all
//! remaining output; only `Finished` still goes through.
//!
//! Output is also PAGED like a terminal pager: the frontend grants a
//! stdout-line credit (`initial_credit`, topped up via `console_feed`), and
//! when it runs out the pump stops consuming. The stream channel is bounded,
//! so a paused pump stops the pipe readers, the OS pipe fills, and git
//! itself blocks mid-`log` - true `less`-style backpressure, the command
//! waits for the user instead of racing to EOF. stderr never counts against
//! the credit (pagers gate stdout only).
//!
//! `| grep` is supported WITHOUT a shell: the pipeline is split on
//! standalone `|` tokens, every stage must be `grep` (anything else is
//! rejected), and matching happens in the pump on stdout lines (stderr
//! passes through, like a real pipe). Only matching lines spend credit, so
//! `log | grep rare` scans far and still pages by visible lines.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::{OperationId, RunnerEvent};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::{mpsc, Notify};

pub const CONSOLE_OUTPUT_EVENT: &str = "legit://console-output";

/// How long output lines are coalesced before a flush.
const FLUSH_INTERVAL: Duration = Duration::from_millis(25);
/// Flush early once a batch reaches this many events, so a flood cannot
/// build an arbitrarily large single IPC payload.
const MAX_BATCH: usize = 500;
/// Stream channel capacity. Small on purpose: it bounds how much output a
/// paused op can have "in flight" past the credit (channel + OS pipe) before
/// git blocks.
const STREAM_BUFFER: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConsoleEventPayload {
    pub op_id: String,
    /// Every event that arrived within the flush window, in order.
    pub events: Vec<RunnerEvent>,
    /// True when the op is now paused waiting for more credit (the pager's
    /// "-- More --" state): the frontend continues it via `console_feed`.
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConsoleExecHandle {
    pub op_id: String,
    pub argv: Vec<String>,
}

/// Shared per-op control state: the cancel flag (set by `console_cancel`
/// BEFORE the process is killed so the pump drops the backlog instantly)
/// and the remaining stdout-line credit (topped up by `console_feed`).
struct ConsoleOpState {
    cancelled: AtomicBool,
    stdout_credit: AtomicI64,
    /// Wakes the pump the moment a cancel/feed lands, instead of it
    /// noticing on the next flush tick (a q would otherwise pay up to
    /// `FLUSH_INTERVAL` extra latency).
    wake: Notify,
}

/// In-flight console ops, keyed by op id; entries removed when the pump ends.
fn console_ops() -> &'static Mutex<HashMap<String, Arc<ConsoleOpState>>> {
    static OPS: OnceLock<Mutex<HashMap<String, Arc<ConsoleOpState>>>> = OnceLock::new();
    OPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One compiled `| grep …` stage of a console pipeline.
struct GrepStage {
    regex: regex::Regex,
    invert: bool,
}

impl GrepStage {
    /// Match against the line with ANSI colour codes stripped - the console
    /// injects `color.ui=always`, and a pattern must not fail because an
    /// escape sequence sits in the middle of the text.
    fn matches(&self, line: &str) -> bool {
        self.regex.is_match(&strip_ansi(line)) != self.invert
    }
}

fn strip_ansi(line: &str) -> std::borrow::Cow<'_, str> {
    static ANSI: OnceLock<regex::Regex> = OnceLock::new();
    ANSI.get_or_init(|| regex::Regex::new("\x1b\\[[0-9;]*m").expect("static regex"))
        .replace_all(line, "")
}

/// Parse the arguments of one `grep` stage. Deliberately small: `-i`, `-v`,
/// `-F`, `-w`, `-E` (our patterns are ERE-like already) and their long
/// forms. Unsupported flags are ERRORS, never silently ignored - a dropped
/// `-v` would show the exact opposite of what the user asked for.
fn parse_grep_stage(args: &[String]) -> Result<GrepStage, AppError> {
    let mut ignore_case = false;
    let mut invert = false;
    let mut fixed = false;
    let mut word = false;
    let mut pattern: Option<&String> = None;
    for arg in args {
        match arg.as_str() {
            "--ignore-case" => ignore_case = true,
            "--invert-match" => invert = true,
            "--fixed-strings" => fixed = true,
            "--word-regexp" => word = true,
            "--extended-regexp" => {}
            long if long.starts_with("--") => {
                return Err(AppError::ParseArgs(format!(
                    "grep: unsupported flag {long} (supported: -i -v -F -w -E)"
                )));
            }
            short if short.starts_with('-') && short.len() > 1 => {
                for c in short[1..].chars() {
                    match c {
                        'i' => ignore_case = true,
                        'v' => invert = true,
                        'F' => fixed = true,
                        'w' => word = true,
                        'E' => {}
                        other => {
                            return Err(AppError::ParseArgs(format!(
                                "grep: unsupported flag -{other} (supported: -i -v -F -w -E)"
                            )));
                        }
                    }
                }
            }
            _ if pattern.is_none() => pattern = Some(arg),
            _ => {
                return Err(AppError::ParseArgs(
                    "grep: only one pattern is supported".to_string(),
                ));
            }
        }
    }
    let pattern =
        pattern.ok_or_else(|| AppError::ParseArgs("grep: missing pattern".to_string()))?;
    let mut body = if fixed {
        regex::escape(pattern)
    } else {
        pattern.clone()
    };
    if word {
        body = format!(r"\b(?:{body})\b");
    }
    let full = if ignore_case { format!("(?i){body}") } else { body };
    let regex = regex::Regex::new(&full)
        .map_err(|e| AppError::ParseArgs(format!("grep: invalid pattern: {e}")))?;
    Ok(GrepStage { regex, invert })
}

/// Split `<git args> | grep … | grep …` on standalone `|` tokens (a `|`
/// inside a quoted argument stays part of that argument - shlex already
/// resolved quoting). The first segment is the git command; every later
/// segment must be a `grep` stage - the console is not a shell, and
/// anything else is rejected up front.
fn split_console_pipeline(argv: Vec<String>) -> Result<(Vec<String>, Vec<GrepStage>), AppError> {
    let mut segments = argv.split(|a| a == "|");
    let git: Vec<String> = segments.next().unwrap_or(&[]).to_vec();
    if git.is_empty() {
        return Err(AppError::ParseArgs("empty command".to_string()));
    }
    let mut stages = Vec::new();
    for segment in segments {
        match segment.first().map(String::as_str) {
            Some("grep") => stages.push(parse_grep_stage(&segment[1..])?),
            Some(other) => {
                return Err(AppError::ParseArgs(format!(
                    "only `| grep` is supported after a pipe (got `{other}`)"
                )));
            }
            None => {
                return Err(AppError::ParseArgs("missing command after `|`".to_string()));
            }
        }
    }
    Ok((git, stages))
}

#[tauri::command]
#[specta::specta]
pub async fn console_exec(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    repo_id: String,
    command: String,
    initial_credit: Option<u32>,
) -> Result<ConsoleExecHandle, AppError> {
    let session = state.get_session(&repo_id).await?;

    let tokens = shlex::split(&command)
        .ok_or_else(|| AppError::ParseArgs("unterminated quote or escape".to_string()))?;
    if tokens.is_empty() {
        return Err(AppError::ParseArgs("empty command".to_string()));
    }
    let (argv, filters) = split_console_pipeline(tokens)?;
    validate_console_args(&argv)?;

    let op_id = OperationId::new();
    let op_id_str = op_id.0.clone();

    let op_state = Arc::new(ConsoleOpState {
        cancelled: AtomicBool::new(false),
        // No credit given = unlimited (no paging).
        stdout_credit: AtomicI64::new(initial_credit.map_or(i64::MAX, i64::from)),
        wake: Notify::new(),
    });
    console_ops()
        .lock()
        .expect("console ops poisoned")
        .insert(op_id_str.clone(), op_state.clone());

    let runner = session.runner.read().await.clone();
    let app_handle = app.clone();
    let op_id_for_emit = op_id_str.clone();
    let op_id_for_cleanup = op_id_str.clone();
    let argv_owned = argv.clone();

    // Run the streaming op in a background task. The command returns the
    // OperationId immediately; the frontend already subscribed to the
    // CONSOLE_OUTPUT_EVENT channel and filters by op_id.
    tokio::spawn(async move {
        let (tx, rx) = mpsc::channel::<RunnerEvent>(STREAM_BUFFER);

        let runner_for_stream = runner;
        let argv_for_stream = argv_owned;
        let op_id_for_stream = op_id;
        let stream_handle = tokio::spawn(async move {
            // The console is the one surface where a human reads raw git
            // output, so ask for colour: piped stdout makes `color.ui=auto`
            // resolve to off. Console-only - parsers everywhere else keep
            // uncoloured output.
            let mut refs: Vec<&str> = vec!["-c", "color.ui=always"];
            refs.extend(argv_for_stream.iter().map(|s| s.as_str()));
            let _ = runner_for_stream.stream(&refs, op_id_for_stream, tx).await;
        });

        pump_console_events(rx, op_state, filters, |events, paused| {
            let payload = ConsoleEventPayload {
                op_id: op_id_for_emit.clone(),
                events,
                paused,
            };
            app_handle.emit(CONSOLE_OUTPUT_EVENT, payload).is_ok()
        })
        .await;

        let _ = stream_handle.await;
        console_ops()
            .lock()
            .expect("console ops poisoned")
            .remove(&op_id_for_cleanup);
    });

    Ok(ConsoleExecHandle {
        op_id: op_id_str,
        argv,
    })
}

/// Grant more stdout-line credit to a paused op (the pager's "next page").
/// Returns false when the op no longer exists (it finished or was killed).
#[tauri::command]
#[specta::specta]
pub async fn console_feed(op_id: String, lines: u32) -> Result<bool, AppError> {
    let op = console_ops()
        .lock()
        .expect("console ops poisoned")
        .get(&op_id)
        .cloned();
    match op {
        Some(op) => {
            // Saturating: a feed must never overflow an unlimited
            // (i64::MAX) credit into a negative, paused one.
            let _ = op.stdout_credit.fetch_update(
                Ordering::Relaxed,
                Ordering::Relaxed,
                |credit| Some(credit.saturating_add(i64::from(lines))),
            );
            op.wake.notify_one();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// How many paused-stdout lines the pump parks OUTSIDE the channel so that
/// stderr and `Finished` queued behind them still flow (pagers gate stdout
/// only). Bounded: past this the channel gate closes again and the bounded
/// channel blocks git as before.
const HELD_STDOUT_CAP: usize = 500;

/// Coalesce runner events into batches for `emit(events, paused)`. Flushes
/// on a `Finished` event, when the batch hits `MAX_BATCH`, when the stdout
/// credit runs out (flagging the batch `paused`), on the flush tick, and on
/// channel close.
///
/// While out of credit, stdout lines are parked in a bounded side buffer
/// (`HELD_STDOUT_CAP`) instead of being emitted, so stderr and `Finished`
/// behind them in the channel still flow - only once the buffer fills does
/// the pump stop consuming, and the bounded channel blocks git (see module
/// docs). A `Finished` that arrives while stdout is parked is itself held:
/// the pause persists until the user pages through (`console_feed`) or
/// cancels. Feed/cancel are noticed via `wake` or on the next tick. Once
/// `cancelled` is set, parked and future output is dropped and consumption
/// resumes so the stream can drain; only `Finished` is still delivered (it
/// carries the "killed" status the panel prints).
async fn pump_console_events(
    mut rx: mpsc::Receiver<RunnerEvent>,
    state: Arc<ConsoleOpState>,
    filters: Vec<GrepStage>,
    mut emit: impl FnMut(Vec<RunnerEvent>, bool) -> bool,
) {
    let mut pending: Vec<RunnerEvent> = Vec::new();
    // Stdout received with no credit left, parked unemitted (see above).
    let mut held: std::collections::VecDeque<RunnerEvent> = std::collections::VecDeque::new();
    // A `Finished` that arrived while stdout was parked - delivered when the
    // parked lines have drained (or on cancel).
    let mut finished_held: Option<RunnerEvent> = None;
    let mut rx_closed = false;
    // Whether the frontend has been told about the current pause, so quiet
    // ticks don't repeat the empty `paused` payload.
    let mut announced_pause = false;
    // First tick one interval OUT: `interval()` fires its first tick
    // immediately, and select! polls branches in random order, so that
    // ready-from-birth tick could win an early iteration and flush a partial
    // batch (a real flake: MAX_BATCH batches split at arbitrary points).
    let mut ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + FLUSH_INTERVAL,
        FLUSH_INTERVAL,
    );
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let cancelled = state.cancelled.load(Ordering::Relaxed);
        let recv_open = !rx_closed && (cancelled || held.len() < HELD_STDOUT_CAP);
        tokio::select! {
            // A cancel/feed landed: fall through to the post-step below.
            _ = state.wake.notified() => {}
            maybe = rx.recv(), if recv_open => match maybe {
                Some(event) => {
                    let finished = matches!(event, RunnerEvent::Finished { .. });
                    if cancelled && !finished {
                        pending.clear();
                        held.clear();
                        continue;
                    }
                    if let RunnerEvent::Stdout { line } = &event {
                        // `| grep` stages: a filtered-out line is consumed
                        // silently and spends NO credit - the pager counts
                        // lines the user will actually see.
                        if !filters.iter().all(|f| f.matches(line)) {
                            continue;
                        }
                        if state.stdout_credit.load(Ordering::Relaxed) <= 0 {
                            held.push_back(event);
                            continue;
                        }
                        state.stdout_credit.fetch_sub(1, Ordering::Relaxed);
                    }
                    if finished && !cancelled && !held.is_empty() {
                        finished_held = Some(event);
                        continue;
                    }
                    pending.push(event);
                    let now_paused = !finished
                        && !cancelled
                        && state.stdout_credit.load(Ordering::Relaxed) <= 0;
                    if finished || now_paused || pending.len() >= MAX_BATCH {
                        if !emit(std::mem::take(&mut pending), now_paused) {
                            return;
                        }
                        announced_pause = now_paused;
                        if finished {
                            return;
                        }
                    }
                    continue;
                }
                None => {
                    rx_closed = true;
                }
            },
            _ = ticker.tick() => {}
        }

        // Post-step, reached on wake, tick, or channel close: cancel wins,
        // then fresh credit drains the parked stdout, then flush.
        if state.cancelled.load(Ordering::Relaxed) {
            pending.clear();
            held.clear();
            if let Some(finished) = finished_held.take() {
                let _ = emit(vec![finished], false);
                return;
            }
            if rx_closed {
                // Nothing more can arrive and there is no Finished to wait
                // for - the runner died without one.
                return;
            }
            continue;
        }
        while !held.is_empty() && state.stdout_credit.load(Ordering::Relaxed) > 0 {
            state.stdout_credit.fetch_sub(1, Ordering::Relaxed);
            pending.push(held.pop_front().expect("checked non-empty"));
        }
        if held.is_empty() {
            if let Some(finished) = finished_held.take() {
                pending.push(finished);
                let _ = emit(std::mem::take(&mut pending), false);
                return;
            }
            if rx_closed {
                if !pending.is_empty() {
                    let _ = emit(std::mem::take(&mut pending), false);
                }
                return;
            }
        }
        let paused_now =
            state.stdout_credit.load(Ordering::Relaxed) <= 0 || !held.is_empty();
        if !pending.is_empty() {
            if !emit(std::mem::take(&mut pending), paused_now) {
                return;
            }
            announced_pause = paused_now;
        } else if paused_now && !announced_pause {
            // Nothing buffered but the op is holding: tell the frontend once
            // so it can show the "-- More --" state.
            if !emit(Vec::new(), true) {
                return;
            }
            announced_pause = true;
        }
        if !paused_now {
            announced_pause = false;
        }
    }
}

/// Cancel an in-flight console command. `true` means the cancel bit: either
/// a running process was killed, or a paused/draining op was told to quit
/// (its process may have already exited - the pager case). `false` means
/// the op was already fully gone; the UI says so instead of pretending the
/// cancel did something.
#[tauri::command]
#[specta::specta]
pub async fn console_cancel(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    op_id: String,
) -> Result<bool, AppError> {
    let session = state.get_session(&repo_id).await?;
    // Flag first, kill second: the pump must already be dropping output by
    // the time the kill lands, or the queued backlog keeps streaming.
    let op = console_ops()
        .lock()
        .expect("console ops poisoned")
        .get(&op_id)
        .cloned();
    let known = op.is_some();
    if let Some(op) = op {
        op.cancelled.store(true, Ordering::Relaxed);
        op.wake.notify_one();
    }
    let runner = session.runner.read().await.clone();
    let killed = runner.cancel(&OperationId(op_id));
    Ok(killed || known)
}

/// Reject arguments that would let the Console escape the active
/// repository's working tree (DESIGN.md §7.4).
fn validate_console_args(argv: &[String]) -> Result<(), AppError> {
    for (idx, arg) in argv.iter().enumerate() {
        // The leading "git" is implied — and a hint the user is confused.
        if idx == 0 && arg.eq_ignore_ascii_case("git") {
            return Err(AppError::ForbiddenArg(
                "drop the leading `git` — the console always runs `git`".into(),
            ));
        }
        if arg == "-C"
            || arg == "--git-dir"
            || arg == "--work-tree"
            || arg == "--namespace"
            || arg.starts_with("--git-dir=")
            || arg.starts_with("--work-tree=")
            || arg.starts_with("--namespace=")
        {
            return Err(AppError::ForbiddenArg(arg.clone()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_upper_c_arg() {
        let argv = vec!["-C".to_string(), "/etc".to_string(), "status".to_string()];
        assert!(matches!(
            validate_console_args(&argv),
            Err(AppError::ForbiddenArg(_))
        ));
    }

    #[test]
    fn rejects_git_dir_long() {
        let argv = vec!["--git-dir=/etc".to_string(), "status".to_string()];
        assert!(matches!(
            validate_console_args(&argv),
            Err(AppError::ForbiddenArg(_))
        ));
    }

    #[test]
    fn rejects_leading_git() {
        let argv = vec!["git".to_string(), "status".to_string()];
        assert!(matches!(
            validate_console_args(&argv),
            Err(AppError::ForbiddenArg(_))
        ));
    }

    #[test]
    fn accepts_normal_command() {
        let argv = vec!["status".to_string(), "--short".to_string()];
        assert!(validate_console_args(&argv).is_ok());
    }

    fn stdout(line: &str) -> RunnerEvent {
        RunnerEvent::Stdout {
            line: line.to_string(),
        }
    }

    fn stderr(line: &str) -> RunnerEvent {
        RunnerEvent::Stderr {
            line: line.to_string(),
        }
    }

    fn finished() -> RunnerEvent {
        RunnerEvent::Finished {
            exit_code: Some(0),
            success: true,
            duration_ms: 1,
        }
    }

    fn op_state(credit: i64) -> Arc<ConsoleOpState> {
        Arc::new(ConsoleOpState {
            cancelled: AtomicBool::new(false),
            stdout_credit: AtomicI64::new(credit),
            wake: Notify::new(),
        })
    }

    /// Collected emit calls: (events, paused flag).
    type Batches = Vec<(Vec<RunnerEvent>, bool)>;

    /// Events queued before the pump runs land in ONE batch, flushed by the
    /// Finished event - not one emit per line.
    #[tokio::test]
    async fn pump_batches_queued_events_into_one_emit() {
        let (tx, rx) = mpsc::channel(STREAM_BUFFER);
        for line in ["a", "b", "c"] {
            tx.send(stdout(line)).await.unwrap();
        }
        tx.send(finished()).await.unwrap();
        drop(tx);

        let mut batches: Batches = Vec::new();
        pump_console_events(rx, op_state(i64::MAX), Vec::new(), |events, paused| {
            batches.push((events, paused));
            true
        })
        .await;

        assert_eq!(batches.len(), 1, "expected a single coalesced batch");
        assert_eq!(batches[0].0.len(), 4);
        assert!(!batches[0].1);
        assert!(matches!(batches[0].0[3], RunnerEvent::Finished { .. }));
    }

    /// A cancelled op's queued output is dropped wholesale; only Finished
    /// gets through (it carries the "killed" status the panel prints).
    #[tokio::test]
    async fn pump_drops_backlog_after_cancel_but_delivers_finished() {
        let (tx, rx) = mpsc::channel(2048);
        for i in 0..1000 {
            tx.send(stdout(&format!("line {i}"))).await.unwrap();
        }
        tx.send(finished()).await.unwrap();
        drop(tx);

        let state = op_state(i64::MAX);
        state.cancelled.store(true, Ordering::Relaxed);
        let mut batches: Batches = Vec::new();
        pump_console_events(rx, state, Vec::new(), |events, paused| {
            batches.push((events, paused));
            true
        })
        .await;

        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].0.len(), 1);
        assert!(matches!(batches[0].0[0], RunnerEvent::Finished { .. }));
    }

    /// A flood flushes every MAX_BATCH events even without Finished/tick, so
    /// one IPC payload can't grow unboundedly.
    #[tokio::test]
    async fn pump_flushes_at_max_batch() {
        let (tx, rx) = mpsc::channel(MAX_BATCH + 2);
        for i in 0..(MAX_BATCH + 1) {
            tx.send(stdout(&format!("line {i}"))).await.unwrap();
        }
        drop(tx);

        let mut batches: Vec<usize> = Vec::new();
        pump_console_events(rx, op_state(i64::MAX), Vec::new(), |events, _| {
            batches.push(events.len());
            true
        })
        .await;

        assert_eq!(batches, vec![MAX_BATCH, 1]);
    }

    /// The pump stops as soon as emit reports the receiver is gone.
    #[tokio::test]
    async fn pump_stops_when_emit_fails() {
        let (tx, rx) = mpsc::channel(2 * MAX_BATCH + 1);
        for i in 0..(2 * MAX_BATCH) {
            tx.send(stdout(&format!("line {i}"))).await.unwrap();
        }
        drop(tx);

        let mut calls = 0;
        pump_console_events(rx, op_state(i64::MAX), Vec::new(), |_, _| {
            calls += 1;
            false
        })
        .await;

        assert_eq!(calls, 1);
    }

    /// Paging: with credit for 2 lines, exactly 2 are emitted (flagged
    /// paused) and the rest stay unconsumed in the channel - that
    /// non-consumption is what ultimately blocks git.
    #[tokio::test(start_paused = true)]
    async fn pump_pauses_when_credit_runs_out() {
        let (tx, rx) = mpsc::channel(16);
        for i in 0..5 {
            tx.send(stdout(&format!("line {i}"))).await.unwrap();
        }

        let state = op_state(2);
        let state_for_pump = state.clone();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(Vec<RunnerEvent>, bool)>();
        let pump = tokio::spawn(async move {
            pump_console_events(rx, state_for_pump, Vec::new(), move |events, paused| {
                out_tx.send((events, paused)).is_ok()
            })
            .await;
        });

        let (events, paused) = out_rx.recv().await.expect("first batch");
        assert_eq!(events.len(), 2, "must stop at the credit");
        assert!(paused, "the credit-exhausted batch is flagged paused");

        // No further output while paused.
        tokio::task::yield_now().await;
        assert!(out_rx.try_recv().is_err(), "paused pump must not emit");

        // Feed: grant more credit than the remaining lines need; the pump
        // notices on its tick. (An exact grant would re-pause - correct
        // pager behaviour, but not what this case is about.)
        state.stdout_credit.fetch_add(4, Ordering::Relaxed);
        let (events, paused) = out_rx.recv().await.expect("resumed batch");
        assert_eq!(events.len(), 3);
        assert!(!paused);

        tx.send(finished()).await.unwrap();
        drop(tx);
        let (events, _) = out_rx.recv().await.expect("finished batch");
        assert!(matches!(events[0], RunnerEvent::Finished { .. }));
        pump.await.unwrap();
    }

    /// stderr never counts against the credit (pagers gate stdout only): a
    /// stderr flood flows freely with zero stdout credit remaining.
    #[tokio::test(start_paused = true)]
    async fn pump_stderr_does_not_consume_credit() {
        let (tx, rx) = mpsc::channel(16);
        tx.send(stdout("only")).await.unwrap();
        for i in 0..5 {
            tx.send(stderr(&format!("warn {i}"))).await.unwrap();
        }
        tx.send(finished()).await.unwrap();
        drop(tx);

        let mut total_stderr = 0;
        let mut saw_finished = false;
        pump_console_events(rx, op_state(1), Vec::new(), |events, _| {
            for e in &events {
                if matches!(e, RunnerEvent::Stderr { .. }) {
                    total_stderr += 1;
                }
                if matches!(e, RunnerEvent::Finished { .. }) {
                    saw_finished = true;
                }
            }
            true
        })
        .await;

        assert_eq!(total_stderr, 5, "stderr must flow with exhausted stdout credit");
        assert!(saw_finished);
    }

    /// A `Finished` that arrives while stdout is parked must wait: the pager
    /// stays in "-- More --" until the user pages through, and the remaining
    /// lines arrive BEFORE Finished once credit is granted.
    #[tokio::test(start_paused = true)]
    async fn pump_finished_waits_for_parked_stdout() {
        let (tx, rx) = mpsc::channel(16);
        for i in 0..3 {
            tx.send(stdout(&format!("line {i}"))).await.unwrap();
        }
        tx.send(finished()).await.unwrap();
        drop(tx);

        let state = op_state(1);
        let state_for_pump = state.clone();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(Vec<RunnerEvent>, bool)>();
        let pump = tokio::spawn(async move {
            pump_console_events(rx, state_for_pump, Vec::new(), move |events, paused| {
                out_tx.send((events, paused)).is_ok()
            })
            .await;
        });

        let (events, paused) = out_rx.recv().await.expect("first batch");
        assert_eq!(events.len(), 1);
        assert!(paused, "credit exhausted after the first line");

        // Finished is queued behind two parked lines: it must NOT surface yet.
        tokio::task::yield_now().await;
        assert!(out_rx.try_recv().is_err(), "Finished must wait for the parked lines");

        state.stdout_credit.fetch_add(10, Ordering::Relaxed);
        state.wake.notify_one();
        let (events, paused) = out_rx.recv().await.expect("drained batch");
        assert_eq!(events.len(), 3, "two parked lines then Finished");
        assert!(matches!(events[0], RunnerEvent::Stdout { .. }));
        assert!(matches!(events[1], RunnerEvent::Stdout { .. }));
        assert!(matches!(events[2], RunnerEvent::Finished { .. }));
        assert!(!paused);
        pump.await.unwrap();
    }

    /// Cancelling a PAUSED op drains and drops the held output and still
    /// delivers Finished - `q` must always get the user out of the pager.
    #[tokio::test(start_paused = true)]
    async fn pump_cancel_while_paused_drains_and_finishes() {
        let (tx, rx) = mpsc::channel(16);
        for i in 0..5 {
            tx.send(stdout(&format!("line {i}"))).await.unwrap();
        }
        tx.send(finished()).await.unwrap();
        drop(tx);

        let state = op_state(1);
        let state_for_pump = state.clone();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(Vec<RunnerEvent>, bool)>();
        let pump = tokio::spawn(async move {
            pump_console_events(rx, state_for_pump, Vec::new(), move |events, paused| {
                out_tx.send((events, paused)).is_ok()
            })
            .await;
        });

        let (events, paused) = out_rx.recv().await.expect("first batch");
        assert_eq!(events.len(), 1);
        assert!(paused);

        state.cancelled.store(true, Ordering::Relaxed);
        let (events, _) = out_rx.recv().await.expect("final batch");
        assert_eq!(events.len(), 1, "held lines are dropped, only Finished flows");
        assert!(matches!(events[0], RunnerEvent::Finished { .. }));
        pump.await.unwrap();
    }

    // --- `| grep` pipeline ---

    fn argv(tokens: &[&str]) -> Vec<String> {
        tokens.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pipeline_without_pipe_passes_through() {
        let (git, stages) = split_console_pipeline(argv(&["status", "--short"])).unwrap();
        assert_eq!(git, argv(&["status", "--short"]));
        assert!(stages.is_empty());
    }

    #[test]
    fn pipeline_splits_git_from_grep_stages() {
        let (git, stages) =
            split_console_pipeline(argv(&["log", "--oneline", "|", "grep", "fix", "|", "grep", "-v", "wip"]))
                .unwrap();
        assert_eq!(git, argv(&["log", "--oneline"]));
        assert_eq!(stages.len(), 2);
        assert!(stages[0].matches("a fix here"));
        assert!(!stages[1].matches("wip: thing"));
    }

    #[test]
    fn pipeline_rejects_non_grep_stages_and_dangling_pipes() {
        assert!(matches!(
            split_console_pipeline(argv(&["log", "|", "wc", "-l"])),
            Err(AppError::ParseArgs(_))
        ));
        assert!(matches!(
            split_console_pipeline(argv(&["log", "|"])),
            Err(AppError::ParseArgs(_))
        ));
        assert!(matches!(
            split_console_pipeline(argv(&["|", "grep", "x"])),
            Err(AppError::ParseArgs(_))
        ));
    }

    #[test]
    fn grep_stage_flags() {
        // -i case-insensitive
        assert!(parse_grep_stage(&argv(&["-i", "ERROR"])).unwrap().matches("an error"));
        // -v invert
        let v = parse_grep_stage(&argv(&["-v", "noise"])).unwrap();
        assert!(v.matches("signal"));
        assert!(!v.matches("noise line"));
        // -w word boundaries
        let w = parse_grep_stage(&argv(&["-w", "fix"])).unwrap();
        assert!(w.matches("a fix here"));
        assert!(!w.matches("prefix"));
        // -F fixed string: regex metacharacters are literal
        let f = parse_grep_stage(&argv(&["-F", "a.b"])).unwrap();
        assert!(f.matches("a.b"));
        assert!(!f.matches("axb"));
        // combined short flags
        let iv = parse_grep_stage(&argv(&["-iv", "WIP"])).unwrap();
        assert!(!iv.matches("wip: x"));
        // regex alternation works by default
        let alt = parse_grep_stage(&argv(&["fix|bug"])).unwrap();
        assert!(alt.matches("bugfix") && alt.matches("a bug"));
    }

    #[test]
    fn grep_stage_rejects_unsupported_flags_and_bad_patterns() {
        assert!(matches!(
            parse_grep_stage(&argv(&["-c", "x"])),
            Err(AppError::ParseArgs(_))
        ));
        assert!(matches!(
            parse_grep_stage(&argv(&["--count", "x"])),
            Err(AppError::ParseArgs(_))
        ));
        assert!(matches!(parse_grep_stage(&argv(&[])), Err(AppError::ParseArgs(_))));
        assert!(matches!(
            parse_grep_stage(&argv(&["("])),
            Err(AppError::ParseArgs(_))
        ));
    }

    #[test]
    fn grep_stage_matches_through_ansi_colour_codes() {
        // The console runs git with color.ui=always: escape codes sit inside
        // the line and must be invisible to the pattern.
        let stage = parse_grep_stage(&argv(&["commit deadbeef"])).unwrap();
        assert!(stage.matches("\x1b[33mcommit deadbeef\x1b[m"));
    }

    /// Filtered-out lines are consumed without spending credit: the pager
    /// counts lines the user will see, so `log | grep rare` scans far past
    /// one page of raw output.
    #[tokio::test]
    async fn pump_grep_filters_lines_and_spares_credit() {
        let (tx, rx) = mpsc::channel(64);
        for i in 0..20 {
            tx.send(stdout(&format!("line {i}"))).await.unwrap();
        }
        tx.send(stdout("MATCH midway")).await.unwrap();
        for i in 20..40 {
            tx.send(stdout(&format!("line {i}"))).await.unwrap();
        }
        tx.send(finished()).await.unwrap();
        drop(tx);

        let filters = vec![parse_grep_stage(&argv(&["MATCH"])).unwrap()];
        let mut lines: Vec<String> = Vec::new();
        // Credit of 2: 41 raw lines but only 1 match - must NOT pause.
        pump_console_events(rx, op_state(2), filters, |events, paused| {
            assert!(!paused, "one matching line must not exhaust a credit of 2");
            for e in events {
                if let RunnerEvent::Stdout { line } = e {
                    lines.push(line);
                }
            }
            true
        })
        .await;

        assert_eq!(lines, vec!["MATCH midway".to_string()]);
    }
}
