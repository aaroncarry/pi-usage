/**
 * Trends aggregation: scan pi session JSONL files and build hourly usage
 * buckets. Accounting mirrors pi's footer: assistant messages, tool results
 * with nested usage, compaction and branch summaries all count; auxiliary
 * records (tools/summaries) are grouped under "Tools / summaries".
 *
 * Token metric convention (same as tmustier's usage extension):
 *   tokens = input + output + cacheWrite (fresh tokens; cacheRead excluded
 *   so cache hits do not drown the chart).
 *
 * A disk cache keyed by file size+mtime makes repeat scans incremental.
 * Forked session copies are deduplicated across files by
 * sourceId:timestamp:token-sum fingerprints (the session header id survives
 * copying, the file path does not).
 */

import { readFile, readdir, stat, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export interface TrendCell {
	messages: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface TrendsData {
	/** hourStart (epoch ms, UTC hour) → "provider\u0000model" → cell */
	hourly: Map<number, Map<string, TrendCell>>;
	/** "provider\u0000model" → display names */
	keys: Map<string, { provider: string; model: string }>;
	/** "provider\u0000model" → contributing session source ids */
	sessions: Map<string, Set<string>>;
	/** All session source ids that contributed at least one assistant message. */
	totalSessions: Set<string>;
	generatedAt: number;
}

export const AUXILIARY_PROVIDER = "Tools";
export const AUXILIARY_MODEL = "summaries";
const AUXILIARY_KEY = `${AUXILIARY_PROVIDER}\u0000${AUXILIARY_MODEL}`;
const EXCLUDED_PROVIDERS = new Set(["faux-provider", "fake-provider"]);
const HOUR_MS = 3_600_000;
const CACHE_VERSION = 1;

export const TREND_METRICS = ["tokens", "cost"] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];

export const TREND_PERIODS = ["7d", "30d", "90d", "all"] as const;
export type TrendPeriod = (typeof TREND_PERIODS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface UsageTuple {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function readUsage(usage: unknown): UsageTuple | undefined {
	if (!isRecord(usage)) return undefined;
	const costValue = usage.cost;
	const cost = typeof costValue === "number" ? costValue : isRecord(costValue) ? toNumber(costValue.total) ?? 0 : 0;
	const tuple = {
		cost,
		input: toNumber(usage.input) ?? 0,
		output: toNumber(usage.output) ?? 0,
		cacheRead: toNumber(usage.cacheRead) ?? 0,
		cacheWrite: toNumber(usage.cacheWrite) ?? 0,
	};
	const sum = tuple.input + tuple.output + tuple.cacheRead + tuple.cacheWrite;
	if (sum === 0 && tuple.cost === 0) return undefined;
	return tuple;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/** Fingerprint shared by duplicate copies of the same record; full field tuple to avoid collisions. */
function fingerprint(tuple: UsageTuple): string {
	return `${tuple.input}:${tuple.output}:${tuple.cacheRead}:${tuple.cacheWrite}:${tuple.cost}`;
}

interface ParsedRecord {
	sourceId: string;
	provider: string;
	model: string;
	timestamp: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	auxiliary: boolean;
}

async function parseSessionFile(path: string): Promise<ParsedRecord[]> {
	const content = await readFile(path, "utf8");
	const records: ParsedRecord[] = [];
	let sourceId = path;
	for (const line of content.split("\n")) {
		// Every counted entry carries a usage object; session headers only
		// provide the source id used for cross-file fork deduplication.
		if (!line.includes('"usage"') && !line.includes('"session"')) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(entry)) continue;
		if (entry.type === "session" && typeof entry.id === "string" && entry.id.trim() !== "") {
			sourceId = entry.id;
			continue;
		}
		let usageTuple: UsageTuple | undefined;
		let provider: string;
		let model: string;
		let timestamp: number;
		let auxiliary: boolean;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			usageTuple = readUsage(entry.usage);
			provider = AUXILIARY_PROVIDER;
			model = AUXILIARY_MODEL;
			timestamp = toNumber(entry.timestamp) ?? 0;
			auxiliary = true;
		} else if (isRecord(entry.message)) {
			const message = entry.message;
			timestamp = toNumber(message.timestamp) ?? toNumber(entry.timestamp) ?? 0;
			if (message.role === "assistant") {
				provider = typeof message.provider === "string" ? message.provider : "";
				model = typeof message.model === "string" ? message.model : "";
				if (!provider || !model || EXCLUDED_PROVIDERS.has(provider)) continue;
				usageTuple = readUsage(message.usage);
				auxiliary = false;
			} else if (message.role === "toolResult") {
				usageTuple = readUsage(message.usage);
				provider = AUXILIARY_PROVIDER;
				model = AUXILIARY_MODEL;
				auxiliary = true;
			} else {
				continue;
			}
		} else {
			continue;
		}
		if (!usageTuple || timestamp <= 0) continue;
		records.push({
			sourceId,
			provider,
			model,
			timestamp,
			cost: usageTuple.cost,
			input: usageTuple.input,
			output: usageTuple.output,
			cacheRead: usageTuple.cacheRead,
			cacheWrite: usageTuple.cacheWrite,
			auxiliary,
		});
	}
	return records;
}

async function collectSessionFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	async function walk(current: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) await walk(fullPath);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
		}
	}
	await walk(dir);
	return files.sort();
}

interface CacheFileEntry {
	size: number;
	mtimeMs: number;
	records: ParsedRecord[];
}

interface TrendsCache {
	version: number;
	files: Record<string, CacheFileEntry>;
}

function isCachedEntryFresh(entry: unknown, size: number, mtimeMs: number): boolean {
	if (!isRecord(entry)) return false;
	return entry.size === size && entry.mtimeMs === mtimeMs && Array.isArray(entry.records);
}

function sanitizeRecords(records: unknown[]): ParsedRecord[] {
	const out: ParsedRecord[] = [];
	for (const record of records) {
		if (!Array.isArray(record) || record.length !== 10) return [];
		const [sourceId, provider, model, timestamp, cost, input, output, cacheRead, cacheWrite, auxiliary] = record as [
			unknown,
			unknown,
			unknown,
			unknown,
			unknown,
			unknown,
			unknown,
			unknown,
			unknown,
			unknown,
		];
		if (
			typeof sourceId !== "string" ||
			typeof provider !== "string" ||
			typeof model !== "string" ||
			typeof timestamp !== "number" ||
			typeof auxiliary !== "boolean" ||
			[toNumber(cost), toNumber(input), toNumber(output), toNumber(cacheRead), toNumber(cacheWrite)].some(
				(value) => value === undefined,
			)
		) {
			return [];
		}
		out.push({
			sourceId,
			provider,
			model,
			timestamp,
			cost: cost as number,
			input: input as number,
			output: output as number,
			cacheRead: cacheRead as number,
			cacheWrite: cacheWrite as number,
			auxiliary,
		});
	}
	return out;
}

async function loadCache(cachePath: string): Promise<TrendsCache> {
	try {
		const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
		if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.files)) {
			return { version: CACHE_VERSION, files: {} };
		}
		const files: Record<string, CacheFileEntry> = {};
		for (const [path, entry] of Object.entries(parsed.files)) {
			if (!isRecord(entry) || typeof entry.size !== "number" || typeof entry.mtimeMs !== "number" || !Array.isArray(entry.records)) {
				continue;
			}
			const records = sanitizeRecords(entry.records);
			if (records.length !== entry.records.length) continue;
			files[path] = { size: entry.size, mtimeMs: entry.mtimeMs, records };
		}
		return { version: CACHE_VERSION, files };
	} catch {
		return { version: CACHE_VERSION, files: {} };
	}
}

async function saveCache(cachePath: string, cache: TrendsCache): Promise<void> {
	const payload = JSON.stringify(cache);
	const tempPath = `${cachePath}.${process.pid}-${Date.now()}.tmp`;
	try {
		await writeFile(tempPath, payload, "utf8");
		await rename(tempPath, cachePath);
	} catch {
		// Cache writing is best-effort; aggregation works without it.
	}
}

/** Collect trends for all sessions under `<agentDir>/sessions`. */
export async function collectTrends(
	agentDir: string,
	options?: { signal?: AbortSignal; cache?: boolean },
): Promise<TrendsData> {
	const sessionsDir = join(agentDir, "sessions");
	const cachePath = join(agentDir, "usage-trends-cache.json");
	const useCache = options?.cache !== false;
	const cache = useCache ? await loadCache(cachePath) : { version: CACHE_VERSION, files: {} };

	const files = await collectSessionFiles(sessionsDir);
	const allRecords: ParsedRecord[] = [];
	let cacheDirty = false;
	const nextFiles: Record<string, CacheFileEntry> = {};
	for (const path of files) {
		options?.signal?.throwIfAborted();
		let size = 0;
		let mtimeMs = 0;
		try {
			const stats = await stat(path);
			size = stats.size;
			mtimeMs = stats.mtimeMs;
		} catch {
			continue;
		}
		const cached = cache.files[path];
		if (cached && isCachedEntryFresh(cached, size, mtimeMs)) {
			nextFiles[path] = cached;
			allRecords.push(...cached.records);
			continue;
		}
		let records: ParsedRecord[] = [];
		try {
			records = await parseSessionFile(path);
		} catch {
			continue;
		}
		nextFiles[path] = { size, mtimeMs, records };
		allRecords.push(...records);
		cacheDirty = true;
	}
	// Drop cache entries for files that disappeared.
	for (const path of Object.keys(cache.files)) {
		if (!(path in nextFiles)) cacheDirty = true;
	}
	if (useCache && cacheDirty) {
		options?.signal?.throwIfAborted();
		await saveCache(cachePath, { version: CACHE_VERSION, files: nextFiles });
	}

	// Cross-file deduplication for forked session copies.
	const seen = new Set<string>();
	const hourly = new Map<number, Map<string, TrendCell>>();
	const keys = new Map<string, { provider: string; model: string }>();
	const sessions = new Map<string, Set<string>>();
	const totalSessions = new Set<string>();
	for (const record of allRecords) {
		const fingerprintKey = record.auxiliary
			? `aux:${record.sourceId}:${record.timestamp}:${fingerprint(record)}`
			: `${record.sourceId}:${record.timestamp}:${fingerprint(record)}`;
		if (seen.has(fingerprintKey)) continue;
		seen.add(fingerprintKey);

		const provider = record.auxiliary ? AUXILIARY_PROVIDER : record.provider;
		const model = record.auxiliary ? AUXILIARY_MODEL : record.model;
		const key = `${provider}\u0000${model}`;
		const hourStart = Math.floor(record.timestamp / HOUR_MS) * HOUR_MS;
		let bucket = hourly.get(hourStart);
		if (!bucket) {
			bucket = new Map();
			hourly.set(hourStart, bucket);
		}
		let cell = bucket.get(key);
		if (!cell) {
			cell = { messages: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			bucket.set(key, cell);
			keys.set(key, { provider, model });
		}
		if (!record.auxiliary) cell.messages += 1;
		cell.cost += record.cost;
		cell.input += record.input;
		cell.output += record.output;
		cell.cacheRead += record.cacheRead;
		cell.cacheWrite += record.cacheWrite;
		if (!record.auxiliary) {
			let sessionSet = sessions.get(key);
			if (!sessionSet) {
				sessionSet = new Set();
				sessions.set(key, sessionSet);
			}
			sessionSet.add(record.sourceId);
			totalSessions.add(record.sourceId);
		}
	}
	return { hourly, keys, sessions, totalSessions, generatedAt: Date.now() };
}

/** Inclusive lower bound (epoch ms) of a period; undefined = all time. */
export function periodStart(period: TrendPeriod, now = Date.now()): number | undefined {
	const dayMs = 86_400_000;
	if (period === "all") return undefined;
	if (period === "7d") return now - 7 * dayMs;
	if (period === "30d") return now - 30 * dayMs;
	return now - 90 * dayMs;
}

export function cellTokens(cell: TrendCell): number {
	return cell.input + cell.output + cell.cacheWrite;
}

function cellMetric(cell: TrendCell, metric: TrendMetric): number {
	return metric === "cost" ? cell.cost : cellTokens(cell);
}

/** Flatten hourly buckets in [from, to] into a sorted array of [hourStart, key, cell]. */
function flattenHourly(
	data: TrendsData,
	fromMs: number | undefined,
): { hourStart: number; key: string; cell: TrendCell }[] {
	const rows: { hourStart: number; key: string; cell: TrendCell }[] = [];
	for (const [hourStart, bucket] of data.hourly) {
		if (fromMs !== undefined && hourStart < fromMs) continue;
		for (const [key, cell] of bucket) {
			rows.push({ hourStart, key, cell });
		}
	}
	return rows.sort((a, b) => a.hourStart - b.hourStart);
}

/** Model/provider distribution rows sorted by cost then tokens, descending. */
export interface DistributionRow {
	provider: string;
	model: string;
	sessions: number;
	messages: number;
	cost: number;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function distributionRows(data: TrendsData, fromMs: number | undefined): DistributionRow[] {
	const rows = new Map<string, DistributionRow>();
	for (const { key, cell } of flattenHourly(data, fromMs)) {
		let row = rows.get(key);
		if (!row) {
			const names = data.keys.get(key) ?? { provider: "unknown", model: "unknown" };
			row = { provider: names.provider, model: names.model, sessions: 0, messages: 0, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			rows.set(key, row);
		}
		row.messages += cell.messages;
		row.cost += cell.cost;
		row.input += cell.input;
		row.output += cell.output;
		row.cacheRead += cell.cacheRead;
		row.cacheWrite += cell.cacheWrite;
		row.tokens += cellTokens(cell);
	}
	const result = [...rows.values()];
	for (const row of result) {
		row.sessions = data.sessions.get(`${row.provider}\u0000${row.model}`)?.size ?? 0;
	}
	result.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.provider.localeCompare(b.provider));
	return result;
}

/**
 * Time series grouped by provider (or model) at hour or day resolution.
 * Bucket size: hourly when the span is ≤ 8 days, otherwise daily.
 */
export interface ChartSeries {
	label: string;
	points: { bucketStart: number; value: number }[];
}

export function chartSeries(
	data: TrendsData,
	options: { fromMs?: number; toMs?: number; metric: TrendMetric; groupBy: "provider" | "model" | "total" },
): { bucketMs: number; startMs: number; bucketCount: number; series: ChartSeries[] } {
	const now = options.toMs ?? Date.now();
	const fromMs = options.fromMs ?? Math.min(...[...data.hourly.keys(), now - HOUR_MS]);
	const spanMs = Math.max(HOUR_MS, now - fromMs);
	const bucketMs = spanMs <= 8 * 86_400_000 ? HOUR_MS : 86_400_000;
	const startMs = Math.floor(fromMs / bucketMs) * bucketMs;
	const bucketCount = Math.max(1, Math.ceil((now - startMs) / bucketMs));

	const buckets = new Map<string, number[]>();
	const totals = new Array<number>(bucketCount).fill(0);
	for (const { hourStart, key, cell } of flattenHourly(data, fromMs)) {
		const names = data.keys.get(key) ?? { provider: "unknown", model: "unknown" };
		const groupKey = options.groupBy === "total" ? "total" : options.groupBy === "provider" ? names.provider : names.model;
		const index = Math.min(bucketCount - 1, Math.floor((hourStart - startMs) / bucketMs));
		if (index < 0) continue;
		let series = buckets.get(groupKey);
		if (!series) {
			series = new Array<number>(bucketCount).fill(0);
			buckets.set(groupKey, series);
		}
		const value = cellMetric(cell, options.metric);
		series[index] = (series[index] ?? 0) + value;
		totals[index] = (totals[index] ?? 0) + value;
	}
	const ranked = [...buckets.entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
	const series: ChartSeries[] = [];
	if (options.groupBy !== "total") {
		series.push({
			label: "Total",
			points: totals.map((value, index) => ({ bucketStart: startMs + index * bucketMs, value })),
		});
	}
	ranked.forEach(([name, values], rank) => {
		if (rank < 5) {
			series.push({ label: name, points: values.map((value, index) => ({ bucketStart: startMs + index * bucketMs, value })) });
		}
	});
	return { bucketMs, startMs, bucketCount, series };
}

function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

/** Daily fresh-token (or cost) totals in [from, now], keyed by local day start. */
export function dailyTotals(
	data: TrendsData,
	metric: TrendMetric,
	fromMs: number | undefined,
): { dayStart: number; value: number }[] {
	const totals = new Map<number, number>();
	for (const { hourStart, cell } of flattenHourly(data, fromMs)) {
		const day = dayStart(hourStart);
		totals.set(day, (totals.get(day) ?? 0) + cellMetric(cell, metric));
	}
	return [...totals.entries()].map(([dayStart, value]) => ({ dayStart, value })).sort((a, b) => a.dayStart - b.dayStart);
}

/** Local-midnight epoch ms for the day containing `time`. */
export function dayStart(time: number): number {
	const date = new Date(time);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}
