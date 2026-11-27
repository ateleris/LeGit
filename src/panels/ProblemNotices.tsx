import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useNotificationsStore, type Problem } from "../store/notifications";
import { useLayer } from "../store/layers";
import { useSummonStore } from "../store/summon";
import { WarningIcon } from "../icons";
import { ToolbarButton } from "./shared/ToolbarButton";

const BANNER_BUTTON_STYLE: React.CSSProperties = {
  color: "var(--banner-warning-fg)",
  borderColor: "var(--banner-warning-fg)",
};

const KIND_LABEL: Record<Problem["kind"], string> = { error: "Error", warning: "Warning" };

function useProblems(surface: Problem["surface"]): Problem[] {
  const problems = useNotificationsStore((s) => s.problems);
  return useMemo(() => problems.filter((p) => p.surface === surface), [problems, surface]);
}

const openGitLog = () => useSummonStore.getState().summon("git-log");

/**
 * App-chrome banner for errors and warnings under the "Banner" notice style:
 * shows the newest one until it is dismissed, which reveals the one before.
 */
export function ProblemBanner() {
  const problems = useProblems("banner");
  const dismiss = useNotificationsStore((s) => s.dismiss);
  useEffect(() => {
    useNotificationsStore.setState((s) => ({ bannerHosts: s.bannerHosts + 1 }));
    return () => useNotificationsStore.setState((s) => ({ bannerHosts: s.bannerHosts - 1 }));
  }, []);

  const shown = problems[problems.length - 1];
  if (!shown) return null;
  const more = problems.length - 1;
  return (
    <div
      role="alert"
      data-testid="problem-banner"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.667em",
        padding: "0.333em 0.667em",
        background: "var(--banner-warning-bg)",
        color: "var(--banner-warning-fg)",
        fontSize: "var(--fz-sm)",
        borderBottom: "1px solid var(--panel-border)",
      }}
    >
      <b>{KIND_LABEL[shown.kind]}</b>
      <span
        title={shown.message}
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
      >
        {shown.message}
      </span>
      {more > 0 && <span style={{ whiteSpace: "nowrap" }}>+{more} more</span>}
      <span style={{ display: "flex", gap: "0.333em", marginLeft: "auto" }}>
        <ToolbarButton
          label="Details"
          title="Open the Git Command Log"
          onClick={openGitLog}
          style={BANNER_BUTTON_STYLE}
        />
        <ToolbarButton
          label="Dismiss"
          title={more > 0 ? "Dismiss this one and show the next" : "Dismiss"}
          onClick={() => dismiss(shown.id)}
          style={BANNER_BUTTON_STYLE}
        />
      </span>
    </div>
  );
}

/**
 * Popup for errors and warnings under the "Popup" notice style. Everything
 * pending is listed in ONE dialog; it closes only through OK or Escape.
 */
export function ProblemPopup() {
  const problems = useProblems("popup");
  if (problems.length === 0) return null;
  return <ProblemDialog problems={problems} />;
}

function ProblemDialog({ problems }: { problems: Problem[] }) {
  const close = () => useNotificationsStore.getState().dismissProblems("popup");
  useLayer(true, "dialog", close);

  // Focus stays in a field the user is typing in, so a keystroke meant for
  // it can never close the popup unread.
  const okRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = document.activeElement;
    const typing =
      el instanceof HTMLElement &&
      (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    if (!typing) okRef.current?.focus();
  }, []);

  const onlyKind = problems.every((p) => p.kind === problems[0].kind) ? problems[0].kind : null;
  const title =
    problems.length === 1
      ? KIND_LABEL[problems[0].kind]
      : `${problems.length} ${onlyKind === "error" ? "errors" : onlyKind === "warning" ? "warnings" : "problems"}`;

  const accentKind = problems.some((p) => p.kind === "error") ? "error" : "warning";
  const accent = accentKind === "error" ? "var(--error-fg)" : "var(--warning-fg)";

  return createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 10002, background: "transparent" }} />
      <div
        data-testid="problem-popup"
        data-kind={accentKind}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: "fixed",
          top: "20%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(34em, calc(100vw - 2em))",
          background: "var(--panel-bg)",
          color: "var(--panel-fg)",
          border: "1px solid var(--panel-border)",
          borderLeft: `0.333em solid ${accent}`,
          borderRadius: 6,
          boxShadow: "0 6px 24px var(--shadow-color)",
          padding: "0.9em 1em",
          zIndex: 10003,
          display: "flex",
          flexDirection: "column",
          gap: "0.7em",
          fontSize: "var(--fz-md)",
        }}
      >
        <div
          style={{
            fontSize: "var(--fz-sm)",
            display: "flex",
            alignItems: "center",
            gap: "0.4em",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontWeight: 600,
            color: accent,
          }}
        >
          <WarningIcon />
          {title}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.7em",
            maxHeight: "50vh",
            overflowY: "auto",
          }}
        >
          {problems.map((p) => (
            <div key={p.id} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {problems.length > 1 && (
                <strong style={{ color: p.kind === "error" ? "var(--error-fg)" : "var(--warning-fg)" }}>
                  {KIND_LABEL[p.kind]}:{" "}
                </strong>
              )}
              {p.message}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5em" }}>
          <button
            data-testid="problem-popup-log"
            onClick={() => {
              openGitLog();
              close();
            }}
          >
            Open Git Command Log
          </button>
          <button
            ref={okRef}
            type="button"
            className="primary"
            data-testid="problem-popup-ok"
            onClick={close}
          >
            OK
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
