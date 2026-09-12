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
import { sumSessionUsage, type SessionUsageTotals } from "./session-usage.ts";
import { BalanceService } from "./service.ts";
import { buildUsageCard, type UsageCardData } from "./ui/card.ts";
import { formatStatusLine } from "./ui/statusline.ts";
import type { AuthResolver } from "./types.ts";

const USAGE_ENTRY_TYPE = "usage-report";
/** Bound /usage fetches so a hanging provider API cannot stall the command. */
const USAGE_FETCH_TIMEOUT_MS = 15_000;

const STATUS_MODES = ["active", "all", "off"] as const;

function isStatusMode(value: string): value is StatusMode {
	return (STATUS_MODES as readonly string[]).includes(value);
}

export default function (pi: ExtensionAPI) {
	let service: BalanceService | undefined;
	let ui: ExtensionUIContext | undefined;
	let activeProviderId: string | undefined;
	let consumption: SessionUsageTotals | undefined;
	/** `/usage <mode>` override for this session; wins over flag and usage.json. */
	let statusOverride: StatusMode | undefined;
	/** `--usage-status` CLI flag; wins over usage.json. */
	let flagStatus: StatusMode | undefined;

	pi.registerFlag("usage-status", {
		description: "Footer status line mode: active | all | off (overrides usage.json)",
		type: "string",
	});

	function authResolverFor(ctx: ExtensionContext): AuthResolver {
		return async (providerId) => {
			const auth = await ctx.modelRegistry.getProviderAuth(providerId);
			if (!auth) {
				// Unknown to the registry: let the caller fall back to auth.json.
				throw new Error(`Provider "${providerId}" not found in model registry`);
			}
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
				if (typeof value === "string") headers[name] = value;
			}
			const token = tokenFromRegistryAuth({ auth: { apiKey: auth.auth.apiKey, headers } });
			if (!token) throw new Error(`No usable credential for "${providerId}"`);
			return token;
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
		});
		ui.setStatus("usage", text);
	}

	function ensureService(ctx: ExtensionContext): BalanceService {
		if (service) return service;
		const agentDir = getAgentDir();
		const next = new BalanceService({ agentDir, config: loadBalanceConfig(agentDir) });
		next.setAuthResolver(authResolverFor(ctx));
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
		return buildUsageCard(data, theme);
	});

	pi.registerCommand("usage", {
		description: "Show usage card, or set the footer status line mode",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const matches = STATUS_MODES.filter((mode) => mode.startsWith(prefix.toLowerCase()));
			return matches.length > 0 ? matches.map((mode) => ({ value: mode, label: mode })) : null;
		},
		handler: async (args, ctx) => {
			const argument = args?.trim().toLowerCase();
			if (!argument) {
				const current = ensureService(ctx);
				await current.refreshAll({ signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS) });
				pi.appendEntry(USAGE_ENTRY_TYPE, {
					balances: current.getAll(),
					activeProviderId,
					generatedAt: Date.now(),
				});
				return;
			}
			if (!isStatusMode(argument)) {
				ctx.ui.notify(`/usage: unknown mode "${argument}" — use active, all, or off`, "warning");
				return;
			}
			statusOverride = argument;
			saveStatusMode(getAgentDir(), argument);
			updateStatus();
			ctx.ui.notify(`Footer status line: ${argument} (saved to usage.json)`, "info");
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
		next.setAuthResolver(authResolverFor(ctx));
		next.onChange(updateStatus);
		service?.stop();
		service = next;
		ui = ctx.ui;
		activeProviderId = ctx.model?.provider;
		consumption = sumSessionUsage(ctx.sessionManager.getEntries());
		next.start();
		updateStatus();
	});

	// Session tokens/cost are local data: refresh immediately after every turn
	// instead of waiting for the provider quota polling cycle.
	pi.on("turn_end", async (_event, ctx) => {
		consumption = sumSessionUsage(ctx.sessionManager.getEntries());
		updateStatus();
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
	});
}
