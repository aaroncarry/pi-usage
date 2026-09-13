/**
 * Interactive trends dashboard: an overlay with three views — Charts
 * (braille time series + model distribution), Heatmap (calendar), Table
 * (provider→model usage) — with period and metric switching.
 */

import type { Component } from "@earendil-works/pi-tui";
import {
	TREND_PERIODS,
	dailyTotals,
	distributionRows,
	chartSeries,
	periodStart,
	projectDistributionRows,
	type DistributionRow,
	type ProjectDistributionRow,
	type TrendMetric,
	type TrendPeriod,
	type TrendsData,
} from "./aggregate.ts";
import {
	formatCost,
	formatShortDate,
	renderBrailleChart,
	renderChartLegend,
	renderHeatmap,
	renderModelBars,
	renderTable,
	tableFootnote,
	type TableRowGroup,
} from "./render.ts";
import { buildInsights, type Insight } from "./insights.ts";
import { formatTokens } from "../session-usage.ts";
import type { ThemeLike } from "../ui/statusline.ts";

const VIEWS = ["table", "charts", "heatmap", "insights"] as const;
type View = (typeof VIEWS)[number];

const VIEW_LABELS: Record<View, string> = { table: "Table", charts: "Charts", heatmap: "Heatmap", insights: "Insights" };

export class TrendsDashboard implements Component {
	private readonly theme: ThemeLike;
	private readonly done: (result: undefined) => void;
	private data: TrendsData | undefined;
	private error: string | undefined;
	private readonly loadPromise: Promise<void>;
	private view: View = "charts";
	private periodIndex = 1; // 30d
	private metricIndex = 0; // tokens
	private expanded = new Set<string>();
	private selected = 0;
	private groupMode: "provider" | "project" = "provider";

	constructor(deps: { theme: ThemeLike; done: (result: undefined) => void; data: Promise<TrendsData> }) {
		this.theme = deps.theme;
		this.done = deps.done;
		this.loadPromise = deps.data.then(
			(data) => {
				this.data = data;
			},
			(error: unknown) => {
				this.error = error instanceof Error ? error.message : String(error);
			},
		);
	}

	handleInput(data: string): void {
		if (data === "\x1b" || data === "q" || data === "Q") {
			this.done(undefined);
			return;
		}
		if (!this.data) return;
		if (data === "v" || data === "V") {
			this.view = VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]!;
			return;
		}
		if (data === "\t" || data === "\x1b[C") {
			this.periodIndex = (this.periodIndex + 1) % TREND_PERIODS.length;
			return;
		}
		if (data === "\x1b[D") {
			this.periodIndex = (this.periodIndex + TREND_PERIODS.length - 1) % TREND_PERIODS.length;
			return;
		}
		if (data === "m" || data === "M") {
			this.metricIndex = this.metricIndex === 0 ? 1 : 0;
			return;
		}
		if (data === "g" || data === "G") {
			this.groupMode = this.groupMode === "provider" ? "project" : "provider";
			return;
		}
		if (this.view === "table") {
			const groups = this.tableGroups();
			if (data === "\x1b[A") {
				this.selected = Math.max(0, this.selected - 1);
				return;
			}
			if (data === "\x1b[B") {
				this.selected = Math.min(Math.max(0, groups.length - 1), this.selected + 1);
				return;
			}
			if (data === "\r" || data === "\n" || data === " ") {
				const group = groups[this.selected];
				if (group && group.children.length > 0) {
					if (this.expanded.has(group.provider)) this.expanded.delete(group.provider);
					else this.expanded.add(group.provider);
				}
			}
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		if (!this.data) {
			const loading = this.error ? theme.fg("error", this.error) : theme.fg("dim", "Scanning sessions…");
			return [this.header(width), "", ` ${loading}`];
		}
		const period = TREND_PERIODS[this.periodIndex] as TrendPeriod;
		const metric = (["tokens", "cost"] as const)[this.metricIndex]!;
		const lines: string[] = [this.header(width), this.periodHeader()];
		if (this.view === "charts") lines.push(...this.renderCharts(period, metric, width));
		else if (this.view === "heatmap") lines.push(...this.renderHeatmapView(metric));
		else if (this.view === "insights") lines.push(...this.renderInsightsView(period));
		else lines.push(...this.renderTableView(period, width));
		lines.push("", ` ${theme.fg("dim", "m metric · ←→ period · v view · ↑↓/enter table · esc close")}`);
		return lines;
	}

	invalidate(): void {}

	private header(width: number): string {
		const theme = this.theme;
		const tabs = VIEWS.map((view) =>
			view === this.view ? theme.fg("accent", theme.bold(`[${VIEW_LABELS[view]}]`)) : theme.fg("dim", VIEW_LABELS[view]),
		).join("  ");
		return ` ${theme.fg("accent", theme.bold("Usage trends"))}  ${tabs}`.slice(0, width);
	}

	private periodHeader(): string {
		const theme = this.theme;
		return (
			" " +
			TREND_PERIODS.map((period, index) =>
				index === this.periodIndex ? theme.fg("accent", `[${period}]`) : theme.fg("dim", period),
			).join("  ")
		);
	}

	private range(): { fromMs?: number; toMs: number } {
		const now = Date.now();
		const period = TREND_PERIODS[this.periodIndex] as TrendPeriod;
		const dayMs = 86_400_000;
		const days = period === "7d" ? 7 : period === "30d" ? 30 : period === "90d" ? 90 : undefined;
		return { fromMs: days === undefined ? undefined : now - days * dayMs, toMs: now };
	}

	private renderCharts(period: TrendPeriod, metric: TrendMetric, width: number): string[] {
		const theme = this.theme;
		const data = this.data!;
		const { fromMs, toMs } = this.range();
		const days = dailyTotals(data, metric, fromMs);
		const total = days.reduce((sum, entry) => sum + entry.value, 0);
		const peak = days.reduce<{ dayStart: number; value: number } | undefined>(
			(best, entry) => (!best || entry.value > best.value ? entry : best),
			undefined,
		);
		const costRows = distributionRows(data, fromMs);
		const totalCost = costRows.reduce((sum, row) => sum + row.cost, 0);
		// Axis labels get fractional mid values; the token formatter must round.
		const formatValue = metric === "cost"
			? (value: number) => `$${value < 10 ? value.toFixed(2) : Math.round(value)}`
			: (value: number) => formatTokens(Math.round(value));
		const summaryParts = [
			`${theme.fg("dim", "Total")} ${metric === "cost" ? formatCost(total) : formatTokens(total)}`,
			`${theme.fg("dim", "Cost")} ${formatCost(totalCost)}`,
		];
		if (peak && peak.value > 0) {
			summaryParts.push(`${theme.fg("dim", "Peak")} ${formatValue(peak.value)} (${formatShortDate(peak.dayStart)})`);
		}
		const streak = currentStreak(data);
		if (streak > 0) summaryParts.push(`${theme.fg("dim", "Streak")} ${streak}d`);
		const chart = chartSeries(data, { fromMs, toMs, metric, groupBy: "model" });
		// Draw least-important series first so Total and bigger models win the
		// contested braille cells; the legend keeps the original order.
		const drawSeries = [...chart.series.slice(1).reverse(), ...chart.series.slice(0, 1)];
		const chartLines = renderBrailleChart(
			drawSeries.map((entry) => ({ label: entry.label, values: entry.points.map((point) => point.value) })),
			theme,
			width - 2,
			8,
			chart.startMs,
			toMs,
			formatValue,
		);
		const models = distributionRows(data, fromMs)
			.filter((row) => row.model !== "summaries")
			.slice(0, 5)
			.map((row) => ({ label: row.model, value: metric === "cost" ? row.cost : row.tokens }));
		return [
			` ${summaryParts.join(theme.fg("dim", " · "))}`,
			"",
			...chartLines.map((line) => ` ${line}`),
			` ${renderChartLegend(chart.series, theme)}`,
			"",
			` ${theme.fg("dim", `Models · ${period}`)}`,
			...renderModelBars(models, theme, width - 2, formatValue),
		];
	}

	private renderHeatmapView(metric: TrendMetric): string[] {
		const theme = this.theme;
		const data = this.data!;
		const days = dailyTotals(data, metric, undefined);
		const total = days.reduce((sum, entry) => sum + entry.value, 0);
		const peak = days.reduce<{ dayStart: number; value: number } | undefined>(
			(best, entry) => (!best || entry.value > best.value ? entry : best),
			undefined,
		);
		const lines = [
			` ${theme.fg("dim", "Activity · 12 weeks")}          ${theme.fg("dim", `Streak`)} ${currentStreak(data)}d`,
			...renderHeatmap(days, theme, 12),
		];
		if (peak && peak.value > 0) {
			const formatted = metric === "cost" ? formatCost(peak.value) : formatTokens(peak.value);
			const unit = metric === "cost" ? "" : " tokens";
			lines.push(
				` ${theme.fg("dim", `Peak ${formatted}${unit} on`)} ${formatShortDate(peak.dayStart)} ${theme.fg("dim", "· Total")} ${
					metric === "cost" ? formatCost(total) : formatTokens(total)
				}`,
			);
		}
		lines.push(
			` ${theme.fg("muted", "░ none")}  ${theme.fg("dim", "▒ light")}  ${theme.fg("text", "▓ mid")}  ${theme.fg("accent", "█ heavy")}`,
		);
		return lines;
	}

	private renderInsightsView(period: TrendPeriod): string[] {
		const theme = this.theme;
		const insights = buildInsights(this.data!, periodStart(period));
		const lines = [` ${theme.fg("accent", theme.bold("What's contributing to your cost?"))}  ${theme.fg("dim", period)}`];
		const structure = insights.filter((insight) => insight.kind === "structure");
		const alarms = insights.filter((insight) => insight.kind === "alarm");
		const renderInsight = (insight: Insight): string[] => {
			const out = [`   ${theme.fg("dim", insight.stat.padStart(6))}  ${insight.headline}`];
			if (insight.advice) out.push(`          ${theme.fg("dim", insight.advice)}`);
			return out;
		};
		if (structure.length > 0) {
			lines.push(` ${theme.fg("dim", "Where it went")}`);
			for (const insight of structure) lines.push(...renderInsight(insight));
		}
		if (alarms.length > 0) {
			lines.push(` ${theme.fg("dim", "Worth attention")}`);
			for (const insight of alarms) lines.push(...renderInsight(insight));
		}
		if (structure.length === 0 && alarms.length === 0) {
			lines.push(` ${theme.fg("muted", "✓ no waste patterns flagged for this period")}`);
		}
		return lines;
	}

	private tableGroups(): TableRowGroup[] {
		const data = this.data!;
		const { fromMs } = this.range();
		const rows = distributionRows(data, fromMs);
		const byProvider = new Map<string, DistributionRow[]>();
		for (const row of rows) {
			const list = byProvider.get(row.provider) ?? [];
			list.push(row);
			byProvider.set(row.provider, list);
		}
		const groups: TableRowGroup[] = [];
		for (const [provider, children] of byProvider) {
			const aggregate = children.reduce(
				(accumulator, child) => {
					accumulator.messages += child.messages;
					accumulator.cost += child.cost;
					accumulator.tokens += child.tokens;
					accumulator.input += child.input;
					accumulator.output += child.output;
					accumulator.cacheRead += child.cacheRead;
					accumulator.cacheWrite += child.cacheWrite;
					accumulator.reasoning += child.reasoning;
					return accumulator;
				},
				{ provider, model: provider, sessions: 0, messages: 0, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			);
			aggregate.sessions = new Set(children.flatMap((child) => [...(data.sessions.get(`${child.provider}\u0000${child.model}`) ?? [])])).size;
			children.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
			groups.push({ provider, row: aggregate, children });
		}
		groups.sort((a, b) => b.row.cost - a.row.cost || b.row.tokens - a.row.tokens);
		if (this.selected >= groups.length) this.selected = Math.max(0, groups.length - 1);
		return groups;
	}

	private projectTableGroups(): TableRowGroup[] {
		const data = this.data!;
		const { fromMs } = this.range();
		const rows = projectDistributionRows(data, fromMs);
		const byProject = new Map<string, ProjectDistributionRow[]>();
		for (const row of rows) {
			const list = byProject.get(row.project) ?? [];
			list.push(row);
			byProject.set(row.project, list);
		}
		const groups: TableRowGroup[] = [];
		for (const [project, children] of byProject) {
			const aggregate = children.reduce(
				(accumulator, child) => {
					accumulator.messages += child.messages;
					accumulator.cost += child.cost;
					accumulator.tokens += child.tokens;
					accumulator.input += child.input;
					accumulator.output += child.output;
					accumulator.cacheRead += child.cacheRead;
					accumulator.cacheWrite += child.cacheWrite;
					accumulator.reasoning += child.reasoning;
					return accumulator;
				},
				{ provider: project, model: project, sessions: 0, messages: 0, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, project },
			);
			aggregate.sessions = new Set(children.flatMap((child) => [...(data.projectSessions.get(`${child.project} ${child.provider} ${child.model}`) ?? [])])).size;
			children.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
			groups.push({ provider: project, row: aggregate, children });
		}
		groups.sort((a, b) => b.row.cost - a.row.cost || b.row.tokens - a.row.tokens);
		if (this.selected >= groups.length) this.selected = Math.max(0, groups.length - 1);
		return groups;
	}

	private renderTableView(period: TrendPeriod, width: number): string[] {
		const theme = this.theme;
		const groups = this.groupMode === "project" ? this.projectTableGroups() : this.tableGroups();
		if (groups.length === 0) return [` ${theme.fg("muted", "No usage recorded in this period")}`];
		// Total-row session count: union across models, not the (double-counting) sum.
		const data = this.data!;
		const { fromMs } = this.range();
		const sessionUnion = new Set(
			distributionRows(data, fromMs).flatMap((row) => [...(data.sessions.get(`${row.provider} ${row.model}`) ?? [])]),
		);
		return [
			...renderTable(groups, theme, width - 2, this.expanded, this.selected, sessionUnion.size),
			` ${tableFootnote(theme)} ${theme.fg("dim", `· ${period} · ${this.groupMode === "project" ? "by project" : "by provider"} · g switch`)}`,
		];
	}
}

function currentStreak(data: TrendsData): number {
	const active = new Set(dailyTotals(data, "tokens", undefined).filter((entry) => entry.value > 0).map((entry) => entry.dayStart));
	const dayMs = 86_400_000;
	let streak = 0;
	let cursor = new Date().setHours(0, 0, 0, 0);
	if (!active.has(cursor)) cursor -= dayMs; // streak survives until the day is over
	while (active.has(cursor)) {
		streak += 1;
		cursor -= dayMs;
	}
	return streak;
}

