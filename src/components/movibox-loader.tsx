import { useEffect } from "react";
import { HarborMark } from "@/components/icons/harbor-mark";

type Size = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<Size, string> = {
  sm: "h-16 w-16",
  md: "h-24 w-24",
  lg: "h-32 w-32",
  xl: "h-44 w-44",
};

export function MoviboxLoader({
  size = "md",
  caption,
  className = "",
  onReady,
}: {
  size?: Size;
  caption?: string;
  className?: string;
  keyed?: boolean;
  logos?: string[];
  onReady?: () => void;
}) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => onReady?.());
    return () => cancelAnimationFrame(frame);
  }, [onReady]);

  return (
    <div className={`flex flex-col items-center justify-center gap-5 ${className}`}>
      <div className={`relative grid place-items-center ${SIZE_CLASS[size]}`} aria-hidden>
        <span className="absolute inset-0 animate-pulse rounded-[30%] bg-[radial-gradient(circle,rgba(255,89,73,0.28),transparent_68%)] blur-xl" />
        <span className="absolute inset-[9%] animate-[spin_5s_linear_infinite] rounded-full border border-transparent border-t-[#ff9a3d]/60 border-r-[#ff5147]/20" />
        <HarborMark className="relative h-[62%] w-[62%] drop-shadow-[0_12px_28px_rgba(255,82,66,0.32)]" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <span className="font-display text-[20px] font-semibold tracking-[-0.025em] text-white">
          MoviBox
        </span>
        <span className="flex gap-1.5" aria-hidden>
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="h-1 w-5 rounded-full bg-gradient-to-r from-[#ff5147] to-[#ffad3d]"
              style={{
                animation: "pulse 1.2s ease-in-out infinite",
                animationDelay: `${index * 160}ms`,
              }}
            />
          ))}
        </span>
      </div>
      {caption ? (
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55">
          {caption}
        </p>
      ) : null}
    </div>
  );
}
