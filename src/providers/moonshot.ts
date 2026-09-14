/** Moonshot AI API account balance adapter (global and China endpoints). */

import type { AccountBalance, ProviderAdapter, ProviderFetchArgs } from "../types.ts";

const ROOTS = { moonshotai: "https://api.moonshot.ai", "moonshotai-cn": "https://api.moonshot.cn" } as const;

type ProviderId = keyof typeof ROOTS;
function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function number(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

export function createMoonshotAdapter(id: ProviderId): ProviderAdapter {
	return {
		id,
		label: id === "moonshotai-cn" ? "Moonshot AI CN" : "Moonshot AI",
		async fetch({ token, signal, fetchImpl }: ProviderFetchArgs): Promise<AccountBalance> {
			const response = await fetchImpl(`${ROOTS[id]}/v1/users/me/balance`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal });
			if (!response.ok) throw new Error(`Moonshot balance API returned HTTP ${response.status}`);
			const body: unknown = await response.json();
			const root = object(body);
			if (!root || root.code !== 0 || root.status !== true) throw new Error("Moonshot balance API returned an unsuccessful response");
			const data = object(root.data);
			const available = number(data?.available_balance);
			if (available === undefined || available < 0) throw new Error("Moonshot balance API returned no available balance");
			const currency = id === "moonshotai-cn" ? "CNY" : "USD";
			const notes: string[] = [];
			for (const key of ["voucher_balance", "cash_balance"] as const) {
				const value = number(data?.[key]);
				if (value !== undefined) notes.push(`${key.replaceAll("_", " ")} ${currency === "USD" ? "$" : "¥"}${value.toFixed(2)}`);
			}
			return { providerId: id, label: id === "moonshotai-cn" ? "Moonshot AI CN" : "Moonshot AI", balance: { amount: available, currency }, windows: [], notes, fetchedAt: Date.now() };
		},
	};
}
