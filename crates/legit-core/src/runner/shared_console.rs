//! One hidden console for the whole process, inherited by every spawned git.
//!
//! A windowed app has no console, so Windows starts a console host for each
//! console child it spawns (`CREATE_NO_WINDOW` only hides it): 20 to 27 ms
//! per git call, measured. With a console of our own the children attach to
//! it instead. Git never talks to it: stdin, stdout and stderr are always
//! pipes or closed.

use std::sync::atomic::{AtomicBool, Ordering};

static SHARED: AtomicBool = AtomicBool::new(false);

/// Whether spawned gits can inherit this process's console.
pub(super) fn active() -> bool {
    SHARED.load(Ordering::Relaxed)
}

/// Give this process a hidden console unless it already has one. Call once
/// at app startup; until it succeeds the runner keeps hiding a console per
/// call. Returns whether children can now inherit a console.
#[cfg(not(windows))]
pub fn ensure_shared_console() -> bool {
    false
}

#[cfg(windows)]
pub fn ensure_shared_console() -> bool {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::System::Console::{AttachConsole, GetConsoleCP};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const ATTACH_TIMEOUT: Duration = Duration::from_secs(2);

    if active() {
        return true;
    }
    if unsafe { GetConsoleCP() } != 0 {
        SHARED.store(true, Ordering::Relaxed);
        return true;
    }
    // A console created by AllocConsole shows its window before it can be
    // hidden. One created for a CREATE_NO_WINDOW child never has a window,
    // and stays alive for as long as any process is attached to it: attach,
    // then let the child go.
    let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let Ok(mut holder) = Command::new(shell)
        .args(["/d", "/c", "pause"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + ATTACH_TIMEOUT;
    let mut attached = false;
    // The child connects to its console during its own startup.
    while !attached && Instant::now() < deadline {
        attached = unsafe { AttachConsole(holder.id()) } != 0;
        if !attached {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let _ = holder.kill();
    let _ = holder.wait();
    SHARED.store(attached, Ordering::Relaxed);
    attached
}
