/**
 * pi-usage extension entry point.
 *
 * Registers the /usage command (prints an inline usage card into the session),
 * keeps a footer status line updated with the active account's quota plus
 * session consumption, and runs a session-scoped background refresh.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isRecord, loadBalanceConfig, saveStatusMode, type StatusMode } from "./config.ts";
import { getAgentDir, tokenFromRegistryAuth } from "./credentials.ts";
import { sumSessionUsage, formatTokens, type SessionUsageTotals } from "./session-usage.ts";
import {
	annotateModelLabels,
	collectTrends,
	dailyTotals,
	distributionRows,
	type TrendsData,
} from "./trends/aggregate.ts";
import { TrendsDashboard } from "./trends/dashboard.ts";
import { sparklineString } from "./trends/render.ts";
import { BalanceService } from "./service.ts";
import { buildUsageCard, type CardTrendsSummary, type UsageCardData } from "./ui/card.ts";
import { formatStatusLine } from "./ui/statusline.ts";
import type { CredentialResolver } from "./types.ts";

const USAGE_ENTRY_TYPE = "usage-report";
/** Bound /usage fetches so a hanging provider API cannot stall the command. */
const USAGE_FETCH_TIMEOUT_MS = 15_000;
/** Trends scans are cached in memory briefly so card/dashboard/sparkline share one scan. */
const TRENDS_TTL_MS = 60_000;

const STATUS_MODES = ["active", "all", "off"] as const;

function isStatusMode(value: string): value is StatusMode {
	return (STATUS_MODES as readonly string[]).includes(value);
}

export default function (pi: ExtensionAPI) {
	let service: BalanceService | undefined;
	let ui: ExtensionUIContext | undefined;
	let activeProviderId: string | undefined;
	let consumption: SessionUsageTotals | undefined;
	let trendsCache: { data: TrendsData; at: number } | undefined;
	let sparkline: string | undefined;
	/** `/usage <mode>` override for this session; wins over flag and usage.json. */
	let statusOverride: StatusMode | undefined;
	/** `--usage-status` CLI flag; wins over usage.json. */
	let flagStatus: StatusMode | undefined;

	pi.registerFlag("usage-status", {
		description: "Footer status line mode: active | all | off (overrides usage.json)",
		type: "string",
	});

	/**
	 * Registry-backed credential resolution: the token comes from
	 * getProviderAuth (which refreshes OAuth tokens before expiry), the base
	 * URL from the registered provider — the auto-detect adapter needs it to
	 * probe relay billing endpoints. Throwing sends the caller to the
	 * auth.json fallback.
	 */
	function credentialResolverFor(ctx: ExtensionContext): CredentialResolver {
		return async (providerId) => {
			const baseUrl = ctx.modelRegistry.getProvider(providerId)?.baseUrl;
			const auth = await ctx.modelRegistry.getProviderAuth(providerId).catch(() => undefined);
			if (!auth) {
				throw new Error(`Provider "${providerId}" not found in model registry`);
			}
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
				if (typeof value === "string") headers[name] = value;
			}
			const token = tokenFromRegistryAuth({ auth: { apiKey: auth.auth.apiKey, headers } });
			if (!token) throw new Error(`No usable credential for "${providerId}"`);
			const accountId = Object.entries(headers).find(
				([name, value]) => name.toLowerCase() === "chatgpt-account-id" && value.trim().length > 0,
			)?.[1];
			return { token, baseUrl, accountId };
		};
	}

	function updateStatus(): void {
		if (!service || !ui) return;
		const mode = statusOverride ?? flagStatus ?? service.config.status ?? "active";
		const text = formatStatusLine({
			balances: service.getAll(),
			mode,
			activeProviderId,
			theme: ui.theme,
			consumption,
			sparkline,
		});
		ui.setStatus("usage", text);
	}

	function ensureService(ctx: ExtensionContext): BalanceService {
		if (service) return service;
		const agentDir = getAgentDir();
		const next = new BalanceService({ agentDir, config: loadBalanceConfig(agentDir) });
		next.setCredentialResolver(credentialResolverFor(ctx));
		service = next;
		return next;
	}

	pi.registerEntryRenderer(USAGE_ENTRY_TYPE, (entry, _options, theme) => {
		if (!isRecord(entry.data) || !Array.isArray(entry.data.balances)) {
			return buildUsageCard({ balances: [], generatedAt: Date.now() }, theme);
		}
		const data: UsageCardData = {
			balances: entry.data.balances as UsageCardData["balances"],
			activeProviderId: typeof entry.data.activeProviderId === "string" ? entry.data.activeProviderId : undefined,
			generatedAt: typeof entry.data.generatedAt === "number" ? entry.data.generatedAt : Date.now(),
		};
		if (isRecord(entry.data.trends)) {
			const raw = entry.data.trends;
			const rawDays = raw.days;
			const rawModels = raw.models;
			if (
				Array.isArray(rawDays) &&
				typeof raw.endsAt === "number" &&
				typeof raw.total === "number" &&
				typeof raw.cost === "number" &&
				Array.isArray(rawModels)
			) {
				data.trends = {
					days: rawDays.filter((value): value is number => typeof value === "number"),
					endsAt: raw.endsAt,
					total: raw.total,
					cost: raw.cost,
					models: rawModels.filter(
						(model): model is { label: string; tokens: number } =>
							isRecord(model) && typeof model.label === "string" && typeof model.tokens === "number",
					),
				};
			}
		}
		return buildUsageCard(data, theme);
	});

	/** Session trends with a small TTL so card, dashboard and sparkline share one scan. */
	async function getTrends(signal?: AbortSignal): Promise<TrendsData> {
		if (trendsCache && Date.now() - trendsCache.at < TRENDS_TTL_MS) return trendsCache.data;
		const data = await collectTrends(getAgentDir(), { signal });
		trendsCache = { data, at: Date.now() };
		return data;
	}

	function costTotal(data: TrendsData, fromMs?: number): number {
		return distributionRows(data, fromMs).reduce((total, row) => total + row.cost, 0);
	}

	/** 30-day summary embedded in the /usage card. */
	async function cardTrendsSummary(): Promise<CardTrendsSummary | undefined> {
		try {
			const data = await getTrends();
			const now = Date.now();
			const from = now - 30 * 86_400_000;
			const days = dailyTotals(data, "tokens", from);
			const todayStart = new Date(now).setHours(0, 0, 0, 0);
			const byDay = new Map(days.map((entry) => [entry.dayStart, entry.value]));
			const aligned: number[] = [];
			for (let index = 29; index >= 0; index--) {
				aligned.push(byDay.get(todayStart - index * 86_400_000) ?? 0);
			}
			const models = annotateModelLabels(distributionRows(data, from))
				.filter((row) => row.model !== "summaries")
				.slice(0, 3)
				.map((row) => ({ label: row.label, tokens: row.tokens }));
			return {
				days: aligned,
				endsAt: todayStart,
				total: aligned.reduce((total, value) => total + value, 0),
				cost: costTotal(data, from),
				models,
			};
		} catch {
			return undefined;
		}
	}

	/** Refresh the 7-day status-line sparkline once trends data is available. */
	function refreshSparkline(): void {
		if (!service || service.config.sparkline === false) return;
		void getTrends()
			.then((data) => {
				const now = Date.now();
				const days = dailyTotals(data, "tokens", now - 7 * 86_400_000);
				const todayStart = new Date(now).setHours(0, 0, 0, 0);
				const byDay = new Map(days.map((entry) => [entry.dayStart, entry.value]));
				const aligned: number[] = [];
				for (let index = 6; index >= 0; index--) {
					aligned.push(byDay.get(todayStart - index * 86_400_000) ?? 0);
				}
				sparkline = sparklineString(aligned);
				updateStatus();
			})
			.catch(() => undefined);
	}

	/** Open the interactive trends dashboard. */
	async function openTrendsDashboard(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/trends requires interactive mode", "warning");
			return;
		}
		ensureService(ctx);
		await ctx.ui.custom<undefined>((_tui, theme, _keybindings, done) => {
			return new TrendsDashboard({ theme, done, data: getTrends() });
		}, {
			overlay: true,
			overlayOptions: { width: "85%", maxHeight: "92%", anchor: "center" },
		});
	}

	pi.registerCommand("usage", {
		description: "Show usage card, open the trends dashboard, or set the footer status line mode",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const options: AutocompleteItem[] = [
				{ value: "trends", label: "trends", description: "Open the interactive trends dashboard" },
				{ value: "active", label: "active", description: "Footer: current account + session usage (default)" },
				{ value: "all", label: "all", description: "Footer: all accounts on one line" },
				{ value: "off", label: "off", description: "Footer: hide the status line" },
			];
			const matches = options.filter((option) => option.value.startsWith(prefix.toLowerCase()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const argument = args?.trim().toLowerCase();
			if (!argument) {
				const current = ensureService(ctx);
				await current.refreshAll({ signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS) });
				const trends = await cardTrendsSummary();
				pi.appendEntry(USAGE_ENTRY_TYPE, {
					balances: current.getAll(),
					activeProviderId,
					generatedAt: Date.now(),
					trends,
				});
				return;
			}
			if (argument === "trends") {
				await openTrendsDashboard(ctx);
				return;
			}
			if (!isStatusMode(argument)) {
				ctx.ui.notify(`/usage: unknown argument "${argument}" — use trends, active, all, or off`, "warning");
				return;
			}
			statusOverride = argument;
			saveStatusMode(getAgentDir(), argument);
			updateStatus();
			ctx.ui.notify(`Footer status line: ${argument} (saved to usage.json)`, "info");
		},
	});

	// First-class command so new users discover the dashboard without knowing
	// about the two-stage "/usage <space> trends" argument completion.
	pi.registerCommand("trends", {
		description: "Open the usage trends dashboard (charts, heatmap, table, insights)",
		handler: async (_args, ctx) => {
			await openTrendsDashboard(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Session replacement tears the old service down via session_shutdown;
		// build a fresh one bound to the new session context.
		const cliFlag = pi.getFlag("usage-status");
		flagStatus = typeof cliFlag === "string" && isStatusMode(cliFlag) ? cliFlag : undefined;
		statusOverride = undefined;
		const agentDir = getAgentDir();
		const next = new BalanceService({ agentDir, config: loadBalanceConfig(agentDir) });
		next.setCredentialResolver(credentialResolverFor(ctx));
		next.onChange(updateStatus);
		service?.stop();
		service = next;
		ui = ctx.ui;
		activeProviderId = ctx.model?.provider;
		consumption = sumSessionUsage(ctx.sessionManager.getEntries());
		next.start();
		updateStatus();
		refreshSparkline();
	});

	// Session tokens/cost are local data: refresh immediately after every turn
	// instead of waiting for the provider quota polling cycle. The sparkline's
	// today-bucket moves too; getTrends' TTL keeps this cheap.
	pi.on("turn_end", async (_event, ctx) => {
		consumption = sumSessionUsage(ctx.sessionManager.getEntries());
		updateStatus();
		refreshSparkline();
	});

	pi.on("model_select", async (event) => {
		activeProviderId = event.model.provider;
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		service?.stop();
		service = undefined;
		ui = undefined;
		consumption = undefined;
		sparkline = undefined;
	});
}
