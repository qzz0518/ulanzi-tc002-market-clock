import { createElement, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, useToast } from "@cladd-ui/react";

interface ToastOptions {
  description?: ReactNode;
  action?: {
    label: string;
    onClick: () => void;
  };
}

// The toast stays up after the click (cladd gives no handle to close it), and
// every action here is an undo that re-inserts what was removed — a second
// click would insert it twice. So it fires once, then reads as done rather
// than leaving a greyed 撤销 under a title that is no longer true.
function ToastAction({ label, onClick }: { label: string; onClick: () => void }) {
  const [used, setUsed] = useState(false);
  return createElement(
    Button,
    {
      type: "button",
      size: "sm",
      className: "toast-action",
      disabled: used,
      onClick: () => {
        if (used) return;
        setUsed(true);
        onClick();
      },
    },
    used ? "已撤销" : label,
  );
}

export function useAppToast() {
  const showToast = useToast();
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  return useMemo(() => ({
    success(title: string, options?: ToastOptions) {
      showToastRef.current({
        title,
        text: options?.action
          ? createElement(
              "span",
              { className: "toast-content" },
              options.description && createElement("span", null, options.description),
              createElement(ToastAction, options.action),
            )
          : options?.description,
        color: "neutral",
      });
    },
    error(title: string, options?: ToastOptions) {
      showToastRef.current({
        title,
        text: options?.description,
        color: "red",
        timeout: 7_000,
      });
    },
  }), []);
}
