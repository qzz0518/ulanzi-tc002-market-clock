import { cn } from "@/lib/utils";

interface ContentIconProps {
  contentId: string;
  className?: string;
  compact?: boolean;
  assetRef?: string;
  iconUrl?: string;
  fallbackLabel?: string;
}

export function ContentIcon({
  contentId,
  className,
  compact = false,
  assetRef,
  iconUrl,
  fallbackLabel,
}: ContentIconProps) {
  const [namespace = "", name = ""] = contentId.split(":");
  if (namespace === "market") {
    if (name === "instrument") {
      return (
        <span className={cn("content-icon", compact && "content-icon--compact", className)} aria-hidden="true">
          {iconUrl
            ? <img src={iconUrl} alt="" />
            : (fallbackLabel ?? "MI").replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "MI"}
        </span>
      );
    }
    return (
      <span className={cn("content-icon", compact && "content-icon--compact", className)} aria-hidden="true">
        <img src={`/api/icons/${encodeURIComponent(name)}.png`} alt="" />
      </span>
    );
  }

  if (contentId === "creative:pixel-asset" && /^[a-f0-9]{64}$/.test(assetRef ?? "")) {
    return (
      <span className={cn("content-icon", compact && "content-icon--compact", className)} aria-hidden="true">
        <img src={`/api/library/ulanzi/imported/${assetRef}`} alt="" />
      </span>
    );
  }

  return (
    <span className={cn("content-icon", compact && "content-icon--compact", className)} aria-hidden="true">
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
