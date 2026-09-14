/**
 * OpenRouter API-key usage adapter.
 *
 * The /credits endpoint reports an account/prepaid-credit bucket and is not a
 * reliable balance source for Workspace keys. The /key endpoint describes the
 * authenticated key's spend cap and usage instead.
 */

import { toNumber } from "../parse.ts";
import type { AccountBalance, ProviderAdapter, ProviderFetchArgs } from "../types.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/key";

type OpenrouterKeyData = {
	label?: unknown;
	limit?: unknown;
	limit_remaining?: unknown;
	limit_reset?: unknown;
	usage?: unknown;
	usage_daily?: unknown;
	usage_weekly?: unknown;
	usage_monthly?: unknown;
	is_free_tier?: unknown;
};

interface OpenrouterKeyResponse {
	data?: OpenrouterKeyData | null;
}

function money(value: number): string {
	return `$${value.toFixed(2)}`;
}

export const openrouterAdapter: ProviderAdapter = {
	id: "openrouter",
	label: "OpenRouter",
	async fetch({ token, signal, fetchImpl }: ProviderFetchArgs): Promise<AccountBalance> {
		const response = await fetchImpl(ENDPOINT, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal,
		});
		if (!response.ok) {
			throw new Error(`OpenRouter key API returned HTTP ${response.status}`);
		}
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) {
			throw new Error("OpenRouter key API returned an unexpected response");
		}
		const data = (body as OpenrouterKeyResponse).data;
		if (typeof data !== "object" || data === null) {
			throw new Error("OpenRouter key API returned no key data");
		}

		const limit = toNumber(data.limit);
		const remaining = toNumber(data.limit_remaining);
		const notes: string[] = [];
		if (data.limit === null) notes.push("no per-key spend cap");
		else if (limit === undefined) notes.push("per-key spend cap unavailable");
		if (data.is_free_tier === true) notes.push("free-tier API key");
		const usageFields: [keyof OpenrouterKeyData, string][] = [
			["usage_daily", "today"],
			["usage_weekly", "this week"],
			["usage_monthly", "this month"],
			["usage", "all-time"],
		];
		for (const [key, label] of usageFields) {
			const value = toNumber(data[key]);
			if (value !== undefined) notes.push(`${label} ${money(value)}`);
		}

		if (limit === undefined && remaining === undefined && notes.length === 0) {
			throw new Error("OpenRouter key API returned no displayable usage data");
		}

		return {
			providerId: "openrouter",
			label: "OpenRouter",
			...(remaining !== undefined
				? {
					balance: {
						amount: Math.max(0, remaining),
						currency: "USD",
						note: limit !== undefined ? `key limit ${money(limit)}` : "key limit remaining",
					},
				}
				: {}),
			windows: [],
			notes,
			fetchedAt: Date.now(),
		};
	},
};
