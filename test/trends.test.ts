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
	periodTotals,
	projectDistributionRows,
	annotateModelLabels,
} from "../src/trends/aggregate.ts";
import { buildInsights } from "../src/trends/insights.ts";
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

function assistantLine(
	provider: string,
	model: string,
	timestamp: number,
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } },
) {
	const { cost, ...tokenFields } = tokens;
	return line({
		type: "message",
		message: {
			role: "assistant",
			provider,
			model,
			timestamp,
			usage: {
				...tokenFields,
				totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
				cost: cost ?? { total: 0.01 },
			},
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
		line({ type: "session", id: "sess-a", version: 3, cwd: "C:\Fixtures\alpha" }),
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
		line({ type: "session", id: "sess-a", version: 3, cwd: "C:\Fixtures\alpha" }),
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
	assert.equal(cache.version, 3);
	// Records must serialize as tuples (objects would never validate on load,
	// silently disabling the cache).
	const firstEntry = Object.values(cache.files)[0] as
		| { records: unknown[]; cwd?: string }
		| undefined;
	const firstRecords = firstEntry?.records ?? [];
	assert.ok(Array.isArray(firstRecords[0]), "cached records are tuples");
	assert.match(String(firstEntry?.cwd), /alpha$/, "cwd must survive the cache round-trip (project attribution)");
	rmSync(dir, { recursive: true, force: true });
});


test("chartSeries buckets hourly within 8 days and groups by model", async () => {
	const dir = makeSessionsDir();
	const t1 = NOW - 2 * HOUR;
	writeSession(dir, "a.jsonl", [assistantLine("p", "m1", t1, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }), assistantLine("p", "m2", t1, { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 })]);
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
	// Flat nonzero series draws a full-width line on the top plot row (the
	// y-axis label and plot row 0 share the first output line).
	const lines = renderBrailleChart([{ label: "Total", values: [50, 50] }], PLAIN_THEME, 40, 4, NOW - HOUR, NOW);
	assert.ok(lines.length >= 5, "height + axis row");
	assert.match(lines[0]!, /[⠀-⣿].*[⠀-⣿]/, "spans the plot width");
	// Zero-value series are dropped entirely.
	const empty = renderBrailleChart([{ label: "Total", values: [0, 0] }], PLAIN_THEME, 40, 4, NOW - HOUR, NOW);
	assert.doesNotMatch(empty.join(""), /[⠁-⣿]/, "only blank braille base chars remain");
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
			{ label: "glm", value: 9600 },
			{ label: "luna", value: 400 },
		],
		PLAIN_THEME,
		60,
	);
	assert.match(lines[0]!, /glm/);
	assert.match(lines[0]!, /96%/);
	assert.match(lines[1]!, /4%/);
});

test("renderTable renders provider rows, expansion, and total", () => {
	const row = { provider: "p", model: "m", sessions: 2, messages: 10, cost: 1.5, tokens: 1000, input: 600, output: 200, cacheRead: 150, cacheWrite: 50, reasoning: 0 };
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
	const cell = { messages: 2, cost: 0.5, input: 100, output: 50, cacheRead: 200, cacheWrite: 10, reasoning: 0, missCount: 0, missCost: 0 };
	return {
		hourly: new Map([[hour, new Map([["p\u0000m", cell]])]]),
		keys: new Map([["p\u0000m", { provider: "p", model: "m" }]]),
		sessions: new Map([["p\u0000m", new Set(["s1"])]]),
		totalSessions: new Set(["s1"]),
		sessionCost: new Map([["s1", 0.5]]),
		hourlyProject: new Map(),
		projectKeys: new Map(),
		projectSessions: new Map(),
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
	assert.match(charts, /\[Charts\]/, "charts is the default view");
	assert.match(charts, /\[30d\]/);
	dashboard.handleInput("v");
	assert.match(dashboard.render(90).join("\n"), /\[Heatmap\]/);
	dashboard.handleInput("v");
	const insights = dashboard.render(90).join("\n");
	assert.match(insights, /\[Insights\]/);
	assert.match(insights, /contributing to your cost/);
	dashboard.handleInput("v");
	const table = dashboard.render(90).join("\n");
	assert.match(table, /\[Table\]/);
	assert.match(table, /Sessions/);
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

test("project aggregation groups sessions by session cwd", async () => {
	const dir = makeSessionsDir();
	const t1 = NOW - 2 * HOUR;
	const header = (id: string, cwd: string) => line({ type: "session", id, version: 3, cwd });
	writeSession(dir, "pi.jsonl", [header("sess-pi", "C:\\Code\\pi"), assistantLine("p", "m1", t1, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } })]);
	writeSession(dir, "app.jsonl", [header("sess-app", "C:\\Code\\app"), assistantLine("p", "m2", t1, { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } })]);

	const data = await collectTrends(dir, { cache: false });
	const rows = projectDistributionRows(data, undefined);
	assert.equal(rows.length, 2);
	const pi = rows.find((row) => row.project === "pi")!;
	const app = rows.find((row) => row.project === "app")!;
	assert.equal(pi.tokens, 10);
	assert.equal(app.tokens, 20);
	assert.equal(pi.sessions, 1, "per-project session count from projectSessions");
	assert.match(pi.model, /^p\/m1$/);

	const insights = buildInsights(data, undefined);
	assert.ok(
		insights.some((insight) => insight.headline.includes('of spend comes from "app"') && insight.stat === "67%"),
		"app project carries 2/3 of the spend",
	);
	rmSync(dir, { recursive: true, force: true });
});

test("cache-miss detection classifies gap, model switch, and mid-session", async () => {
	const dir = makeSessionsDir();
	const base = NOW - 3 * HOUR;
	const big = { input: 30_000, output: 10, cacheRead: 0, cacheWrite: 0 };
	writeSession(dir, "a.jsonl", [
		line({ type: "session", id: "s", version: 3 }),
		assistantLine("p", "m1", base, big), // no previous message → no miss
		assistantLine("p", "m1", base + 30_000, big), // 30s later, low cache read → mid-session
		assistantLine("q", "m2", base + 60_000, big), // model switch
		line({
			type: "compaction",
			id: "c",
			parentId: "x",
			timestamp: base + 90_000,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		}),
		assistantLine("p", "m1", base + 120_000, big), // after compaction → protected
		assistantLine("p", "m1", base + 600_000, big), // 8 min gap → TTL miss
	]);
	const data = await collectTrends(dir, { cache: false });
	const totals = periodTotals(data, undefined);
	assert.equal(totals.missCount, 3, "model switch, mid-session, and TTL gap flagged; compaction-adjacent exempt");
});

test("buildInsights surfaces spend share, cache leverage, misses, and concentration", () => {
	const hour = NOW - 2 * HOUR;
	const mkCell = (over: Partial<import("../src/trends/aggregate.ts").TrendCell>) => ({
		messages: 1,
		cost: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		missCount: 0,
		missCost: 0,
		...over,
	});
	const data: import("../src/trends/aggregate.ts").TrendsData = {
		hourly: new Map([
			[hour, new Map([
				["big\u0000m", mkCell({ cost: 0.9, input: 900, output: 10, reasoning: 5, missCount: 1, missCost: 0.5 })],
				["small\u0000m", mkCell({ cost: 0.1, input: 10, output: 5 })],
			])],
		]),
		keys: new Map([
			["big\u0000m", { provider: "big", model: "m" }],
			["small\u0000m", { provider: "small", model: "m" }],
		]),
		sessions: new Map(),
		totalSessions: new Set(["s1"]),
		sessionCost: new Map([["s1", 0.9], ["s2", 0.1]]),
		hourlyProject: new Map(),
		projectKeys: new Map(),
		projectSessions: new Map(),
		generatedAt: NOW,
	};
	const insights = buildInsights(data, undefined);
	const headlines = insights.map((insight) => insight.headline);
	assert.ok(headlines.some((headline) => /drives 90% of your spend/.test(headline)), "top-model share");
	assert.ok(insights.some((insight) => insight.headline === "of processed tokens came from cache reads" && insight.stat === "0%"), "cache leverage with low-coverage advice");
	assert.ok(insights.some((insight) => insight.headline.includes("of output is reasoning")), "reasoning share");
	assert.ok(insights.some((insight) => insight.kind === "alarm" && /cache miss/.test(insight.headline) && insight.stat === "$0.50"), "cache-miss alarm with miss cost");
	assert.ok(insights.some((insight) => insight.kind === "alarm" && /single session/.test(insight.headline) && insight.stat === "90%"), "spend concentration");
});

test("buildInsights flags accelerated burn vs the prior 4 weeks", () => {
	const day = 86_400_000;
	const now = Date.now();
	const today = new Date(now).setHours(0, 0, 0, 0);
	const hourly = new Map<number, Map<string, import("../src/trends/aggregate.ts").TrendCell>>();
	const cell = { messages: 1, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, missCount: 0, missCost: 0 };
	for (let index = 40; index >= 8; index--) {
		hourly.set(today - index * day, new Map([["p\u0000m", { ...cell, cost: 0.1 }]]));
	}
	for (let index = 3; index >= 0; index--) {
		hourly.set(today - index * day, new Map([["p\u0000m", { ...cell, cost: 1.0 }]]));
	}
	const data: import("../src/trends/aggregate.ts").TrendsData = {
		hourly,
		keys: new Map([["p\u0000m", { provider: "p", model: "m" }]]),
		sessions: new Map(),
		totalSessions: new Set(["s"]),
		sessionCost: new Map([["s", 4.4]]),
		hourlyProject: new Map(),
		projectKeys: new Map(),
		projectSessions: new Map(),
		generatedAt: now,
	};
	const insights = buildInsights(data, undefined, now);
	assert.ok(
		insights.some((insight) => insight.kind === "alarm" && /daily burn vs the prior 4 weeks/.test(insight.headline)),
		"10x burn is flagged",
	);
});

test("annotateModelLabels disambiguates same model across providers", () => {
	const rows = [
		{ provider: "openai-codex", model: "gpt-5.6-luna" },
		{ provider: "lingsuan", model: "gpt-5.6-luna" },
		{ provider: "deepseek", model: "deepseek-flash" },
	];
	const labeled = annotateModelLabels(rows);
	assert.deepEqual(
		labeled.map((row) => row.label),
		["gpt-5.6-luna (openai-codex)", "gpt-5.6-luna (lingsuan)", "deepseek-flash"],
	);
});

test("chartSeries keeps same-model series separate per provider", async () => {
	const dir = makeSessionsDir();
	const t1 = NOW - 2 * HOUR;
	writeSession(dir, "a.jsonl", [assistantLine("codex", "luna", t1, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 })]);
	writeSession(dir, "b.jsonl", [assistantLine("lingsuan", "luna", t1, { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 })]);
	const data = await collectTrends(dir, { cache: false });
	const chart = chartSeries(data, { fromMs: NOW - 8 * 86_400_000, toMs: NOW, metric: "tokens", groupBy: "model" });
	const lunaSeries = chart.series.filter((entry) => entry.label.startsWith("luna"));
	assert.equal(lunaSeries.length, 2, "same model id stays split per provider");
	assert.deepEqual(
		lunaSeries.map((entry) => entry.label).sort(),
		["luna (codex)", "luna (lingsuan)"],
	);
	rmSync(dir, { recursive: true, force: true });
});
