import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoLog, repoTags } from "../../lib/commands";
import type { Commit, TagInfo } from "../../lib/types";
import { copyText } from "../../lib/clipboard";
import { notify } from "../../store/notifications";
import { PanelError } from "../shared/PanelError";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { Button } from "../shared/buttons";
import { formatReleaseNotes, latestTagName } from "./releaseNotes";

/** Explicit walk cap - a release range can exceed repoLog's 500 default.
 *  Hitting it shows a truncation notice; never a silently shortened list. */
const MAX_COMMITS = 10_000;

/**
 * Release Notes panel - a plain-text summary of the commits in a from..to
 * range (Git Extensions' release-notes generator, with tag/branch pickers).
 * From defaults to the most recently created tag, To to HEAD, so "notes
 * since the last release" needs zero clicks. See the 2026-07-31 spec.
 */
export function ReleaseNotesPanel() {
  const repo = useActiveRepo();
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState("HEAD");

  // Reset when the repo changes - the range belongs to the previous repo.
  const prevRepoId = useRef(repo?.id);
  useEffect(() => {
    if (prevRepoId.current === repo?.id) return;
    prevRepoId.current = repo?.id;
    setFrom(null);
    setTo("HEAD");
  }, [repo?.id]);

  const { data: tags = [] } = useQuery<TagInfo[]>({
    queryKey: [repo?.id, "tags"],
    queryFn: () => repoTags(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  // Default From once tags arrive; null means "not yet chosen" so a repo
  // without tags still lets the user type a rev by hand.
  useEffect(() => {
    if (from === null && tags.length > 0) setFrom(latestTagName(tags));
  }, [from, tags]);

  const range = from && to.trim() !== "" ? `${from}..${to}` : null;

  const {
    data: commits = [],
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<Commit[]>({
    // Under the "log" domain: new commits change the notes.
    queryKey: [repo?.id, "log", "release-notes", range],
    queryFn: () => repoLog(repo!.id, MAX_COMMITS, 0, range!),
    enabled: !!repo && range !== null,
    staleTime: 5_000,
    placeholderData: keepPreviousData,
  });
  usePanelFocusEffect(() => { refetch(); });

  const notes = useMemo(() => formatReleaseNotes(commits), [commits]);
  const truncated = commits.length >= MAX_COMMITS;

  const onCopy = async () => {
    try {
      await copyText(notes);
      notify.success("Release notes copied");
    } catch {
      notify.error("Could not copy to the clipboard");
    }
  };

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  const inputStyle: React.CSSProperties = {
    fontSize: "var(--fz-md)",
    fontFamily: "monospace",
    flex: 1,
    minWidth: 0,
  };

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__body" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: "10em" }}>
            <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>From</span>
            <input
              value={from ?? ""}
              placeholder="tag / branch / SHA"
              onChange={(e) => setFrom(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: "10em" }}>
            <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>To</span>
            <input
              value={to}
              placeholder="HEAD"
              onChange={(e) => setTo(e.target.value)}
              style={inputStyle}
            />
          </label>
          <Button variant="primary" disabled={notes === ""} onClick={onCopy}>
            Copy
          </Button>
        </div>

        {isError ? (
          <PanelError error={error} margin={0} />
        ) : range === null ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            Pick a From revision (tag, branch, or any rev expression) to generate notes.
          </span>
        ) : commits.length === 0 && !isFetching ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No commits in this range.
          </span>
        ) : (
          <>
            <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
              {commits.length} {commits.length === 1 ? "commit" : "commits"}
              {truncated ? ` - list truncated at ${MAX_COMMITS}` : ""}
            </span>
            <textarea
              readOnly
              value={notes}
              spellCheck={false}
              style={{
                flex: 1,
                minHeight: 0,
                resize: "none",
                fontSize: "var(--fz-md)",
                fontFamily: "monospace",
                whiteSpace: "pre",
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
