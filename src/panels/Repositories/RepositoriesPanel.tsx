import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { recentRepos } from "../../lib/commands";
import { formatAppError } from "../../lib/types";
import { useRepoStore } from "../../store/repos";

/** v0.1 Repositories panel — open / close / switch (DESIGN.md §8). */
export function RepositoriesPanel() {
  const openRepos = useRepoStore((s) => s.openRepos);
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const openRepo = useRepoStore((s) => s.openRepo);
  const closeRepo = useRepoStore((s) => s.closeRepo);
  const setActive = useRepoStore((s) => s.setActive);
  const refresh = useRepoStore((s) => s.refresh);
  const initialized = useRepoStore((s) => s.initialized);

  const [recents, setRecents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!initialized) refresh();
    recentRepos().then(setRecents).catch(console.warn);
  }, [initialized, refresh]);

  const doOpen = async (path: string) => {
    setError(null);
    try {
      await openRepo(path);
      const next = await recentRepos();
      setRecents(next);
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
      <div className="legit-panel__toolbar">
        <button className="primary" onClick={doDialog}>
          Open repository…
        </button>
        <span className="legit-subtle">
          {openRepos.length} open · {recents.length} recent
        </span>
      </div>
      <div className="legit-panel__body">
        {error && <div className="legit-error">{error}</div>}
        <Section title="Open">
          {openRepos.length === 0 && (
            <div className="legit-subtle">No repositories are open.</div>
          )}
          {openRepos.map((r) => (
            <div
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                borderBottom: "1px solid var(--panel-border)",
              }}
            >
              <button
                onClick={() => setActive(r.id)}
                style={{ minWidth: 80 }}
                className={r.id === activeRepoId ? "primary" : ""}
              >
                {r.id === activeRepoId ? "Active" : "Activate"}
              </button>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
                  {r.path}
                </div>
              </div>
              <button
                className="danger"
                onClick={() => closeRepo(r.id)}
                aria-label={`Close ${r.name}`}
              >
                Close
              </button>
            </div>
          ))}
        </Section>
        <Section title="Recent">
          {recents.length === 0 && (
            <div className="legit-subtle">No recent repositories yet.</div>
          )}
          {recents.map((p) => (
            <div
              key={p}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "2px 0",
              }}
            >
              <button onClick={() => doOpen(p)} style={{ minWidth: 80 }}>
                Open
              </button>
              <span style={{ flex: 1 }}>{p}</span>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: "var(--fz-sm)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--subtle-fg)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
