import { useEffect } from "react";
import { useThemeStore } from "./store/themes";
import { useSettingsStore } from "./store/settings";
import { useGitStatusStore } from "./store/git-status";
import { useRepoStore } from "./store/repos";
import { GitSetupGate } from "./panels/Setup/GitSetupGate";
import { AppLayout } from "./panels/AppLayout";
import { ErrorBoundary } from "./panels/ErrorBoundary";
import { Toasts } from "./panels/Toasts";

export function App() {
  const initThemes = useThemeStore((s) => s.init);
  const initSettings = useSettingsStore((s) => s.init);
  const initGitStatus = useGitStatusStore((s) => s.refresh);
  const initRepos = useRepoStore((s) => s.init);
  const gitStatus = useGitStatusStore((s) => s.status);

  useEffect(() => {
    // settings + git must come first; repo restore needs the resolved git binary.
    (async () => {
      await initSettings();
      await initGitStatus();
      await initRepos();
      initThemes();
    })();
  }, [initSettings, initThemes, initGitStatus, initRepos]);

  // Block the app until we know whether git is available (DESIGN.md §7.6).
  // The Gate renders a setup screen if git is unavailable or below the floor.
  if (!gitStatus) {
    return <SplashScreen />;
  }

  return (
    <ErrorBoundary>
      <GitSetupGate status={gitStatus}>
        <AppLayout />
      </GitSetupGate>
      <Toasts />
    </ErrorBoundary>
  );
}

function SplashScreen() {
  return (
    <div className="legit-splash">
      <div className="legit-splash__inner">
        <div className="legit-splash__title">LeGit</div>
        <div className="legit-splash__subtitle">resolving git…</div>
      </div>
    </div>
  );
}
