import { cn } from "@/lib/utils";

interface ContentIconProps {
  contentId: string;
  className?: string;
  compact?: boolean;
  assetRef?: string;
}

export function ContentIcon({ contentId, className, compact = false, assetRef }: ContentIconProps) {
  const [namespace = "", name = ""] = contentId.split(":");
  if (namespace === "market") {
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
