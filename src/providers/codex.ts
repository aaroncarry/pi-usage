/**
 * OpenAI Codex (ChatGPT subscription) adapter.
 *
 * Query method borrowed from CodexBar: the ChatGPT OAuth access token stored
 * by pi in auth.json is accepted by the backend usage endpoint.
 */

import { accountIdFromToken } from "../credentials.ts";
import { toNumber } from "../parse.ts";
import type { AccountBalance, ProviderAdapter, ProviderFetchArgs, UsageWindow } from "../types.ts";

const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const WORKSPACE_PLANS = new Set([
	"team",
	"business",
	"education",
	"quorum",
	"k12",
	"enterprise",
	"edu",
	"free_workspace",
]);

interface CodexWindow {
	used_percent?: unknown;
	reset_at?: unknown;
	limit_window_seconds?: unknown;
}

interface CodexSpendControlLimit {
	limit?: unknown;
	used?: unknown;
	remaining_percent?: unknown;
	remainingPercent?: unknown;
	reset_at?: unknown;
	resets_at?: unknown;
	resetsAt?: unknown;
}

interface CodexUsageResponse {
	plan_type?: unknown;
	rate_limit?: { primary_window?: unknown; secondary_window?: unknown } | null;
	additional_rate_limits?: unknown;
	credits?: { has_credits?: unknown; unlimited?: unknown; balance?: unknown } | null;
	rate_limit_reset_credits?: { available_count?: unknown } | null;
	spend_control?: { individual_limit?: unknown; individualLimit?: unknown } | null;
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
	const usedPercent = toNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;
	const limitWindowSeconds = toNumber(window.limit_window_seconds);
	const label = limitWindowSeconds !== undefined ? windowLabel(limitWindowSeconds) : fallbackLabel;
	return { label, usedPercent, resetsAt: parseResetAt(window.reset_at) };
}

/**
 * Business/Enterprise accounts may have no 5-hour or weekly windows. Their
 * usable quota is exposed as a monthly spend-control limit instead.
 */
function parseSpendControlWindow(raw: unknown): UsageWindow | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const limit = toNumber((raw as CodexSpendControlLimit).limit);
	if (limit === undefined || limit <= 0) return undefined;
	const spendControl = raw as CodexSpendControlLimit;
	const used = toNumber(spendControl.used);
	const remainingPercent = toNumber(spendControl.remaining_percent) ?? toNumber(spendControl.remainingPercent);
	const usedPercent = used !== undefined
		? (used / limit) * 100
		: remainingPercent !== undefined
			? 100 - remainingPercent
			: 0;
	const reset = spendControl.resets_at ?? spendControl.resetsAt ?? spendControl.reset_at;
	return {
		label: "monthly",
		usedPercent: Math.max(0, usedPercent),
		resetsAt: parseResetAt(reset),
	};
}

function parseResetAt(value: unknown): number | undefined {
	const numeric = toNumber(value);
	if (numeric !== undefined) return numeric < 1e12 ? numeric * 1000 : numeric;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}

export const codexAdapter: ProviderAdapter = {
	id: "openai-codex",
	label: "Codex",
	async fetch({ token, accountId, signal, fetchImpl }: ProviderFetchArgs): Promise<AccountBalance> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		};
		// Workspace accounts require this scope header. Personal OAuth tokens do
		// not always carry it, so omit it when the JWT is opaque or malformed.
		const requestAccountId = accountId ?? accountIdFromToken(token);
		if (requestAccountId) headers["ChatGPT-Account-Id"] = requestAccountId;
		const response = await fetchImpl(ENDPOINT, { headers, signal });
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
		if (Array.isArray(usage.additional_rate_limits)) {
			for (const raw of usage.additional_rate_limits) {
				if (typeof raw !== "object" || raw === null) continue;
				const item = raw as Record<string, unknown>;
				const name = typeof item.limit_name === "string" && item.limit_name.trim()
					? item.limit_name.trim()
					: typeof item.metered_feature === "string" && item.metered_feature.trim()
						? item.metered_feature.trim()
						: "additional";
				const group = item.rate_limit;
				if (typeof group !== "object" || group === null) continue;
				const value = group as Record<string, unknown>;
				const primaryWindow = parseWindow(`${name} 5h`, value.primary_window);
				if (primaryWindow) windows.push(primaryWindow);
				const secondaryWindow = parseWindow(`${name} weekly`, value.secondary_window);
				if (secondaryWindow) windows.push(secondaryWindow);
			}
		}
		const workspaceLimit = usage.spend_control?.individual_limit ?? usage.spend_control?.individualLimit;
		if (windows.length === 0) {
			const monthly = parseSpendControlWindow(workspaceLimit);
			if (monthly) windows.push(monthly);
		}
		const notes: string[] = [];
		const credits = toNumber(usage.credits?.balance);
		if (usage.credits?.unlimited === true) notes.push("credits unlimited");
		else if (credits !== undefined && credits > 0) notes.push(`$${credits.toFixed(2)} credits`);
		const resetCredits = toNumber(usage.rate_limit_reset_credits?.available_count);
		if (resetCredits !== undefined && resetCredits >= 0) notes.push(`${resetCredits} usage limit resets available`);
		const spendCap = toNumber(usage.spend_control?.individual_limit);
		if (spendCap !== undefined && spendCap > 0) notes.push(`monthly spend cap $${spendCap.toFixed(2)}`);
		const planType = typeof usage.plan_type === "string" ? usage.plan_type : undefined;
		const plan = planType ? planType.charAt(0).toUpperCase() + planType.slice(1) : undefined;
		const workspacePlan = planType !== undefined && WORKSPACE_PLANS.has(planType.toLowerCase());
		if (windows.length === 0 && !workspacePlan) {
			throw new Error("Codex usage API returned no rate limit windows");
		}
		return { providerId: "openai-codex", label: "Codex", plan, windows, notes, fetchedAt: Date.now() };
	},
};
