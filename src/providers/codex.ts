/**
 * OpenAI Codex (ChatGPT subscription) adapter.
 *
 * Query method borrowed from CodexBar: the ChatGPT OAuth access token stored
 * by pi in auth.json is accepted by the backend usage endpoint.
 */

import type { AccountBalance, ProviderAdapter, ProviderFetchArgs, UsageWindow } from "../types.ts";

const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

interface CodexWindow {
	used_percent?: unknown;
	reset_at?: unknown;
	limit_window_seconds?: unknown;
}

interface CodexUsageResponse {
	plan_type?: unknown;
	rate_limit?: { primary_window?: unknown; secondary_window?: unknown } | null;
	credits?: { balance?: unknown } | null;
	spend_control?: { individual_limit?: unknown } | null;
}

function windowLabel(limitWindowSeconds: number): string {
	if (limitWindowSeconds === 18_000) return "5h";
	if (limitWindowSeconds === 604_800) return "weekly";
	const hours = Math.round(limitWindowSeconds / 3_600);
	return hours > 0 ? `${hours}h` : `${limitWindowSeconds}s`;
}

function parseWindow(fallbackLabel: string, raw: unknown): UsageWindow | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const window = raw as CodexWindow;
	if (typeof window.used_percent !== "number") return undefined;
	const label = typeof window.limit_window_seconds === "number" ? windowLabel(window.limit_window_seconds) : fallbackLabel;
	const resetsAt = typeof window.reset_at === "number" ? window.reset_at * 1000 : undefined;
	return { label, usedPercent: window.used_percent, resetsAt };
}

/** Accept numbers or numeric strings ("0" from credits.balance). */
function money(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

export const codexAdapter: ProviderAdapter = {
	id: "openai-codex",
	label: "Codex",
	async fetch({ token, signal, fetchImpl }: ProviderFetchArgs): Promise<AccountBalance> {
		const response = await fetchImpl(ENDPOINT, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal,
		});
		if (!response.ok) {
			throw new Error(`Codex usage API returned HTTP ${response.status}`);
		}
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) {
			throw new Error("Codex usage API returned an unexpected response");
		}
		const usage = body as CodexUsageResponse;
		const windows: UsageWindow[] = [];
		const primary = parseWindow("5h", usage.rate_limit?.primary_window);
		if (primary) windows.push(primary);
		const secondary = parseWindow("weekly", usage.rate_limit?.secondary_window);
		if (secondary) windows.push(secondary);
		const notes: string[] = [];
		const credits = money(usage.credits?.balance);
		if (credits !== undefined && credits > 0) notes.push(`$${credits.toFixed(2)} credits`);
		const spendCap = money(usage.spend_control?.individual_limit);
		if (spendCap !== undefined && spendCap > 0) notes.push(`monthly spend cap $${spendCap.toFixed(2)}`);
		const planType = typeof usage.plan_type === "string" ? usage.plan_type : undefined;
		const plan = planType ? planType.charAt(0).toUpperCase() + planType.slice(1) : undefined;
		if (windows.length === 0) {
			throw new Error("Codex usage API returned no rate limit windows");
		}
		return { providerId: "openai-codex", label: "Codex", plan, windows, notes, fetchedAt: Date.now() };
	},
};
