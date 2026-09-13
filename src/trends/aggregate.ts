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
	/** Thinking tokens reported by the provider (assistant messages only). */
	reasoning: number;
	/** Likely cache misses detected on this bucket's assistant messages. */
	missCount: number;
	/** Cost of the cache-miss messages themselves. */
	missCost: number;
}

export interface TrendsData {
	/** hourStart (epoch ms, UTC hour) → "provider${KEY_SEP}model" → cell */
	hourly: Map<number, Map<string, TrendCell>>;
	/** "provider${KEY_SEP}model" → display names */
	keys: Map<string, { provider: string; model: string }>;
	/** "provider${KEY_SEP}model" → contributing session source ids */
	sessions: Map<string, Set<string>>;
	/** All session source ids that contributed at least one assistant message. */
	totalSessions: Set<string>;
	/** Session source id → non-auxiliary cost, for spend-concentration insights. */
	sessionCost: Map<string, number>;
	/** hourStart → "project${KEY_SEP}provider${KEY_SEP}model" → cell */
	hourlyProject: Map<number, Map<string, TrendCell>>;
	/** "project${KEY_SEP}provider${KEY_SEP}model" → names */
	projectKeys: Map<string, { project: string; provider: string; model: string }>;
	/** "project${KEY_SEP}provider${KEY_SEP}model" → contributing session source ids */
	projectSessions: Map<string, Set<string>>;
	generatedAt: number;
}

/** Zero-character join key for composite map keys (never appears in real names). */
const KEY_SEP = String.fromCharCode(0);

export const AUXILIARY_PROVIDER = "Tools";
export const AUXILIARY_MODEL = "summaries";
const AUXILIARY_KEY = `${AUXILIARY_PROVIDER}${KEY_SEP}${AUXILIARY_MODEL}`;
const EXCLUDED_PROVIDERS = new Set(["faux-provider", "fake-provider"]);
const HOUR_MS = 3_600_000;
const CACHE_VERSION = 3;

export const TREND_METRICS = ["tokens", "cost"] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];

export const TREND_PERIODS = ["7d", "30d", "90d", "all"] as const;
export type TrendPeriod = (typeof TREND_PERIODS)[number];

/** Short project label: last path segment of the session cwd. */
export function projectLabel(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	const segments = trimmed.split(/[\\/]/);
	return segments[segments.length - 1] || "unknown";
}

/**
 * Display labels for model rows: bare model id unless the same id exists
 * under multiple providers, then "model (provider)" to disambiguate.
 */
export function annotateModelLabels<T extends { provider: string; model: string }>(
	rows: T[],
): (T & { label: string })[] {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.model, (counts.get(row.model) ?? 0) + 1);
	return rows.map((row) => ({
		...row,
		label: (counts.get(row.model) ?? 0) > 1 ? `${row.model} (${row.provider})` : row.model,
	}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface UsageTuple {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

/** Cache-miss classification: 0 none, 1 session gap, 2 model switch, 3 mid-session. */
type CacheMissKind = 0 | 1 | 2 | 3;

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
		reasoning: toNumber(usage.reasoning) ?? 0,
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
	reasoning: number;
	auxiliary: boolean;
	miss: CacheMissKind;
	project: string;
}

async function parseSessionFile(path: string): Promise<{ records: ParsedRecord[]; cwd?: string }> {
	const content = await readFile(path, "utf8");
	const records: ParsedRecord[] = [];
	let sourceId = path;
	let cwd: string | undefined;
	// Adjacency state for cache-miss detection (per file, file order).
	let compactionPending = false;
	let prevAssistant: { ctx: number; model: string; timestamp: number } | undefined;
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
		if (entry.type === "session") {
			if (typeof entry.id === "string" && entry.id.trim() !== "") sourceId = entry.id;
			if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") cwd = entry.cwd;
			continue;
		}
		let usageTuple: UsageTuple | undefined;
		let provider: string;
		let model: string;
		let timestamp: number;
		let reasoning = 0;
		let auxiliary: boolean;
		let miss: CacheMissKind = 0;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			usageTuple = readUsage(entry.usage);
			provider = AUXILIARY_PROVIDER;
			model = AUXILIARY_MODEL;
			timestamp = toNumber(entry.timestamp) ?? 0;
			auxiliary = true;
			// The next assistant message starts a fresh context; never a miss.
			compactionPending = true;
			prevAssistant = undefined;
		} else if (isRecord(entry.message)) {
			const message = entry.message;
			timestamp = toNumber(message.timestamp) ?? toNumber(entry.timestamp) ?? 0;
			if (message.role === "assistant") {
				provider = typeof message.provider === "string" ? message.provider : "";
				model = typeof message.model === "string" ? message.model : "";
				if (!provider || !model || EXCLUDED_PROVIDERS.has(provider)) continue;
				usageTuple = readUsage(message.usage);
				auxiliary = false;
				const prev = prevAssistant;
				const afterCompaction = compactionPending;
				compactionPending = false;
				if (usageTuple && prev && !afterCompaction) {
					const prevCtx = prev.ctx;
					if (prevCtx >= 20_000 && usageTuple.cacheRead < Math.min(5_000, 0.3 * prevCtx)) {
						// Gap > 5 min: cache TTL expired; model change: different cache
						// namespace; otherwise the cache was dropped mid-session.
						miss = timestamp - prev.timestamp > 5 * 60_000 ? 1 : prev.model !== model ? 2 : 3;
					}
				}
				if (usageTuple) {
					prevAssistant = {
						ctx: usageTuple.input + usageTuple.cacheRead + usageTuple.cacheWrite,
						model,
						timestamp,
					};
				}
			} else if (message.role === "toolResult") {
				usageTuple = readUsage(message.usage);
				provider = AUXILIARY_PROVIDER;
				model = AUXILIARY_MODEL;
				auxiliary = true;
			} else {
				continue;
			}
			reasoning = usageTuple ? toNumber((message.usage as Record<string, unknown> | undefined)?.reasoning) ?? 0 : 0;
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
			reasoning,
			auxiliary,
			miss,
			project: "unknown",
		});
	}
	return { records, cwd };
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
	cwd?: string;
	records: ParsedRecord[];
}

/** Serialize a record into the cached tuple form (must match sanitizeRecords). */
function toTuple(record: ParsedRecord): unknown[] {
	return [
		record.sourceId,
		record.provider,
		record.model,
		record.timestamp,
		record.cost,
		record.input,
		record.output,
		record.cacheRead,
		record.cacheWrite,
		record.reasoning,
		record.auxiliary,
		record.miss,
	];
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
		if (!Array.isArray(record) || record.length !== 12) return [];
		const [sourceId, provider, model, timestamp, cost, input, output, cacheRead, cacheWrite, reasoning, auxiliary, miss] = record as [
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
			unknown,
			unknown,
		];
		if (
			typeof sourceId !== "string" ||
			typeof provider !== "string" ||
			typeof model !== "string" ||
			typeof timestamp !== "number" ||
			typeof auxiliary !== "boolean" ||
			[toNumber(cost), toNumber(input), toNumber(output), toNumber(cacheRead), toNumber(cacheWrite), toNumber(reasoning), toNumber(miss)].some(
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
			reasoning: reasoning as number,
			auxiliary,
			miss: miss as CacheMissKind,
			project: "unknown",
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
			const records = sanitizeRecords(entry.records).map((record) => ({ ...record, project: projectLabel(typeof entry.cwd === 'string' ? entry.cwd : '') }));
			if (records.length !== entry.records.length) continue;
			files[path] = { size: entry.size, mtimeMs: entry.mtimeMs, records };
		}
		return { version: CACHE_VERSION, files };
	} catch {
		return { version: CACHE_VERSION, files: {} };
	}
}

async function saveCache(
	cachePath: string,
	cache: { version: number; files: Record<string, { size: number; mtimeMs: number; records: unknown[] }> },
): Promise<void> {
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
		let parsed: { records: ParsedRecord[]; cwd?: string } = { records: [] };
		try {
			parsed = await parseSessionFile(path);
		} catch {
			continue;
		}
		const project = parsed.cwd ? projectLabel(parsed.cwd) : "unknown";
		for (const record of parsed.records) {
			record.project = project;
		}
		nextFiles[path] = { size, mtimeMs, cwd: parsed.cwd, records: parsed.records };
		allRecords.push(...parsed.records);
		cacheDirty = true;
	}
	// Drop cache entries for files that disappeared.
	for (const path of Object.keys(cache.files)) {
		if (!(path in nextFiles)) cacheDirty = true;
	}
	if (useCache && cacheDirty) {
		options?.signal?.throwIfAborted();
		const serializable = Object.fromEntries(
			Object.entries(nextFiles).map(([path, entry]) => [
				path,
				{ size: entry.size, mtimeMs: entry.mtimeMs, cwd: entry.cwd, records: entry.records.map(toTuple) },
			]),
		);
		await saveCache(cachePath, { version: CACHE_VERSION, files: serializable });
	}

	// Cross-file deduplication for forked session copies.
	const seen = new Set<string>();
	const hourly = new Map<number, Map<string, TrendCell>>();
	const keys = new Map<string, { provider: string; model: string }>();
	const sessions = new Map<string, Set<string>>();
	const totalSessions = new Set<string>();
	const sessionCost = new Map<string, number>();
	const hourlyProject = new Map<number, Map<string, TrendCell>>();
	const projectKeys = new Map<string, { project: string; provider: string; model: string }>();
	const projectSessions = new Map<string, Set<string>>();
	for (const record of allRecords) {
		const fingerprintKey = record.auxiliary
			? `aux:${record.sourceId}:${record.timestamp}:${fingerprint(record)}`
			: `${record.sourceId}:${record.timestamp}:${fingerprint(record)}`;
		if (seen.has(fingerprintKey)) continue;
		seen.add(fingerprintKey);

		const provider = record.auxiliary ? AUXILIARY_PROVIDER : record.provider;
		const model = record.auxiliary ? AUXILIARY_MODEL : record.model;
		const key = `${provider}${KEY_SEP}${model}`;
		const hourStart = Math.floor(record.timestamp / HOUR_MS) * HOUR_MS;
		let bucket = hourly.get(hourStart);
		if (!bucket) {
			bucket = new Map();
			hourly.set(hourStart, bucket);
		}
		let cell = bucket.get(key);
		if (!cell) {
			cell = { messages: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, missCount: 0, missCost: 0 };
			bucket.set(key, cell);
			keys.set(key, { provider, model });
		}
		if (!record.auxiliary) cell.messages += 1;
		cell.cost += record.cost;
		cell.input += record.input;
		cell.output += record.output;
		cell.cacheRead += record.cacheRead;
		cell.cacheWrite += record.cacheWrite;
		if (!record.auxiliary) cell.reasoning += record.reasoning;
		if (record.miss !== 0) {
			cell.missCount += 1;
			cell.missCost += record.cost;
		}
		if (!record.auxiliary) {
			let sessionSet = sessions.get(key);
			if (!sessionSet) {
				sessionSet = new Set();
				sessions.set(key, sessionSet);
			}
			sessionSet.add(record.sourceId);
			totalSessions.add(record.sourceId);
			sessionCost.set(record.sourceId, (sessionCost.get(record.sourceId) ?? 0) + record.cost);
		}

		// Per-project aggregation (same rules, project-qualified keys).
		const project = record.project || "unknown";
		const pkey = `${project}${KEY_SEP}${provider}${KEY_SEP}${model}`;
		let projectBucket = hourlyProject.get(hourStart);
		if (!projectBucket) {
			projectBucket = new Map();
			hourlyProject.set(hourStart, projectBucket);
		}
		let projectCell = projectBucket.get(pkey);
		if (!projectCell) {
			projectCell = { messages: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, missCount: 0, missCost: 0 };
			projectBucket.set(pkey, projectCell);
			projectKeys.set(pkey, { project, provider, model });
		}
		if (!record.auxiliary) projectCell.messages += 1;
		projectCell.cost += record.cost;
		projectCell.input += record.input;
		projectCell.output += record.output;
		projectCell.cacheRead += record.cacheRead;
		projectCell.cacheWrite += record.cacheWrite;
		if (!record.auxiliary) {
			projectCell.reasoning += record.reasoning;
			let projectSessionSet = projectSessions.get(pkey);
			if (!projectSessionSet) {
				projectSessionSet = new Set();
				projectSessions.set(pkey, projectSessionSet);
			}
			projectSessionSet.add(record.sourceId);
					}
	}
	return {
		hourly,
		keys,
		sessions,
		totalSessions,
		sessionCost,
		hourlyProject,
		projectKeys,
		projectSessions,
		generatedAt: Date.now(),
	};
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

interface FlatRow {
	hourStart: number;
	key: string;
	cell: TrendCell;
}

const flattenCache = new WeakMap<TrendsData, FlatRow[]>();

/** Flatten hourly buckets into a time-sorted array; memoized per TrendsData. */
function flattenHourly(data: TrendsData, fromMs?: number): FlatRow[] {
	let all = flattenCache.get(data);
	if (!all) {
		all = [];
		for (const [hourStart, bucket] of data.hourly) {
			for (const [key, cell] of bucket) {
				all.push({ hourStart, key, cell });
			}
		}
		all.sort((a, b) => a.hourStart - b.hourStart);
		flattenCache.set(data, all);
	}
	if (fromMs === undefined) return all;
	let low = 0;
	while (low < all.length && all[low]!.hourStart < fromMs) low += 1;
	return all.slice(low);
}

const projectFlattenCache = new WeakMap<TrendsData, { hourStart: number; key: string; cell: TrendCell }[]>();

function flattenHourlyProject(data: TrendsData, fromMs?: number): { hourStart: number; key: string; cell: TrendCell }[] {
	let all = projectFlattenCache.get(data);
	if (!all) {
		all = [];
		for (const [hourStart, bucket] of data.hourlyProject) {
			for (const [key, cell] of bucket) {
				all.push({ hourStart, key, cell });
			}
		}
		all.sort((a, b) => a.hourStart - b.hourStart);
		projectFlattenCache.set(data, all);
	}
	if (fromMs === undefined) return all;
	let low = 0;
	while (low < all.length && all[low]!.hourStart < fromMs) low += 1;
	return all.slice(low);
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
	reasoning: number;
}

export function distributionRows(data: TrendsData, fromMs: number | undefined): DistributionRow[] {
	const rows = new Map<string, DistributionRow>();
	for (const { key, cell } of flattenHourly(data, fromMs)) {
		let row = rows.get(key);
		if (!row) {
			const names = data.keys.get(key) ?? { provider: "unknown", model: "unknown" };
			row = { provider: names.provider, model: names.model, sessions: 0, messages: 0, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
			rows.set(key, row);
		}
		row.messages += cell.messages;
		row.cost += cell.cost;
		row.input += cell.input;
		row.output += cell.output;
		row.cacheRead += cell.cacheRead;
		row.cacheWrite += cell.cacheWrite;
		row.reasoning += cell.reasoning;
		row.tokens += cellTokens(cell);
	}
	const result = [...rows.values()];
	for (const row of result) {
		row.sessions = data.sessions.get(`${row.provider}${KEY_SEP}${row.model}`)?.size ?? 0;
	}
	result.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.provider.localeCompare(b.provider));
	return result;
}

/** Project-level distribution rows (project -> model), sorted by cost desc. */
export interface ProjectDistributionRow extends DistributionRow {
	project: string;
}

export function projectDistributionRows(data: TrendsData, fromMs: number | undefined): ProjectDistributionRow[] {
	const rows = new Map<string, ProjectDistributionRow>();
	for (const { key, cell } of flattenHourlyProject(data, fromMs)) {
		const names = data.projectKeys.get(key) ?? { project: "unknown", provider: "unknown", model: "unknown" };
		const rowKey = `${names.project}${KEY_SEP}${names.provider}${KEY_SEP}${names.model}`;
		let row = rows.get(rowKey);
		if (!row) {
			row = {
				provider: names.provider,
				model: `${names.provider}/${names.model}`,
				project: names.project,
				sessions: data.projectSessions.get(key)?.size ?? 0,
				messages: 0,
				cost: 0,
				tokens: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
			};
			rows.set(rowKey, row);
		}
		row.messages += cell.messages;
		row.cost += cell.cost;
		row.input += cell.input;
		row.output += cell.output;
		row.cacheRead += cell.cacheRead;
		row.cacheWrite += cell.cacheWrite;
		row.reasoning += cell.reasoning;
		row.tokens += cellTokens(cell);
	}
	const result = [...rows.values()];
	result.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.project.localeCompare(b.project));
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
	let fromMs = options.fromMs;
	if (fromMs === undefined) {
		fromMs = now - HOUR_MS;
		for (const hourStart of data.hourly.keys()) {
			if (hourStart < fromMs) fromMs = hourStart;
		}
	}
	const spanMs = Math.max(HOUR_MS, now - fromMs);
	const bucketMs = spanMs <= 8 * 86_400_000 ? HOUR_MS : 86_400_000;
	// Day buckets align to local midnight so chart, heatmap and sparkline agree.
	const startMs = bucketMs === 86_400_000 ? dayStart(fromMs) : Math.floor(fromMs / bucketMs) * bucketMs;
	const bucketCount = Math.max(1, Math.ceil((now - startMs) / bucketMs));

	const flat = flattenHourly(data, fromMs);
	const namesByKey = new Map<string, { provider: string; model: string }>();
	const modelCounts = new Map<string, number>();
	for (const { key } of flat) {
		const names = data.keys.get(key) ?? { provider: "unknown", model: "unknown" };
		namesByKey.set(key, names);
		if (options.groupBy === "model") modelCounts.set(names.model, (modelCounts.get(names.model) ?? 0) + 1);
	}
	const groupLabel = (names: { provider: string; model: string }): string => {
		if (options.groupBy === "total") return "total";
		if (options.groupBy === "provider") return names.provider;
		return (modelCounts.get(names.model) ?? 0) > 1 ? `${names.model} (${names.provider})` : names.model;
	};

	const buckets = new Map<string, number[]>();
	const totals = new Array<number>(bucketCount).fill(0);
	for (const { hourStart, key, cell } of flat) {
		const names = namesByKey.get(key) ?? { provider: "unknown", model: "unknown" };
		const groupKey = groupLabel(names);
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
	const ranked = [...buckets.entries()]
		.filter(([, values]) => sum(values) > 0)
		.sort((a, b) => sum(b[1]) - sum(a[1]));
	const series: ChartSeries[] = [];
	if (options.groupBy !== "total") {
		series.push({
			label: "Total",
			points: totals.map((value, index) => ({ bucketStart: startMs + index * bucketMs, value })),
		});
	}
	ranked.slice(0, 5).forEach(([name, values]) => {
		series.push({ label: name, points: values.map((value, index) => ({ bucketStart: startMs + index * bucketMs, value })) });
	});
	return { bucketMs, startMs, bucketCount, series };
}

function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

/** Sum of every bucket in [fromMs, now] plus the distinct session count. */
export function periodTotals(
	data: TrendsData,
	fromMs: number | undefined,
): TrendCell & { sessions: number } {
	const total: TrendCell = {
		messages: 0,
		cost: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		missCount: 0,
		missCost: 0,
	};
	const sessions = new Set<string>();
	for (const { key, cell } of flattenHourly(data, fromMs)) {
		total.messages += cell.messages;
		total.cost += cell.cost;
		total.input += cell.input;
		total.output += cell.output;
		total.cacheRead += cell.cacheRead;
		total.cacheWrite += cell.cacheWrite;
		total.reasoning += cell.reasoning;
		total.missCount += cell.missCount;
		total.missCost += cell.missCost;
		for (const sourceId of data.sessions.get(key) ?? []) sessions.add(sourceId);
	}
	return { ...total, sessions: sessions.size };
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
