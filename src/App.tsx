import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logoUrl from "./assets/legit-logo.png";
import { useAppVersion } from "./lib/appVersion";
import { useThemeStore } from "./store/themes";
import { useSettingsStore } from "./store/settings";
import { useGitStatusStore } from "./store/git-status";
import { useRepoStore } from "./store/repos";
import { GitSetupGate } from "./panels/Setup/GitSetupGate";
import { AppLayout } from "./panels/AppLayout";
import { ErrorBoundary } from "./panels/ErrorBoundary";
import { Toasts } from "./panels/Toasts";
import { DevRibbon } from "./panels/DevRibbon";

/** Boot progresses through these; the splash subtitle tracks the phase. */
type BootPhase = "git" | "repos" | "done";

const BOOT_SUBTITLE: Record<BootPhase, string> = {
  git: "resolving git…",
  repos: "restoring repositories…",
  // Shown only when boot finished but git still couldn't be resolved.
  done: "resolving git…",
};

// The window starts hidden (`visible: false` in tauri.conf.json) so the first
// frame the user ever sees - the splash included - already carries their
// theme. Revealed here once the applied theme has actually been composited;
// the Rust side has a failsafe show in case the frontend never boots.
let windowRevealed = false;
async function revealWindowOnceThemed() {
  if (windowRevealed) return;
  windowRevealed = true;
  // Double rAF: the first callback runs before the upcoming paint, the second
  // runs after the themed splash has been painted.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  try {
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  } catch (e) {
    // Not running under Tauri (tests) - nothing to reveal.
    console.warn("failed to show the main window", e);
  }
}

export function App() {
  const initThemes = useThemeStore((s) => s.init);
  const initSettings = useSettingsStore((s) => s.init);
  const initGitStatus = useGitStatusStore((s) => s.refresh);
  const initRepos = useRepoStore((s) => s.init);
  const gitStatus = useGitStatusStore((s) => s.status);
  const [bootPhase, setBootPhase] = useState<BootPhase>("git");

  useEffect(() => {
    (async () => {
      try {
        // Settings, then theme, before anything else: the window stays hidden
        // until the user's theme is applied, so even the splash is themed.
        // A theme failure must still reveal the window (default theme).
        try {
          await initSettings();
          await initThemes();
        } finally {
          void revealWindowOnceThemed();
        }
        // git before repos: repo restore needs the resolved git binary.
        await initGitStatus();
        setBootPhase("repos");
        await initRepos();
      } finally {
        // Each init is non-throwing internally, but a failure here must never
        // strand the user on the splash.
        setBootPhase("done");
      }
    })();
  }, [initSettings, initThemes, initGitStatus, initRepos]);

  // Block the app until we know whether git is available (DESIGN.md §7.6) AND
  // the persisted repos + theme are restored, so the first real paint shows a
  // fully populated layout instead of an empty repo list. Panel contents still
  // stream in afterwards via their own (delayed) loading indicators.
  // The Gate renders a setup screen if git is unavailable or below the floor.
  if (!gitStatus || bootPhase !== "done") {
    return <SplashScreen subtitle={BOOT_SUBTITLE[bootPhase]} />;
  }

  return (
    <ErrorBoundary>
      <GitSetupGate status={gitStatus}>
        <AppLayout />
      </GitSetupGate>
      <Toasts />
      <DevRibbon />
    </ErrorBoundary>
  );
}

function SplashScreen({ subtitle }: { subtitle: string }) {
  const version = useAppVersion();
  return (
    <div className="legit-splash">
      <div className="legit-splash__inner">
        <img className="legit-splash__logo" src={logoUrl} alt="" />
        <div className="legit-splash__title">LeGit</div>
        <div className="legit-splash__subtitle">{subtitle}</div>
        {version && <div className="legit-splash__version">v{version}</div>}
      </div>
    </div>
  );
}
