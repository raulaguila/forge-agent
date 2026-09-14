/** Rough USD estimates per 1M tokens (input/output). Override via settings later. */
const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "claude-sonnet": { in: 3, out: 15 },
  "claude-haiku": { in: 0.8, out: 4 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
  "gemini-1.5": { in: 0.35, out: 1.05 },
  default: { in: 1, out: 3 },
};

function priceFor(model: string): { in: number; out: number } {
  const m = model.toLowerCase();
  for (const [key, price] of Object.entries(PRICE_PER_M)) {
    if (key !== "default" && m.includes(key)) {
      return price;
    }
  }
  if (m.includes("claude") && m.includes("haiku")) {
    return PRICE_PER_M["claude-haiku"];
  }
  if (m.includes("claude")) {
    return PRICE_PER_M["claude-sonnet"];
  }
  if (m.includes("gemini")) {
    return PRICE_PER_M["gemini-2.0-flash"];
  }
  return PRICE_PER_M.default;
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = priceFor(model);
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

export function formatUsage(u: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}): string {
  const cost =
    u.estimatedCostUsd != null ? ` · ~$${u.estimatedCostUsd.toFixed(4)}` : "";
  return `tokens in ${u.inputTokens} / out ${u.outputTokens} (Σ ${u.totalTokens})${cost}`;
}
