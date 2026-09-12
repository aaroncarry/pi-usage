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
	percent_remaining?: unknown;
	unlimited?: unknown;
}

interface CopilotUsageResponse {
	quota_snapshots?: unknown;
	copilot_plan?: unknown;
	quota_reset_date?: unknown;
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
	if (snapshot.unlimited === true) {
		return { label, usedPercent: 0, detail: "unlimited" };
	}
	const percentRemaining = toNumber(snapshot.percent_remaining);
	if (percentRemaining === undefined) return undefined;
	const entitlement = toNumber(snapshot.entitlement);
	const remaining = toNumber(snapshot.remaining);
	// Placeholder shape: GitHub reports all-zero rows for token-based billing
	// and some business seats; they carry no usable quota signal.
	if (entitlement === 0 && remaining === 0) return undefined;
	return { label, usedPercent: Math.max(0, 100 - percentRemaining) };
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
		if (typeof usage.quota_snapshots !== "object" || usage.quota_snapshots === null) {
			throw new Error("Copilot usage API returned no quota snapshots");
		}
		const snapshots = usage.quota_snapshots as Record<string, unknown>;
		const windows = Object.entries(snapshots)
			.map(([key, value]) => parseSnapshot(key, value))
			.filter((window): window is UsageWindow => window !== undefined);
		if (windows.length === 0) {
			throw new Error("Copilot usage API returned no usable quota snapshots");
		}
		const planRaw = typeof usage.copilot_plan === "string" ? usage.copilot_plan : undefined;
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
		return { providerId: "github-copilot", label: "Copilot", plan, windows, notes: [], fetchedAt: Date.now() };
	},
};
