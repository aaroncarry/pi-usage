/**
 * z.ai / GLM adapter.
 *
 * Two disjoint surfaces, both borrowed from CodexBar's zai.js plugin:
 * 1. Coding plan quota windows (`/api/monitor/usage/quota/limit`), available
 *    only to coding-plan keys.
 * 2. BigModel CN pay-as-you-go balance (console endpoint). Empirically this
 *    also accepts z.ai global keys, so it is attempted as a best-effort
 *    fallback regardless of region; a failure never breaks quota display.
 */

import type { AccountBalance, MoneyBalance, ProviderAdapter, ProviderFetchArgs, UsageWindow } from "../types.ts";

const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const CN_BALANCE_URL = "https://www.bigmodel.cn/api/biz/account/query-customer-account-report";
const BASES = { global: "https://api.z.ai", cn: "https://open.bigmodel.cn" } as const;

/** unit → minutes multiplier (1=day, 3=hour, 5=minute, 6=week). */
const UNIT_MINUTES: Record<number, number> = { 1: 1_440, 3: 60, 5: 1, 6: 10_080 };

interface ZaiLimit {
	type?: unknown;
	unit?: unknown;
	number?: unknown;
	percentage?: unknown;
	usage?: unknown;
	remaining?: unknown;
	nextResetTime?: unknown;
}

interface ZaiQuotaResponse {
	success?: unknown;
	msg?: unknown;
	data?: { planName?: unknown; plan?: unknown; limits?: unknown } | null;
}

interface BigmodelBalanceResponse {
	success?: unknown;
	data?: {
		availableBalance?: unknown;
		balance?: unknown;
		rechargeAmount?: unknown;
		giveAmount?: unknown;
		totalSpendAmount?: unknown;
	} | null;
}

interface ParsedLimit {
	type: "TIME_LIMIT" | "TOKENS_LIMIT" | "CREDIT_LIMIT";
	percent: number;
	windowMinutes?: number;
	resetsAt?: number;
	detail?: string;
}

function optionalInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** z.ai mixes seconds and milliseconds epochs; disambiguate by magnitude. */
function normalizeEpoch(value: number): number {
	return value < 1e12 ? value * 1000 : value;
}

function parseLimit(raw: unknown): ParsedLimit | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const limit = raw as ZaiLimit;
	if (typeof limit.percentage !== "number") return undefined;
	if (limit.type !== "TIME_LIMIT" && limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT") return undefined;
	const unit = optionalInt(limit.unit);
	const number = optionalInt(limit.number);
	const multiplier = unit !== undefined ? UNIT_MINUTES[unit] : undefined;
	const windowMinutes =
		multiplier !== undefined && number !== undefined && number > 0 ? number * multiplier : undefined;
	const reset = optionalInt(limit.nextResetTime);
	const usage = optionalInt(limit.usage);
	const remaining = optionalInt(limit.remaining);
	const detail = usage !== undefined && remaining !== undefined ? `${remaining} of ${usage} left` : undefined;
	return {
		type: limit.type,
		percent: limit.percentage,
		windowMinutes,
		resetsAt: reset !== undefined ? normalizeEpoch(reset) : undefined,
		detail,
	};
}

function windowTitle(windowMinutes: number | undefined): string {
	if (windowMinutes === 300) return "5h";
	if (windowMinutes === 10_080) return "weekly";
	if (windowMinutes === 43_200) return "monthly";
	if (windowMinutes !== undefined && windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	if (windowMinutes !== undefined) return `${windowMinutes}m`;
	return "window";
}

function windowsFromLimits(limits: ParsedLimit[]): UsageWindow[] {
	const windows: UsageWindow[] = [];
	const creditLimits = limits
		.filter((limit) => limit.type !== "TIME_LIMIT")
		.sort((a, b) => (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (b.windowMinutes ?? Number.MAX_SAFE_INTEGER));
	const timeLimit = limits.filter((limit) => limit.type === "TIME_LIMIT").at(-1);
	const sessionLimit = creditLimits.length >= 2 ? creditLimits[0] : undefined;
	const tokenLimit = creditLimits.at(-1);
	for (const entry of [sessionLimit, tokenLimit, timeLimit]) {
		if (!entry) continue;
		windows.push({
			label: entry.type === "TIME_LIMIT" ? "MCP" : windowTitle(entry.windowMinutes),
			usedPercent: entry.percent,
			resetsAt: entry.resetsAt,
			detail: entry.detail,
		});
	}
	return windows;
}

/** Server messages arrive in Chinese; map the known one to English. */
const QUOTA_FAILURE_TRANSLATIONS: Record<string, string> = {
	"当前用户不存在coding plan": "no coding plan on this account",
};

async function fetchQuota(
	url: string,
	token: string,
	fetchImpl: ProviderFetchArgs["fetchImpl"],
	signal: AbortSignal | undefined,
): Promise<{ windows: UsageWindow[]; plan?: string; failure?: string }> {
	const response = await fetchImpl(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		signal,
	});
	if (!response.ok) return { windows: [], failure: `HTTP ${response.status}` };
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null) return { windows: [], failure: "invalid response" };
	const quota = body as ZaiQuotaResponse;
	if (quota.success !== true) {
		const message = typeof quota.msg === "string" ? quota.msg : "invalid response";
		return { windows: [], failure: QUOTA_FAILURE_TRANSLATIONS[message] ?? message };
	}
	if (!Array.isArray(quota.data?.limits)) return { windows: [], failure: "no limits in response" };
	const limits = quota.data.limits.map(parseLimit).filter((limit): limit is ParsedLimit => limit !== undefined);
	const windows = windowsFromLimits(limits);
	const planCandidate = [quota.data?.planName, quota.data?.plan].find((value) => typeof value === "string" && value.trim() !== "");
	const plan = typeof planCandidate === "string" ? planCandidate.trim() : undefined;
	return { windows, plan };
}

async function fetchCnBalance(
	token: string,
	fetchImpl: ProviderFetchArgs["fetchImpl"],
	signal: AbortSignal | undefined,
): Promise<MoneyBalance | undefined> {
	const response = await fetchImpl(CN_BALANCE_URL, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		signal,
	});
	if (!response.ok) return undefined;
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null) return undefined;
	const parsed = body as BigmodelBalanceResponse;
	if (parsed.success !== true) return undefined;
	const data = parsed.data ?? {};
	const available = typeof data.availableBalance === "number" ? data.availableBalance : typeof data.balance === "number" ? data.balance : undefined;
	if (available === undefined || !Number.isFinite(available)) return undefined;
	const notes: string[] = [];
	if (typeof data.rechargeAmount === "number") notes.push(`recharged ¥${data.rechargeAmount.toFixed(2)}`);
	if (typeof data.totalSpendAmount === "number") notes.push(`spent ¥${data.totalSpendAmount.toFixed(2)}`);
	return { amount: available, currency: "CNY", note: notes.join(" · ") || undefined };
}

export const zaiAdapter: ProviderAdapter = {
	id: "zai",
	label: "GLM",
	async fetch({ token, signal, fetchImpl, options }: ProviderFetchArgs): Promise<AccountBalance> {
		const region = options.region === "global" ? "global" : options.region === "cn" ? "cn" : "auto";
		const bases = region === "auto" ? [BASES.global, BASES.cn] : [BASES[region]];
		let quotaFailure: string | undefined;
		let windows: UsageWindow[] = [];
		let plan: string | undefined;
		for (const base of bases) {
			try {
				const result = await fetchQuota(`${base}${QUOTA_PATH}`, token, fetchImpl, signal);
				if (result.windows.length > 0) {
					windows = result.windows;
					plan = result.plan;
					break;
				}
				quotaFailure ??= result.failure;
			} catch (error) {
				quotaFailure ??= error instanceof Error ? error.message : String(error);
			}
		}
		// Best-effort CN balance; a failure here must never break quota display.
		const balance = await fetchCnBalance(token, fetchImpl, signal).catch(() => undefined);
		if (windows.length === 0 && !balance) {
			throw new Error(quotaFailure ? `z.ai: ${quotaFailure}` : "z.ai returned no usage data");
		}
		return { providerId: "zai", label: "GLM", plan, windows, balance, notes: [], fetchedAt: Date.now() };
	},
};
