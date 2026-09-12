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
	extra_usage?: {
		is_enabled?: unknown;
		monthly_limit?: unknown;
		used_credits?: unknown;
	} | null;
}

function parseWindow(label: string, raw: unknown): UsageWindow | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const window = raw as AnthropicUsageWindow;
	const usedPercent = toNumber(window.utilization);
	if (usedPercent === undefined) return undefined;
	return { label, usedPercent, resetsAt: parseTimestamp(window.resets_at) };
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
		if (windows.length === 0) {
			throw new Error("Claude usage API returned no usage windows");
		}
		const notes: string[] = [];
		const extra = usage.extra_usage;
		const monthlyLimit = toNumber(extra?.monthly_limit);
		const usedCredits = toNumber(extra?.used_credits);
		if (extra?.is_enabled === true && monthlyLimit !== undefined) {
			const used = usedCredits !== undefined ? ` ${usedCredits}` : "";
			notes.push(`extra usage:${used} of ${monthlyLimit}`);
		}
		return { providerId: "anthropic", label: "Claude", windows, notes, fetchedAt: Date.now() };
	},
};
