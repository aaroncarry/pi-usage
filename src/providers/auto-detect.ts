/**
 * Auto-detecting adapter for providers without a built-in one.
 *
 * Approach borrowed from pi-provider-hub: given the provider's base URL,
 * probe well-known relay billing protocols — New API (`/dashboard/billing/*`,
 * the most common self-hosted gateway), Sub2API (`/usage`) — plus hostname
 * pinned endpoints for DeepSeek, MiniMax, and Zhipu (for custom ids pointing
 * at those hosts).
 *
 * The first successful probe pins the winning candidate for the session; an
 * exhausted probe (every candidate rejected terminally, e.g. HTTP 404/401)
 * pins a "not supported" error so probing does not repeat on every refresh.
 * Transient network errors stay unpinned and are retried next time.
 */

import { toNumber } from "../parse.ts";
import type { AccountBalance, ProviderAdapter, ProviderFetchArgs } from "../types.ts";

/** Same-origin URL join: "https://x.com/v1" + "usage" → "https://x.com/v1/usage". */
function resolveSameOriginEndpoint(baseUrl: string, endpoint: string): string {
	return new URL(endpoint.trim(), `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

/** Base URLs to probe: a base with a path is already specific; a bare origin also tries /v1. */
function baseUrlCandidates(baseUrl: string): string[] {
	const parsed = new URL(baseUrl);
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (parsed.pathname !== "" && parsed.pathname !== "/") return [trimmed];
	return [trimmed, `${trimmed}/v1`];
}

interface CandidateContext {
	baseUrl: string;
	token: string;
	signal?: AbortSignal;
	fetchImpl: ProviderFetchArgs["fetchImpl"];
}

type Candidate = {
	name: string;
	run(ctx: CandidateContext): Promise<Omit<AccountBalance, "providerId" | "label" | "fetchedAt">>;
};

async function requestJson(
	url: string,
	token: string,
	fetchImpl: ProviderFetchArgs["fetchImpl"],
	signal: AbortSignal | undefined,
	authorization: "bearer" | "raw" = "bearer",
): Promise<unknown> {
	const response = await fetchImpl(url, {
		headers: {
			Accept: "application/json",
			Authorization: authorization === "bearer" ? `Bearer ${token}` : token,
		},
		signal,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

function numberAt(payload: unknown, ...paths: string[][]): number | undefined {
	for (const path of paths) {
		let current: unknown = payload;
		for (const segment of path) {
			if (typeof current !== "object" || current === null) {
				current = undefined;
				break;
			}
			current = (current as Record<string, unknown>)[segment];
		}
		const value = toNumber(current);
		if (value !== undefined) return value;
	}
	return undefined;
}

function stringAt(payload: unknown, ...paths: string[][]): string | undefined {
	for (const path of paths) {
		let current: unknown = payload;
		for (const segment of path) {
			if (typeof current !== "object" || current === null) {
				current = undefined;
				break;
			}
			current = (current as Record<string, unknown>)[segment];
		}
		if (typeof current === "string" && current.trim() !== "") return current.trim();
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const deepseekCandidate: Candidate = {
	name: "deepseek",
	async run({ baseUrl, token, signal, fetchImpl }) {
		const payload = (await requestJson(resolveSameOriginEndpoint(baseUrl, "user/balance"), token, fetchImpl, signal)) as unknown;
		if (!isRecord(payload) || !Array.isArray(payload.balance_infos)) {
			throw new Error("response has no balance_infos");
		}
		const entries = payload.balance_infos.filter(isRecord);
		const entry =
			entries.find((item) => stringAt(item, ["currency"])?.toUpperCase() === "CNY") ?? entries[0] ?? payload;
		const amount = numberAt(entry, ["total_balance"]);
		if (amount === undefined) throw new Error("response has no total_balance");
		return { balance: { amount, currency: stringAt(entry, ["currency"]) ?? "CNY" }, windows: [], notes: [] };
	},
};

const minimaxCandidate: Candidate = {
	name: "minimax",
	async run({ baseUrl, token, signal, fetchImpl }) {
		let lastError: Error | undefined;
		for (const endpoint of ["v1/token_plan/remains", "v1/api/openplatform/coding_plan/remains"]) {
			try {
				const payload = (await requestJson(resolveSameOriginEndpoint(baseUrl, endpoint), token, fetchImpl, signal)) as unknown;
				const data = isRecord(payload) && isRecord(payload.data) ? payload.data : isRecord(payload) ? payload : {};
				const models = Array.isArray(data.model_remains)
					? data.model_remains.filter(isRecord)
					: [];
				const model =
					models.find((item) => stringAt(item, ["model_name"], ["modelName"])?.toLowerCase().startsWith("minimax-m")) ??
					models[0] ??
					data;
				const total = numberAt(model, ["current_interval_total_count"], ["currentIntervalTotalCount"]);
				const remainingPercent = numberAt(
					model,
					["current_interval_remaining_percent"],
					["currentIntervalRemainingPercent"],
					["remaining_percent"],
					["remainingPercent"],
				);
				const remainingCount = numberAt(
					model,
					["current_interval_remaining"],
					["currentIntervalRemaining"],
					["current_interval_usage_count"],
					["currentIntervalUsageCount"],
				);
				let usedPercent: number | undefined;
				if (remainingPercent !== undefined) usedPercent = 100 - remainingPercent;
				else if (total !== undefined && total > 0 && remainingCount !== undefined) {
					usedPercent = (remainingCount / total) * 100;
				}
				if (usedPercent === undefined) throw new Error("response has no quota fields");
				return {
					windows: [{ label: "plan", usedPercent: Math.max(0, Math.min(100, usedPercent)) }],
					notes: [],
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		}
		throw lastError ?? new Error("endpoints not found");
	},
};

const zhipuCandidate: Candidate = {
	name: "zhipu",
	async run({ baseUrl, token, signal, fetchImpl }) {
		const payload = (await requestJson(
			resolveSameOriginEndpoint(baseUrl, "/api/monitor/usage/quota/limit"),
			token,
			fetchImpl,
			signal,
			"raw",
		)) as unknown;
		const data = isRecord(payload) && isRecord(payload.data) ? payload.data : isRecord(payload) ? payload : {};
		const limits = Array.isArray(data.limits) ? data.limits.filter(isRecord) : [];
		const limit = limits.find((item) => stringAt(item, ["type"])?.toUpperCase() === "TOKENS_LIMIT");
		const usedPercent = numberAt(limit, ["percentage"], ["usedPercentage"]);
		if (usedPercent === undefined) throw new Error("response has no usage percentage");
		return {
			windows: [{ label: "tokens", usedPercent: Math.max(0, Math.min(100, usedPercent)) }],
			notes: [],
		};
	},
};

const newApiCandidate: Candidate = {
	name: "new-api",
	async run({ baseUrl, token, signal, fetchImpl }) {
		let lastError: Error | undefined;
		for (const base of baseUrlCandidates(baseUrl)) {
			try {
				const subscription = (await requestJson(
					resolveSameOriginEndpoint(base, "dashboard/billing/subscription"),
					token,
					fetchImpl,
					signal,
				)) as unknown;
				const usage = (await requestJson(
					resolveSameOriginEndpoint(base, "dashboard/billing/usage"),
					token,
					fetchImpl,
					signal,
				)) as unknown;
				const parsedBase = new URL(base);
				if (parsedBase.pathname.replace(/\/+$/, "") === "/v1") parsedBase.pathname = "/";
				let tokenData: Record<string, unknown> | undefined;
				try {
					const tokenUsage = (await requestJson(
						resolveSameOriginEndpoint(parsedBase.toString(), "/api/usage/token/"),
						token,
						fetchImpl,
						signal,
					)) as unknown;
					tokenData = isRecord(tokenUsage) && isRecord(tokenUsage.data) ? tokenUsage.data : undefined;
				} catch {
					// Optional endpoint; the dashboard pair alone often suffices.
				}
				const rawTotal = numberAt(subscription, ["hard_limit_usd"], ["soft_limit_usd"], ["system_hard_limit_usd"]);
				const dashboardUsed = numberAt(usage, ["total_usage"]);
				const usedFromDashboard = dashboardUsed === undefined ? undefined : dashboardUsed / 100;
				const unlimited = tokenData?.unlimited_quota === true || rawTotal === 100_000_000;
				const tokenTotal = toNumber(tokenData?.total_granted);
				const tokenRemaining = toNumber(tokenData?.total_available);
				const total = tokenTotal ?? (unlimited ? undefined : rawTotal);
				const used =
					tokenTotal !== undefined && tokenRemaining !== undefined
						? Math.max(0, tokenTotal - tokenRemaining)
						: usedFromDashboard;
				const remaining =
					tokenRemaining ?? (total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined);
				if (remaining === undefined && !unlimited) {
					throw new Error("response has no quota values");
				}
				const notes: string[] = [];
				if (unlimited) notes.push("unlimited quota");
				if (used !== undefined && total !== undefined && !unlimited) {
					notes.push(`used $${used.toFixed(2)} of $${total.toFixed(2)}`);
				}
				return { balance: { amount: remaining ?? 0, currency: "USD" }, windows: [], notes };
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		}
		throw lastError ?? new Error("endpoints not found");
	},
};

const sub2apiCandidate: Candidate = {
	name: "sub2api",
	async run({ baseUrl, token, signal, fetchImpl }) {
		let lastError: Error | undefined;
		for (const base of baseUrlCandidates(baseUrl)) {
			try {
				const payload = (await requestJson(resolveSameOriginEndpoint(base, "usage"), token, fetchImpl, signal)) as unknown;
				if (!isRecord(payload)) throw new Error("invalid response");
				const total = numberAt(payload, ["quota", "limit"], ["total"]);
				const used = numberAt(payload, ["quota", "used"], ["used"]);
				const remaining =
					numberAt(payload, ["remaining"], ["balance"], ["quota", "remaining"]) ??
					(total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined);
				if (remaining === undefined) throw new Error("response has no balance");
				const currency = stringAt(payload, ["unit"], ["quota", "unit"]) ?? "USD";
				const notes: string[] = [];
				if (used !== undefined && total !== undefined) notes.push(`used ${used} of ${total}`);
				return { balance: { amount: remaining, currency }, windows: [], notes };
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		}
		throw lastError ?? new Error("endpoint not found");
	},
};

function hostnameCandidates(baseUrl: string): Candidate[] {
	let hostname = "";
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return [newApiCandidate, sub2apiCandidate];
	}
	const candidates: Candidate[] = [];
	if (hostname === "api.deepseek.com") candidates.push(deepseekCandidate);
	if (["api.minimaxi.com", "www.minimaxi.com", "api.minimax.io", "www.minimax.io"].includes(hostname)) {
		candidates.push(minimaxCandidate);
	}
	if (["open.bigmodel.cn", "bigmodel.cn", "api.z.ai", "z.ai"].includes(hostname)) candidates.push(zhipuCandidate);
	candidates.push(newApiCandidate, sub2apiCandidate);
	return candidates;
}

function isTransientError(message: string): boolean {
	return /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|aborted|timed? ?out/i.test(message);
}

/**
 * Build the auto-detecting adapter for one provider id. Detection runs on the
 * first fetch; the winning candidate is pinned for the session, as is an
 * exhausted "not supported" outcome. Transient network errors are not pinned.
 */
export function createAutoDetectAdapter(id: string): ProviderAdapter {
	let winner: Candidate | undefined;
	let pinnedError: string | undefined;

	return {
		id,
		label: id,
		async fetch(args: ProviderFetchArgs): Promise<AccountBalance> {
			if (pinnedError) throw new Error(pinnedError);
			if (!args.baseUrl) {
				throw new Error(`Base URL for "${id}" is unknown; cannot auto-detect a balance endpoint`);
			}
			const context: CandidateContext = {
				baseUrl: args.baseUrl,
				token: args.token,
				signal: args.signal,
				fetchImpl: args.fetchImpl,
			};
			const finalize = (balance: Omit<AccountBalance, "providerId" | "label" | "fetchedAt">): AccountBalance => ({
				...balance,
				providerId: id,
				label: id,
				fetchedAt: Date.now(),
			});
			if (winner) {
				return finalize(await winner.run(context));
			}
			const errors: string[] = [];
			let sawTransient = false;
			for (const candidate of hostnameCandidates(args.baseUrl)) {
				try {
					const balance = await candidate.run(context);
					winner = candidate;
					return finalize(balance);
				} catch (error) {
					if (args.signal?.aborted) throw error;
					const message = error instanceof Error ? error.message : String(error);
					if (isTransientError(message)) sawTransient = true;
					errors.push(`${candidate.name}: ${message}`);
				}
			}
			const summary = `no balance endpoint detected (${errors.join("; ")})`;
			if (!sawTransient) pinnedError = summary;
			throw new Error(summary);
		},
	};
}
