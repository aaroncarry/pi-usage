/**
 * Footer status line rendering: one dense row injected via
 * ctx.ui.setStatus("usage", ...). The default ("all") shows every configured
 * account on that row — active account first and unstyled, the rest dimmed —
 * so the dedicated footer line carries full value. "active" shows only the
 * active account with all of its windows; "off" hides the row.
 */

import type { StatusMode } from "../config.ts";
import { formatMoney } from "../format.ts";
import { formatTokens, type SessionUsageTotals } from "../session-usage.ts";
import type { AccountBalance } from "../types.ts";

/** Structural subset of pi's Theme used by the status line/panel. */
export interface ThemeLike {
	fg(color: "dim" | "muted" | "accent" | "success" | "warning" | "error" | "text", text: string): string;
	bold(text: string): string;
	bg(color: "customMessageBg", text: string): string;
}

const MAX_STATUS_SEGMENTS = 6;

export function orderActiveFirst(balances: AccountBalance[], activeProviderId?: string): AccountBalance[] {
	if (!activeProviderId) return [...balances];
	const active = balances.filter((balance) => balance.providerId === activeProviderId);
	const rest = balances.filter((balance) => balance.providerId !== activeProviderId);
	return [...active, ...rest];
}

/** Compact per-account summary, e.g. "Codex 5h 13%" or "GLM ¥21.46". */
export function accountSummary(balance: AccountBalance, options?: { allWindows?: boolean }): string {
	if (balance.error) return `${balance.label} !`;
	const parts: string[] = [];
	const windows = options?.allWindows ? balance.windows : balance.windows.slice(0, 1);
	for (const window of windows) {
		parts.push(`${window.label} ${Math.round(window.usedPercent)}%`);
	}
	if (balance.balance) parts.push(formatMoney(balance.balance));
	return parts.length > 0 ? `${balance.label} ${parts.join(" · ")}` : balance.label;
}

/**
 * Consumption segment (plan B): session totals, tokens always and real cost
 * only when non-zero, e.g. "session 87k tok · $0.020".
 */
export function formatConsumptionSegment(consumption: SessionUsageTotals | undefined, theme: ThemeLike): string | undefined {
	if (!consumption || (consumption.tokens === 0 && consumption.cost === 0)) return undefined;
	let text = theme.fg("dim", `session ${formatTokens(consumption.tokens)} tok`);
	if (consumption.cost > 0) {
		text += ` ${theme.fg("success", `$${consumption.cost.toFixed(3)}`)}`;
	}
	return text;
}

export function formatStatusLine(options: {
	balances: AccountBalance[];
	mode: StatusMode;
	activeProviderId?: string;
	theme: ThemeLike;
	consumption?: SessionUsageTotals;
	/** Pre-rendered 7-day sparkline segment (scheme 4), appended last. */
	sparkline?: string;
}): string | undefined {
	if (options.mode === "off") return undefined;
	const ordered = orderActiveFirst(options.balances, options.activeProviderId);
	const selected =
		options.mode === "active"
			? ordered.filter((balance) => balance.providerId === options.activeProviderId)
			: ordered;
	const segments = selected.slice(0, MAX_STATUS_SEGMENTS).map((balance) => {
		const text = accountSummary(balance, { allWindows: options.mode === "active" });
		if (balance.error) return options.theme.fg("error", text);
		return balance.providerId === options.activeProviderId ? text : options.theme.fg("dim", text);
	});
	const consumptionSegment = formatConsumptionSegment(options.consumption, options.theme);
	if (consumptionSegment) segments.push(consumptionSegment);
	if (options.sparkline) segments.push(options.theme.fg("dim", `7d ${options.sparkline}`));
	if (segments.length === 0) return undefined;
	return segments.join(options.theme.fg("dim", " · "));
}
