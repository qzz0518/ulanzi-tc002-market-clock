import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface DisclosureProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  open: boolean;
  /** Mount nothing until the first open, then stay mounted — for blocks that are many and heavy. */
  lazy?: boolean;
  /** false renders a plain wrapper: the same markup in a layout where the block never folds. */
  animated?: boolean;
  /** Padding goes here, never on the clip: padding cannot shrink, so on the clip it would hold a
   *  shut fold open, and inside the clip it keeps cladd's focus rings (≈3px outside) visible. */
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * The console's one open/close-in-place block, on the shared `.disclosure` clocks in globals.css.
 * Content stays mounted while shut and is inert, so Tab skips it and closing animates too.
 * A lazy block opening for the first time mounts shut, commits, and only then flips open —
 * mounting straight into the open state would skip the transition and pop in.
 */
export function Disclosure({
  open,
  lazy = false,
  animated = true,
  bodyClassName,
  className,
  children,
  ...rest
}: DisclosureProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(open || !lazy);
  // Open on first render (a default section): no entrance on page load.
  const [armed, setArmed] = useState(open || !lazy);
  if (open && !mounted) setMounted(true);
  useLayoutEffect(() => {
    if (!open || armed || !ref.current) return;
    void ref.current.offsetHeight;
    setArmed(true);
  }, [open, armed, mounted]);
  if (!mounted) return null;
  const shown = open && armed;
  return (
    <div
      ref={ref}
      className={cn(animated && "disclosure", className)}
      data-open={shown}
      inert={!shown}
      {...rest}
    >
      <div>
        <div className={bodyClassName}>{children}</div>
      </div>
    </div>
  );
}
