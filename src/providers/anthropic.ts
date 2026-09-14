/**
 * Anthropic Claude (subscription OAuth) adapter.
 *
 * Query method borrowed from CodexBar: the Claude Code OAuth access token
 * stored by pi in auth.json is accepted by the OAuth usage endpoint with the
 * matching beta header.
 */

import { parseTimestamp, toNumber } from "../parse.ts";
import type { AccountBalance, ProviderAdapter, ProviderFetchArgs, UsageWindow } from "../types.ts";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";

interface AnthropicUsageWindow {
	utilization?: unknown;
	resets_at?: unknown;
}

interface AnthropicUsageResponse {
	five_hour?: unknown;
	seven_day?: unknown;
	seven_day_opus?: unknown;
	seven_day_sonnet?: unknown;
	seven_day_oauth_apps?: unknown;
	extra_usage?: {
		is_enabled?: unknown;
		monthly_limit?: unknown;
		used_credits?: unknown;
		currency?: unknown;
	} | null;
}

function parseWindow(label: string, raw: unknown): UsageWindow | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const window = raw as AnthropicUsageWindow;
	const usedPercent = toNumber(window.utilization);
	if (usedPercent === undefined) return undefined;
	return { label, usedPercent: Math.max(0, Math.min(100, usedPercent)), resetsAt: parseTimestamp(window.resets_at) };
}

export const anthropicAdapter: ProviderAdapter = {
	id: "anthropic",
	label: "Claude",
	async fetch({ token, signal, fetchImpl }: ProviderFetchArgs): Promise<AccountBalance> {
		const response = await fetchImpl(ENDPOINT, {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": BETA_HEADER,
				Accept: "application/json",
			},
			signal,
		});
		if (!response.ok) {
			throw new Error(`Claude usage API returned HTTP ${response.status}`);
		}
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) {
			throw new Error("Claude usage API returned an unexpected response");
		}
		const usage = body as AnthropicUsageResponse;
		const windows: UsageWindow[] = [];
		const fiveHour = parseWindow("5h", usage.five_hour);
		if (fiveHour) windows.push(fiveHour);
		const sevenDay = parseWindow("weekly", usage.seven_day);
		if (sevenDay) windows.push(sevenDay);
		// Team/Max responses may expose model-specific weekly buckets while the
		// aggregate bucket is null or omitted. Keep every non-null bucket instead
		// of treating that valid response as an API failure.
		const opus = parseWindow("weekly-opus", usage.seven_day_opus);
		if (opus) windows.push(opus);
		const sonnet = parseWindow("weekly-sonnet", usage.seven_day_sonnet);
		if (sonnet) windows.push(sonnet);
		const oauthApps = parseWindow("weekly-oauth-apps", usage.seven_day_oauth_apps);
		if (oauthApps) windows.push(oauthApps);

		const notes: string[] = [];
		const extra = usage.extra_usage;
		const monthlyLimit = toNumber(extra?.monthly_limit);
		const usedCredits = toNumber(extra?.used_credits);
		const extraEnabled = extra?.is_enabled === true;
		const currency = typeof extra?.currency === "string" && extra.currency.trim() ? extra.currency : "USD";
		let balance: AccountBalance["balance"];
		if (extraEnabled && monthlyLimit !== undefined) {
			// Anthropic reports extra_usage amounts in cents, not dollars.
			const used = usedCredits ?? 0;
			balance = {
				amount: Math.max(0, monthlyLimit - used) / 100,
				currency,
				note: `extra usage: ${currency === "USD" ? "$" : ""}${(used / 100).toFixed(2)} of ${currency === "USD" ? "$" : ""}${(monthlyLimit / 100).toFixed(2)}`,
			};
		} else if (extraEnabled && usedCredits !== undefined) {
			notes.push(`extra usage used ${currency === "USD" ? "$" : ""}${(usedCredits / 100).toFixed(2)}`);
		}
		if (windows.length === 0 && !balance && notes.length === 0) {
			throw new Error("Claude usage API returned no displayable usage data");
		}
		return { providerId: "anthropic", label: "Claude", ...(balance ? { balance } : {}), windows, notes, fetchedAt: Date.now() };
	},
};
