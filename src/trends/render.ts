/**
 * Trends rendering: braille line charts, block bars, calendar heatmap, model
 * distribution bars, and the provider→model table. All pure string/Component
 * builders — no data access.
 */

import { Text, type Component } from "@earendil-works/pi-tui";
import { formatTokens } from "../session-usage.ts";
import type { ThemeLike } from "../ui/statusline.ts";
import type { DistributionRow } from "./aggregate.ts";

// ── Formatting ────────────────────────────────────────────────────────────

/** Cost formatting tiers: 0 → "-", tiny → 4dp, then 2dp/1dp/integer. */
export function formatCost(value: number): string {
	if (value === 0) return "-";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 100) return value < 10 ? `$${value.toFixed(2)}` : `$${value.toFixed(1)}`;
	return `$${Math.round(value)}`;
}

/** Compact count formatting: 4,643 style grouping. */
export function formatCount(value: number): string {
	if (value === 0) return "-";
	return value.toLocaleString("en-US");
}

/** Short local date like "9/13". */
export function formatShortDate(time: number): string {
	const date = new Date(time);
	return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** Local day label like "09-06". */
export function formatDayLabel(time: number): string {
	const date = new Date(time);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${month}-${day}`;
}

// ── Block bars (8 levels per cell) ───────────────────────────────────────

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const SPARK_CELLS = 8;

function blockFor(value: number, max: number): string {
	if (max <= 0 || value <= 0) return BLOCKS[0]!;
	const level = Math.min(SPARK_CELLS - 1, Math.max(1, Math.round((value / max) * (SPARK_CELLS - 1))));
	return BLOCKS[level]!;
}

/** Row of block bars, one cell per day (missing days render empty). */
export function blockBars(days: { dayStart: number; value: number }[], cells: number, now = Date.now()): { bars: string; max: number } {
	const dayMs = 86_400_000;
	const todayStart = new Date(now).setHours(0, 0, 0, 0);
	const byDay = new Map(days.map((entry) => [entry.dayStart, entry.value]));
	const values: number[] = [];
	for (let index = cells - 1; index >= 0; index--) {
		values.push(byDay.get(todayStart - index * dayMs) ?? 0);
	}
	const max = Math.max(...values, 0);
	return { bars: values.map((value) => blockFor(value, max)).join(""), max };
}

/** Compact sparkline string like "▁▂▁▄█ 1.2M" (value suffix included). */
export function sparkline(days: { dayStart: number; value: number }[], total: number, now = Date.now()): string {
	return `${blockBars(days, 7, now).bars} ${formatTokens(total)}`;
}


/** Compact sparkline string like "▁▂▁▄█ 1.2M" from raw per-day values. */
export function sparklineString(days: number[]): string {
	const max = Math.max(...days, 0);
	return `${days.map((value) => blockFor(value, max)).join("")} ${formatTokens(days.reduce((total, value) => total + value, 0))}`;
}

// ── Model distribution bars ──────────────────────────────────────────────

export function renderModelBars(
	rows: { label: string; value: number }[],
	theme: ThemeLike,
	width: number,
	formatValue: (value: number) => string = formatTokens,
): string[] {
	const total = rows.reduce((sum, row) => sum + row.value, 0);
	const lines: string[] = [];
	for (const row of rows) {
		const share = total > 0 ? row.value / total : 0;
		const label = row.label.length > 24 ? `${row.label.slice(0, 23)}…` : row.label;
		const countWidth = Math.max(4, formatValue(row.value).length + String(Math.round(share * 100)).length + 4);
		const barWidth = Math.max(4, Math.min(30, width - label.length - countWidth - 4));
		const filled = Math.round(share * barWidth);
		const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, barWidth - filled))}`;
		lines.push(
			`  ${theme.fg("muted", label.padEnd(24).slice(0, 24))} ${theme.fg("accent", bar)} ${String(Math.round(share * 100)).padStart(3)}%  ${theme.fg("dim", formatValue(row.value))}`,
		);
	}
	return lines;
}

// ── Calendar heatmap ─────────────────────────────────────────────────────

const HEAT_LEVELS = ["░", "▒", "▓", "█"];

/**
 * Weekly calendar heatmap (rows = weekday, columns = weeks), Monday start.
 * `weeks` columns; intensity levels come from quartiles of the nonzero days.
 */
export function renderHeatmap(
	days: { dayStart: number; value: number }[],
	theme: ThemeLike,
	weeks: number,
	now = Date.now(),
): string[] {
	const dayMs = 86_400_000;
	const byDay = new Map(days.map((entry) => [entry.dayStart, entry.value]));
	const todayStart = new Date(now).setHours(0, 0, 0, 0);
	const todayDow = (new Date(todayStart).getDay() + 6) % 7; // Monday = 0
	const lastMonday = todayStart - todayDow * dayMs;

	const nonzero = days.filter((entry) => entry.value > 0).map((entry) => entry.value).sort((a, b) => a - b);
	const quartile = (fraction: number): number => {
		if (nonzero.length === 0) return 0;
		const index = Math.min(nonzero.length - 1, Math.floor(fraction * nonzero.length));
		return nonzero[index]!;
	};
	const light = quartile(0.25);
	const mid = quartile(0.5);
	const heavy = quartile(0.75);

	const lines: string[] = [];
	for (let dow = 0; dow < 7; dow++) {
		let line = "";
		for (let week = weeks - 1; week >= 0; week--) {
			const dayMsStart = lastMonday - week * 7 * dayMs + dow * dayMs;
			if (dayMsStart > todayStart) {
				line += "  ";
				continue;
			}
			const value = byDay.get(dayMsStart) ?? 0;
			let level = -1;
			if (value > 0) {
				level = 0;
				if (value >= light) level = 1;
				if (value >= mid) level = 2;
				if (value >= heavy) level = 3;
			}
			const glyph = level < 0 ? theme.fg("muted", "░") : theme.fg(level >= 3 ? "accent" : level === 2 ? "success" : "dim", HEAT_LEVELS[level]!);
			line += `${glyph} `;
		}
		lines.push(`  ${line}`);
	}
	return lines;
}

// ── Braille line chart ───────────────────────────────────────────────────

const BRAILLE_BASE = 0x2800;
// Dot bit layout: [x % 2][y % 4]; y = 0 is the top row of the cell.
const DOT_BITS = [
	[0x01, 0x02, 0x04, 0x40],
	[0x08, 0x10, 0x20, 0x80],
];

export interface BrailleSeries {
	label: string;
	values: number[];
}

/**
 * Multi-series braille line chart. Series are OR-merged per cell; the last
 * drawn series owns the color (caller orders series least-important first).
 */
export function renderBrailleChart(
	series: BrailleSeries[],
	theme: ThemeLike,
	width: number,
	height: number,
	startMs: number,
	endMs: number,
	formatValue: (value: number) => string = formatTokens,
): string[] {
	const plotHeight = Math.max(4, height);
	const labelWidth = Math.max(6, ...series.map((s) => formatValue(Math.max(...s.values, 0)).length));
	const plotWidth = Math.max(10, width - labelWidth - 3);
	const dotWidth = plotWidth * 2;
	const dotHeight = plotHeight * 4;

	const masks: number[][] = Array.from({ length: plotHeight }, () => new Array<number>(plotWidth).fill(0));
	const owners: number[][] = Array.from({ length: plotHeight }, () => new Array<number>(plotWidth).fill(-2));

	const drawn = series.filter((entry) => entry.values.some((value) => value > 0));
	const yMax = Math.max(1, ...drawn.map((s) => Math.max(...s.values, 0)));
	drawn.forEach((seriesEntry, seriesIndex) => {
		const count = seriesEntry.values.length;
		if (count === 0) return;
		const setDot = (x: number, y: number): void => {
			if (x < 0 || x >= dotWidth || y < 0 || y >= dotHeight) return;
			const col = Math.floor(x / 2);
			const row = Math.floor(y / 4);
			masks[row]![col]! |= DOT_BITS[x % 2]![y % 4]!;
			owners[row]![col] = seriesIndex;
		};
		// Active range: only draw between the first and last nonzero bucket so
		// stopped series do not leave a long horizontal zero tail.
		let firstIndex = 0;
		let lastIndex = count - 1;
		while (firstIndex < count && seriesEntry.values[firstIndex]! <= 0) firstIndex += 1;
		while (lastIndex >= 0 && seriesEntry.values[lastIndex]! <= 0) lastIndex -= 1;
		const previous = seriesEntry.values.map((value, index) => ({
			x: count === 1 ? dotWidth - 1 : Math.round((index / (count - 1)) * (dotWidth - 1)),
			y: Math.round((1 - value / yMax) * (dotHeight - 1)),
		}));
		for (let index = firstIndex; index <= lastIndex; index++) {
			setDot(previous[index]!.x, previous[index]!.y);
			if (index > firstIndex) {
				const from = previous[index - 1]!;
				const to = previous[index]!;
				const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
				for (let step = 1; step < steps; step++) {
					setDot(
						Math.round(from.x + ((to.x - from.x) * step) / steps),
						Math.round(from.y + ((to.y - from.y) * step) / steps),
					);
				}
			}
		}
	});

	const SERIES_COLORS = ["accent", "success", "warning", "muted", "error", "dim"] as const;
	const lines: string[] = [];
	const axisLabel = (row: number): string => {
		const value = (1 - row / (plotHeight - 1)) * yMax;
		return formatValue(Math.max(0, value));
	};
	for (let row = 0; row < plotHeight; row++) {
		let line = row === 0 || row === plotHeight - 1 || row === Math.floor(plotHeight / 2)
			? axisLabel(row).padStart(labelWidth) + (row === plotHeight - 1 ? " └" : " ┤")
			: " ".repeat(labelWidth) + " │";
		for (let col = 0; col < plotWidth; col++) {
			const mask = masks[row]![col]!;
			if (mask === 0) {
				line += " ";
				continue;
			}
			const owner = owners[row]![col]!;
			const color = SERIES_COLORS[owner % SERIES_COLORS.length]!;
			line += theme.fg(color, String.fromCharCode(BRAILLE_BASE + mask));
		}
		lines.push(line);
	}
	// X axis labels: start + end (middle label when there is room).
	const startLabel = formatDayLabel(startMs);
	const endLabel = formatDayLabel(endMs);
	const midTime = (startMs + endMs) / 2;
	const midLabel = formatDayLabel(midTime);
	const hasMid = plotWidth >= startLabel.length + endLabel.length + midLabel.length + 10;
	let axis = " ".repeat(labelWidth + 2);
	const midCol = hasMid ? Math.floor(plotWidth / 2 - midLabel.length / 2) : -1;
	for (let col = 0; col < plotWidth; col++) {
		if (col < startLabel.length) axis += col < startLabel.length ? startLabel[col]! : " ";
		else if (midCol >= 0 && col >= midCol && col < midCol + midLabel.length) axis += midLabel[col - midCol]!;
		else if (col >= plotWidth - endLabel.length) axis += endLabel[col - (plotWidth - endLabel.length)]!;
		else axis += " ";
	}
	lines.push(theme.fg("dim", axis));
	return lines;
}

/** Legend line for the chart: colored markers + labels. */
export function renderChartLegend(series: { label: string }[], theme: ThemeLike): string {
	const colors = ["accent", "success", "warning", "muted", "error", "dim"] as const;
	return series
		.map((entry, index) => theme.fg(colors[index % colors.length]!, `● ${entry.label}`))
		.join(theme.fg("dim", "  "));
}

// ── Provider→model table ─────────────────────────────────────────────────

interface TableColumn {
	header: string;
	width: number;
	value: (row: DistributionRow) => string;
}

const TABLE_COLUMNS: TableColumn[] = [
	{ header: "Sessions", width: 9, value: (row) => formatCount(row.sessions) },
	{ header: "Msgs", width: 9, value: (row) => formatCount(row.messages) },
	{ header: "Cost", width: 9, value: (row) => formatCost(row.cost) },
	{ header: "Tokens", width: 9, value: (row) => formatTokens(row.tokens) },
	{ header: "↑In", width: 8, value: (row) => formatTokens(row.input + row.cacheWrite) },
	{ header: "↓Out", width: 8, value: (row) => formatTokens(row.output) },
	{ header: "Cache", width: 8, value: (row) => formatTokens(row.cacheRead + row.cacheWrite) },
];

function fitColumns(width: number, nameWidth: number): TableColumn[] {
	const columnsWidth = (columns: TableColumn[]): number => columns.reduce((total, column) => total + column.width + 2, 0);
	for (let count = TABLE_COLUMNS.length; count >= 1; count--) {
		const columns = TABLE_COLUMNS.slice(0, count);
		if (nameWidth + columnsWidth(columns) <= width) return columns;
	}
	return [];
}

/**
 * Provider→model table rows. `expanded` holds provider keys rendered open.
 * Group rows arrive pre-grouped: provider rows with `children`.
 */
export interface TableRowGroup {
	provider: string;
	row: DistributionRow;
	children: DistributionRow[];
}

export function renderTable(
	groups: TableRowGroup[],
	theme: ThemeLike,
	width: number,
	expanded: Set<string>,
	selected: number,
	totalSessions?: number,
): string[] {
	const nameWidth = Math.min(26, Math.max(16, Math.floor(width * 0.35)));
	const columns = fitColumns(width, nameWidth);
	if (columns.length === 0) return [theme.fg("error", "  terminal too narrow for the table")];

	const header =
		theme.fg("dim", "Provider / Model".padEnd(nameWidth)) +
		columns.map((column) => theme.fg("dim", column.header.padStart(column.width + 1))).join("");
	const lines = [header, theme.fg("dim", "─".repeat(Math.min(width, nameWidth + columns.reduce((total, column) => total + column.width + 2, 0))))];

	const renderRow = (row: DistributionRow, indent: number, dim: boolean, isSelected: boolean, marker?: string): string => {
		const name = (marker ? `${marker} ` : "") + row.model;
		const truncated = name.length > nameWidth - indent ? `${name.slice(0, nameWidth - indent - 1)}…` : name;
		const segments = [
			truncated.padEnd(nameWidth - indent),
			...columns.map((column) => column.value(row).padStart(column.width + 1)),
		];
		const line = " ".repeat(indent) + segments.join("");
		return isSelected ? theme.fg("accent", line) : theme.fg(dim ? "muted" : "text", line);
	};

	groups.forEach((group, groupIndex) => {
		const isOpen = expanded.has(group.provider);
		const marker = group.children.length > 0 ? (isOpen ? "▾" : "▸") : " ";
		lines.push(renderRow({ ...group.row, model: group.provider }, 1, false, selected === groupIndex, marker));
		if (isOpen) {
			for (const child of group.children) {
				lines.push(renderRow(child, 4, true, false));
			}
		}
	});

	const total = groups.reduce(
		(accumulator, group) => {
			accumulator.messages += group.row.messages;
			accumulator.cost += group.row.cost;
			accumulator.tokens += group.row.tokens;
			accumulator.input += group.row.input;
			accumulator.output += group.row.output;
			accumulator.cacheRead += group.row.cacheRead;
			accumulator.cacheWrite += group.row.cacheWrite;
			accumulator.reasoning += group.row.reasoning;
			return accumulator;
		},
		{ messages: 0, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, provider: "", model: "", sessions: 0 },
	);
	lines.push(theme.fg("dim", "─".repeat(Math.min(width, nameWidth + columns.reduce((total2, column) => total2 + column.width + 2, 0)))));
	const totalSessionsValue = totalSessions !== undefined ? formatCount(totalSessions) : "-";
	const totalRow: DistributionRow = { ...total, sessions: 0, provider: "", model: "" };
	lines.push(
		theme.bold("Total".padEnd(nameWidth)) +
			columns
				.map((column) =>
					theme.bold(
						(column.header === "Sessions" ? totalSessionsValue : column.value(totalRow)).padStart(column.width + 1),
					),
				)
				.join(""),
	);
	return lines;
}

/** Card/table footnote explaining the token accounting. */
export function tableFootnote(theme: ThemeLike): string {
	return theme.fg("dim", "Tokens = Input + Output + CacheWrite · ↑In = Input + CacheWrite · Cache = Read + Write");
}

/** Wrap table lines into a pi-tui component. */
export function tableComponent(lines: string[]): Component {
	return new Text(lines.join("\n"), 0, 0);
}
