import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	collectTrends,
	chartSeries,
	dailyTotals,
	distributionRows,
	periodStart,
} from "../src/trends/aggregate.ts";
import {
	blockBars,
	formatCost,
	renderBrailleChart,
	renderHeatmap,
	renderModelBars,
	renderTable,
	sparklineString,
} from "../src/trends/render.ts";
import { TrendsDashboard } from "../src/trends/dashboard.ts";
import { buildUsageCard, type CardTrendsSummary } from "../src/ui/card.ts";
import { formatStatusLine, type ThemeLike } from "../src/ui/statusline.ts";

const PLAIN_THEME: ThemeLike = {
	fg: (_color, text) => text,
	bold: (text) => text,
	bg: (_color, text) => text,
};

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-13T10:00:00Z");

function line(json: unknown): string {
	return JSON.stringify(json);
}

function assistantLine(provider: string, model: string, timestamp: number, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
	return line({
		type: "message",
		message: {
			role: "assistant",
			provider,
			model,
			timestamp,
			usage: { ...tokens, totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite, cost: { total: 0.01 } },
		},
	});
}

function makeSessionsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-usage-trends-"));
	mkdirSync(join(dir, "sessions", "--proj--"), { recursive: true });
	return dir;
}

function writeSession(dir: string, name: string, content: string[]): void {
	writeFileSync(join(dir, "sessions", "--proj--", name), content.join("\n") + "\n", "utf8");
}

test("collectTrends parses, dedupes forks, and groups auxiliary usage", async () => {
	const dir = makeSessionsDir();
	const t1 = NOW - 2 * HOUR;
	const tokens = { input: 100, output: 50, cacheRead: 200, cacheWrite: 10 };
	writeSession(dir, "a.jsonl", [
		line({ type: "session", id: "sess-a", version: 3 }),
		assistantLine("openai-codex", "gpt-x", t1, tokens),
		assistantLine("faux-provider", "fake", t1, tokens),
		line({ type: "message", message: { role: "assistant", provider: "openai-codex", model: "zero", timestamp: t1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } }),
		line({
			type: "message",
			message: { role: "toolResult", toolCallId: "t1", toolName: "summarize", content: [], isError: false, timestamp: t1 + HOUR, usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } },
		}),
		line({ type: "compaction", id: "c1", parentId: "p", timestamp: t1 + HOUR, usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } } }),
	]);
	// Forked copy: same source session id, same assistant record → deduped.
	writeSession(dir, "b.jsonl", [
		line({ type: "session", id: "sess-a", version: 3 }),
		assistantLine("openai-codex", "gpt-x", t1, tokens),
		assistantLine("openai-codex", "gpt-y", t1 + HOUR, tokens),
	]);

	const data = await collectTrends(dir, { cache: false });
	const modelKeys = [...data.keys.values()];
	assert.ok(modelKeys.some((names) => names.model === "gpt-x"));
	// gpt-x appears once despite the forked copy (dedup by sourceId+ts+tokens).
	const gptKey = [...data.keys.entries()].find(([, names]) => names.model === "gpt-x")![0]!;
	const cells = [...data.hourly.values()].map((bucket) => bucket.get(gptKey)!).filter(Boolean);
	assert.equal(cells.reduce((total, cell) => total + cell.messages, 0), 1);
	assert.equal(cells.reduce((total, cell) => total + cell.input, 0), 100);
	// Auxiliary bucket holds toolResult + compaction (2 records).
	const auxKey = "Tools\u0000summaries";
	const auxCells = [...data.hourly.values()].map((bucket) => bucket.get(auxKey)!).filter(Boolean);
	assert.equal(auxCells.reduce((total, cell) => total + cell.input, 0), 12);
	// Faux provider excluded; gpt-y recorded under its own key.
	assert.ok(!modelKeys.some((names) => names.provider === "faux-provider"));
	assert.ok(modelKeys.some((names) => names.model === "gpt-y"));
	assert.deepEqual([...data.totalSessions], ["sess-a"]);

	// Distribution rows are model-level: gpt-x + gpt-y, each 160 fresh tokens
	// (input+output+cacheWrite; cacheRead excluded). Fork copy deduped.
	const rows = distributionRows(data, periodStart("30d", NOW));
	const codexRows = rows.filter((row) => row.provider === "openai-codex");
	assert.equal(rows[0]!.provider, "openai-codex", "highest cost first");
	assert.equal(codexRows.length, 2);
	assert.equal(codexRows.reduce((total, row) => total + row.tokens, 0), 320);

	// Disk cache written and reused (same results on a second pass).
	const data2 = await collectTrends(dir);
	assert.equal(data2.keys.size, data.keys.size);
	const cache = JSON.parse(readFileSync(join(dir, "usage-trends-cache.json"), "utf8"));
	assert.equal(cache.version, 1);
	rmSync(dir, { recursive: true, force: true });
});


test("chartSeries buckets hourly within 8 days and groups by model", async () => {
	const dir = makeSessionsDir();
	const t1 = NOW - 2 * HOUR;
	writeSession(dir, "a.jsonl", [assistantLine("p", "m1", t1, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }), assistantLine("p", "m2", t1, { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 })]);
	const data = await collectTrends(dir, { cache: false });
	const chart = chartSeries(data, { fromMs: NOW - 8 * 86_400_000, toMs: NOW, metric: "tokens", groupBy: "model" });
	assert.equal(chart.bucketMs, HOUR);
	const total = chart.series.find((entry) => entry.label === "Total")!;
	const m1 = chart.series.find((entry) => entry.label === "m1")!;
	assert.equal(total.points.reduce((sum, point) => sum + point.value, 0), 15);
	assert.equal(m1.points.reduce((sum, point) => sum + point.value, 0), 10);
	rmSync(dir, { recursive: true, force: true });
});

test("dailyTotals aligns to local day starts", async () => {
	const dir = makeSessionsDir();
	const t1 = NOW - 2 * HOUR;
	writeSession(dir, "a.jsonl", [assistantLine("p", "m", t1, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 })]);
	const data = await collectTrends(dir, { cache: false });
	const days = dailyTotals(data, "tokens", undefined);
	assert.equal(days.length, 1);
	assert.ok(days[0]!.value > 0);
	rmSync(dir, { recursive: true, force: true });
});

test("formatCost uses display tiers", () => {
	assert.equal(formatCost(0), "-");
	assert.equal(formatCost(0.001), "$0.0010");
	assert.equal(formatCost(1.5), "$1.50");
	assert.equal(formatCost(42.1), "$42.1");
	assert.equal(formatCost(22193), "$22193");
});

test("blockBars and sparklineString render 8-level bars", () => {
	const day = 86_400_000;
	const today = new Date(NOW).setHours(0, 0, 0, 0);
	const days = Array.from({ length: 30 }, (_, index) => ({
		dayStart: today - (29 - index) * day,
		value: index === 29 ? 100 : index === 28 ? 50 : 0,
	}));
	const { bars } = blockBars(days, 30, NOW);
	assert.equal(bars.length, 30);
	assert.match(bars, /█$/);
	assert.equal(sparklineString([0, 25, 0, 50, 100]), "▁▃▁▅█ 175");
});

test("renderBrailleChart encodes points into braille cells", () => {
	const series = [{ label: "Total", values: [0, 100] }];
	const lines = renderBrailleChart(series, PLAIN_THEME, 40, 4, NOW - HOUR, NOW);
	assert.ok(lines.length >= 5, "height + axis row");
	const body = lines.slice(1, -1).join("");
	assert.match(body, /[\u2800-\u28ff]/, "contains braille glyphs");
	// First point (value 0) sits on the bottom row of the plot.
	const bottomRow = lines[lines.length - 2]!;
	assert.match(bottomRow, /[\u2800-\u28ff]/);
});

test("renderHeatmap draws one row per weekday", () => {
	const day = 86_400_000;
	const today = new Date(NOW).setHours(0, 0, 0, 0);
	const days = Array.from({ length: 12 }, (_, index) => ({ dayStart: today - index * day, value: index * 10 }));
	const lines = renderHeatmap(days, PLAIN_THEME, 12, NOW);
	assert.equal(lines.length, 7);
});

test("renderModelBars shows share and tokens", () => {
	const lines = renderModelBars(
		[
			{ label: "glm", tokens: 9600 },
			{ label: "luna", tokens: 400 },
		],
		PLAIN_THEME,
		60,
	);
	assert.match(lines[0]!, /glm/);
	assert.match(lines[0]!, /96%/);
	assert.match(lines[1]!, /4%/);
});

test("renderTable renders provider rows, expansion, and total", () => {
	const row = { provider: "p", model: "m", sessions: 2, messages: 10, cost: 1.5, tokens: 1000, input: 600, output: 200, cacheRead: 150, cacheWrite: 50 };
	const groups = [{ provider: "p", row, children: [{ ...row, model: "m1" }, { ...row, model: "m2" }] }];
	const collapsed = renderTable(groups, PLAIN_THEME, 100, new Set(), 0).join("\n");
	assert.match(collapsed, /▸ p/);
	assert.match(collapsed, /Total/);
	const expanded = renderTable(groups, PLAIN_THEME, 100, new Set(["p"]), 0).join("\n");
	assert.match(expanded, /▾ p/);
	assert.match(expanded, /m1/);
});

test("renderBrailleChart uses the metric formatter for axis labels", () => {
	const lines = renderBrailleChart([{ label: "Total", values: [0, 4] }], PLAIN_THEME, 40, 4, NOW - HOUR, NOW, (value) => `$${value.toFixed(2)}`);
	assert.match(lines.join("\n"), /\$4\.00/);
});

function trendsFixture(): import("../src/trends/aggregate.ts").TrendsData {
	const hour = NOW - 2 * HOUR;
	const cell = { messages: 2, cost: 0.5, input: 100, output: 50, cacheRead: 200, cacheWrite: 10 };
	return {
		hourly: new Map([[hour, new Map([["p\u0000m", cell]])]]),
		keys: new Map([["p\u0000m", { provider: "p", model: "m" }]]),
		sessions: new Map([["p\u0000m", new Set(["s1"])]]),
		totalSessions: new Set(["s1"]),
		generatedAt: NOW,
	};
}

test("TrendsDashboard renders views, switches them, and closes", async () => {
	let closed = false;
	const dashboard = new TrendsDashboard({ theme: PLAIN_THEME, done: () => (closed = true), data: Promise.resolve(trendsFixture()) });
	const loading = dashboard.render(90).join("\n");
	assert.match(loading, /Scanning sessions/);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const charts = dashboard.render(90).join("\n");
	assert.match(charts, /\[Charts\]/);
	assert.match(charts, /\[30d\]/);
	dashboard.handleInput("v");
	assert.match(dashboard.render(90).join("\n"), /\[Heatmap\]/);
	dashboard.handleInput("v");
	assert.match(dashboard.render(90).join("\n"), /\[Table\]/);
	assert.match(dashboard.render(90).join("\n"), /Sessions/);
	dashboard.handleInput("\x1b[C"); // next period → 90d
	assert.match(dashboard.render(90).join("\n"), /\[90d\]/);
	dashboard.handleInput("\x1b");
	assert.equal(closed, true);
});

test("usage card renders the 30-day trends summary", () => {
	const trends: CardTrendsSummary = {
		days: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, 100],
		endsAt: new Date(NOW).setHours(0, 0, 0, 0),
		total: 150,
		cost: 0.42,
		models: [
			{ label: "glm", tokens: 120 },
			{ label: "luna", tokens: 30 },
		],
	};
	const card = buildUsageCard({ balances: [], generatedAt: NOW, trends }, PLAIN_THEME);
	const rendered = card.render(80).join("\n");
	assert.match(rendered, /Last 30 days/);
	assert.match(rendered, /150/);
	assert.match(rendered, /glm/);
});

test("formatStatusLine appends the 7-day sparkline segment", () => {
	const balances = [
		{ providerId: "openai-codex", label: "Codex", windows: [], notes: [], fetchedAt: 0 },
	];
	const line = formatStatusLine({
		balances,
		mode: "active",
		activeProviderId: "openai-codex",
		theme: PLAIN_THEME,
		sparkline: "▁▃▁▅██▇ 1.2M",
	});
	assert.match(line ?? "", /7d ▁▃▁▅██▇ 1\.2M$/);
});
