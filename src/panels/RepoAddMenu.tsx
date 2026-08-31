import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { recentRepos, wslListDistros } from "../lib/commands";
import { hostLabel, parseLocator } from "../lib/locator";
import { formatAppError } from "../lib/types";
import { useGitProfiles } from "../lib/useGitProfiles";
import { useRepoStore } from "../store/repos";
import { notify } from "../store/notifications";
import { SectionLabel } from "./Commits/menu/primitives";
import { AddRepoIcon } from "../icons";
import { CloneForm, InitForm, WslOpenForm } from "./Repositories/forms";

const RECENTS_SHOWN = 5;

type Mode = "menu" | "clone" | "init" | "wsl";

/** Whether this machine has WSL distros, fetched once per app run (the check
 * spawns wsl.exe; the answer doesn't change while the app runs). */
let wslAvailable: Promise<boolean> | null = null;
function hasWsl(): Promise<boolean> {
  wslAvailable ??= wslListDistros()
    .then((list) => list.length > 0)
    .catch(() => false);
  return wslAvailable;
}

/**
 * The tab strip's "+" button: an add-repository menu (Open… / Clone… / Init…
 * plus the most recent repos), so cloning or initializing never requires the
 * Repositories panel. The forms are the shared ones from `Repositories/forms`.
 *
 * While a clone is running the popover pins itself open — outside clicks and
 * Escape are ignored — because dismissing it would orphan the progress meter
 * and the cancel button. Only "Cancel clone" (or completion) releases it.
 */
export function RepoAddMenu() {
  const openRepo = useRepoStore((s) => s.openRepo);
  const cloneRepo = useRepoStore((s) => s.cloneRepo);
  const initRepo = useRepoStore((s) => s.initRepo);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [recents, setRecents] = useState<string[]>([]);
  const [wsl, setWsl] = useState(false);
  const { data: profiles = [], refetch: refetchProfiles } = useGitProfiles();
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Pin while a clone is in flight; a ref so the document listener sees the
  // current value without re-registering.
  const cloneBusyRef = useRef(false);

  const openRepoIds = useRepoStore((s) => s.openRepos.map((r) => r.id).join("\0"));

  // Load menu data lazily each time the popover opens (recents change as
  // repos are opened; the profile list refreshes through the shared query).
  useEffect(() => {
    if (!open) return;
    recentRepos().then(setRecents).catch(console.warn);
    hasWsl().then(setWsl).catch(console.warn);
    void refetchProfiles();
  }, [open, openRepoIds, refetchProfiles]);

  const close = () => {
    setOpen(false);
    setMode("menu");
    setError(null);
  };

  // Dismiss on outside mousedown + Escape (capture phase, like every other
  // menu) — unless a clone is running.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const onDown = (e: MouseEvent) => {
      if (cloneBusyRef.current) return;
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !cloneBusyRef.current) {
        // Consumed: closing the menu must not leak to other Escape listeners
        // (e.g. exiting a maximized panel).
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDown, { capture: true, signal: controller.signal });
    document.addEventListener("keydown", onKey, { signal: controller.signal });
    return () => controller.abort();
  }, [open]);

  const doOpenDialog = async () => {
    close();
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string") await openRepo(selected);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  const doOpenRecent = async (path: string) => {
    close();
    try {
      await openRepo(path);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="legit-tabs__icon"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add repository"
        title="Add repository (open / clone / init)"
      >
        <AddRepoIcon />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            width: mode === "menu" ? 320 : 380,
            maxHeight: 480,
            overflowY: "auto",
            background: "var(--panel-bg)",
            color: "var(--panel-fg)",
            border: "1px solid var(--panel-border)",
            borderRadius: 4,
            boxShadow: "0 4px 10px var(--shadow-color)",
            zIndex: 1000,
            padding: mode === "menu" ? 4 : 8,
          }}
        >
          {error && (
            <div className="legit-error" style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
              {error}
            </div>
          )}

          {mode === "menu" && (
            <>
              <MenuRow label="Open repository…" onClick={doOpenDialog} />
              {wsl && <MenuRow label="Open in WSL…" onClick={() => setMode("wsl")} />}
              <MenuRow label="Clone repository…" onClick={() => setMode("clone")} />
              <MenuRow label="Initialize repository…" onClick={() => setMode("init")} />
              {recents.length > 0 && (
                <>
                  <SectionLabel>Recent</SectionLabel>
                  {recents.slice(0, RECENTS_SHOWN).map((p) => {
                    const parsed = parseLocator(p);
                    const chip = hostLabel(parsed.host);
                    return (
                      <MenuRow
                        key={p}
                        label={parsed.path}
                        chip={chip ?? undefined}
                        title={p}
                        subtle
                        onClick={() => doOpenRecent(p)}
                      />
                    );
                  })}
                </>
              )}
            </>
          )}

          {mode === "clone" && (
            <CloneForm
              profiles={profiles}
              onCancel={() => setMode("menu")}
              onError={setError}
              onBusyChange={(busy) => {
                cloneBusyRef.current = busy;
              }}
              onClone={async (url, parentDir, name, profileId, opId, options) => {
                await cloneRepo(url, parentDir, name, profileId, opId, options);
                close();
              }}
            />
          )}

          {mode === "wsl" && (
            <WslOpenForm
              onCancel={() => setMode("menu")}
              onError={setError}
              onOpen={async (locator) => {
                await openRepo(locator);
                close();
              }}
            />
          )}

          {mode === "init" && (
            <InitForm
              profiles={profiles}
              onCancel={() => setMode("menu")}
              onError={setError}
              onInit={async (path, profileId, options) => {
                const summary = await initRepo(path, profileId, options);
                close();
                if (!summary) {
                  notify.success(`Bare repository created at ${path}`);
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  label,
  onClick,
  title,
  subtle,
  chip,
}: {
  label: string;
  onClick: () => void;
  title?: string;
  subtle?: boolean;
  /** Small host badge before the label (e.g. the WSL distro of a recent). */
  chip?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="menuitem"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={subtle ? "legit-subtle" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 8px",
        borderRadius: 3,
        cursor: "pointer",
        background: hover ? "var(--button-hover-bg)" : "transparent",
        whiteSpace: "nowrap",
        fontSize: subtle ? "var(--fz-sm)" : undefined,
      }}
    >
      {chip && (
        <span
          style={{
            flex: "none",
            fontSize: "var(--fz-xs)",
            border: "1px solid var(--panel-border)",
            borderRadius: 3,
            padding: "0 3px",
          }}
        >
          {chip}
        </span>
      )}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          // Recents are RTL-ellipsized so the repo NAME end stays visible.
          direction: subtle ? "rtl" : undefined,
          textAlign: subtle ? "left" : undefined,
        }}
      >
        {label}
      </span>
    </div>
  );
}
