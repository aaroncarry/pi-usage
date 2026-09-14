/** Vercel AI Gateway credits adapter. */

import type { AccountBalance, ProviderAdapter, ProviderFetchArgs } from "../types.ts";

const ENDPOINT = "https://ai-gateway.vercel.sh/v1/credits";
function amount(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return Number(value);
	return undefined;
}
export const vercelAIGatewayAdapter: ProviderAdapter = {
	id: "vercel-ai-gateway",
	label: "Vercel AI Gateway",
	async fetch({ token, signal, fetchImpl }: ProviderFetchArgs): Promise<AccountBalance> {
		const response = await fetchImpl(ENDPOINT, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal });
		if (!response.ok) throw new Error(`Vercel AI Gateway credits API returned HTTP ${response.status}`);
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) throw new Error("Vercel AI Gateway credits API returned an unexpected response");
		const root = body as { balance?: unknown; total_used?: unknown };
		const balance = amount(root.balance);
		const used = amount(root.total_used);
		if (balance === undefined || used === undefined) throw new Error("Vercel AI Gateway credits API returned no credit totals");
		return { providerId: "vercel-ai-gateway", label: "Vercel AI Gateway", balance: { amount: balance, currency: "USD", note: `lifetime spend $${used.toFixed(2)}` }, windows: [], notes: [], fetchedAt: Date.now() };
	},
};
