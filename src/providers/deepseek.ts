/**
 * DeepSeek adapter: prepaid account balance via the public balance endpoint.
 */

import type { AccountBalance, ProviderAdapter, ProviderFetchArgs } from "../types.ts";

const ENDPOINT = "https://api.deepseek.com/user/balance";

interface DeepseekBalanceInfo {
	currency?: unknown;
	total_balance?: unknown;
	granted_balance?: unknown;
	topped_up_balance?: unknown;
}

interface DeepseekBalanceResponse {
	is_available?: unknown;
	balance_infos?: unknown;
}

function parseAmount(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

export const deepseekAdapter: ProviderAdapter = {
	id: "deepseek",
	label: "DeepSeek",
	async fetch({ token, signal, fetchImpl }: ProviderFetchArgs): Promise<AccountBalance> {
		const response = await fetchImpl(ENDPOINT, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal,
		});
		if (!response.ok) {
			throw new Error(`DeepSeek balance API returned HTTP ${response.status}`);
		}
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) {
			throw new Error("DeepSeek balance API returned an unexpected response");
		}
		const parsed = body as DeepseekBalanceResponse;
		if (!Array.isArray(parsed.balance_infos)) {
			throw new Error("DeepSeek balance API returned no balance_infos");
		}
		const balances = parsed.balance_infos
			.map((entry): { amount: number; currency: string; granted?: number } | undefined => {
				if (typeof entry !== "object" || entry === null) return undefined;
				const info = entry as DeepseekBalanceInfo;
				const amount = parseAmount(info.total_balance);
				if (amount === undefined) return undefined;
				const currency = typeof info.currency === "string" && info.currency.trim() ? info.currency.trim().toUpperCase() : "CNY";
				const granted = parseAmount(info.granted_balance);
				return { amount, currency, granted };
			})
			.filter((entry): entry is { amount: number; currency: string; granted?: number } => entry !== undefined);
		if (balances.length === 0) throw new Error("DeepSeek balance API returned no usable balances");
		const first = balances[0]!;
		const notes: string[] = [];
		if (balances.length > 1) {
			for (const entry of balances) notes.push(`${entry.currency} balance ${entry.amount.toFixed(2)}`);
		}
		if (first.granted !== undefined && first.granted > 0) notes.push(`granted ${first.currency} ${first.granted.toFixed(2)}`);
		if (parsed.is_available === false) notes.push("account unavailable");
		return {
			providerId: "deepseek",
			label: "DeepSeek",
			balance: { amount: first.amount, currency: first.currency },
			windows: [],
			notes,
			fetchedAt: Date.now(),
		};
	},
};
