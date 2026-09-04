import { native } from "./backend";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  Compass,
  Download,
  History,
  Clock3,
  Library,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Brand } from "./setup";
import { preference, useDemo } from "./store";
import { navigate } from "./routing";
import type { Page } from "./types";

const navigation = [
  { page: "discover", label: "Discover", icon: Compass },
  { page: "downloads", label: "Downloads", icon: Download },
  { page: "history", label: "History", icon: History },
  { page: "monitoring", label: "Monitoring", icon: Clock3 },
  { page: "library", label: "Library", icon: Library },
] as const;

function NavHint({
  label,
  compact,
  children,
}: {
  label: string;
  compact: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip.Root disabled={!compact}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="right" sideOffset={12} className="tooltip-positioner">
          <Tooltip.Popup className="tooltip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function SidebarContent({
  page,
  compact,
  onToggle,
  onNavigate,
  toggleRef,
}: {
  page: Page;
  compact: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  toggleRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const state = useDemo();
  const provider = state.preferences.defaultProvider === "realdebrid" ? "Real-Debrid" : "TorBox";
  return (
    <>
      <Brand />
      <nav aria-label="Main navigation">
        {navigation.map(({ page: target, label, icon: Icon }) => (
          <NavHint key={target} label={label} compact={compact}>
            <a
              aria-label={label}
              href={`#/${target}`}
              onClick={onNavigate}
              className={`nav-item ${page === target ? "selected" : ""}`}
              aria-current={page === target ? "page" : undefined}
            >
              <Icon size={18} />
              <span>{label}</span>
              {target === "downloads" && (
                <span className="count">
                  {
                    state.jobs.filter((j) =>
                      ["active", "queued", "paused", "failed", "preparing", "scheduled"].includes(
                        j.status,
                      ),
                    ).length
                  }
                </span>
              )}
              {target === "monitoring" && <span className="count">{state.rules.length}</span>}
            </a>
          </NavHint>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <NavHint
          label={
            native
              ? state.preferences.provider
                ? `${provider} connected`
                : `${provider} not connected`
              : "TorBox · Demo — no live downloads"
          }
          compact={compact}
        >
          <button
            className={compact ? "nav-item provider-mini" : "provider-status"}
            aria-label={
              native
                ? state.preferences.provider
                  ? `${provider} connected`
                  : `${provider} not connected`
                : "TorBox · Demo — no live downloads"
            }
            onClick={() => {
              navigate("settings", "About & diagnostics");
              onNavigate();
            }}
          >
            {compact ? (
              <i className="dot" aria-hidden="true" />
            ) : (
              <>
                <strong>
                  <span className="dot" />
                  {native
                    ? state.preferences.provider
                      ? `${provider} · Connected`
                      : `${provider} · Not connected`
                    : "TorBox · Demo"}
                </strong>
                <small>
                  {native
                    ? `${state.jobs.filter((j) => j.status === "active").length} active downloads`
                    : "No live downloads."}
                </small>
              </>
            )}
          </button>
        </NavHint>
        <div className="sidebar-actions">
          <NavHint label="Settings" compact={compact}>
            <a
              aria-label="Settings"
              href="#/settings/Providers"
              onClick={onNavigate}
              className={`nav-item ${page === "settings" ? "selected" : ""}`}
              aria-current={page === "settings" ? "page" : undefined}
            >
              <Settings size={18} />
              <span>Settings</span>
            </a>
          </NavHint>
          <NavHint label={compact ? "Expand sidebar" : "Collapse sidebar"} compact={compact}>
            <button
              ref={toggleRef}
              className="nav-item sidebar-toggle"
              aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!compact}
              onClick={onToggle}
            >
              {compact ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              <span>Collapse sidebar</span>
            </button>
          </NavHint>
        </div>
      </div>
    </>
  );
}

export function Sidebar({ page }: { page: Page }) {
  const { preferences } = useDemo();
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 760px)").matches);
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = matchMedia("(max-width: 760px)");
    const change = () => {
      setNarrow(query.matches);
      setMobileOpen(false);
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const compact = narrow || preferences.sidebarCollapsed;
  return (
    <Tooltip.Provider delay={300}>
      <aside className={`sidebar ${compact ? "sidebar-collapsed" : ""}`} aria-label="Sidebar">
        <SidebarContent
          page={page}
          compact={compact}
          toggleRef={toggleRef}
          onNavigate={() => setMobileOpen(false)}
          onToggle={() =>
            narrow
              ? setMobileOpen(true)
              : preference("sidebarCollapsed", !preferences.sidebarCollapsed)
          }
        />
      </aside>
      <Dialog.Root open={narrow && mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal className="modal-layer">
          <Dialog.Backdrop className="modal-backdrop" />
          <Dialog.Popup className="sidebar sidebar-mobile" finalFocus={toggleRef}>
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <SidebarContent
              page={page}
              compact={false}
              onToggle={() => setMobileOpen(false)}
              onNavigate={() => setMobileOpen(false)}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </Tooltip.Provider>
  );
}
