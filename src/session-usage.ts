/**
 * Session consumption aggregation, mirroring pi's footer accounting: sum of
 * usage across assistant messages, tool results, branch summaries, and
 * compaction entries of the current session.
 */

export interface UsageLike {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface SessionEntryLike {
	type: string;
	message?: { role?: string; usage?: UsageLike };
	usage?: UsageLike;
}

export interface SessionUsageTotals {
	tokens: number;
	cost: number;
}

export function sumSessionUsage(entries: readonly SessionEntryLike[]): SessionUsageTotals {
	const totals: SessionUsageTotals = { tokens: 0, cost: 0 };
	for (const entry of entries) {
		let usage: UsageLike | undefined;
		if (entry.type === "message" && entry.message?.role === "assistant") {
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message?.role === "toolResult") {
			usage = entry.message.usage;
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			usage = entry.usage;
		}
		if (!usage) continue;
		totals.tokens += usageTotalTokens(usage);
		totals.cost += usage.cost?.total ?? 0;
	}
	return totals;
}

function usageTotalTokens(usage: UsageLike): number {
	if (typeof usage.totalTokens === "number") return usage.totalTokens;
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** Same tiers as pi's footer formatTokens, so numbers match across rows. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}
