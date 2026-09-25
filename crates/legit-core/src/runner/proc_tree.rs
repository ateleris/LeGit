//! Killing a spawned git's whole process tree on cancel, and keeping every
//! spawned git from outliving the app.

/// Handle on a spawned git's whole process tree, for `terminate_tree`.
///
/// Unix needs nothing: the child leads its own process group (see
/// `build_command_with_env`) and a group signal reaches every descendant.
/// Windows has no group signal, so each invocation gets its own job object
/// (nested inside the app-lifetime `app_job`); git's helpers inherit the
/// membership, and `TerminateJobObject` kills the entire tree in one call.
/// Without this only the direct child died and an orphaned `index-pack`
/// kept the partial clone's pack file open until its next (throttled)
/// progress write hit the broken pipe - long enough for the cancelled
/// clone's cleanup to fail with "being used by another process".
///
/// The job has NO kill-on-close limit: dropping the handle after a normal
/// completion must not kill daemons git deliberately leaves behind
/// (fsmonitor--daemon); those are reaped by `app_job` at app exit.
pub(super) struct ProcTree {
    #[cfg(windows)]
    job: Option<usize>,
}

#[cfg(not(windows))]
impl ProcTree {
    pub(super) fn new(_child: &tokio::process::Child) -> Self {
        Self {}
    }
}

#[cfg(windows)]
impl ProcTree {
    pub(super) fn new(child: &tokio::process::Child) -> Self {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
        let Some(raw) = child.raw_handle() else {
            return Self { job: None };
        };
        let job = unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Self { job: None };
            }
            if AssignProcessToJobObject(job, raw as HANDLE) == 0 {
                CloseHandle(job);
                return Self { job: None };
            }
            job
        };
        Self {
            job: Some(job as usize),
        }
    }

    /// Kill every process in the job. Best-effort: with no job (creation or
    /// assignment failed at spawn) the caller still kills the direct child.
    fn terminate(&self) {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if let Some(job) = self.job {
            unsafe {
                TerminateJobObject(job as HANDLE, 1);
            }
        }
    }
}

#[cfg(windows)]
impl Drop for ProcTree {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        if let Some(job) = self.job {
            unsafe {
                CloseHandle(job as HANDLE);
            }
        }
    }
}

/// Terminate a cancelled invocation's whole process tree, not just the
/// direct child. git forks helpers (remote-https, index-pack, ...) that
/// inherit our pipes and do the real work, so killing only the direct child
/// can leave the operation effectively running (on Git for Windows even the
/// real git itself: `cmd\git.exe` is a shim around it).
///
/// Unix: the child leads its own process group (see `build_command_with_env`),
/// so one group signal reaches every descendant - and the termination is
/// gentle first: SIGTERM lets git run its own cleanup handlers (a terminated
/// clone removes its partial target, lockfiles get released) before any hard
/// kill. The group is swept with SIGKILL afterwards for stragglers.
///
/// Windows: there is no group signal here; the invocation's job object
/// (`ProcTree`) terminates the whole tree at once, then the direct child is
/// killed and reaped. Any straggler that escaped the job dies on broken
/// pipe once the reader tasks are aborted; `app_job` reaps the rest at exit.
/// How long a SIGTERMed git gets to run its cleanup handlers before the hard
/// SIGKILL. Long enough for normal junk removal and lock release, short
/// enough that a cancel of a signal-ignoring process still feels immediate.
#[cfg(unix)]
pub(super) const TERM_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg_attr(not(windows), allow(unused_variables))]
pub(super) async fn terminate_tree(
    child: &mut tokio::process::Child,
    tree: &ProcTree,
) -> std::io::Result<std::process::ExitStatus> {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // Negative pid: signal the whole process group the child leads.
        let pgid = -(pid as i32);
        unsafe {
            libc::kill(pgid, libc::SIGTERM);
        }
        let status = match tokio::time::timeout(TERM_GRACE, child.wait()).await {
            Ok(status) => status?,
            Err(_elapsed) => {
                tracing::warn!("cancelled git ignored SIGTERM - escalating to SIGKILL");
                unsafe {
                    libc::kill(pgid, libc::SIGKILL);
                }
                child.wait().await?
            }
        };
        // Sweep the group for stragglers that outlived the direct child.
        // (Daemons git means to leave behind, e.g. fsmonitor--daemon, have
        // detached into their own session and are not hit by this.)
        unsafe {
            libc::kill(pgid, libc::SIGKILL);
        }
        return Ok(status);
    }
    #[cfg(windows)]
    tree.terminate();
    let _ = child.start_kill();
    child.wait().await
}

/// Windows: an app-lifetime job object with `KILL_ON_JOB_CLOSE`. Every git we
/// spawn is assigned to it, and processes a git spawns inherit the membership.
/// When the LeGit process ends - cleanly or by crash - the OS closes the
/// handle and terminates everything still inside the job, so no git we
/// started (nor any of its children) can outlive the app. The Unix
/// counterpart is `PR_SET_PDEATHSIG` in `build_command_with_env`.
#[cfg(windows)]
pub(super) mod app_job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// The raw handle, stored as `usize` so the static is `Send + Sync`. It
    /// is deliberately never closed: closing it would kill every running git.
    static JOB: OnceLock<Option<usize>> = OnceLock::new();

    fn handle() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return None;
            }
            Some(job as usize)
        })
        .map(|raw| raw as HANDLE)
    }

    /// Best-effort enrolment right after spawn. On failure the child simply
    /// is not tied to the app's lifetime, which is the pre-existing behavior.
    /// (A child that spawns its own process in the instant before assignment
    /// would escape the job; in practice assignment runs before the newly
    /// created process gets scheduled.)
    pub(crate) fn assign(child: &tokio::process::Child) {
        let (Some(job), Some(raw)) = (handle(), child.raw_handle()) else {
            return;
        };
        unsafe {
            AssignProcessToJobObject(job, raw as HANDLE);
        }
    }
}
