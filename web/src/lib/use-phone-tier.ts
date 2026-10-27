import { useSyncExternalStore } from "react";

// Same query as the 52rem tier in globals.css, where the cladd control tokens
// step up a size. A control that does not follow those tokens (Switch: fixed
// thumb sizes) picks its size from this instead, so it still matches its row.
const PHONE_QUERY = "(max-width: 52rem)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const isPhone = () => window.matchMedia(PHONE_QUERY).matches;

export function usePhoneTier(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}
