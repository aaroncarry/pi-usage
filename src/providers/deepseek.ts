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
		const first = parsed.balance_infos.find((entry): entry is DeepseekBalanceInfo => typeof entry === "object" && entry !== null);
		if (!first) {
			throw new Error("DeepSeek balance API returned an empty balance_infos list");
		}
		const amount = parseAmount(first.total_balance);
		if (amount === undefined) {
			throw new Error("DeepSeek balance API returned no usable total_balance");
		}
		const currency = typeof first.currency === "string" && first.currency ? first.currency : "CNY";
		const notes: string[] = [];
		const granted = parseAmount(first.granted_balance);
		if (granted !== undefined && granted > 0) notes.push(`granted ${currency} ${granted.toFixed(2)}`);
		if (parsed.is_available === false) notes.push("account unavailable");
		return {
			providerId: "deepseek",
			label: "DeepSeek",
			balance: { amount, currency },
			windows: [],
			notes,
			fetchedAt: Date.now(),
		};
	},
};
