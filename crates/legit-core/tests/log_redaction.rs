//! Proves credentials never reach a formatted log line (`legit.log`).
//!
//! Lives in its own test binary on purpose: tracing caches callsite interest
//! process-globally, and with a single registered dispatcher it computes that
//! interest from the REGISTERING thread's default subscriber. Under the
//! parallel lib-test process, another test hitting the runner's callsites
//! first (with no subscriber) caches `Interest::never` and the capture below
//! silently sees nothing. A dedicated process has no competing threads.

use legit_core::GitRunner;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::Layer;

#[derive(Clone, Default)]
struct Sink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Sink {
    type Writer = Sink;
    fn make_writer(&'a self) -> Sink {
        self.clone()
    }
}

/// The formatted log line is what lands in `legit.log`: the fmt layer prints
/// every enclosing span's fields as a prefix, so a raw argv recorded on a
/// span would carry the token even though the event's own `args` field is
/// redacted. Asserted on the OUTPUT, not the function.
#[tokio::test]
async fn formatted_log_output_never_carries_url_credentials() {
    let sink = Sink::default();
    // Same shape as the app's file layer: default (full) format, info.
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(sink.clone())
            .with_filter(tracing_subscriber::EnvFilter::new("info")),
    );
    let dir = tempfile::tempdir().unwrap();
    let runner = GitRunner::for_repo("git", dir.path());
    // The span is opened when `run` is CALLED, so the call itself must
    // happen under the capturing subscriber, not just the await.
    let out = async {
        runner
            .run(&["-c", "x.y=https://user:ghp_SECRET@github.com/o/r.git", "--version"])
            .await
    }
    .with_subscriber(subscriber)
    .await
    .unwrap();
    assert!(out.success, "git --version must succeed: {out:?}");

    let text = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
    assert!(text.contains("git ok"), "the info event was not captured: {text}");
    assert!(text.contains("***"), "redacted argv expected in the line: {text}");
    assert!(!text.contains("ghp_SECRET"), "secret leaked into the formatted log: {text}");
}
