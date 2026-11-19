import { useCallback, useEffect, useRef, useState } from "react";
import { TitledSection } from "../shared/SectionChrome";
import { PanelError } from "../shared/PanelError";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { confirmDialog } from "../../store/confirm";
import { notify } from "../../store/notifications";
import { formatAppError } from "../../lib/errors";
import { useActiveRepo } from "../../store/repos";
import { useSignatureStore } from "../../store/signatures";
import { useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { usePanelViewState } from "../../store/panelViewState";
import { api } from "../../lib/commands";
import { formatFull, formatRelative } from "../../lib/time";
import type { CommitDetails, CommitId, SignatureVerification } from "../../lib/types";
import { signaturePresentation } from "../../lib/signature";
import { STALE } from "../../lib/queryTiming";

/** Commit Details panel — receives a CommitId payload from the summon mechanism. */
export function CommitDetailsPanel() {
  const repo = useActiveRepo();
  // Per-repo view state (store/panelViewState.ts): survives a layout apply's
  // dock rebuild and panel close/reopen, and each repo keeps its own
  // selection across tab switches - it also covers the summoned-for-the-new-
  // repo delivery race that useRepoSwitchClear used to handle (writes key by
  // the active repo at call time).
  const [selectedId, setSelectedId] = usePanelViewState<CommitId | null>(
    "commit-details.selectedId",
    null,
  );

  const onReceive = useCallback((id: unknown) => {
    if (typeof id !== "string") return;
    setSelectedId(id as CommitId);
  }, [setSelectedId]);

  useSummonTarget("commit-details", onReceive);

  const queryKey = [repo?.id, "commit-details", selectedId];

  const { data, isFetching, isError, error, refetch } = useQuery<CommitDetails>({
    queryKey,
    queryFn: () => api.repoCommitDetails(repo!.id, selectedId!),
    enabled: !!repo && !!selectedId,
    staleTime: STALE.stable,
  });

  // Record the verification result in the session signature cache so the
  // Commits list keeps showing the verified verdict chip on every commit
  // that has been inspected here (not just the selected row).
  useEffect(() => {
    if (repo && data?.commit.signature) {
      useSignatureStore.getState().record(repo.id, data.commit.id, data.commit.signature);
    }
  }, [repo, data]);

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
      <PanelLoadingBar active={isFetching} />

      {isError && (
        <PanelError error={error} />
      )}

      {data && <CommitView details={data} repoId={repo.id} />}
    </div>
  );
}

function CommitView({ details, repoId }: { details: CommitDetails; repoId: string }) {
  const { commit, raw_object } = details;
  const [showRaw, setShowRaw] = useState(false);

  const subject = commit.message.split("\n")[0] ?? "";
  const body = commit.message.includes("\n\n")
    ? commit.message.slice(commit.message.indexOf("\n\n") + 2)
    : null;

  return (
    <div className="legit-panel__body" style={{ overflowY: "auto", fontSize: "var(--fz-md)" }}>
      <TitledSection title="SHA">
        <code style={{ userSelect: "all", wordBreak: "break-all" }}>{commit.id}</code>
      </TitledSection>

      {commit.parents.length > 0 && (
        <TitledSection title={commit.parents.length === 1 ? "Parent" : "Parents"}>
          {commit.parents.map((p) => (
            <div key={p}><code style={{ fontSize: "var(--fz-sm)" }}>{p}</code></div>
          ))}
        </TitledSection>
      )}

      <TitledSection title="Author">
        <div>{commit.author.name} &lt;{commit.author.email}&gt;</div>
        <div className="legit-subtle">{formatFull(commit.author.timestamp, commit.author.tz_offset_minutes)} ({formatRelative(commit.author.timestamp)})</div>
      </TitledSection>

      {(commit.committer.name !== commit.author.name || commit.committer.timestamp !== commit.author.timestamp) && (
        <TitledSection title="Committer">
          <div>{commit.committer.name} &lt;{commit.committer.email}&gt;</div>
          <div className="legit-subtle">{formatFull(commit.committer.timestamp, commit.committer.tz_offset_minutes)}</div>
        </TitledSection>
      )}

      <TitledSection title="Message">
        <div style={{ fontWeight: 600, marginBottom: body ? 6 : 0 }}>{subject}</div>
        {body && (
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "var(--fz-md)", lineHeight: 1.5 }}>
            {body}
          </pre>
        )}
      </TitledSection>

      {commit.signature && (
        <TitledSection title="Signature">
          <SignatureView sig={commit.signature} repoId={repoId} commitId={commit.id} />
        </TitledSection>
      )}

      <TitledSection title="">
        <button onClick={() => setShowRaw((s) => !s)} style={{ fontSize: "var(--fz-sm)" }}>
          {showRaw ? "Hide raw object" : "Show raw object"}
        </button>
        {showRaw && (
          <pre style={{ marginTop: "0.667em", fontSize: "var(--fz-xs)", whiteSpace: "pre-wrap", wordBreak: "break-all", overflowX: "auto", background: "var(--input-bg)", padding: "0.667em", borderRadius: 4 }}>
            {raw_object}
          </pre>
        )}
      </TitledSection>
    </div>
  );
}

function SignatureView({
  sig,
  repoId,
  commitId,
}: {
  sig: SignatureVerification;
  repoId: string;
  commitId: CommitId;
}) {
  const { color, title } = signaturePresentation(sig.status);
  const queryClient = useQueryClient();
  const running = useRef(false);

  const trustSigner = async () => {
    if (running.current) return;
    running.current = true;
    try {
      const info = await api.signerTrustInfo(repoId, commitId);
      if (!info.key) {
        notify.error("Cannot trust this signer: the commit does not carry an SSH signature.");
        return;
      }
      const path =
        info.target === "Unconfigured"
          ? "~/.config/git/allowed_signers"
          : info.target.Configured.path;
      const unconfigured = info.target === "Unconfigured";
      const confirmed = await confirmDialog({
        title: unconfigured ? "Set up signature verification?" : "Trust this signer?",
        message: unconfigured
          ? "No allowed-signers file is configured. A new one will be created and set " +
            "in the global git config of this repository's host. Commits signed with " +
            "this key will then show as verified."
          : "Commits signed with this key will show as verified.",
        detail: `${info.principal}\n${info.key.fingerprint}\n-> ${path}`,
        confirmLabel: "Trust signer",
        danger: false,
      });
      if (!confirmed) return;
      await api.trustCommitSigner(
        repoId,
        info.principal,
        info.key.key_type,
        info.key.key_b64,
        unconfigured,
      );
      useSignatureStore.getState().clearRepo(repoId);
      queryClient.invalidateQueries({ queryKey: [repoId, "commit-details"] });
    } catch (e: unknown) {
      notify.error(formatAppError(e));
    } finally {
      running.current = false;
    }
  };

  return (
    <div>
      <span style={{ color, fontWeight: 600 }} title={title}>{sig.status}</span>
      {sig.signer && <span className="legit-subtle" style={{ marginLeft: "0.667em" }}>{sig.signer}</span>}
      {sig.status === "Untrusted" && (
        <button onClick={trustSigner} style={{ marginLeft: "0.667em", fontSize: "var(--fz-sm)" }}>
          Trust this signer...
        </button>
      )}
      {sig.key_id && <div className="legit-subtle"><code>{sig.key_id}</code></div>}
    </div>
  );
}

