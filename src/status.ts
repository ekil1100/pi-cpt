import type { ContextUsage, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { Config } from "./config.ts";

export type Phase = "idle" | "compacting" | "fallback";

const formatTokens = (value: number): string =>
  value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(Math.round(value));

const formatUsage = (
  usage: ContextUsage | undefined,
  [format, direction]: Config["status"],
): string => {
  if (format === "percent") {
    if (usage?.percent == null) return "?";
    const value = direction === "left" ? Math.max(0, 100 - usage.percent) : usage.percent;
    return `${Math.round(value)}%`;
  }
  if (usage?.tokens == null) return "?";
  const value =
    direction === "left" ? Math.max(0, usage.contextWindow - usage.tokens) : usage.tokens;
  return formatTokens(value);
};

export const formatStatus = (
  usage: ContextUsage | undefined,
  phase: Phase,
  model: string,
  theme: Pick<ExtensionUIContext["theme"], "fg">,
  status: Config["status"],
): string => {
  const context = formatUsage(usage, status);
  const activity =
    phase === "idle" ? "" : phase === "compacting" ? " · compacting" : " · default fallback";
  return theme.fg("accent", "cpt") + theme.fg("dim", ` · ${context} · ${model}${activity}`);
};
