import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { recentRepos } from "../../lib/commands";
import { parseLocator } from "../../lib/locator";
import { formatAppError } from "../../lib/types";
import { useGitProfiles } from "../../lib/useGitProfiles";
import { useRepoStore } from "../../store/repos";
import { notify } from "../../store/notifications";
import { Button } from "../shared/buttons";
import { HostBadge } from "../shared/HostBadge";
import { CloneForm, InitForm } from "./forms";

type Mode = "none" | "clone" | "init";

/** Repositories panel — open / clone / init / close / switch. */
export function RepositoriesPanel() {
  const openRepos = useRepoStore((s) => s.openRepos);
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const openRepo = useRepoStore((s) => s.openRepo);
  const initRepo = useRepoStore((s) => s.initRepo);
  const cloneRepo = useRepoStore((s) => s.cloneRepo);
  const closeRepo = useRepoStore((s) => s.closeRepo);
  const setActive = useRepoStore((s) => s.setActive);
  const refresh = useRepoStore((s) => s.refresh);
  const initialized = useRepoStore((s) => s.initialized);

  const [recents, setRecents] = useState<string[]>([]);
  const { data: profiles = [] } = useGitProfiles();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("none");

  useEffect(() => {
    if (!initialized) refresh();
    recentRepos().then(setRecents).catch(console.warn);
  }, [initialized, refresh]);

  const refreshRecents = () => recentRepos().then(setRecents).catch(console.warn);

  const doOpen = async (path: string) => {
    setError(null);
    try {
      await openRepo(path);
      refreshRecents();
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const doDialog = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") await doOpen(selected);
  };

  return (
    <div className="legit-panel">
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" onClick={doDialog}>Open repository…</Button>
        <button onClick={() => { setError(null); setMode(mode === "clone" ? "none" : "clone"); }} aria-pressed={mode === "clone"}>
          Clone…
        </button>
        <button onClick={() => { setError(null); setMode(mode === "init" ? "none" : "init"); }} aria-pressed={mode === "init"}>
          Init…
        </button>
        <span className="legit-subtle" style={{ marginLeft: "auto" }}>
          {openRepos.length} open · {recents.length} recent
        </span>
      </div>
      <div className="legit-panel__body">
        {error && <div className="legit-error" style={{ marginBottom: 8 }}>{error}</div>}

        {mode === "clone" && (
          <div style={{ marginBottom: 14 }}>
          <CloneForm
            profiles={profiles}
            onCancel={() => setMode("none")}
            onError={setError}
            onClone={async (url, parentDir, name, profileId, opId, options) => {
              await cloneRepo(url, parentDir, name, profileId, opId, options);
              setMode("none");
              refreshRecents();
            }}
          />
          </div>
        )}
        {mode === "init" && (
          <div style={{ marginBottom: 14 }}>
          <InitForm
            profiles={profiles}
            onCancel={() => setMode("none")}
            onError={setError}
            onInit={async (path, profileId, options) => {
              const summary = await initRepo(path, profileId, options);
              setMode("none");
              refreshRecents();
              if (!summary) {
                notify.success(`Bare repository created at ${path}`);
              }
            }}
          />
          </div>
        )}

        <Section title="Open">
          {openRepos.length === 0 && <div className="legit-subtle">No repositories are open.</div>}
          {openRepos.map((r) => (
            <div
              key={r.id}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--panel-border)" }}
            >
              <Button onClick={() => setActive(r.id)} style={{ minWidth: 80 }} variant={r.id === activeRepoId ? "primary" : "default"}>
                {r.id === activeRepoId ? "Active" : "Activate"}
              </Button>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>{r.path}</div>
              </div>
              <Button variant="danger" onClick={() => closeRepo(r.id)} aria-label={`Close ${r.name}`}>Close</Button>
            </div>
          ))}
        </Section>
        <Section title="Recent">
          {recents.length === 0 && <div className="legit-subtle">No recent repositories yet.</div>}
          {recents.map((p) => {
            const parsed = parseLocator(p);
            return (
              <div key={p} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }} title={p}>
                <button onClick={() => doOpen(p)} style={{ minWidth: 80 }}>Open</button>
                {parsed.host && <HostBadge distro={parsed.host.distro} />}
                <span style={{ flex: 1 }}>{parsed.path}</span>
              </div>
            );
          })}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: "var(--fz-sm)", textTransform: "uppercase", letterSpacing: 0.5, color: "var(--subtle-fg)", marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}
