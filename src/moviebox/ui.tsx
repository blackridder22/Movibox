import { native } from "./backend";
import { notify } from "./store";
// Owned primitives adapted from blackridder22UI. Base UI retains accessible behavior;
// Movie Box's approved Paper tokens supply the visual treatment.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type ReactElement,
  type Ref,
} from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Menu } from "@base-ui/react/menu";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Select } from "@base-ui/react/select";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { motion, useIsPresent, usePresence } from "motion/react";
import { Presence, useMotionPolicy, useMotionTransition } from "./motion";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Minus,
  MoreHorizontal,
  X,
  Info,
  Folder,
  Search,
} from "lucide-react";
import { dismissNotice, useNotices, type Notice } from "./store";
export function Button({
  children,
  className = "",
  variant = "secondary",
  busy = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={`button ${variant} ${className}`}
    >
      {busy && <LoaderCircle className="spin" size={15} />} {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Button
      {...props}
      variant="ghost"
      className={`icon-button ${props.className ?? ""}`}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}
export function ActionGroup({
  children,
  align = "end",
  className = "",
}: {
  children: ReactNode;
  align?: "start" | "end" | "between";
  className?: string;
}) {
  return <div className={`action-group action-group-${align} ${className}`}>{children}</div>;
}
export function Input({
  onKeyDown,
  onPointerDown,
  onBlur,
  onClick,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const [editing, setEditing] = useState(false);
  return (
    <input
      {...props}
      readOnly={props.readOnly || !editing}
      className={`input ${props.className ?? ""}`}
      onClick={(e) => {
        setEditing(true);
        onClick?.(e);
      }}
      onPointerDown={(e) => {
        setEditing(true);
        onPointerDown?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !editing) {
          e.preventDefault();
          setEditing(true);
        }
        if (e.key === "Escape" && editing) {
          e.stopPropagation();
          setEditing(false);
        }
        onKeyDown?.(e);
      }}
      onBlur={(e) => {
        setEditing(false);
        onBlur?.(e);
      }}
    />
  );
}
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
      {error && (
        <small className="error" role="alert">
          {error}
        </small>
      )}
    </label>
  );
}
export function Choice({
  value,
  options,
  onChange,
  label,
  className = "",
  displayValue,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  label: string;
  className?: string;
  displayValue?: string;
}) {
  return (
    <Select.Root value={value} onValueChange={(v) => v !== null && onChange(v)}>
      <Select.Trigger aria-label={label} className={`choice ${className}`}>
        {displayValue ? <span>{displayValue}</span> : <Select.Value />}
        {<ChevronDown size={14} />}
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} className="select-positioner">
          <Select.Popup className="choice-menu">
            <Select.List>
              {options.map((option) => (
                <Select.Item key={option} value={option} className="menu-item">
                  <Select.ItemText>{option}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <SwitchPrimitive.Root
      disabled={disabled}
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className="switch"
    >
      <SwitchPrimitive.Thumb className="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
export function CheckBox({
  checked,
  onChange,
  label,
  disabled = false,
  indeterminate = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  indeterminate?: boolean;
}) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
      indeterminate={indeterminate}
      className="checkbox"
    >
      <CheckboxPrimitive.Indicator>
        {indeterminate ? <Minus size={12} /> : <Check size={12} />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
export type MenuAction = { label: string; run: () => void; danger?: boolean; disabled?: boolean };
export function Popover({
  title,
  trigger,
  children,
  open,
  onOpenChange,
  className = "",
  footer,
  sideOffset = 8,
  alignOffset = 0,
}: {
  title: string;
  trigger: ReactElement;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  footer?: ReactNode;
  sideOffset?: number;
  alignOffset?: number;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger render={trigger} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          align="end"
          className="popover-positioner"
        >
          <PopoverPrimitive.Popup className={`popover ${className}`}>
            <PopoverPrimitive.Title
              className={className === "source-popover" ? "sr-only" : "popover-title"}
            >
              {title}
            </PopoverPrimitive.Title>
            {children}
            {footer && <ActionGroup>{footer}</ActionGroup>}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
export function Actions({
  items,
  label = "More actions",
  children,
}: {
  items: MenuAction[];
  label?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    window.addEventListener("hashchange", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("hashchange", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        className={children ? "button ghost" : "button ghost icon-button"}
        aria-label={label}
      >
        {children ?? <MoreHorizontal size={18} />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="select-positioner">
          <Menu.Popup className="choice-menu">
            {items.map((item) => (
              <Menu.Item
                key={item.label}
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
                disabled={item.disabled}
                className={`menu-item ${item.danger ? "error" : ""}`}
              >
                {item.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function ContextActions({ items, children }: { items: MenuAction[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    window.addEventListener("hashchange", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("hashchange", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);
  return (
    <ContextMenu.Root open={open} onOpenChange={setOpen}>
      <ContextMenu.Trigger className="context-trigger">{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner sideOffset={4} className="select-positioner">
          <ContextMenu.Popup className="choice-menu">
            {items.map((item) => (
              <ContextMenu.Item
                key={item.label}
                disabled={item.disabled}
                className={`menu-item ${item.danger ? "error" : ""}`}
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
              >
                {item.label}
              </ContextMenu.Item>
            ))}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
export function Modal({
  title,
  description,
  children,
  onClose,
  footer,
  wide = false,
  size,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  size?: "compact" | "form";
}) {
  const [present, safeToRemove] = usePresence();
  const restore = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return (
    <Dialog.Root
      open={present}
      onOpenChangeComplete={(open) => {
        if (!open) safeToRemove?.();
      }}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal className="modal-layer">
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Viewport className="modal-viewport">
          <Dialog.Popup
            finalFocus={restore}
            initialFocus={true}
            className={`modal ${wide ? "wide" : ""} ${size ? `modal-${size}` : ""}`}
          >
            <div className="modal-header">
              <div>
                <Dialog.Title>{title}</Dialog.Title>
                {description && <Dialog.Description>{description}</Dialog.Description>}
              </div>
              <Dialog.Close className="button ghost icon-button" aria-label="Close dialog">
                <X size={18} />
              </Dialog.Close>
            </div>
            <div className="modal-body">{children}</div>
            {footer && <ActionGroup className="modal-footer">{footer}</ActionGroup>}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Confirm({
  title,
  description,
  confirm = "Confirm",
  onConfirm,
  onClose,
  children,
  danger = true,
}: {
  title: string;
  description: string;
  confirm?: string;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
  danger?: boolean;
}) {
  return (
    <Modal
      size="compact"
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
export function Drawer({
  title,
  description,
  inspector = false,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  inspector?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const present = useIsPresent();
  const { instant, reduced } = useMotionPolicy();
  const transition = useMotionTransition();
  const hidden = { opacity: 0, transform: instant || reduced ? "none" : "translateX(3%)" };
  useEffect(() => {
    const origin = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    panel?.focus();
    return () => {
      if (
        origin?.isConnected &&
        (document.activeElement === document.body || panel?.contains(document.activeElement))
      )
        origin.focus();
    };
  }, []);
  return (
    <motion.aside
      ref={ref}
      initial={instant ? false : hidden}
      animate={{ opacity: 1, transform: "none" }}
      exit={hidden}
      transition={transition}
      inert={!present}
      data-exiting={!present}
      tabIndex={-1}
      className={`drawer ${inspector ? "inspector" : ""}`}
      aria-labelledby={id}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="drawer-header">
        <div>
          {inspector ? <h2 id={id}>{title}</h2> : <span id={id}>{title}</span>}
          {description && <p>{description}</p>}
        </div>
        <IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      {children}
    </motion.aside>
  );
}
export function Banner({
  title,
  children,
  tone = "info",
}: {
  title: string;
  children?: ReactNode;
  tone?: "info" | "warning" | "error" | "success";
}) {
  return (
    <div className={`banner ${tone}`}>
      <Info size={16} />
      <div>
        <strong>{title}</strong>
        {children && <div className="banner-description">{children}</div>}
      </div>
    </div>
  );
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <Search size={28} />
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Tabs({
  value,
  items,
  onChange,
  segmented = false,
}: {
  value: string;
  items: { value: string; label: string; icon?: ReactNode }[];
  onChange: (v: string) => void;
  segmented?: boolean;
}) {
  return (
    <div className={segmented ? "tabs segmented" : "tabs"} role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          aria-label={item.label}
          tabIndex={value === item.value ? 0 : -1}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(
              event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>("button"),
            );
            const index = buttons.indexOf(event.currentTarget);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }}
          className={value === item.value ? "selected" : ""}
          onClick={() => onChange(item.value)}
        >
          {item.icon ?? item.label}
        </button>
      ))}
    </div>
  );
}
export function Header({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children}
    </header>
  );
}
export function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
export function FolderChoice({
  value,
  onChange,
  actionText,
}: {
  value: string;
  onChange: (v: string) => void;
  actionText?: string;
}) {
  const chooseNativeFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const folder = await open({
        directory: true,
        multiple: false,
        defaultPath: value.startsWith("/") ? value : undefined,
        title: "Choose download folder",
      });
      if (typeof folder === "string") onChange(folder);
    } catch (error) {
      notify(String(error));
    }
  };
  if (native)
    return (
      <div className={`folder-choice ${actionText ? "folder-action" : ""}`}>
        <Button className="folder-trigger" title={value} onClick={chooseNativeFolder}>
          <Folder size={16} />
          <span className="folder-path">{actionText ?? value}</span>
        </Button>
      </div>
    );
  return (
    <div className={`folder-choice ${actionText ? "folder-action" : ""}`}>
      {!actionText && <Folder size={16} />}
      <Choice
        value={value}
        displayValue={actionText}
        label="Save to folder"
        options={[
          ...new Set([value, "Movies", "Series", "External drive / Movies", "Choose folder…"]),
        ]}
        onChange={(v) => onChange(v === "Choose folder…" ? "Demo folder / Downloads" : v)}
      />
    </div>
  );
}
export function Notices() {
  const notices = useNotices();
  return (
    <div className="notices" aria-live="polite" aria-atomic="false">
      <Presence>
        {notices.map((n) => (
          <NoticeItem key={n.id} notice={n} />
        ))}
      </Presence>
    </div>
  );
}
function NoticeItem({ notice: n }: { notice: Notice }) {
  const present = useIsPresent();
  const { instant, reduced } = useMotionPolicy();
  const transition = useMotionTransition("popup");
  const hidden = { opacity: 0, transform: instant || reduced ? "none" : "translateY(20%)" };
  return (
    <motion.div
      className="toast"
      initial={instant ? false : hidden}
      animate={{ opacity: 1, transform: "none" }}
      exit={hidden}
      transition={transition}
      inert={!present}
      data-exiting={!present}
    >
      <Check size={16} />
      <span>{n.text}</span>
      {n.action && (
        <Button
          variant="ghost"
          onClick={() => {
            n.action?.run();
            dismissNotice(n.id);
          }}
        >
          {n.action.label}
        </Button>
      )}
      <IconButton label="Dismiss notification" onClick={() => dismissNotice(n.id)}>
        <X size={14} />
      </IconButton>
    </motion.div>
  );
}
