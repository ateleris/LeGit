//! Holds a repo's watcher batches while one of the app's own git invocations
//! rewrites the working tree.
//!
//! During a merge/pull/checkout the on-disk index still describes the old
//! tree, so every refresh triggered mid-flight sees the files written so far
//! as modified and re-scans a change set that grows to the whole incoming
//! diff. Batches arriving in that window are merged and delivered as ONE
//! batch when the last such invocation ends.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use legit_core::runner::{GitRequest, OperationId, RunOutputBytes, RunnerError, RunnerEvent};
use legit_core::{rewrites_worktree, GitExecutor};
use legit_watch::{ChangeDomain, WatchBatch, WatchSink};
use tokio::sync::mpsc;

/// Mirrors the watcher's own display cap for trigger paths.
const MAX_HELD_TRIGGER_PATHS: usize = 8;

type SharedSink = Arc<dyn Fn(WatchBatch) + Send + Sync + 'static>;

#[derive(Default)]
struct QuietState {
    active: u32,
    sink: Option<SharedSink>,
    held_domains: BTreeSet<ChangeDomain>,
    held_triggers: Vec<String>,
    held_count: u32,
}

#[derive(Default)]
pub struct WatchQuiet {
    state: Mutex<QuietState>,
}

impl WatchQuiet {
    /// Route `sink` through this gate. The returned sink is what the watcher
    /// gets; held batches are later flushed to the wrapped one.
    pub fn attach(self: &Arc<Self>, sink: WatchSink) -> WatchSink {
        let shared: SharedSink = Arc::from(sink);
        self.lock().sink = Some(shared);
        let gate = self.clone();
        Box::new(move |batch| gate.deliver(batch))
    }

    pub fn begin(self: &Arc<Self>) -> QuietGuard {
        self.lock().active += 1;
        QuietGuard { gate: self.clone() }
    }

    fn deliver(&self, batch: WatchBatch) {
        let sink = {
            let mut st = self.lock();
            if st.active > 0 {
                st.held_domains.extend(batch.domains);
                for path in batch.trigger_paths {
                    if st.held_triggers.len() < MAX_HELD_TRIGGER_PATHS && !st.held_triggers.contains(&path) {
                        st.held_triggers.push(path);
                    }
                }
                st.held_count = st.held_count.saturating_add(batch.trigger_count);
                return;
            }
            st.sink.clone()
        };
        if let Some(sink) = sink {
            sink(batch);
        }
    }

    fn end(&self) {
        let flush = {
            let mut st = self.lock();
            st.active = st.active.saturating_sub(1);
            if st.active > 0 || st.held_domains.is_empty() {
                return;
            }
            let batch = WatchBatch {
                domains: std::mem::take(&mut st.held_domains).into_iter().collect(),
                trigger_paths: std::mem::take(&mut st.held_triggers),
                trigger_count: std::mem::take(&mut st.held_count),
            };
            st.sink.clone().map(|sink| (sink, batch))
        };
        if let Some((sink, batch)) = flush {
            sink(batch);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, QuietState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct QuietGuard {
    gate: Arc<WatchQuiet>,
}

impl Drop for QuietGuard {
    fn drop(&mut self) {
        self.gate.end();
    }
}

/// The worktree-rewriting invocations currently running for one repo, by
/// operation id: what "Stop" on the activity bar cancels. Commands do not
/// carry these ids themselves, so the session's executor wrapper mints and
/// records them.
#[derive(Default)]
pub struct InFlightRewrites {
    ids: Mutex<Vec<OperationId>>,
}

impl InFlightRewrites {
    fn enter(self: &Arc<Self>, id: OperationId) -> RewriteGuard {
        self.lock().push(id.clone());
        RewriteGuard { set: self.clone(), id }
    }

    pub fn snapshot(&self) -> Vec<OperationId> {
        self.lock().clone()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<OperationId>> {
        self.ids.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct RewriteGuard {
    set: Arc<InFlightRewrites>,
    id: OperationId,
}

impl Drop for RewriteGuard {
    fn drop(&mut self) {
        let mut ids = self.set.lock();
        if let Some(pos) = ids.iter().position(|i| *i == self.id) {
            ids.remove(pos);
        }
    }
}

/// Wraps a session's executor so every worktree-rewriting invocation, from
/// any command or the console, quiets the repo's watcher for its duration
/// and is cancellable through the session's `InFlightRewrites`.
pub struct QuietingExecutor {
    inner: Arc<dyn GitExecutor>,
    quiet: Arc<WatchQuiet>,
    rewrites: Arc<InFlightRewrites>,
}

impl QuietingExecutor {
    pub fn wrap(
        inner: Arc<dyn GitExecutor>,
        quiet: Arc<WatchQuiet>,
        rewrites: Arc<InFlightRewrites>,
    ) -> Arc<dyn GitExecutor> {
        Arc::new(Self { inner, quiet, rewrites })
    }
}

#[async_trait]
impl GitExecutor for QuietingExecutor {
    async fn execute(&self, mut req: GitRequest<'_>) -> Result<RunOutputBytes, RunnerError> {
        if !rewrites_worktree(req.args) {
            return self.inner.execute(req).await;
        }
        let _quiet = self.quiet.begin();
        let id = req.op_id.get_or_insert_with(OperationId::new).clone();
        let _running = self.rewrites.enter(id);
        self.inner.execute(req).await
    }

    async fn stream(
        &self,
        args: &[&str],
        op_id: OperationId,
        events_tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<i32, RunnerError> {
        let _quiet = rewrites_worktree(args).then(|| self.quiet.begin());
        self.inner.stream(args, op_id, events_tx).await
    }

    fn cancel(&self, op_id: &OperationId) -> bool {
        self.inner.cancel(op_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use legit_core::test_support::{ok, FakeExecutor};

    fn recording_gate() -> (Arc<WatchQuiet>, WatchSink, Arc<Mutex<Vec<WatchBatch>>>) {
        let seen: Arc<Mutex<Vec<WatchBatch>>> = Arc::default();
        let gate = Arc::new(WatchQuiet::default());
        let record = seen.clone();
        let sink = gate.attach(Box::new(move |b| record.lock().unwrap().push(b)));
        (gate, sink, seen)
    }

    fn batch(domains: &[ChangeDomain], path: &str) -> WatchBatch {
        WatchBatch { domains: domains.to_vec(), trigger_paths: vec![path.to_string()], trigger_count: 1 }
    }

    #[test]
    fn batches_pass_straight_through_when_idle() {
        let (_gate, sink, seen) = recording_gate();
        sink(batch(&[ChangeDomain::Status], "a.txt"));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn batches_during_a_rewrite_arrive_once_merged_when_it_ends() {
        let (gate, sink, seen) = recording_gate();
        let outer = gate.begin();
        let inner = gate.begin();
        sink(batch(&[ChangeDomain::Status, ChangeDomain::Diff], "a.txt"));
        sink(batch(&[ChangeDomain::Status, ChangeDomain::Stashes], "b.txt"));
        drop(inner);
        assert!(seen.lock().unwrap().is_empty(), "still held while one rewrite is active");
        drop(outer);

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].domains, vec![ChangeDomain::Status, ChangeDomain::Stashes, ChangeDomain::Diff]);
        assert_eq!(seen[0].trigger_paths, vec!["a.txt".to_string(), "b.txt".to_string()]);
        assert_eq!(seen[0].trigger_count, 2);
    }

    #[test]
    fn a_rewrite_without_events_flushes_nothing() {
        let (gate, sink, seen) = recording_gate();
        drop(gate.begin());
        assert!(seen.lock().unwrap().is_empty());
        sink(batch(&[ChangeDomain::Log], "x"));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    /// Records, while each invocation runs, how many rewrites the gate
    /// counts and whether the invocation is registered as stoppable under
    /// the op id it was handed.
    struct Probe {
        inner: FakeExecutor,
        gate: Arc<WatchQuiet>,
        rewrites: Arc<InFlightRewrites>,
        active_during: Mutex<Vec<u32>>,
        registered_during: Mutex<Vec<bool>>,
    }

    #[async_trait]
    impl GitExecutor for Probe {
        async fn execute(&self, req: GitRequest<'_>) -> Result<RunOutputBytes, RunnerError> {
            self.active_during.lock().unwrap().push(self.gate.lock().active);
            let registered = req.op_id.as_ref().is_some_and(|id| self.rewrites.snapshot().contains(id));
            self.registered_during.lock().unwrap().push(registered);
            self.inner.execute(req).await
        }
    }

    #[tokio::test]
    async fn executor_quiets_only_worktree_rewriting_invocations() {
        let (gate, _sink, _seen) = recording_gate();
        let inner = FakeExecutor::default();
        inner.expect(&["status"], ok(""));
        inner.expect(&["merge", "main"], ok(""));
        let rewrites = Arc::new(InFlightRewrites::default());
        let probe = Arc::new(Probe {
            inner,
            gate: gate.clone(),
            rewrites: rewrites.clone(),
            active_during: Mutex::default(),
            registered_during: Mutex::default(),
        });
        let exec = QuietingExecutor::wrap(probe.clone(), gate.clone(), rewrites.clone());

        exec.run(&["status"]).await.unwrap();
        exec.run(&["merge", "main"]).await.unwrap();

        assert_eq!(*probe.active_during.lock().unwrap(), vec![0, 1]);
        assert_eq!(gate.lock().active, 0, "released when the invocation ends");
        // Only the rewrite is stoppable, under the id the runner was given,
        // and nothing stays registered once it has ended.
        assert_eq!(*probe.registered_during.lock().unwrap(), vec![false, true]);
        assert!(rewrites.is_empty());
        probe.inner.assert_done();
    }
}
