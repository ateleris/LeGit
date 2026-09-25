//! Scripted `GitExecutor` for tests of code built on git invocations
//! (compiled for this crate's tests, or with the `test-support` feature).
//! Every invocation must match the next scripted step exactly (args, env
//! overrides, stdin); `assert_done` fails when steps are left over.

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;

use crate::executor::GitExecutor;
use crate::runner::{GitRequest, RunOutput, RunOutputBytes, RunnerError};

/// One scripted step: the exact args expected, the env overrides expected
/// (None = a plain run), the stdin expected (None = no stdin), and the output
/// to return.
struct Step {
    args: Vec<String>,
    env: Option<Vec<(String, String)>>,
    stdin: Option<String>,
    output: RunOutput,
}

/// A strict-FIFO scripted executor. Every `run*` call must match the next
/// step's args exactly; the script must be fully consumed by the end of the
/// test (`assert_done`).
#[derive(Default)]
pub struct FakeExecutor {
    script: Mutex<VecDeque<Step>>,
}

pub fn out(exit_code: i32, stdout: &str, stderr: &str) -> RunOutput {
    RunOutput {
        stdout: stdout.to_string(),
        stderr: stderr.to_string(),
        exit_code: Some(exit_code),
        success: exit_code == 0,
        duration_ms: 0,
    }
}

pub fn ok(stdout: &str) -> RunOutput {
    out(0, stdout, "")
}

pub fn fail(exit_code: i32, stderr: &str) -> RunOutput {
    out(exit_code, "", stderr)
}

impl FakeExecutor {
    pub fn expect(&self, args: &[&str], output: RunOutput) -> &Self {
        self.script.lock().unwrap().push_back(Step {
            args: args.iter().map(|s| s.to_string()).collect(),
            env: None,
            stdin: None,
            output,
        });
        self
    }

    /// Expect an invocation carrying per-invocation env overrides.
    pub fn expect_env(&self, args: &[&str], env: &[(&str, &str)], output: RunOutput) -> &Self {
        self.script.lock().unwrap().push_back(Step {
            args: args.iter().map(|s| s.to_string()).collect(),
            env: Some(env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()),
            stdin: None,
            output,
        });
        self
    }

    /// Expect an invocation fed the given stdin (asserted exactly).
    pub fn expect_stdin(&self, args: &[&str], stdin: &str, output: RunOutput) -> &Self {
        self.script.lock().unwrap().push_back(Step {
            args: args.iter().map(|s| s.to_string()).collect(),
            env: None,
            stdin: Some(stdin.to_string()),
            output,
        });
        self
    }

    fn next_with_stdin(
        &self,
        actual: &[&str],
        actual_env: Option<&[(&str, &str)]>,
        actual_stdin: Option<&str>,
    ) -> RunOutput {
        let mut script = self.script.lock().unwrap();
        let step = script
            .pop_front()
            .unwrap_or_else(|| panic!("unexpected git invocation: {actual:?}"));
        assert_eq!(
            actual.to_vec(),
            step.args.iter().map(String::as_str).collect::<Vec<_>>(),
            "git invoked with unexpected args"
        );
        let actual_env: Option<Vec<(String, String)>> = actual_env
            .map(|e| e.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
        assert_eq!(actual_env, step.env, "git invoked with unexpected env overrides");
        assert_eq!(
            actual_stdin.map(str::to_string),
            step.stdin,
            "git invoked with unexpected stdin (script stdin-fed commands with `expect_stdin`)"
        );
        step.output
    }

    pub fn assert_done(&self) {
        let script = self.script.lock().unwrap();
        assert!(
            script.is_empty(),
            "expected {} more git invocation(s), next: {:?}",
            script.len(),
            script.front().map(|s| &s.args)
        );
    }
}

#[async_trait]
impl GitExecutor for FakeExecutor {
    async fn execute(&self, req: GitRequest<'_>) -> Result<RunOutputBytes, RunnerError> {
        let env = (!req.env.is_empty()).then_some(req.env);
        let o = self.next_with_stdin(req.args, env, req.stdin);
        Ok(RunOutputBytes {
            stdout: o.stdout.into_bytes(),
            stderr: o.stderr,
            exit_code: o.exit_code,
            success: o.success,
            duration_ms: o.duration_ms,
        })
    }
}
