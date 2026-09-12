import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexAdapter } from "../src/providers/codex.ts";
import { deepseekAdapter } from "../src/providers/deepseek.ts";
import { zaiAdapter } from "../src/providers/zai.ts";
import { createCustomAdapter, dotPath } from "../src/providers/custom.ts";
import { resolveConfigValue, resolveProviderToken } from "../src/credentials.ts";
import type { FetchLike } from "../src/types.ts";

/** Scripted fetch: matches by URL prefix, records every call. */
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
