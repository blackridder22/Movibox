import moviboxMark from "@/assets/brand/movibox-mark-ui.png";

export function HarborMark({ className }: { className?: string }) {
  return (
    <img src={moviboxMark} alt="" aria-hidden className={`object-contain ${className ?? ""}`} />
  );
}
