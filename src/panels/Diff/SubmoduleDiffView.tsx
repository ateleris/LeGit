import { useQuery } from "@tanstack/react-query";
import { repoSubmoduleLog } from "../../lib/commands";
import type { SubmoduleChange, SubmoduleLog } from "../../lib/types";

/**
 * Rich submodule pointer diff (spec 2026-07-08): old -> new SHA, a dirty
 * badge, and the commits between the pointers (lazy `git -C <sub> log`,
 * TortoiseGit-style). An unfetched target renders a distinct state instead
 * of an error.
 */
export function SubmoduleDiffView({
  repoId,
  change,
}: {
  repoId: string;
  change: SubmoduleChange;
}) {
  const { path, old_sha, new_sha, dirty } = change;
  const { data, isError } = useQuery<SubmoduleLog>({
    queryKey: [repoId, "submodule-log", path, old_sha, new_sha],
    queryFn: () => repoSubmoduleLog(repoId, path, old_sha, new_sha!),
    enabled: new_sha !== null,
    staleTime: 60_000,
    retry: false,
  });

  return (
    <div
      className="legit-panel__body"
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--fz-md)", fontFamily: "monospace" }}>{path}</span>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
          submodule
        </span>
        {dirty && (
          <span
            style={{
              fontSize: "var(--fz-sm)",
              color: "var(--status-modified)",
              border: "1px solid currentColor",
              borderRadius: "0.75em",
              padding: "0 0.5em",
            }}
          >
            contains uncommitted changes
          </span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "monospace",
          fontSize: "var(--fz-md)",
        }}
      >
        <Sha sha={old_sha} fallback="(none)" />
        <span className="legit-subtle">→</span>
        <Sha sha={new_sha} fallback="(removed)" />
      </div>

      {new_sha === null ? (
        <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
          Submodule removed.
        </span>
      ) : isError ? (
        <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
          Could not read the submodule's history.
        </span>
      ) : data?.kind === "target_missing" ? (
        <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
          The target commit is not present locally - fetch inside the submodule
          to see the commits it brings in.
        </span>
      ) : data?.kind === "commits" ? (
        data.commits.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No new commits between the pointers (backwards move or divergence).
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {data.commits.map((c) => (
              <div
                key={c.id}
                style={{ display: "flex", gap: 8, fontSize: "var(--fz-md)" }}
              >
                <span
                  className="legit-subtle"
                  style={{ fontFamily: "monospace", flexShrink: 0 }}
                  title={c.id}
                >
                  {c.id.slice(0, 8)}
                </span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={c.subject}
                >
                  {c.subject}
                </span>
              </div>
            ))}
            {data.commits.length === 100 && (
              <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
                First 100 commits shown.
              </span>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}

function Sha({ sha, fallback }: { sha: string | null; fallback: string }) {
  if (sha === null) return <span className="legit-subtle">{fallback}</span>;
  return <span title={sha}>{sha.slice(0, 12)}</span>;
}
