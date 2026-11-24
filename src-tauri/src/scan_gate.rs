//! Bounds repeated read scans of one repo to a single run in flight.
//!
//! A refresh trigger can arrive faster than a scan finishes (a watcher batch
//! every few hundred ms against a status that takes seconds on a large change
//! set). Unbounded, every trigger spawns its own git processes and they pile
//! up. Through a gate, callers that arrive while a scan runs wait for it and
//! then share ONE follow-up scan: at most one in flight, and every caller
//! still gets a result from a scan that started after it asked.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct ScanGate<T> {
    arrivals: AtomicU64,
    /// The newest result and the arrival count it covers.
    last: tokio::sync::Mutex<Option<(u64, T)>>,
}

impl<T> Default for ScanGate<T> {
    fn default() -> Self {
        Self { arrivals: AtomicU64::new(0), last: tokio::sync::Mutex::new(None) }
    }
}

impl<T: Clone> ScanGate<T> {
    pub async fn run<F, Fut>(&self, scan: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let ticket = self.arrivals.fetch_add(1, Ordering::SeqCst) + 1;
        let mut last = self.last.lock().await;
        if let Some((covered, value)) = last.as_ref() {
            if *covered >= ticket {
                return value.clone();
            }
        }
        let covered = self.arrivals.load(Ordering::SeqCst);
        let value = scan().await;
        *last = Some((covered, value.clone()));
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use tokio::sync::Notify;

    #[tokio::test]
    async fn sequential_callers_each_get_a_fresh_scan() {
        let gate = ScanGate::<usize>::default();
        let runs = AtomicUsize::new(0);
        for expected in 1..=3 {
            let got = gate.run(|| async { runs.fetch_add(1, Ordering::SeqCst) + 1 }).await;
            assert_eq!(got, expected);
        }
    }

    /// The pile-up guard: ten triggers during one slow scan cost exactly one
    /// more scan, started after all of them arrived.
    #[tokio::test]
    async fn callers_arriving_during_a_scan_share_one_follow_up() {
        let gate = Arc::new(ScanGate::<usize>::default());
        let runs = Arc::new(AtomicUsize::new(0));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_in_flight = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Notify::new());
        let started = Arc::new(Notify::new());

        let scan = {
            let (runs, in_flight, max_in_flight) = (runs.clone(), in_flight.clone(), max_in_flight.clone());
            move |hold: Option<(Arc<Notify>, Arc<Notify>)>| async move {
                let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                max_in_flight.fetch_max(now, Ordering::SeqCst);
                if let Some((started, release)) = hold {
                    started.notify_one();
                    release.notified().await;
                }
                in_flight.fetch_sub(1, Ordering::SeqCst);
                runs.fetch_add(1, Ordering::SeqCst) + 1
            }
        };

        let first = {
            let (gate, scan, hold) = (gate.clone(), scan.clone(), (started.clone(), release.clone()));
            tokio::spawn(async move { gate.run(|| scan(Some(hold))).await })
        };
        started.notified().await;

        let followers: Vec<_> = (0..10)
            .map(|_| {
                let (gate, scan) = (gate.clone(), scan.clone());
                tokio::spawn(async move { gate.run(|| scan(None)).await })
            })
            .collect();
        while gate.arrivals.load(Ordering::SeqCst) < 11 {
            tokio::task::yield_now().await;
        }
        release.notify_one();

        assert_eq!(first.await.unwrap(), 1);
        for f in followers {
            assert_eq!(f.await.unwrap(), 2, "followers share the one follow-up scan");
        }
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert_eq!(max_in_flight.load(Ordering::SeqCst), 1);
    }
}
