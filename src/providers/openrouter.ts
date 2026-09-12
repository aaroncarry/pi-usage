/**
 * OpenRouter adapter: prepaid credits via the public credits endpoint. Works
 * with both API keys and OAuth access tokens (plain Bearer either way).
 */

import { toNumber } from "../parse.ts";
import type { AccountBalance, ProviderAdapter, ProviderFetchArgs } from "../types.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/credits";

interface OpenrouterCreditsResponse {
	data?: {
		total_credits?: unknown;
		total_usage?: unknown;
	} | null;
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
			throw new Error(`OpenRouter credits API returned HTTP ${response.status}`);
		}
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) {
			throw new Error("OpenRouter credits API returned an unexpected response");
		}
		const parsed = body as OpenrouterCreditsResponse;
		const totalCredits = toNumber(parsed.data?.total_credits);
		const totalUsage = toNumber(parsed.data?.total_usage);
		if (totalCredits === undefined || totalUsage === undefined) {
			throw new Error("OpenRouter credits API returned no credit totals");
		}
		return {
			providerId: "openrouter",
			label: "OpenRouter",
			balance: {
				amount: totalCredits - totalUsage,
				currency: "USD",
				note: `used $${totalUsage.toFixed(2)} of $${totalCredits.toFixed(2)}`,
			},
			windows: [],
			notes: [],
			fetchedAt: Date.now(),
		};
	},
};
