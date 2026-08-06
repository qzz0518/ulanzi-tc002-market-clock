import { createElement, useMemo, useRef, type ReactNode } from "react";
import { useToast } from "@cladd-ui/react";

interface ToastOptions {
  description?: ReactNode;
  action?: {
    label: string;
    onClick: () => void;
  };
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
              createElement(
                "button",
                { type: "button", className: "toast-action", onClick: options.action.onClick },
                options.action.label,
              ),
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
