/**
 * usage.json configuration: `<agentDir>/usage.json`.
 *
 * The file is optional; everything falls back to sensible defaults. Invalid
 * entries are ignored rather than rejected so a hand-edited file cannot break
 * the whole extension.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type StatusMode = "active" | "all" | "off";

export const DEFAULT_INTERVAL_MINUTES = 5;
export const MIN_INTERVAL_MINUTES = 1;

/** Generic adapter configured entirely from usage.json. */
export interface CustomProviderConfig {
	/** Request URL. */
	url: string;
	/** HTTP method, defaults to GET. */
	method?: string;
	/**
	 * Extra request headers. Values support $ENV interpolation and the
	 * "{token}" placeholder for the provider's stored auth.json token.
	 */
	headers?: Record<string, string>;
	/** Dot path (e.g. "data.availableBalance") to a numeric balance. */
	balancePath?: string;
	/** Currency code for the balance, e.g. "CNY". */
	currency?: string;
	/** Dot path to an array of usage window items. */
	windowsPath?: string;
	/** Field names inside each window item (defaults: label, percent, resetsAt). */
	windowFields?: { label?: string; percent?: string; resetsAt?: string };
}

export interface ProviderConfig {
	/** Set false to hide a provider from panel and status line. */
	enabled?: boolean;
	/** Display name override. */
	label?: string;
	/** z.ai region: "auto" (default), "global" or "cn". */
	region?: string;
	/** Generic adapter definition; entries with this are not built-in adapters. */
	custom?: CustomProviderConfig;
	[key: string]: unknown;
}

export interface BalanceConfig {
	/** Background refresh interval in minutes (min 1, default 5). */
	intervalMinutes?: number;
	/** Footer status line: active account + session consumption (default), all accounts, or off. */
	status?: StatusMode;
	/**
	 * Auto-detect balance endpoints for providers without a built-in adapter
	 * (New API relays, Sub2API, MiniMax, Zhipu). Default true.
	 */
	autoDetect?: boolean;
	/** Per-provider options; entries with `custom` define generic adapters. */
	providers?: Record<string, ProviderConfig>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadBalanceConfig(agentDir: string): BalanceConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, "usage.json"), "utf8"));
	} catch {
		return {};
	}
	if (!isRecord(raw)) return {};
	return sanitizeBalanceConfig(raw);
}

export function intervalMs(config: BalanceConfig): number {
	const minutes = config.intervalMinutes;
	const resolved =
		typeof minutes === "number" && Number.isFinite(minutes)
			? Math.max(MIN_INTERVAL_MINUTES, minutes)
			: DEFAULT_INTERVAL_MINUTES;
	return resolved * 60_000;
}

/**
 * Persist a new footer status mode to usage.json, preserving all other
 * fields. An unreadable file is replaced with a minimal valid config.
 */
export function saveStatusMode(agentDir: string, status: StatusMode): void {
	const path = join(agentDir, "usage.json");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		raw = undefined;
	}
	const config = isRecord(raw) ? raw : {};
	config.status = status;
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

function sanitizeBalanceConfig(raw: Record<string, unknown>): BalanceConfig {
	const config: BalanceConfig = {};
	if (typeof raw.intervalMinutes === "number" && Number.isFinite(raw.intervalMinutes) && raw.intervalMinutes > 0) {
		config.intervalMinutes = raw.intervalMinutes;
	}
	if (raw.status === "active" || raw.status === "all" || raw.status === "off") {
		config.status = raw.status;
	}
	if (typeof raw.autoDetect === "boolean") config.autoDetect = raw.autoDetect;
	if (isRecord(raw.providers)) {
		const providers: Record<string, ProviderConfig> = {};
		for (const [id, value] of Object.entries(raw.providers)) {
			if (!isRecord(value)) continue;
			providers[id] = sanitizeProviderConfig(value);
		}
		if (Object.keys(providers).length > 0) config.providers = providers;
	}
	return config;
}

function sanitizeProviderConfig(raw: Record<string, unknown>): ProviderConfig {
	const entry: ProviderConfig = {};
	if (typeof raw.enabled === "boolean") entry.enabled = raw.enabled;
	if (typeof raw.label === "string") entry.label = raw.label;
	if (typeof raw.region === "string") entry.region = raw.region;
	if (isRecord(raw.custom)) entry.custom = sanitizeCustomConfig(raw.custom);
	return entry;
}

function sanitizeCustomConfig(raw: Record<string, unknown>): CustomProviderConfig {
	const custom: CustomProviderConfig = { url: typeof raw.url === "string" ? raw.url : "" };
	if (typeof raw.method === "string") custom.method = raw.method;
	if (isRecord(raw.headers)) {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(raw.headers)) {
			if (typeof value === "string") headers[name] = value;
		}
		custom.headers = headers;
	}
	if (typeof raw.balancePath === "string") custom.balancePath = raw.balancePath;
	if (typeof raw.currency === "string") custom.currency = raw.currency;
	if (typeof raw.windowsPath === "string") custom.windowsPath = raw.windowsPath;
	if (isRecord(raw.windowFields)) {
		const fields = raw.windowFields;
		const windowFields: { label?: string; percent?: string; resetsAt?: string } = {};
		if (typeof fields.label === "string") windowFields.label = fields.label;
		if (typeof fields.percent === "string") windowFields.percent = fields.percent;
		if (typeof fields.resetsAt === "string") windowFields.resetsAt = fields.resetsAt;
		custom.windowFields = windowFields;
	}
	return custom;
}
