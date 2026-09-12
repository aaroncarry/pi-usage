/**
 * BalanceService: resolves credentials, runs provider adapters, caches
 * snapshots with a TTL, dedupes concurrent fetches, and runs the background
 * refresh timer for one session.
 */

import { intervalMs, type BalanceConfig, type ProviderConfig, loadBalanceConfig } from "./config.ts";
import {
	readStoredCredential,
	readStoredCredentialIds,
	resolveProviderToken,
} from "./credentials.ts";
import { getBuiltinAdapters } from "./providers/index.ts";
import { createAutoDetectAdapter } from "./providers/auto-detect.ts";
import { createCustomAdapter } from "./providers/custom.ts";
import type { AccountBalance, CredentialResolver, FetchLike, ProviderAdapter, ResolvedCredential } from "./types.ts";

export interface BalanceServiceOptions {
	agentDir: string;
	config?: BalanceConfig;
	fetchImpl?: FetchLike;
	/** Extra/override adapters, mainly for tests. */
	adapters?: ProviderAdapter[];
}

function toErrorMessage(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	let message = error.message || error.name;
	let cause: unknown = error.cause;
	for (let depth = 0; depth < 3 && cause !== undefined && cause !== null; depth++) {
		const causeText = describeCause(cause);
		if (!causeText || message.includes(causeText)) break;
		message = `${message} (${causeText})`;
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return message;
}

function describeCause(cause: unknown): string {
	if (cause instanceof Error) {
		if (cause.message) return cause.message;
		const code = (cause as Error & { code?: unknown }).code;
		if (typeof code === "string") return code;
		const errors = (cause as Error & { errors?: unknown }).errors;
		if (Array.isArray(errors)) {
			const nested = errors.map(describeCause).filter(Boolean).join(", ");
			if (nested) return nested;
		}
		return cause.name;
	}
	return typeof cause === "string" ? cause : "";
}

export class BalanceService {
	readonly config: BalanceConfig;
	private readonly agentDir: string;
	private readonly fetchImpl: FetchLike;
	private readonly adapters: Map<string, ProviderAdapter>;
	private readonly autoAdapters = new Map<string, ProviderAdapter>();
	private credentialResolver: CredentialResolver | undefined;
	private readonly balances = new Map<string, AccountBalance>();
	private readonly lastFetched = new Map<string, number>();
	private readonly inflight = new Map<string, Promise<AccountBalance>>();
	private readonly listeners = new Set<() => void>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: BalanceServiceOptions) {
		this.agentDir = options.agentDir;
		this.config = options.config ?? loadBalanceConfig(options.agentDir);
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		this.adapters = new Map(getBuiltinAdapters().map((adapter) => [adapter.id, adapter]));
		for (const adapter of options.adapters ?? []) {
			this.adapters.set(adapter.id, adapter);
		}
	}

	/** Wire the live credential resolver (pi's modelRegistry-backed lookup). */
	setCredentialResolver(resolver: CredentialResolver | undefined): void {
		this.credentialResolver = resolver;
	}

	/** Subscribe to cache changes (any fetch finishing). Returns unsubscribe. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Provider ids that should be displayed: built-in adapters with a stored
	 * credential, every remaining auth.json credential when auto-detection is
	 * on, and explicitly configured custom adapters.
	 */
	listConfiguredProviderIds(): string[] {
		const ids: string[] = [];
		const configured = this.config.providers ?? {};
		const autoDetect = this.config.autoDetect !== false;
		for (const id of this.adapters.keys()) {
			if (configured[id]?.enabled === false) continue;
			if (readStoredCredential(this.agentDir, id)) ids.push(id);
		}
		if (autoDetect) {
			for (const id of readStoredCredentialIds(this.agentDir)) {
				if (this.adapters.has(id) || ids.includes(id)) continue;
				if (configured[id]?.enabled === false) continue;
				ids.push(id);
			}
		}
		for (const [id, entry] of Object.entries(configured)) {
			if (entry.enabled === false) continue;
			if (this.adapters.has(id) || ids.includes(id) || !entry.custom?.url) continue;
			ids.push(id);
		}
		return ids;
	}

	get(providerId: string): AccountBalance | undefined {
		return this.balances.get(providerId);
	}

	/** Best display name before the first fetch lands: config label → adapter label → id. */
	labelFor(providerId: string): string {
		return this.config.providers?.[providerId]?.label ?? this.adapterFor(providerId)?.label ?? providerId;
	}

	/** Cached snapshots for all configured providers (missing ones omitted). */
	getAll(): AccountBalance[] {
		return this.listConfiguredProviderIds()
			.map((id) => this.balances.get(id))
			.filter((balance): balance is AccountBalance => balance !== undefined);
	}

	/** Fetch (or return cached) balance for one provider. Never rejects. */
	async refresh(providerId: string, options?: { force?: boolean; signal?: AbortSignal }): Promise<AccountBalance> {
		const cached = this.balances.get(providerId);
		const last = this.lastFetched.get(providerId);
		// Failed snapshots never satisfy the TTL: transient network errors must
		// be retried on the next refresh instead of being served for 5 minutes.
		if (!options?.force && cached && !cached.error && last !== undefined && Date.now() - last < intervalMs(this.config)) {
			return cached;
		}
		const pending = this.inflight.get(providerId);
		if (pending) return pending;
		const task = this.fetchBalance(providerId, options?.signal).finally(() => {
			this.inflight.delete(providerId);
		});
		this.inflight.set(providerId, task);
		return task;
	}

	/** Refresh every configured provider in parallel. Never rejects. */
	async refreshAll(options?: { force?: boolean; signal?: AbortSignal }): Promise<AccountBalance[]> {
		return Promise.all(this.listConfiguredProviderIds().map((id) => this.refresh(id, options)));
	}

	/** Start the background refresh timer and kick off an initial fetch. */
	start(): void {
		if (this.timer) return;
		void this.refreshAll();
		this.timer = setInterval(() => {
			void this.refreshAll();
		}, intervalMs(this.config));
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private adapterFor(providerId: string): ProviderAdapter | undefined {
		const known = this.adapters.get(providerId);
		if (known) return known;
		const entry = this.config.providers?.[providerId];
		if (entry?.custom?.url) {
			return createCustomAdapter(providerId, entry.custom, entry.label ?? providerId);
		}
		if (this.config.autoDetect !== false) {
			let adapter = this.autoAdapters.get(providerId);
			if (!adapter) {
				adapter = createAutoDetectAdapter(providerId);
				this.autoAdapters.set(providerId, adapter);
			}
			return adapter;
		}
		return undefined;
	}

	private async fetchBalance(providerId: string, signal?: AbortSignal): Promise<AccountBalance> {
		const adapter = this.adapterFor(providerId);
		let balance: AccountBalance;
		if (!adapter) {
			balance = {
				providerId,
				label: providerId,
				windows: [],
				notes: [],
				error: `Unknown provider "${providerId}"`,
				fetchedAt: Date.now(),
			};
		} else {
			balance = await this.runAdapter(providerId, adapter, signal);
		}
		const labelOverride = this.config.providers?.[providerId]?.label;
		if (labelOverride) balance = { ...balance, label: labelOverride };
		this.balances.set(providerId, balance);
		this.lastFetched.set(providerId, Date.now());
		this.notifyListeners();
		return balance;
	}

	private async runAdapter(
		providerId: string,
		adapter: ProviderAdapter,
		signal?: AbortSignal,
	): Promise<AccountBalance> {
		try {
			const resolved = await this.resolveRunCredential(providerId);
			const options: ProviderConfig = this.config.providers?.[providerId] ?? {};
			return await adapter.fetch({
				token: resolved.token,
				baseUrl: resolved.baseUrl,
				signal,
				fetchImpl: this.fetchImpl,
				options,
			});
		} catch (error) {
			return {
				providerId,
				label: adapter.label,
				windows: [],
				notes: [],
				error: toErrorMessage(error),
				fetchedAt: Date.now(),
			};
		}
	}

	/**
	 * Token plus base URL for one fetch. Registry-backed resolution runs first
	 * (it refreshes OAuth tokens); auth.json is the fallback. Custom providers
	 * without a stored credential get an empty token — they authenticate via
	 * their own configured headers.
	 */
	private async resolveRunCredential(providerId: string): Promise<ResolvedCredential> {
		const stored = readStoredCredential(this.agentDir, providerId);
		if (!stored) {
			if (this.credentialResolver) {
				return this.credentialResolver(providerId).catch(() => ({ token: "" }));
			}
			return { token: "" };
		}
		if (this.credentialResolver) {
			try {
				const resolved = await this.credentialResolver(providerId);
				if (resolved.token) return resolved;
			} catch {
				// Registry lookup failed (unknown provider, refresh error); fall back.
			}
		}
		const token = await resolveProviderToken(providerId, undefined, this.agentDir);
		return { token };
	}

	private notifyListeners(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Listener errors must not break refresh bookkeeping.
			}
		}
	}
}
