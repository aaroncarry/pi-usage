import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexAdapter } from "../src/providers/codex.ts";
import { deepseekAdapter } from "../src/providers/deepseek.ts";
import { zaiAdapter } from "../src/providers/zai.ts";
import { anthropicAdapter } from "../src/providers/anthropic.ts";
import { githubCopilotAdapter } from "../src/providers/github-copilot.ts";
import { kimiCodingAdapter } from "../src/providers/kimi-coding.ts";
import { minimaxAdapter } from "../src/providers/minimax.ts";
import { createMoonshotAdapter } from "../src/providers/moonshot.ts";
import { opencodeZenAdapter } from "../src/providers/opencode-zen.ts";
import { openrouterAdapter } from "../src/providers/openrouter.ts";
import { vercelAIGatewayAdapter } from "../src/providers/vercel-ai-gateway.ts";
import { createAutoDetectAdapter } from "../src/providers/auto-detect.ts";
import { createCustomAdapter, dotPath } from "../src/providers/custom.ts";
import { resolveConfigValue, resolveProviderToken } from "../src/credentials.ts";
import type { FetchLike } from "../src/types.ts";

/** Scripted fetch: matches by URL prefix, records every call. */
class ScriptedFetch {
	readonly calls: { url: string; init?: RequestInit }[] = [];
	private readonly handlers: { prefix: string; respond: () => Response }[];

	constructor(handlers: { prefix: string; respond: () => Response }[]) {
		this.handlers = handlers;
	}

	get fetchImpl(): FetchLike {
		return async (url: string, init?: RequestInit) => {
			this.calls.push({ url, init });
			const handler = this.handlers.find((entry) => url.startsWith(entry.prefix));
			if (!handler) throw new Error(`unexpected fetch: ${url}`);
			return handler.respond();
		};
	}

	get urls(): string[] {
		return this.calls.map((call) => call.url);
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

const CODEX_FIXTURE = {
	user_id: "user-test",
	plan_type: "plus",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 13, limit_window_seconds: 18000, reset_after_seconds: 984, reset_at: 1789231563 },
		secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_after_seconds: 587784, reset_at: 1789818363 },
	},
	credits: { has_credits: false, unlimited: false, balance: "0" },
	spend_control: { reached: false, individual_limit: null },
};

test("codex adapter parses plan and usage windows", async () => {
	const scripted = new ScriptedFetch([
		{ prefix: "https://chatgpt.com/backend-api/wham/usage", respond: () => jsonResponse(CODEX_FIXTURE) },
	]);
	const balance = await codexAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.providerId, "openai-codex");
	assert.equal(balance.plan, "Plus");
	assert.equal(balance.windows.length, 2);
	assert.deepEqual(
		{ label: balance.windows[0]?.label, usedPercent: balance.windows[0]?.usedPercent },
		{ label: "5h", usedPercent: 13 },
	);
	assert.equal(balance.windows[0]?.resetsAt, 1789231563 * 1000);
	assert.equal(balance.windows[1]?.label, "weekly");
	assert.ok(balance.notes.length === 0, "zero credits must not produce a note");
	assert.equal(scripted.urls.length, 1);
});

test("codex adapter reports HTTP errors", async () => {
	const scripted = new ScriptedFetch([
		{ prefix: "https://chatgpt.com/backend-api/wham/usage", respond: () => jsonResponse({ error: "no" }, 401) },
	]);
	await assert.rejects(
		codexAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} }),
		/401/,
	);
});

test("codex adapter scopes enterprise OAuth requests and parses monthly spend control", async () => {
	const accountId = "acct-enterprise";
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})).toString("base64url");
	const scripted = new ScriptedFetch([
		{
			prefix: "https://chatgpt.com/backend-api/wham/usage",
			respond: () =>
				jsonResponse({
					plan_type: "enterprise",
					rate_limit: { primary_window: null, secondary_window: null },
					spend_control: {
						individual_limit: { limit: 150000, used: 138000, reset_at: 1789818363 },
					},
				}),
		},
	]);
	const balance = await codexAdapter.fetch({ token: `header.${payload}.signature`, fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.plan, "Enterprise");
	assert.deepEqual(balance.windows[0], {
		label: "monthly",
		usedPercent: 92,
		resetsAt: 1789818363 * 1000,
	});
	const headers = scripted.calls[0]?.init?.headers as Record<string, string>;
	assert.equal(headers["ChatGPT-Account-Id"], accountId);
});

test("codex adapter accepts workspace responses without personal rate windows", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://chatgpt.com/backend-api/wham/usage",
			respond: () => jsonResponse({ plan_type: "enterprise", rate_limit: null, spend_control: { reached: false } }),
		},
	]);
	const balance = await codexAdapter.fetch({ token: "opaque-token", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.error, undefined);
	assert.equal(balance.plan, "Enterprise");
	assert.deepEqual(balance.windows, []);
});

test("codex adapter surfaces credits and spend cap", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://chatgpt.com/backend-api/wham/usage",
			respond: () =>
				jsonResponse({
					...CODEX_FIXTURE,
					credits: { balance: "12.5" },
					spend_control: { individual_limit: 100 },
				}),
		},
	]);
	const balance = await codexAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.deepEqual(balance.notes, ["$12.50 credits", "monthly spend cap $100.00"]);
});

test("deepseek adapter parses balance_infos", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://api.deepseek.com/user/balance",
			respond: () =>
				jsonResponse({
					is_available: true,
					balance_infos: [
						{ currency: "CNY", total_balance: "38.48", granted_balance: "0.00", topped_up_balance: "38.48" },
					],
				}),
		},
	]);
	const balance = await deepseekAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.balance?.amount, 38.48);
	assert.equal(balance.balance?.currency, "CNY");
	assert.equal(balance.windows.length, 0);
});

test("zai adapter falls back to bigmodel balance when no coding plan", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://api.z.ai/api/monitor/usage/quota/limit",
			respond: () => jsonResponse({ code: 500, msg: "当前用户不存在coding plan", success: false }),
		},
		{
			prefix: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
			respond: () => jsonResponse({ code: 500, msg: "当前用户不存在coding plan", success: false }),
		},
		{
			prefix: "https://www.bigmodel.cn/api/biz/account/query-customer-account-report",
			respond: () =>
				jsonResponse({
					code: 200,
					msg: "操作成功",
					success: true,
					data: {
						balance: 21.456,
						rechargeAmount: 118.0,
						giveAmount: 0.0,
						totalSpendAmount: 96.543,
						availableBalance: 21.456,
					},
				}),
		},
	]);
	const balance = await zaiAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.error, undefined);
	assert.equal(balance.balance?.amount, 21.456);
	assert.equal(balance.balance?.currency, "CNY");
	assert.match(balance.balance?.note ?? "", /recharged ¥118\.00/);
	assert.equal(balance.windows.length, 0);
	assert.equal(scripted.urls.length, 3, "auto region tries global quota, cn quota, then balance");
});

test("zai adapter parses coding plan windows", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://api.z.ai/api/monitor/usage/quota/limit",
			respond: () =>
				jsonResponse({
					code: 200,
					success: true,
					data: {
						planName: "GLM Coding Plan",
						limits: [
							{
								type: "CREDIT_LIMIT",
								unit: 3,
								number: 5,
								percentage: 34,
								usage: 120,
								remaining: 79,
								nextResetTime: 1789231563000,
							},
							{
								type: "CREDIT_LIMIT",
								unit: 6,
								number: 1,
								percentage: 12,
								usage: 2000,
								remaining: 1760,
								nextResetTime: 1789818363000,
							},
							{ type: "TIME_LIMIT", unit: 6, number: 1, percentage: 5 },
						],
					},
				}),
		},
	]);
	const balance = await zaiAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.plan, "GLM Coding Plan");
	assert.deepEqual(
		balance.windows.map((window) => window.label),
		["5h", "weekly", "MCP"],
	);
	assert.equal(balance.windows[0]?.detail, "79 of 120 left");
	assert.equal(balance.windows[0]?.resetsAt, 1789231563000);
});

test("zai adapter errors when both quota and balance fail", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://api.z.ai/",
			respond: () => jsonResponse({ code: 500, msg: "boom", success: false }),
		},
		{
			prefix: "https://open.bigmodel.cn/",
			respond: () => jsonResponse({ code: 500, msg: "当前用户不存在coding plan", success: false }),
		},
		{
			prefix: "https://www.bigmodel.cn/",
			respond: () => jsonResponse({ success: false }, 401),
		},
	]);
	await assert.rejects(zaiAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} }), /z\.ai: boom/);
});

test("dotPath resolves nested paths and array indices", () => {
	const body = { data: { list: [{ percent: 42 }], value: 7 } };
	assert.equal(dotPath(body, "data.value"), 7);
	assert.equal(dotPath(body, "data.list[0].percent"), 42);
	assert.equal(dotPath(body, "data.missing.deep"), undefined);
	assert.equal(dotPath(body, "data.list[5].percent"), undefined);
});

test("custom adapter extracts balance and windows via dot paths", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://relay.example/api/status",
			respond: () =>
				jsonResponse({
					data: {
						amount: "9.75",
						windows: [
							{ name: "5h", pct: 20, reset: 1789231563 },
							{ name: "week", pct: 3, reset: 1789818363 },
						],
					},
				}),
		},
	]);
	const adapter = createCustomAdapter(
		"lingsuan",
		{
			url: "https://relay.example/api/status",
			headers: { Authorization: "Bearer {token}", "X-Env": "$MY_VAR" },
			balancePath: "data.amount",
			currency: "CNY",
			windowsPath: "data.windows",
			windowFields: { label: "name", percent: "pct", resetsAt: "reset" },
		},
		"LingSuan",
	);
	process.env.MY_VAR = "hello";
	const balance = await adapter.fetch({ token: "tok", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.balance?.amount, 9.75);
	assert.equal(balance.balance?.currency, "CNY");
	assert.deepEqual(
		balance.windows.map((window) => window.label),
		["5h", "week"],
	);
	assert.equal(balance.windows[1]?.resetsAt, 1789818363 * 1000);
});

test("resolveConfigValue interpolates env vars and escapes", () => {
	process.env.PI_USAGE_TEST_VAR = "hello";
	assert.equal(resolveConfigValue("$PI_USAGE_TEST_VAR"), "hello");
	assert.equal(resolveConfigValue("${PI_USAGE_TEST_VAR}!"), "hello!");
	assert.equal(resolveConfigValue("$$keep $!me"), "$keep !me");
	assert.equal(resolveConfigValue("$PI_USAGE_TEST_MISSING"), undefined);
	assert.equal(resolveConfigValue("literal"), "literal");
	delete process.env.PI_USAGE_TEST_VAR;
});

test("resolveProviderToken falls back to auth.json for api_key and expired oauth", async () => {
	process.env.PI_USAGE_TEST_KEY = "from-env";
	const authJson = JSON.stringify({
		"test-keyed": { type: "api_key", key: "$PI_USAGE_TEST_KEY" },
		"test-expired": { type: "oauth", access: "stale", refresh: "r", expires: Date.now() - 1000 },
		"test-ok": { type: "oauth", access: "fresh", expires: Date.now() + 3_600_000 },
	});
	const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-test-"));
	writeFileSync(join(agentDir, "auth.json"), authJson);

	await assert.rejects(resolveProviderToken("test-none", undefined, agentDir), /No credential configured/);

	const keyed = await resolveProviderToken("test-keyed", undefined, agentDir);
	assert.equal(keyed, "from-env");

	await assert.rejects(resolveProviderToken("test-expired", undefined, agentDir), /expired/);

	const oauth = await resolveProviderToken("test-ok", undefined, agentDir);
	assert.equal(oauth, "fresh");

	rmSync(agentDir, { recursive: true, force: true });
	delete process.env.PI_USAGE_TEST_KEY;
});

test("anthropic adapter parses Claude OAuth usage windows", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://api.anthropic.com/api/oauth/usage",
			respond: () =>
				jsonResponse({
					five_hour: { utilization: 42, resets_at: "2026-09-13T12:00:00Z" },
					seven_day: { utilization: 10, resets_at: "2026-09-19T00:00:00Z" },
					extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 20 },
				}),
		},
	]);
	const balance = await anthropicAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.label, "Claude");
	assert.deepEqual(
		balance.windows.map((window) => window.label),
		["5h", "weekly"],
	);
	assert.equal(balance.windows[0]?.usedPercent, 42);
	assert.equal(balance.windows[0]?.resetsAt, Date.parse("2026-09-13T12:00:00Z"));
	assert.equal(balance.balance?.amount, 0.8);
	assert.equal(balance.balance?.currency, "USD");
	assert.match(balance.balance?.note ?? "", /extra usage: \$0\.20 of \$1\.00/);
	const headers = scripted.calls[0]?.init?.headers as Record<string, string>;
	assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
});

test("anthropic adapter accepts model-specific windows when aggregate windows are absent", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://api.anthropic.com/api/oauth/usage",
			respond: () =>
				jsonResponse({
					five_hour: null,
					seven_day: null,
					seven_day_opus: { utilization: 12, resets_at: "2026-09-20T00:00:00Z" },
					seven_day_sonnet: { utilization: 8, resets_at: "2026-09-20T00:00:00Z" },
				}),
		},
	]);
	const balance = await anthropicAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.deepEqual(balance.windows.map((window) => window.label), ["weekly-opus", "weekly-sonnet"]);
	assert.equal(balance.windows[0]?.usedPercent, 12);
	assert.equal(balance.error, undefined);
});

test("github-copilot adapter parses quota snapshots and skips placeholders", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://github.com/copilot_internal/user",
			respond: () =>
				jsonResponse({
					copilot_plan: "copilot_pro",
					quota_reset_date: "2026-10-01T00:00:00Z",
					quota_snapshots: {
						premium_interactions: { entitlement: 300, remaining: 150, percent_remaining: 50, unlimited: false, quota_id: "premium" },
						chat: { entitlement: 0, remaining: 0, unlimited: true, quota_id: "chat" },
						dead: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: false, quota_id: "x" },
					},
				}),
		},
	]);
	const balance = await githubCopilotAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.plan, "Copilot Pro");
	assert.deepEqual(
		balance.windows.map((window) => window.label),
		["premium", "chat"],
	);
	assert.equal(balance.windows[0]?.usedPercent, 50);
	assert.equal(balance.windows[1]?.detail, "unlimited");
	assert.equal(balance.windows[0]?.resetsAt, Date.parse("2026-10-01T00:00:00Z"));
	const headers = scripted.calls[0]?.init?.headers as Record<string, string>;
	assert.match(headers.Authorization ?? "", /^token /, "GitHub expects the token scheme, not Bearer");
});

test("kimi coding adapter parses quota counts and reset times", async () => {
	const scripted = new ScriptedFetch([{ prefix: "https://api.kimi.com/coding/v1/usages", respond: () => jsonResponse({ usage: { limit: "100", remaining: "75", resetTime: "2026-09-20T00:00:00Z" } }) }]);
	const balance = await kimiCodingAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.windows[0]?.usedPercent, 25);
	assert.equal(balance.windows[0]?.detail, "75 of 100 left");
	assert.equal(balance.windows[0]?.resetsAt, Date.parse("2026-09-20T00:00:00Z"));
});

test("minimax adapter distinguishes remaining token-plan quota", async () => {
	const scripted = new ScriptedFetch([{ prefix: "https://api.minimax.io/v1/token_plan/remains", respond: () => jsonResponse({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "MiniMax-M2", current_interval_usage_count: 20, current_interval_total_count: 100, current_interval_remaining_percent: 80, current_interval_status: 1, start_time: 1_700_000_000_000, end_time: 1_700_018_000_000, current_weekly_usage_count: 50, current_weekly_total_count: 100, current_weekly_remaining_percent: 50, current_weekly_status: 1, weekly_start_time: 1_700_000_000_000, weekly_end_time: 1_700_604_800_000 }] }) }]);
	const balance = await minimaxAdapter.fetch({ token: "token-plan", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.windows[0]?.usedPercent, 20);
	assert.equal(balance.windows[0]?.detail, "80 of 100 left");
	assert.equal(balance.windows[1]?.usedPercent, 50);
});

test("moonshot adapter parses account balance", async () => {
	const scripted = new ScriptedFetch([{ prefix: "https://api.moonshot.ai/v1/users/me/balance", respond: () => jsonResponse({ code: 0, status: true, data: { available_balance: 12.5, cash_balance: 10 } }) }]);
	const balance = await createMoonshotAdapter("moonshotai").fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.balance?.amount, 12.5);
	assert.equal(balance.balance?.currency, "USD");
});

test("vercel AI gateway adapter parses credits", async () => {
	const scripted = new ScriptedFetch([{ prefix: "https://ai-gateway.vercel.sh/v1/credits", respond: () => jsonResponse({ balance: "9.50", total_used: "2.25" }) }]);
	const balance = await vercelAIGatewayAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.balance?.amount, 9.5);
	assert.match(balance.balance?.note ?? "", /lifetime spend \$2\.25/);
});

test("opencode Go adapter parses rolling usage windows", async () => {
	const scripted = new ScriptedFetch([{ prefix: "https://opencode.ai/zen/go/v1/usage", respond: () => jsonResponse({ usage: { rolling: { status: "ok", percent: 25 }, weekly: { status: "rate-limited", percent: 80, resetsAt: "2026-09-20T00:00:00Z" } } }) }]);
	const balance = await opencodeZenAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.deepEqual(balance.windows.map((window) => window.label), ["rolling", "weekly"]);
	assert.equal(balance.windows[1]?.resetsAt, Date.parse("2026-09-20T00:00:00Z"));
});

test("openrouter adapter reads the authenticated key limit", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://openrouter.ai/api/v1/key",
			respond: () =>
				jsonResponse({
					data: {
						limit: 100,
						limit_remaining: 62.5,
						usage_daily: 2.5,
						usage: 37.5,
					},
				}),
		},
	]);
	const balance = await openrouterAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.balance?.amount, 62.5);
	assert.equal(balance.balance?.currency, "USD");
	assert.match(balance.balance?.note ?? "", /key limit \$100\.00/);
	assert.deepEqual(balance.notes, ["today $2.50", "all-time $37.50"]);
	assert.equal(scripted.urls[0], "https://openrouter.ai/api/v1/key");
});

test("openrouter adapter reports usage without fabricating a workspace wallet", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://openrouter.ai/api/v1/key",
			respond: () =>
				jsonResponse({
					data: {
						limit: null,
						limit_remaining: null,
						usage: 89290.64,
						usage_monthly: 6147.70,
					},
				}),
		},
	]);
	const balance = await openrouterAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.balance, undefined);
	assert.deepEqual(balance.notes, ["no per-key spend cap", "this month $6147.70", "all-time $89290.64"]);
});

test("openrouter adapter preserves a genuine zero key limit", async () => {
	const scripted = new ScriptedFetch([
		{
			prefix: "https://openrouter.ai/api/v1/key",
			respond: () => jsonResponse({ data: { limit: 0, limit_remaining: 0, usage: 0 } }),
		},
	]);
	const balance = await openrouterAdapter.fetch({ token: "t", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.balance?.amount, 0);
	assert.match(balance.balance?.note ?? "", /key limit \$0\.00/);
});

test("auto-detect adapter probes new-api billing endpoints", async () => {
	const scripted = new ScriptedFetch([
		{ prefix: "https://relay.example/v1/dashboard/billing/subscription", respond: () => jsonResponse({ hard_limit_usd: 50 }) },
		{ prefix: "https://relay.example/v1/dashboard/billing/usage", respond: () => jsonResponse({ total_usage: 1250 }) },
	]);
	const adapter = createAutoDetectAdapter("lingsuan");
	const balance = await adapter.fetch({
		token: "sk",
		baseUrl: "https://relay.example/v1",
		fetchImpl: scripted.fetchImpl,
		options: {},
	});
	assert.equal(balance.providerId, "lingsuan");
	assert.equal(balance.balance?.amount, 37.5);
	assert.equal(balance.balance?.currency, "USD");
	assert.deepEqual(balance.notes, ["used $12.50 of $50.00"]);
	// Pinned winner: second fetch re-queries only the new-api pair.
	await adapter.fetch({ token: "sk", baseUrl: "https://relay.example/v1", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(scripted.calls.length, 6);
});

test("auto-detect adapter detects sub2api usage endpoints", async () => {
	const scripted = new ScriptedFetch([
		{ prefix: "https://s2a.example/usage", respond: () => jsonResponse({ quota: { limit: 100, used: 30 }, unit: "USD" }) },
	]);
	const adapter = createAutoDetectAdapter("s2a");
	const balance = await adapter.fetch({ token: "sk", baseUrl: "https://s2a.example", fetchImpl: scripted.fetchImpl, options: {} });
	assert.equal(balance.balance?.amount, 70);
	assert.equal(balance.balance?.currency, "USD");
	assert.deepEqual(balance.notes, ["used 30 of 100"]);
});

test("auto-detect adapter pins exhaustion and skips repeated probing", async () => {
	const scripted = new ScriptedFetch([
		{ prefix: "https://relay.example/", respond: () => jsonResponse({ error: "not found" }, 404) },
	]);
	const adapter = createAutoDetectAdapter("relay");
	await assert.rejects(
		adapter.fetch({ token: "sk", baseUrl: "https://relay.example", fetchImpl: scripted.fetchImpl, options: {} }),
		/no balance endpoint detected/,
	);
	await assert.rejects(
		adapter.fetch({ token: "sk", baseUrl: "https://relay.example", fetchImpl: scripted.fetchImpl, options: {} }),
		/no balance endpoint detected/,
	);
	// new-api probes 2 base variants (1 call each), sub2api the same: 4 total,
	// and the second fetch reuses the pinned exhaustion without any calls.
	assert.equal(scripted.calls.length, 4);
});
