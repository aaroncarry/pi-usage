/** Shared display formatting for panel and status line. */

import type { MoneyBalance } from "./types.ts";

const CURRENCY_SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$", EUR: "€" };

export function formatMoney(balance: MoneyBalance): string {
	const symbol = CURRENCY_SYMBOLS[balance.currency] ?? (balance.currency ? `${balance.currency} ` : "");
	return `${symbol}${balance.amount.toFixed(2)}`;
}

export function formatBar(percent: number, cells = 10): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * cells);
	return "█".repeat(filled) + "░".repeat(cells - filled);
}

/** Human-readable reset countdown: "now", "16m", "5h 12m", "6d 18h". */
export function formatResetDuration(resetsAt: number, now = Date.now()): string {
	if (resetsAt - now <= 0) return "now";
	const totalMinutes = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
	const days = Math.floor(totalMinutes / 1_440);
	const hours = Math.floor(totalMinutes / 60) % 24;
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

/** " · resets in 5h 12m" / " · resets now" / "" when unknown. */
export function formatResetSuffix(resetsAt: number | undefined, now = Date.now()): string {
	if (resetsAt === undefined) return "";
	const duration = formatResetDuration(resetsAt, now);
	return duration === "now" ? " · resets now" : ` · resets in ${duration}`;
}
