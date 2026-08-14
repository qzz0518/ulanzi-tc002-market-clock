import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function uid(prefix: string): string {
  // crypto.randomUUID exists only in secure contexts. Phones reach this console
  // over plain-http LAN (http://192.168.x.x:43820), where it is undefined — and
  // the VIBE preview mints ids during render, so without the fallback the whole
  // tab white-screens there. These ids only need workspace-local uniqueness.
  const core = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${core.slice(0, 12)}`;
}

export function seconds(milliseconds: number): number {
  return Math.round(milliseconds / 100) / 10;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
