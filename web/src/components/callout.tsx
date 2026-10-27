import type { ComponentType, ReactNode, SVGProps } from "react";
import { Surface } from "@cladd-ui/react";
import { cn } from "@/lib/utils";

interface CalloutProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: ReactNode;
  tone?: "neutral" | "success" | "warning" | "error";
  role?: "status" | "alert";
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * The console's one notice card — offline, not-signed-in, a failed read, a warning before an
 * action. Tone lives in the icon only and the card stays neutral: a tinted card reads as a
 * different system, and every page had grown its own (a brand-green band, a recessed block,
 * a full-bleed strip). Body copy goes in as <p> children.
 */
export function Callout({ icon: Icon, title, tone = "neutral", role, action, className, children }: CalloutProps) {
  return (
    <Surface variant="solid" outline className={cn("callout", className)} contentClassName="callout__content">
      <Icon aria-hidden="true" className={cn("callout__icon", tone !== "neutral" && `is-${tone}`)} />
      <div className="callout__body">
        <div className="callout__text" role={role}>
          <strong>{title}</strong>
          {children}
        </div>
        {action && <div className="callout__action">{action}</div>}
      </div>
    </Surface>
  );
}
