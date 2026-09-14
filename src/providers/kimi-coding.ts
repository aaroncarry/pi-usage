/**
 * Kimi For Coding managed usage adapter.
 *
 * The coding plan endpoint reports quota counts (not dollars), while the
 * optional booster wallet uses fixed-point units. Keep these separate so a
 * wallet balance is never mistaken for a token-plan quota.
 */

import { parseTimestamp, toNumber } from "../parse.ts";
import type { AccountBalance, ProviderAdapter, ProviderFetchArgs, UsageWindow } from "../types.ts";

const ENDPOINT = "https://api.kimi.com/coding/v1/usages";
const FIXED_POINT_UNITS_PER_CENT = 1_000_000;

type UsageRow = {
	limit?: unknown;
	used?: unknown;
	remaining?: unknown;
	resetTime?: unknown;
};

type KimiResponse = {
	usage?: unknown;
	limits?: unknown;
	boosterWallet?: unknown;
};

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
	const number = toNumber(value);
	return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function windowMinutes(value: unknown): number | undefined {
	const row = object(value);
	const duration = nonnegativeInteger(row?.duration);
	if (duration === undefined || duration === 0) return undefined;
	const unit = row?.timeUnit;
	const multiplier = unit === "TIME_UNIT_MINUTE" ? 1 : unit === "TIME_UNIT_HOUR" ? 60 : unit === "TIME_UNIT_DAY" ? 1440 : unit === "TIME_UNIT_WEEK" ? 10080 : undefined;
	const minutes = multiplier === undefined ? undefined : duration * multiplier;
	return minutes !== undefined && Number.isSafeInteger(minutes) ? minutes : undefined;
}

function defaultLabel(minutes: number): string {
	if (minutes === 300) return "5h";
	if (minutes === 1440) return "daily";
	if (minutes === 10080) return "weekly";
	return `${minutes}m`;
}

function parseRow(raw: unknown, minutes: number, label: string): UsageWindow | undefined {
	const row = object(raw) as UsageRow | undefined;
	if (!row) return undefined;
	const limit = nonnegativeInteger(row.limit);
	if (limit === undefined || limit === 0) return undefined;
	const usedValue = nonnegativeInteger(row.used);
	const remainingValue = nonnegativeInteger(row.remaining);
	if (row.used !== undefined && usedValue === undefined) return undefined;
	if (row.remaining !== undefined && remainingValue === undefined) return undefined;
	const used = usedValue ?? (remainingValue === undefined ? 0 : Math.max(0, limit - remainingValue));
	const remaining = remainingValue ?? Math.max(0, limit - used);
	if (used > limit || remaining > limit) return undefined;
	return {
		label,
		usedPercent: (used / limit) * 100,
		resetsAt: parseTimestamp(row.resetTime),
		detail: `${remaining} of ${limit} left`,
	};
}

function parseWallet(raw: unknown): AccountBalance["balance"] | undefined {
	const wallet = object(raw);
	const balance = object(wallet?.balance);
	if (!wallet || !balance || balance.type !== "BOOSTER") return undefined;
	const rawLeft = nonnegativeInteger(balance.amountLeft);
	if (rawLeft === undefined) return undefined;
	const cents = rawLeft / FIXED_POINT_UNITS_PER_CENT;
	const amount = Math.round(cents) / 100;
	if (!Number.isFinite(amount)) return undefined;
	const currency = object(wallet.monthlyChargeLimit)?.currency;
	if (typeof currency !== "string" || !/^[A-Z]{3}$/u.test(currency)) return undefined;
	return { amount, currency, note: "Kimi booster wallet remaining" };
}

export const kimiCodingAdapter: ProviderAdapter = {
	id: "kimi-coding",
	label: "Kimi Coding",
	async fetch({ token, signal, fetchImpl }: ProviderFetchArgs): Promise<AccountBalance> {
		const response = await fetchImpl(ENDPOINT, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal,
		});
		if (!response.ok) throw new Error(`Kimi Coding usage API returned HTTP ${response.status}`);
		const body: unknown = await response.json();
		const root = object(body) as KimiResponse | undefined;
		if (!root) throw new Error("Kimi Coding usage API returned an unexpected response");
		const windows: UsageWindow[] = [];
		const seen = new Set<number>();
		const add = (window: UsageWindow | undefined, minutes: number) => {
			if (window && !seen.has(minutes)) {
				seen.add(minutes);
				windows.push(window);
			}
		};
		const weekly = parseRow(root.usage, 10080, "weekly");
		add(weekly, 10080);
		if (Array.isArray(root.limits)) {
			for (const raw of root.limits) {
				const item = object(raw);
				const minutes = windowMinutes(item?.window);
				if (minutes === undefined) continue;
				const name = typeof item?.name === "string" && item.name.trim() ? item.name.trim() : defaultLabel(minutes);
				add(parseRow(item?.detail, minutes, name), minutes);
			}
		}
		const balance = parseWallet(root.boosterWallet);
		if (windows.length === 0 && !balance) throw new Error("Kimi Coding usage API returned no usable usage data");
		return { providerId: "kimi-coding", label: "Kimi Coding", windows, balance, notes: [], fetchedAt: Date.now() };
	},
};
