import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function seconds(milliseconds: number): number {
  return Math.round(milliseconds / 100) / 10;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
