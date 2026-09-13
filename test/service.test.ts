import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BalanceService } from "../src/service.ts";
import { loadBalanceConfig, saveStatusMode } from "../src/config.ts";
import { formatStatusLine, type ThemeLike } from "../src/ui/statusline.ts";
import { buildUsageCard } from "../src/ui/card.ts";
import { formatTokens, sumSessionUsage } from "../src/session-usage.ts";
import type { AccountBalance, FetchLike } from "../src/types.ts";

const PLAIN_THEME: ThemeLike = {
	fg: (_color, text) => text,
	bold: (text) => text,
	bg: (_color, text) => text,
};

class ScriptedFetch {
	readonly urls: string[] = [];
	private readonly handlers: { prefix: string; respond: () => Response }[];

	constructor(handlers: { prefix: string; respond: () => Response }[]) {
		this.handlers = handlers;
	}

	get fetchImpl(): FetchLike {
		return async (url: string) => {
			this.urls.push(url);
			const handler = this.handlers.find((entry) => url.startsWith(entry.prefix));
			if (!handler) throw new Error(`unexpected fetch: ${url}`);
			return handler.respond();
		};
	}
}

function makeAgentDir(authJson: unknown, balanceJson: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-usage-svc-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify(authJson));
	writeFileSync(join(dir, "usage.json"), JSON.stringify(balanceJson));
	return dir;
}

test("BalanceService refreshes, caches, dedupes, and overrides labels", async () => {
	const agentDir = makeAgentDir(
		{ deepseek: { type: "api_key", key: "sk-test" } },
		{ providers: { deepseek: { label: "DeepSeek Platform" } } },
	);
	try {
		const scripted = new ScriptedFetch([
			{
				prefix: "https://api.deepseek.com/user/balance",
				respond: () =>
					new Response(
						JSON.stringify({
							is_available: true,
							balance_infos: [{ currency: "CNY", total_balance: "38.48" }],
						}),
						{ status: 200 },
					),
			},
		]);
		const service = new BalanceService({ agentDir, fetchImpl: scripted.fetchImpl });
		assert.deepEqual(service.listConfiguredProviderIds(), ["deepseek"]);

		let changes = 0;
		service.onChange(() => {
			changes += 1;
		});

		const balance = await service.refresh("deepseek");
		assert.equal(balance.label, "DeepSeek Platform", "config label overrides adapter label");
		assert.equal(balance.balance?.amount, 38.48);
		assert.equal(changes, 1);

		await service.refresh("deepseek");
		assert.equal(scripted.urls.length, 1, "second refresh within TTL must be cached");

		const forced = await service.refresh("deepseek", { force: true });
		assert.equal(forced.balance?.amount, 38.48);
		assert.equal(scripted.urls.length, 2, "force refresh bypasses TTL");
		assert.equal(changes, 2);
		assert.equal(service.get("deepseek")?.fetchedAt, forced.fetchedAt);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("BalanceService surfaces credential errors and supports custom adapters", async () => {
	const agentDir = makeAgentDir(
		{ "openai-codex": { type: "oauth", access: "stale", expires: Date.now() - 1000 } },
		{
			providers: {
				lingsuan: {
					custom: { url: "https://relay.example/api", balancePath: "data.amount", currency: "CNY" },
				},
			},
		},
	);
	try {
		const scripted = new ScriptedFetch([
			{
				prefix: "https://relay.example/api",
				respond: () => new Response(JSON.stringify({ data: { amount: 5 } }), { status: 200 }),
			},
		]);
		const service = new BalanceService({ agentDir, fetchImpl: scripted.fetchImpl });
		assert.deepEqual(service.listConfiguredProviderIds().sort(), ["lingsuan", "openai-codex"]);

		const custom = await service.refresh("lingsuan");
		assert.equal(custom.balance?.amount, 5);
		assert.equal(scripted.urls.length, 1);

		const expired = await service.refresh("openai-codex");
		assert.match(expired.error ?? "", /expired/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("loadBalanceConfig ignores invalid files and keeps valid fields", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-usage-cfg-"));
	try {
		writeFileSync(join(dir, "usage.json"), "{ not json");
		assert.deepEqual(loadBalanceConfig(dir), {});

		writeFileSync(
			join(dir, "usage.json"),
			JSON.stringify({ intervalMinutes: 3, status: "all", providers: { zai: { region: "cn" } } }),
		);
		assert.deepEqual(loadBalanceConfig(dir), {
			intervalMinutes: 3,
			status: "all",
			providers: { zai: { region: "cn" } },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveStatusMode persists status and preserves other fields", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-usage-save-"));
	try {
		writeFileSync(join(dir, "usage.json"), JSON.stringify({ intervalMinutes: 3, providers: { zai: { region: "cn" } } }));
		saveStatusMode(dir, "off");
		assert.deepEqual(loadBalanceConfig(dir), {
			intervalMinutes: 3,
			providers: { zai: { region: "cn" } },
			status: "off",
		});

		writeFileSync(join(dir, "usage.json"), "{ not json");
		saveStatusMode(dir, "all");
		assert.deepEqual(loadBalanceConfig(dir), { status: "all" }, "invalid config is replaced");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const THEME: ThemeLike = {
	fg: (color, text) => `[${color}]${text}`,
	bold: (text) => `b(${text})`,
	bg: (_color, text) => text,
};

function balanceFixture(overrides: Partial<AccountBalance>): AccountBalance {
	return {
		providerId: "openai-codex",
		label: "Codex",
		windows: [{ label: "5h", usedPercent: 13 }],
		notes: [],
		fetchedAt: 0,
		...overrides,
	};
}

test("formatStatusLine respects mode and active provider", () => {
	const balances = [
		balanceFixture({}),
		{
			providerId: "deepseek",
			label: "DeepSeek",
			windows: [],
			notes: [],
			fetchedAt: 0,
			balance: { amount: 38.48, currency: "CNY" },
		},
		{
			providerId: "zai",
			label: "GLM",
			windows: [],
			notes: [],
			fetchedAt: 0,
			error: "boom",
		},
	];
	const active = formatStatusLine({ balances, mode: "active", activeProviderId: "openai-codex", theme: THEME });
	assert.equal(active, "Codex 5h 13% used");
	const all = formatStatusLine({ balances, mode: "all", activeProviderId: "openai-codex", theme: THEME });
	assert.match(all ?? "", /^Codex 5h 13% used/, "active account comes first, unstyled");
	assert.match(all ?? "", /\[dim\]DeepSeek ¥38\.48/);
	assert.match(all ?? "", /\[error\]GLM !/);
	assert.equal(formatStatusLine({ balances, mode: "off", theme: THEME }), undefined);
	assert.equal(
		formatStatusLine({ balances, mode: "active", activeProviderId: "zai", theme: THEME }),
		"[error]GLM !",
	);
});

test("formatStatusLine active mode shows all windows of the active account", () => {
	const balances = [
		balanceFixture({
			windows: [
				{ label: "5h", usedPercent: 13 },
				{ label: "weekly", usedPercent: 2 },
			],
		}),
	];
	const line = formatStatusLine({ balances, mode: "active", activeProviderId: "openai-codex", theme: THEME });
	assert.equal(line, "Codex 5h 13% used · weekly 2% used");
});

test("usage card renders accounts, bars, and errors", async () => {
	const agentDir = makeAgentDir(
		{
			"openai-codex": { type: "oauth", access: "t", expires: Date.now() + 3_600_000 },
			deepseek: { type: "api_key", key: "sk" },
		},
		{},
	);
	try {
		const scripted = new ScriptedFetch([
			{
				prefix: "https://chatgpt.com/backend-api/wham/usage",
				respond: () =>
					new Response(
						JSON.stringify({
							plan_type: "plus",
							rate_limit: {
								primary_window: { used_percent: 13, limit_window_seconds: 18000, reset_at: 1789231563 },
								secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 1789818363 },
							},
							credits: { balance: "0" },
						}),
						{ status: 200 },
					),
			},
			{
				prefix: "https://api.deepseek.com/user/balance",
				respond: () => new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "38.48" }] }), { status: 200 }),
			},
		]);
		const service = new BalanceService({ agentDir, fetchImpl: scripted.fetchImpl });
		await service.refreshAll();

		const card = buildUsageCard(
			{ balances: service.getAll(), activeProviderId: "openai-codex", generatedAt: Date.now() },
			PLAIN_THEME,
		);
		const rendered = card.render(80).join("\n");
		assert.match(rendered, /Usage/);
		assert.match(rendered, /● Codex \(Plus\)/, "active account first with marker");
		assert.match(rendered, /○ DeepSeek/);
		assert.match(rendered, /5h\s+█*░*\s+13%/);
		assert.match(rendered, /resets (now|in)/, "fixture reset_at is in the past, so 'resets now'");
		assert.match(rendered, /Balance ¥38\.48/);
		assert.ok(
			rendered.indexOf("Codex (Plus)") < rendered.indexOf("DeepSeek"),
			"active account is listed first",
		);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("sumSessionUsage mirrors footer accounting", () => {
	const totals = sumSessionUsage([
		{ type: "message", message: { role: "user" } },
		{
			type: "message",
			message: { role: "assistant", usage: { totalTokens: 350, cost: { total: 0.01 } } },
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
			},
		},
		{
			type: "branch_summary",
			usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150, cost: { total: 0.002 } },
		},
		{
			type: "compaction",
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0 } },
		},
	]);
	assert.equal(totals.tokens, 350 + 15 + 150 + 10);
	assert.ok(Math.abs(totals.cost - 0.013) < 1e-9);
});

test("sumSessionUsage falls back to component sums without totalTokens", () => {
	const totals = sumSessionUsage([
		{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 5 } } },
	]);
	assert.equal(totals.tokens, 40);
});

test("formatTokens uses pi footer tiers", () => {
	assert.equal(formatTokens(934), "934");
	assert.equal(formatTokens(8740), "8.7k");
	assert.equal(formatTokens(87400), "87k");
	assert.equal(formatTokens(1240000), "1.2M");
	assert.equal(formatTokens(15000000), "15M");
});

test("formatStatusLine appends the session consumption segment", () => {
	const balances = [
		balanceFixture({ windows: [{ label: "5h", usedPercent: 13 }, { label: "weekly", usedPercent: 2 }] }),
	];

	const noCost = formatStatusLine({
		balances,
		mode: "active",
		activeProviderId: "openai-codex",
		theme: THEME,
		consumption: { tokens: 87400, cost: 0 },
	});
	assert.match(noCost ?? "", /weekly 2% used\[dim\] · \[dim\]session 87k tok$/);

	const withCost = formatStatusLine({
		balances,
		mode: "active",
		activeProviderId: "openai-codex",
		theme: THEME,
		consumption: { tokens: 12300, cost: 0.02 },
	});
	assert.match(withCost ?? "", /\[success\]\$0\.020$/);

	const empty = formatStatusLine({
		balances,
		mode: "active",
		activeProviderId: "openai-codex",
		theme: THEME,
		consumption: { tokens: 0, cost: 0 },
	});
	assert.equal(empty, "Codex 5h 13% used · weekly 2% used", "zero consumption shows no segment");

	const plain = formatStatusLine({
		balances,
		mode: "active",
		activeProviderId: "openai-codex",
		theme: THEME,
	});
	assert.equal(plain, "Codex 5h 13% used · weekly 2% used", "missing consumption shows no segment");

	const all = formatStatusLine({
		balances: [
			...balances,
			{ providerId: "deepseek", label: "DeepSeek", windows: [], notes: [], fetchedAt: 0, balance: { amount: 38.48, currency: "CNY" } },
		],
		mode: "all",
		activeProviderId: "openai-codex",
		theme: THEME,
		consumption: { tokens: 500, cost: 0 },
	});
	assert.match(all ?? "", /\[dim\]session 500 tok$/, "consumption goes last in all mode");
});

test("BalanceService surfaces the fetch cause chain and retries errors", async () => {
	const agentDir = makeAgentDir({ deepseek: { type: "api_key", key: "sk" } }, {});
	try {
		let fail = true;
		const service = new BalanceService({
			agentDir,
			fetchImpl: async () => {
				if (fail) {
					throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:7897") });
				}
				return new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "1.00" }] }), {
					status: 200,
				});
			},
		});

		const failed = await service.refresh("deepseek");
		assert.equal(failed.error, "fetch failed (connect ECONNREFUSED 127.0.0.1:7897)");

		fail = false;
		const retried = await service.refresh("deepseek");
		assert.equal(retried.error, undefined, "error snapshots bypass the TTL and retry");
		assert.equal(retried.balance?.amount, 1.0);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
