import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoCommitDetails } from "../../lib/commands";
import { formatFull, formatRelative } from "../../lib/time";
import type { CommitDetails, CommitId, SignatureVerification } from "../../lib/types";
import { formatAppError } from "../../lib/types";

/** Commit Details panel — receives a CommitId payload from the summon mechanism. */
export function CommitDetailsPanel() {
  const repo = useActiveRepo();
  const [selectedId, setSelectedId] = useState<CommitId | null>(null);

  useEffect(() => { setSelectedId(null); }, [repo?.id]);

  const onReceive = useCallback((id: unknown) => {
    if (typeof id === "string") setSelectedId(id as CommitId);
  }, []);

  useSummonTarget("commit-details", onReceive);

  const queryKey = [repo?.id, "commit-details", selectedId];

  const { data, isFetching, isError, error, refetch } = useQuery<CommitDetails>({
    queryKey,
    queryFn: () => repoCommitDetails(repo!.id, selectedId!),
    enabled: !!repo && !!selectedId,
    staleTime: 60_000,
  });

  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  if (!repo || !selectedId) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">Select a commit in Log to see its details.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <div className="legit-panel__toolbar">
        <strong>Commit Details</strong>
        {isFetching && <span className="legit-subtle" style={{ fontSize: 11, marginLeft: 8 }}>Loading…</span>}
      </div>

      {isError && (
        <pre className="legit-error" style={{ margin: "8px 12px", fontSize: 12 }}>
          {formatAppError(error)}
        </pre>
      )}

      {data && <CommitView details={data} />}
    </div>
  );
}

function CommitView({ details }: { details: CommitDetails }) {
  const { commit, raw_object } = details;
  const [showRaw, setShowRaw] = useState(false);

  const subject = commit.message.split("\n")[0] ?? "";
  const body = commit.message.includes("\n\n")
    ? commit.message.slice(commit.message.indexOf("\n\n") + 2)
    : null;

  return (
    <div className="legit-panel__body" style={{ overflowY: "auto", fontSize: 12 }}>
      <Section title="SHA">
        <code style={{ userSelect: "all", wordBreak: "break-all" }}>{commit.id}</code>
      </Section>

      {commit.parents.length > 0 && (
        <Section title={commit.parents.length === 1 ? "Parent" : "Parents"}>
          {commit.parents.map((p) => (
            <div key={p}><code style={{ fontSize: 11 }}>{p}</code></div>
          ))}
        </Section>
      )}

      <Section title="Author">
        <div>{commit.author.name} &lt;{commit.author.email}&gt;</div>
        <div className="legit-subtle">{formatFull(commit.author.timestamp, commit.author.tz_offset_minutes)} ({formatRelative(commit.author.timestamp)})</div>
      </Section>

      {(commit.committer.name !== commit.author.name || commit.committer.timestamp !== commit.author.timestamp) && (
        <Section title="Committer">
          <div>{commit.committer.name} &lt;{commit.committer.email}&gt;</div>
          <div className="legit-subtle">{formatFull(commit.committer.timestamp, commit.committer.tz_offset_minutes)}</div>
        </Section>
      )}

      <Section title="Message">
        <div style={{ fontWeight: 600, marginBottom: body ? 6 : 0 }}>{subject}</div>
        {body && (
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, lineHeight: 1.5 }}>
            {body}
          </pre>
        )}
      </Section>

      {commit.signature && (
        <Section title="Signature">
          <SignatureView sig={commit.signature} />
        </Section>
      )}

      <Section title="">
        <button onClick={() => setShowRaw((s) => !s)} style={{ fontSize: 11 }}>
          {showRaw ? "Hide raw object" : "Show raw object"}
        </button>
        {showRaw && (
          <pre style={{ marginTop: 8, fontSize: 10, whiteSpace: "pre-wrap", wordBreak: "break-all", overflowX: "auto", background: "var(--input-bg)", padding: 8, borderRadius: 4 }}>
            {raw_object}
          </pre>
        )}
      </Section>
    </div>
  );
}

function SignatureView({ sig }: { sig: SignatureVerification }) {
  const statusColor =
    sig.status === "Good"
      ? "var(--success-fg)"
      : sig.status === "NoSignature"
      ? "var(--subtle-fg)"
      : "var(--error-fg)";

  return (
    <div>
      <span style={{ color: statusColor, fontWeight: 600 }}>{sig.status}</span>
      {sig.signer && <span className="legit-subtle" style={{ marginLeft: 8 }}>{sig.signer}</span>}
      {sig.key_id && <div className="legit-subtle"><code>{sig.key_id}</code></div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {title && (
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--subtle-fg)", marginBottom: 4 }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}
