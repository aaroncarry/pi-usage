/**
 * Credential resolution for pi-usage.
 *
 * Prefers pi's model registry (`ctx.modelRegistry.getProviderAuth`), which
 * refreshes OAuth tokens before they expire and persists them to auth.json.
 * The auth.json fallback covers providers the registry does not know; it
 * mirrors pi's config value interpolation rules ($ENV / ${ENV}, $$ and $!
 * escapes, !command).
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Location of pi's agent directory (mirrors pi's config.ts rules). */
export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export interface StoredApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: Record<string, string>;
}

export interface StoredOAuthCredential {
	type: "oauth";
	access?: string;
	refresh?: string;
	expires?: number;
}

export type StoredCredential = StoredApiKeyCredential | StoredOAuthCredential;

export function readStoredCredential(agentDir: string, providerId: string): StoredCredential | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const entries = raw as Record<string, unknown>;
	const credential = entries[providerId];
	if (typeof credential !== "object" || credential === null) return undefined;
	const record = credential as Record<string, unknown>;
	if (record.type === "api_key") {
		return {
			type: "api_key",
			key: typeof record.key === "string" ? record.key : undefined,
			env: readEnvRecord(record.env),
		};
	}
	if (record.type === "oauth") {
		return {
			type: "oauth",
			access: typeof record.access === "string" ? record.access : undefined,
			refresh: typeof record.refresh === "string" ? record.refresh : undefined,
			expires: typeof record.expires === "number" ? record.expires : undefined,
		};
	}
	return undefined;
}

/** Subset of pi-ai's AuthResult that pi-usage relies on. */
export interface RegistryAuth {
	auth: { apiKey?: string; headers?: Record<string, string> };
}

export type ProviderAuthLookup = (providerId: string) => Promise<RegistryAuth | undefined>;

const BEARER_RE = /^Bearer\s+(.+)$/iu;

/** Extract the bearer token/api key from a registry auth result. */
export function tokenFromRegistryAuth(auth: RegistryAuth | undefined): string | undefined {
	if (!auth) return undefined;
	if (auth.auth.apiKey) return auth.auth.apiKey;
	const authorization = Object.entries(auth.auth.headers ?? {}).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	return typeof authorization === "string" ? BEARER_RE.exec(authorization)?.[1] : undefined;
}

/** OAuth tokens this close to expiry are considered stale in the auth.json fallback. */
const OAUTH_FALLBACK_MIN_VALIDITY_MS = 60_000;

/**
 * Resolve a usable token for a provider. Throws with an actionable message
 * when no credential is configured or the fallback OAuth token is expired;
 * the service turns the message into the account's `error`.
 */
export async function resolveProviderToken(
	providerId: string,
	lookup: ProviderAuthLookup | undefined,
	agentDir: string,
): Promise<string> {
	try {
		const fromRegistry = tokenFromRegistryAuth(await lookup?.(providerId));
		if (fromRegistry) return fromRegistry;
	} catch {
		// Registry lookup failed (unknown provider, refresh error); fall through.
	}
	const credential = readStoredCredential(agentDir, providerId);
	if (!credential) {
		throw new Error(`No credential configured for "${providerId}" (run /login or pi auth)`);
	}
	if (credential.type === "api_key") {
		const key = credential.key ? resolveConfigValue(credential.key, credential.env) : undefined;
		if (key) return key;
		throw new Error(`Could not resolve API key for "${providerId}"`);
	}
	if (!credential.access) {
		throw new Error(`OAuth credential for "${providerId}" has no access token`);
	}
	if (credential.expires !== undefined && Date.now() > credential.expires - OAUTH_FALLBACK_MIN_VALIDITY_MS) {
		throw new Error(`OAuth token for "${providerId}" is expired; run /login or "pi auth check" to refresh`);
	}
	return credential.access;
}

/**
 * Resolve a config value following pi's resolve-config-value rules:
 * "!command" runs through the shell, "$ENV"/"${ENV}" interpolate, "$$"/"$!"
 * escape literals, anything else is literal.
 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	if (config.startsWith("!")) return runCommand(config.slice(1));
	return interpolateTemplate(config, env);
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function interpolateTemplate(config: string, env?: Record<string, string>): string | undefined {
	let out = "";
	let index = 0;
	while (index < config.length) {
		const dollar = config.indexOf("$", index);
		if (dollar < 0) {
			out += config.slice(index);
			break;
		}
		out += config.slice(index, dollar);
		const next = config[dollar + 1];
		if (next === "$" || next === "!") {
			out += next;
			index = dollar + 2;
			continue;
		}
		if (next === "{") {
			const end = config.indexOf("}", dollar + 2);
			if (end < 0) {
				out += "$";
				index = dollar + 1;
				continue;
			}
			const name = config.slice(dollar + 2, end);
			const value = ENV_NAME_RE.test(name) ? envValue(name, env) : undefined;
			if (value === undefined) return undefined;
			out += value;
			index = end + 1;
			continue;
		}
		const match = ENV_NAME_PREFIX_RE.exec(config.slice(dollar + 1));
		if (match?.[0]) {
			const value = envValue(match[0], env);
			if (value === undefined) return undefined;
			out += value;
			index = dollar + 1 + match[0].length;
			continue;
		}
		out += "$";
		index = dollar + 1;
	}
	return out;
}

function envValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function runCommand(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

function readEnvRecord(value: unknown): Record<string, string> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [name, envValueEntry] of Object.entries(value)) {
		if (typeof envValueEntry === "string") out[name] = envValueEntry;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
