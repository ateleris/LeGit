import type { GitStatus } from "../../lib/types";
import { Row } from "./primitives";

/** "2.34.0" from a `minimum_required` triple. */
export function formatVersionTriple(v: [number, number, number]): string {
  return `${v[0]}.${v[1]}.${v[2]}`;
}

/** The four facts of a probed git binary. Shared by the app machine's and the
 *  WSL executable sections so the two readouts cannot drift. */
export function GitStatusReadout({ status }: { status: GitStatus }) {
  return (
    <>
      <Row label="Resolved path" value={<code>{status.resolved_path}</code>} />
      <Row
        label="Version"
        value={
          status.version ? (
            <code>{status.version.raw}</code>
          ) : (
            <span className="legit-error">{status.error ?? "(unknown)"}</span>
          )
        }
      />
      <Row
        label="Minimum required"
        value={<code>{formatVersionTriple(status.minimum_required)}</code>}
      />
      <Row
        label="Meets minimum"
        value={
          status.meets_minimum ? (
            <span className="legit-success">yes</span>
          ) : (
            <span className="legit-error">no</span>
          )
        }
      />
    </>
  );
}
