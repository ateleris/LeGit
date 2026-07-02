// SVG-per-row renderer for the Commits panel graph column.
//
// Every cross-lane transition is drawn exactly once:
//
//   - Regular edges (child → parent): the child's row draws the full arc
//     from the child dot to the parent's lane at the row bottom. Rows in
//     between draw a vertical pass-through on the parent's lane (driven by
//     `activeLanes` from CommitsPanel), and the parent's row closes the
//     connection with a top stub on its own lane.
//   - Jog edges (a lane terminating into a commit on another lane): emitted
//     by lanes.ts as self-edges (`fromCommitId === toCommitId`). The
//     commit's row draws an arc from its dot up to the dying lane at the
//     row top, where it meets the line coming down from above.
//
// Connectors are horizontal/vertical line segments joined by quarter
// circles (radius = half the smaller of row height and lane width),
// tangent-aligned with the straight lines they meet: horizontal at the dot
// (the dot covers the start), vertical at the row boundary. Cross-lane arcs
// use per-arc linearGradient strokes so the line fades between the two lanes'
// colours.
//
// Lane colours are read from CSS custom properties written by the theme
// applier (see src/theme/applier.ts — `graph.lane.N` -> `--graph-lane-N`).

import { StashIcon } from "../../../icons";
import type { LaneEdge, LaneIndex } from "../graph/types";

interface GraphCellProps {
  commitId: string;
  commitLane: LaneIndex;
  totalLanes: number;
  /** Lanes that are genuinely active at this row — only these get pass-through lines. */
  activeLanes: ReadonlySet<LaneIndex>;
  /** Edges originating at this commit (child→parent). */
  edges: LaneEdge[];
  /** All edges arriving at this commit as parent (child→parent). */
  incomingEdges: LaneEdge[];
  rowHeight: number;
  /** Per-lane horizontal spacing in px (user-configurable, see Global Settings). */
  laneSpacing: number;
  /** Commit-dot radius in px (user-configurable, see Global Settings). */
  dotRadius: number;
  /** Stroke width of connector lines/arcs in px (user-configurable). */
  lineWidth: number;
  /**
   * True when a pass-through span on the commit's *own* lane covers this row —
   * an unrelated edge's lane line runs straight through this commit (its parent
   * sits below this row on the same lane). Pass-through lines are suppressed
   * for the commit's own lane to avoid double-drawing, so the own-lane vertical
   * stubs must stand in for the transiting line and be drawn full height.
   */
  ownLanePassThrough?: boolean;
  /**
   * Draw the node as a hollow ring instead of a filled dot. Used for the
   * synthetic "uncommitted changes" row to signal it is not a real commit.
   */
  hollow?: boolean;
  /**
   * Draw the node as a diamond filled with the stash colour, marking a stash
   * entry so it reads as special at a glance. Takes precedence over `hollow`.
   */
  isStash?: boolean;
}

/**
 * Stash node glyph: a lane-coloured square (side = the commit dot's diameter,
 * so stash nodes and commit dots read as the same visual weight) with the
 * stash chip's lucide `Archive` icon knocked out of it in the panel
 * background colour (a "negative"). The graph node and the chip share one
 * metaphor while the node's colour stays consistent with the edge running
 * into it; everything scales with the user's dot-radius setting.
 */
function StashNode({
  cx,
  cy,
  dotRadius,
  color,
}: {
  cx: number;
  cy: number;
  dotRadius: number;
  color: string;
}) {
  const side = dotRadius * 2;
  const iconSize = side * 0.8;
  return (
    <g>
      <rect
        x={cx - dotRadius}
        y={cy - dotRadius}
        width={side}
        height={side}
        rx={Math.max(0.5, side * 0.15)}
        fill={color}
      />
      <StashIcon
        x={cx - iconSize / 2}
        y={cy - iconSize / 2}
        size={iconSize}
        color="var(--panel-bg, #1e1e1e)"
        strokeWidth={2.75}
      />
    </g>
  );
}

export function laneColor(lane: LaneIndex): string {
  const LANE_VARS = [
    "var(--graph-lane-0)",
    "var(--graph-lane-1)",
    "var(--graph-lane-2)",
    "var(--graph-lane-3)",
    "var(--graph-lane-4)",
    "var(--graph-lane-5)",
  ];
  return lane < LANE_VARS.length ? LANE_VARS[lane] : "var(--graph-lane-fallback)";
}

/**
 * Connector from (xFrom, yFrom) to (xTo, yTo): a horizontal run, a quarter
 * circle of radius `r`, and (if `r` doesn't span the full height) a vertical
 * run to the row boundary. `r` must not exceed either leg (|dx|, |dy|), or a
 * straight run would go negative — the caller guarantees this.
 *
 * The sweep is chosen so the tangent is horizontal entering the circle and
 * vertical leaving it, seamlessly joining the straight segments:
 *   going down + right → sweep 1 (CW)    going down + left → sweep 0 (CCW)
 *   going up   + right → sweep 0 (CCW)   going up   + left → sweep 1 (CW)
 */
function arcPath(xFrom: number, xTo: number, yFrom: number, yTo: number, r: number): string {
  const dx = xTo - xFrom;
  if (dx === 0) return "";
  const dy = yTo - yFrom;
  const sweep = dy > 0 === dx > 0 ? 1 : 0;
  const xTurn = xTo - Math.sign(dx) * r;
  const yLand = yFrom + Math.sign(dy) * r;
  let d = `M ${xFrom} ${yFrom}`;
  if (xTurn !== xFrom) d += ` H ${xTurn}`;
  d += ` A ${r} ${r} 0 0 ${sweep} ${xTo} ${yLand}`;
  if (yLand !== yTo) d += ` V ${yTo}`;
  return d;
}

export function GraphCell({
  commitId,
  commitLane,
  totalLanes,
  activeLanes,
  edges,
  incomingEdges,
  rowHeight,
  laneSpacing,
  dotRadius,
  lineWidth,
  ownLanePassThrough = false,
  hollow = false,
  isStash = false,
}: GraphCellProps) {
  const halfRow = rowHeight / 2;
  const width = (totalLanes + 1) * laneSpacing;

  const laneX = (lane: LaneIndex): number => lane * laneSpacing + laneSpacing / 2;

  // Corner radius for every connector arc: half the smaller layout metric, so
  // it stays proportional when row height and lane width differ and never
  // exceeds either straight run (≤ rowHeight/2 = the dot-to-boundary reach,
  // and ≤ laneSpacing/2 ≤ the horizontal leg of any lane jog).
  const cornerRadius = Math.min(laneSpacing, rowHeight) / 2;

  const hasFirstParentContinuation = edges.some(
    (e) => e.fromLane === commitLane && e.toLane === commitLane,
  );

  // A line comes down this commit's own lane from above iff some regular
  // (non-jog) edge arrives here on this lane — either a same-lane child or
  // a cross-lane edge that already transitioned in its child's row — or a
  // pass-through span transits this commit on its own lane (an unrelated lane
  // line running straight through; its pass-through is suppressed here, so the
  // top stub stands in for it).
  const hasTopStub = ownLanePassThrough || incomingEdges.some(
    (e) => e.fromCommitId !== e.toCommitId && e.toLane === commitLane,
  );

  // Cross-lane transitions drawn in this row as the child: regular edges
  // only — jog self-edges are drawn as incoming arcs below.
  const crossEdges = edges.filter(
    (e) => e.fromLane !== e.toLane && e.fromCommitId !== e.toCommitId,
  );

  // Jog arcs: dying lanes curving into this commit's dot at this row.
  const jogEdges = incomingEdges.filter(
    (e) => e.fromCommitId === e.toCommitId,
  );

  const passThroughLanes: LaneIndex[] = [];
  for (const lane of activeLanes) {
    if (lane !== commitLane) passThroughLanes.push(lane);
  }

  const dotX = laneX(commitLane);
  const dotColor = laneColor(commitLane);

  // Short commit ID prefix used in gradient IDs — unique enough for the DOM.
  const idPrefix = commitId.slice(0, 12);

  return (
    <svg
      width={width}
      height={rowHeight}
      viewBox={`0 0 ${width} ${rowHeight}`}
      style={{ overflow: "visible", display: "block" }}
      aria-hidden="true"
    >
      {/* Gradient definitions — one per cross-lane arc. */}
      {(crossEdges.length > 0 || jogEdges.length > 0) && (
        <defs>
          {/* Child arcs: child colour at dot → parent colour at row boundary. */}
          {crossEdges.map((edge, i) => (
            <linearGradient
              key={`gout-${i}`}
              id={`gout-${idPrefix}-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={laneX(edge.fromLane)} y1={halfRow}
              x2={laneX(edge.toLane)}   y2={rowHeight}
            >
              <stop offset="0%"   stopColor={laneColor(edge.fromLane)} />
              <stop offset="100%" stopColor={laneColor(edge.toLane)} />
            </linearGradient>
          ))}
          {/* Jog arcs: dying lane colour at row top → this lane's colour at dot. */}
          {jogEdges.map((edge, i) => (
            <linearGradient
              key={`gin-${i}`}
              id={`gin-${idPrefix}-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={laneX(edge.fromLane)} y1={0}
              x2={laneX(edge.toLane)}   y2={halfRow}
            >
              <stop offset="0%"   stopColor={laneColor(edge.fromLane)} />
              <stop offset="100%" stopColor={laneColor(edge.toLane)} />
            </linearGradient>
          ))}
        </defs>
      )}

      {/* 1. Pass-through vertical lines — only for genuinely active lanes. */}
      {passThroughLanes.map((lane) => (
        <line
          key={`pt-${lane}`}
          x1={laneX(lane)} y1={0}
          x2={laneX(lane)} y2={rowHeight}
          stroke={laneColor(lane)}
          strokeWidth={lineWidth}
        />
      ))}

      {/* 2. Vertical lines for the commit's own lane. */}
      {hasTopStub && (
        <line
          x1={dotX} y1={0}
          x2={dotX} y2={halfRow}
          stroke={dotColor}
          strokeWidth={lineWidth}
        />
      )}
      {(hasFirstParentContinuation || ownLanePassThrough) && (
        <line
          x1={dotX} y1={halfRow}
          x2={dotX} y2={rowHeight}
          stroke={dotColor}
          strokeWidth={lineWidth}
        />
      )}

      {/* 3a. Jog arcs (background) — dot up to the dying lane at the row top. */}
      {jogEdges.map((edge, i) => {
        const d = arcPath(laneX(edge.toLane), laneX(edge.fromLane), halfRow, 0, cornerRadius);
        return (
          <path key={`in-${i}`} d={d}
            stroke={`url(#gin-${idPrefix}-${i})`}
            strokeWidth={lineWidth} fill="none" />
        );
      })}

      {/* 3b. Child arcs (foreground) — dot down to the parent's lane at the row bottom. */}
      {crossEdges.map((edge, i) => {
        const d = arcPath(laneX(edge.fromLane), laneX(edge.toLane), halfRow, rowHeight, cornerRadius);
        return (
          <path key={`out-${i}`} d={d}
            stroke={`url(#gout-${idPrefix}-${i})`}
            strokeWidth={lineWidth} fill="none" />
        );
      })}

      {/* 4. Commit node — rendered last so it sits on top of all lines. A stash
          shows as a lane-coloured square (dot-sized) with the Archive icon
          punched out of it (see StashNode); a hollow ring (filled with the
          panel background so lane lines don't show through its centre) marks
          the synthetic working-directory row; otherwise a filled lane-coloured
          dot. */}
      {isStash ? (
        <StashNode cx={dotX} cy={halfRow} dotRadius={dotRadius} color={dotColor} />
      ) : hollow ? (
        <circle
          cx={dotX} cy={halfRow} r={dotRadius}
          fill="var(--panel-bg, #1e1e1e)"
          stroke={dotColor}
          strokeWidth={lineWidth}
        />
      ) : (
        <circle cx={dotX} cy={halfRow} r={dotRadius} fill={dotColor} />
      )}
    </svg>
  );
}
