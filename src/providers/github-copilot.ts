/**
 * GitHub Copilot adapter.
 *
 * Query method borrowed from CodexBar: the GitHub OAuth token stored by pi
 * (k Copilot's device-flow login) is accepted directly by the internal user
 * endpoint, no Copilot token exchange needed.
 */

import { parseTimestamp, toNumber } from "../parse.ts";
import type { AccountBalance, ProviderAdapter, ProviderFetchArgs, UsageWindow } from "../types.ts";

const ENDPOINT = "https://github.com/copilot_internal/user";

const REQUEST_HEADERS = {
	Accept: "application/json",
	"Editor-Version": "vscode/1.96.2",
	"Editor-Plugin-Version": "copilot-chat/0.26.7",
	"X-Github-Api-Version": "2025-04-01",
} as const;

interface CopilotSnapshot {
	entitlement?: unknown;
	remaining?: unknown;
	quota_remaining?: unknown;
	percent_remaining?: unknown;
	credits_used?: unknown;
	overage_count?: unknown;
	token_based_billing?: unknown;
	unlimited?: unknown;
}

interface CopilotUsageResponse {
	quota_snapshots?: unknown;
	limited_user_quotas?: unknown;
	monthly_quotas?: unknown;
	copilot_plan?: unknown;
	access_type_sku?: unknown;
	login?: unknown;
	quota_reset_date?: unknown;
	quota_reset_date_utc?: unknown;
	limited_user_reset_date?: unknown;
}

/** Short display labels for the known snapshot keys. */
const SNAPSHOT_LABELS: Record<string, string> = {
	premium_interactions: "premium",
	chat: "chat",
	embeddings: "embeddings",
};

function snapshotLabel(key: string): string {
	return SNAPSHOT_LABELS[key] ?? key.replaceAll("_", " ");
}

function parseSnapshot(key: string, raw: unknown): UsageWindow | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const snapshot = raw as CopilotSnapshot;
	const label = snapshotLabel(key);
	if (snapshot.unlimited === true) return { label, usedPercent: 0, detail: "unlimited" };
	if (snapshot.token_based_billing === true) {
		const entitlement = toNumber(snapshot.entitlement);
		const remaining = toNumber(snapshot.quota_remaining) ?? toNumber(snapshot.remaining);
		const used = toNumber(snapshot.credits_used) ?? (entitlement !== undefined && remaining !== undefined ? entitlement - remaining : undefined);
		if (entitlement === undefined || entitlement <= 0 || remaining === undefined || used === undefined) return undefined;
		if (remaining < 0 || used < 0 || used > entitlement) return undefined;
		return { label: "AI credits", usedPercent: Math.min(100, used / entitlement * 100), detail: `${remaining} of ${entitlement} left` };
	}
	const percentRemaining = toNumber(snapshot.percent_remaining);
	if (percentRemaining === undefined) return undefined;
	const entitlement = toNumber(snapshot.entitlement);
	const remaining = toNumber(snapshot.remaining);
	// Placeholder shape: GitHub reports all-zero rows for token-based billing
	// and some business seats; they carry no usable quota signal.
	if (entitlement === 0 && remaining === 0) return undefined;
	return { label, usedPercent: Math.max(0, Math.min(100, 100 - percentRemaining)) };
}

export const githubCopilotAdapter: ProviderAdapter = {
	id: "github-copilot",
	label: "Copilot",
	async fetch({ token, signal, fetchImpl }: ProviderFetchArgs): Promise<AccountBalance> {
		const response = await fetchImpl(ENDPOINT, {
			headers: { Authorization: `token ${token}`, ...REQUEST_HEADERS },
			signal,
		});
		if (!response.ok) {
			throw new Error(`Copilot usage API returned HTTP ${response.status}`);
		}
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) {
			throw new Error("Copilot usage API returned an unexpected response");
		}
		const usage = body as CopilotUsageResponse;
		const snapshots = typeof usage.quota_snapshots === "object" && usage.quota_snapshots !== null
			? usage.quota_snapshots as Record<string, unknown>
			: undefined;
		const windows = snapshots
			? Object.entries(snapshots)
				.map(([key, value]) => parseSnapshot(key, value))
				.filter((window): window is UsageWindow => window !== undefined)
			: [];
		const limited = typeof usage.limited_user_quotas === "object" && usage.limited_user_quotas !== null
			? usage.limited_user_quotas as Record<string, unknown>
			: undefined;
		const monthly = typeof usage.monthly_quotas === "object" && usage.monthly_quotas !== null
			? usage.monthly_quotas as Record<string, unknown>
			: undefined;
		if (windows.length === 0) {
			const remaining = toNumber(limited?.chat);
			const entitlement = toNumber(monthly?.chat);
			if (remaining !== undefined && entitlement !== undefined && entitlement > 0 && remaining >= 0 && remaining <= entitlement) {
				windows.push({ label: "chat", usedPercent: (entitlement - remaining) / entitlement * 100, detail: `${remaining} of ${entitlement} left` });
			}
		}
		if (windows.length === 0) throw new Error("Copilot usage API returned no usable quota data");
		const planRaw = typeof usage.copilot_plan === "string" ? usage.copilot_plan : typeof usage.access_type_sku === "string" ? usage.access_type_sku : undefined;
		const plan = planRaw
			? planRaw
					.split("_")
					.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
					.join(" ")
			: undefined;
		const quotaResetDate = parseTimestamp(usage.quota_reset_date);
		for (const window of windows) {
			window.resetsAt ??= quotaResetDate;
		}
		const notes: string[] = [];
		const overage = snapshots?.premium_interactions && typeof snapshots.premium_interactions === "object"
			? toNumber((snapshots.premium_interactions as CopilotSnapshot).overage_count)
			: undefined;
		if (overage !== undefined && overage > 0) notes.push(`additional usage ${overage}`);
		return { providerId: "github-copilot", label: "Copilot", plan, windows, notes, fetchedAt: Date.now() };
	},
};
