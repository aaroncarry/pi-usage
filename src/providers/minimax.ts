/** MiniMax Token Plan and pay-as-you-go account balance adapter. */

import { parseTimestamp, toNumber } from "../parse.ts";
import type { AccountBalance, MoneyBalance, ProviderAdapter, ProviderFetchArgs, UsageWindow } from "../types.ts";

const ROOTS = { global: "https://api.minimax.io", cn: "https://api.minimaxi.com" } as const;

type MiniMaxRow = Record<string, unknown>;

function object(value: unknown): MiniMaxRow | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as MiniMaxRow : undefined;
}
function integer(value: unknown): number | undefined {
	const n = toNumber(value);
	return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
function amount(value: unknown): string | undefined {
	if (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}
function labelFor(row: MiniMaxRow, fallback: string): string {
	return typeof row.model_name === "string" && row.model_name.trim() ? row.model_name.trim().slice(0, 80) : fallback;
}
function percentFromCounts(total: number, reported: number, remainingPercent: number | undefined): { used: number; remaining: number } | undefined {
	if (total <= 0 || reported > total) return undefined;
	if (remainingPercent === undefined) return { used: total - reported, remaining: reported };
	const asRemaining = reported / total * 100;
	const asUsed = (total - reported) / total * 100;
	if (Math.min(Math.abs(asRemaining - remainingPercent), Math.abs(asUsed - remainingPercent)) > 1) return undefined;
	const remaining = Math.abs(asUsed - remainingPercent) < Math.abs(asRemaining - remainingPercent) ? total - reported : reported;
	return { used: total - remaining, remaining };
}
function parseWindow(row: MiniMaxRow, prefix: "current_interval" | "current_weekly", label: string): UsageWindow | undefined {
	const status = integer(row[`${prefix}_status`]);
	if (status !== undefined && ![1, 2, 3].includes(status)) return undefined;
	const start = parseTimestamp(row[prefix === "current_interval" ? "start_time" : "weekly_start_time"]);
	const end = parseTimestamp(row[prefix === "current_interval" ? "end_time" : "weekly_end_time"]);
	if (end !== undefined && start !== undefined && end < start) return undefined;
	if (status === 3) return { label, usedPercent: 0, resetsAt: end, detail: "unlimited" };
	const total = integer(row[`${prefix}_total_count`]);
	const reported = integer(row[`${prefix}_usage_count`]);
	if (total === undefined || reported === undefined) return undefined;
	const remainingPercent = toNumber(row[`${prefix}_remaining_percent`]);
	const resolved = percentFromCounts(total, reported, remainingPercent);
	if (!resolved) return undefined;
	return {
		label,
		usedPercent: total === 0 ? 0 : resolved.used / total * 100,
		resetsAt: end,
		detail: `${resolved.remaining} of ${total} left`,
	};
}

export const minimaxAdapter: ProviderAdapter = {
	id: "minimax",
	label: "MiniMax",
	async fetch({ token, signal, fetchImpl, options }: ProviderFetchArgs): Promise<AccountBalance> {
		return fetchMiniMax("minimax", token, signal, fetchImpl, options);
	},
};

export const minimaxCnAdapter: ProviderAdapter = {
	id: "minimax-cn",
	label: "MiniMax CN",
	async fetch({ token, signal, fetchImpl, options }: ProviderFetchArgs): Promise<AccountBalance> {
		return fetchMiniMax("minimax-cn", token, signal, fetchImpl, options);
	},
};

async function fetchMiniMax(id: "minimax" | "minimax-cn", token: string, signal: AbortSignal | undefined, fetchImpl: ProviderFetchArgs["fetchImpl"], options: ProviderFetchArgs["options"]): Promise<AccountBalance> {
	const isBalance = token.startsWith("sk-api-");
	const root = options.region === "global" ? ROOTS.global : options.region === "cn" || id === "minimax-cn" ? ROOTS.cn : id === "minimax" ? ROOTS.global : ROOTS.cn;
	const endpoint = `${root}${isBalance ? "/account/query_balance" : "/v1/token_plan/remains"}`;
	const response = await fetchImpl(endpoint, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal });
	if (!response.ok) throw new Error(`MiniMax usage API returned HTTP ${response.status}`);
	const body: unknown = await response.json();
	const payload = object(body);
	if (!payload || (object(payload.base_resp)?.status_code !== 0 && payload.base_resp !== undefined)) throw new Error("MiniMax usage API returned an unsuccessful response");
	const currency = id === "minimax-cn" ? "CNY" : "USD";
	if (isBalance) {
		const available = amount(payload.available_amount);
		if (available === undefined) throw new Error("MiniMax account balance was unavailable");
		const notes = ["cash_balance", "voucher_balance", "credit_balance", "owed_amount"].flatMap((key) => {
			const value = amount(payload[key]);
			return value !== undefined ? [`${key.replaceAll("_", " ")} ${currency === "USD" ? "$" : "¥"}${value}`] : [];
		});
		const balance: MoneyBalance = { amount: Number(available), currency };
		return { providerId: id, label: id === "minimax-cn" ? "MiniMax CN" : "MiniMax", balance, windows: [], notes, fetchedAt: Date.now() };
	}
	if (!Array.isArray(payload.model_remains) || payload.model_remains.length === 0) throw new Error("MiniMax Token Plan returned no quota rows");
	const windows: UsageWindow[] = [];
	for (const [index, raw] of payload.model_remains.entries()) {
		const row = object(raw);
		if (!row) continue;
		const model = labelFor(row, `quota ${index + 1}`);
		const interval = parseWindow(row, "current_interval", `${model} rolling`);
		const weekly = parseWindow(row, "current_weekly", `${model} weekly`);
		if (interval) windows.push(interval);
		if (weekly) windows.push(weekly);
	}
	if (windows.length === 0) throw new Error("MiniMax Token Plan returned no usable quota windows");
	return { providerId: id, label: id === "minimax-cn" ? "MiniMax CN" : "MiniMax", windows, notes: [], fetchedAt: Date.now() };
}
