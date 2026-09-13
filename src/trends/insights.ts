/**
 * Cost insights (tmustier-style): structural facts about where spend went
 * plus alarms for waste patterns. All numbers derive from the aggregated
 * trends data; formulas are documented per insight.
 */

import { dailyTotals, distributionRows, periodTotals, type TrendsData } from "./aggregate.ts";
import { formatCost } from "./render.ts";

export interface Insight {
	kind: "structure" | "alarm";
	/** Short right-aligned stat, e.g. "$0.03" or "74%". */
	stat: string;
	headline: string;
	advice?: string;
}

function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

export function buildInsights(data: TrendsData, fromMs: number | undefined, now = Date.now()): Insight[] {
	const rows = distributionRows(data, fromMs);
	const totals = periodTotals(data, fromMs);
	const insights: Insight[] = [];

	const allTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

	// Structure: the model that dominates spend.
	if (totals.cost > 0 && rows.length > 1) {
		const top = [...rows].sort((a, b) => b.cost - a.cost)[0]!;
		const share = top.cost / totals.cost;
		if (share >= 0.5) {
			insights.push({
				kind: "structure",
				stat: formatCost(top.cost),
				headline: `${top.model} drives ${Math.round(share * 100)}% of your spend`,
				advice: "routing some traffic to a cheaper model is the biggest cost lever",
			});
		}
	}

	// Structure: cache leverage — share of processed tokens served from cache.
	if (allTokens > 0) {
		const leverage = totals.cacheRead / allTokens;
		insights.push({
			kind: "structure",
			stat: `${Math.round(leverage * 100)}%`,
			headline: "of processed tokens came from cache reads",
			advice:
				leverage < 0.3
					? "low cache coverage inflates cost — keep sessions warm and avoid re-sending large context"
					: undefined,
		});
	}

	// Structure: reasoning share of output (only when meaningful).
	if (totals.output > 0) {
		const share = totals.reasoning / totals.output;
		if (share >= 0.05) {
			insights.push({
				kind: "structure",
				stat: `${Math.round(share * 100)}%`,
				headline: "of output is reasoning (thinking) tokens",
				advice: "lowering the thinking level on routine tasks cuts this hidden spend",
			});
		}
	}

	// Alarm: likely cache misses (full-price prompt re-reads).
	if (totals.missCount > 0) {
		insights.push({
			kind: "alarm",
			stat: formatCost(totals.missCost),
			headline: `${totals.missCount} likely cache miss${totals.missCount > 1 ? "es" : ""} re-read the prompt at full price`,
			advice: "pauses over 5 minutes and mid-session model switches invalidate the prompt cache",
		});
	}

	// Burn trend: last 7 days' daily average vs the prior 28 days.
	const costDays = dailyTotals(data, "cost", undefined);
	const dayMs = 86_400_000;
	const todayStart = new Date(now).setHours(0, 0, 0, 0);
	const last7 = costDays.filter((entry) => entry.dayStart >= todayStart - 6 * dayMs);
	const prior28 = costDays.filter(
		(entry) => entry.dayStart >= todayStart - 34 * dayMs && entry.dayStart < todayStart - 6 * dayMs,
	);
	if (last7.length >= 3 && prior28.length >= 7) {
		const recentAvg = sum(last7.map((entry) => entry.value)) / 7;
		const priorAvg = sum(prior28.map((entry) => entry.value)) / 28;
		if (priorAvg > 0) {
			const ratio = recentAvg / priorAvg;
			if (ratio >= 1.5) {
				insights.push({
					kind: "alarm",
					stat: `${ratio.toFixed(1)}x`,
					headline: "daily burn vs the prior 4 weeks",
					advice: "recent sessions cost materially more per day — check cache misses or a pricier model",
				});
			} else if (ratio <= 0.5) {
				insights.push({
					kind: "structure",
					stat: `${ratio.toFixed(1)}x`,
					headline: "daily burn vs the prior 4 weeks",
				});
			}
		}
	}

	// Alarm: spend concentration in one session.
	if (data.sessionCost.size >= 2) {
		const costs = [...data.sessionCost.values()].sort((a, b) => b - a);
		const top = costs[0]!;
		const total = sum(costs);
		if (total > 0 && top / total >= 0.6) {
			insights.push({
				kind: "alarm",
				stat: `${Math.round((top / total) * 100)}%`,
				headline: "of spend comes from a single session",
			});
		}
	}

	return insights;
}
