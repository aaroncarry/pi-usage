/**
 * Shared data model for pi-usage.
 *
 * Every provider adapter normalizes its API responses into `AccountBalance`;
 * the panel and status line render that shape without provider-specific logic.
 */

import type { ProviderConfig } from "./config.ts";

/** One usage window, e.g. a 5-hour or weekly subscription quota window. */
export interface UsageWindow {
	/** Short window label, e.g. "5h", "weekly", "MCP". */
	label: string;
	/** Used fraction in percent (0-100+, values above 100 are clamped when drawn). */
	usedPercent: number;
	/** Epoch milliseconds when the window resets, if the API reports one. */
	resetsAt?: number;
	/** Optional detail such as "880 of 1000 left". */
	detail?: string;
}

/** Monetary balance (prepaid credits, account balance). */
export interface MoneyBalance {
	amount: number;
	/** ISO currency code, e.g. "CNY", "USD". */
	currency: string;
	/** Optional breakdown text, e.g. "recharged ¥118.00 · spent ¥96.54". */
	note?: string;
}

/** Normalized snapshot for one account. */
export interface AccountBalance {
	/** pi provider id, matching the key in auth.json. */
	providerId: string;
	/** Display name, e.g. "Codex". */
	label: string;
	/** Plan name if the API reports one, e.g. "Plus". */
	plan?: string;
	windows: UsageWindow[];
	balance?: MoneyBalance;
	/** Extra single-line facts rendered in the panel. */
	notes: string[];
	/** Fetch/parse failure; when set, windows /usage may be empty. */
	error?: string;
	/** Epoch milliseconds of the fetch attempt. */
	fetchedAt: number;
}

/** Minimal HTTP client interface so adapters can be tested without network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Arguments handed to a provider adapter on each fetch. */
export interface ProviderFetchArgs {
	/**
	 * Resolved bearer token or API key for the provider. Empty for custom
	 * providers without a stored credential; those authenticate via their own
	 * configured headers.
	 */
	token: string;
	/** Account/workspace id used by providers that scope OAuth requests. */
	accountId?: string;
	/** Provider base URL from pi's model registry, when known. */
	baseUrl?: string;
	signal?: AbortSignal;
	fetchImpl: FetchLike;
	/** Per-provider options from usage.json (`providers` section). */
	options: ProviderConfig;
}

/** Normalizes one provider's usage /usage API into an AccountBalance. */
export interface ProviderAdapter {
	/** pi provider id, matching auth.json key / model registry provider id. */
	id: string;
	label: string;
	fetch(args: ProviderFetchArgs): Promise<AccountBalance>;
}

/** Live credential plus the provider base URL (for auto-detection). */
export interface ResolvedCredential {
	token: string;
	accountId?: string;
	baseUrl?: string;
}

/** Resolves the live bearer token/API key (and base URL) for a provider id. */
export type CredentialResolver = (providerId: string) => Promise<ResolvedCredential>;
