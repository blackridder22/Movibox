import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimatePresence, type Transition } from "motion/react";
import { useDemo } from "./store";
import "./motion.css";

const MotionContext = createContext({ instant: true, reduced: false });

export function MotionProvider({ children }: { children: ReactNode }) {
  const { preferences } = useDemo();
  const [input, setInput] = useState("keyboard");
  const [systemReduced, setSystemReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduced(media.matches);
    const pointer = () => {
      document.documentElement.dataset.motionInput = "pointer";
      setInput("pointer");
    };
    const keyboard = () => {
      document.documentElement.dataset.motionInput = "keyboard";
      setInput("keyboard");
    };
    document.documentElement.dataset.motionInput = "keyboard";
    media.addEventListener("change", update);
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", keyboard, true);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", keyboard, true);
      delete document.documentElement.dataset.motionInput;
    };
  }, []);
  const value = useMemo(
    () => ({
      instant: input === "keyboard",
      reduced: systemReduced || preferences.motion === "Reduce",
    }),
    [input, systemReduced, preferences.motion],
  );
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export const useMotionPolicy = () => useContext(MotionContext);

// CSS owns the timing and curve tokens used by both CSS and Motion.
export function useMotionTransition(
  kind: "fast" | "popup" | "surface" = "surface",
  moving = false,
): Transition {
  const { instant, reduced } = useMotionPolicy();
  const css = getComputedStyle(document.documentElement);
  const duration = parseFloat(css.getPropertyValue(`--motion-${reduced ? "fast" : kind}`)) || 0;
  const curve = css
    .getPropertyValue(moving ? "--ease-in-out" : "--ease-out")
    .match(/[\d.]+/g)
    ?.map(Number);
  return {
    duration: instant ? 0 : duration / 1000,
    ease: curve?.length === 4 ? (curve as [number, number, number, number]) : "linear",
  };
}

export function Presence({ children }: { children: ReactNode }) {
  return (
    <AnimatePresence initial={false} propagate>
      {children}
    </AnimatePresence>
  );
}

export function usePageMotion(ref: RefObject<HTMLElement | null>, route: string) {
  const { instant } = useMotionPolicy();
  const previous = useRef(route);
  const animation = useRef<Animation | null>(null);
  const animatedTarget = useRef<HTMLElement | null>(null);
  useEffect(() => () => animation.current?.cancel(), []);
  useLayoutEffect(() => {
    const changed = previous.current !== route;
    previous.current = route;
    if (instant) {
      animation.current?.cancel();
      return;
    }
    if (!changed) return;
    const main = ref.current;
    if (!main || main.querySelector(".drawer")) return;
    const target = main.querySelector<HTMLElement>(".settings-content, .page");
    if (!target) return;
    const opacity =
      animatedTarget.current === target && animation.current?.playState === "running"
        ? getComputedStyle(target).opacity
        : "0.35";
    animation.current?.cancel();
    animatedTarget.current = target;
    const css = getComputedStyle(document.documentElement);
    animation.current = target.animate([{ opacity }, { opacity: 1 }], {
      duration: parseFloat(css.getPropertyValue("--motion-fast")),
      easing: css.getPropertyValue("--ease-out").trim(),
    });
  }, [ref, route, instant]);
}
