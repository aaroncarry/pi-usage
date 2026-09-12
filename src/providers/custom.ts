/**
 * Config-driven generic adapter: reads an arbitrary JSON endpoint and extracts
 * a monetary balance and/or usage windows via dot paths. Used for providers
 * without a built-in adapter (e.g. self-hosted relays).
 */

import type { CustomProviderConfig } from "../config.ts";
import { resolveConfigValue } from "../credentials.ts";
import type { AccountBalance, MoneyBalance, ProviderAdapter, ProviderFetchArgs, UsageWindow } from "../types.ts";

/**
 * Resolve "data.list[0].percent"-style paths. Bracket suffixes index into
 * arrays; missing segments yield undefined.
 */
export function dotPath(root: unknown, path: string): unknown {
	let current: unknown = root;
	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null) return undefined;
		const bracket = /^([^\[\]]+)\[(\d+)\]$/u.exec(segment);
		const container = current as Record<string, unknown>;
		if (bracket) {
			const key = bracket[1];
			const index = bracket[2];
			if (!key || index === undefined) return undefined;
			const array = container[key];
			if (!Array.isArray(array)) return undefined;
			current = array[Number(index)];
			continue;
		}
		current = container[segment];
	}
	return current;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

function toEpoch(value: unknown): number | undefined {
	const number = toNumber(value);
	if (number === undefined) return undefined;
	return number < 1e12 ? number * 1000 : number;
}

function buildHeaders(custom: CustomProviderConfig, token: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(custom.headers ?? {})) {
		// "{token}" pulls in the provider's own auth.json credential, if any.
		const resolved = resolveConfigValue(value.replaceAll("{token}", token));
		if (resolved !== undefined) headers[name] = resolved;
	}
	return headers;
}

export function createCustomAdapter(id: string, custom: CustomProviderConfig, fallbackLabel: string): ProviderAdapter {
	return {
		id,
		label: fallbackLabel,
		async fetch({ token, signal, fetchImpl }: ProviderFetchArgs): Promise<AccountBalance> {
			const response = await fetchImpl(custom.url, {
				method: custom.method ?? "GET",
				headers: { Accept: "application/json", ...buildHeaders(custom, token) },
				signal,
			});
			if (!response.ok) {
				throw new Error(`${id} returned HTTP ${response.status}`);
			}
			const body: unknown = await response.json();
			let balance: MoneyBalance | undefined;
			if (custom.balancePath) {
				const amount = toNumber(dotPath(body, custom.balancePath));
				if (amount !== undefined) balance = { amount, currency: custom.currency ?? "USD" };
			}
			const windows: UsageWindow[] = [];
			if (custom.windowsPath) {
				const rawWindows = dotPath(body, custom.windowsPath);
				if (Array.isArray(rawWindows)) {
					const fields = { label: "label", percent: "percent", resetsAt: "resetsAt", ...custom.windowFields };
					rawWindows.forEach((entry, index) => {
						const percent = toNumber(dotPath(entry, fields.percent ?? "percent"));
						if (percent === undefined) return;
						const label = dotPath(entry, fields.label ?? "label");
						const resetsAt = toEpoch(dotPath(entry, fields.resetsAt ?? "resetsAt"));
						windows.push({
							label: typeof label === "string" && label ? label : `w${index + 1}`,
							usedPercent: percent,
							resetsAt,
						});
					});
				}
			}
			if (!balance && windows.length === 0) {
				throw new Error(`${id}: no balance or windows extracted (check balancePath/windowsPath)`);
			}
			return { providerId: id, label: fallbackLabel, windows, balance, notes: [], fetchedAt: Date.now() };
		},
	};
}
