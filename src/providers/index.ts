import type { ProviderAdapter } from "../types.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { codexAdapter } from "./codex.ts";
import { deepseekAdapter } from "./deepseek.ts";
import { githubCopilotAdapter } from "./github-copilot.ts";
import { openrouterAdapter } from "./openrouter.ts";
import { zaiAdapter } from "./zai.ts";

export function getBuiltinAdapters(): ProviderAdapter[] {
	return [codexAdapter, anthropicAdapter, githubCopilotAdapter, openrouterAdapter, zaiAdapter, deepseekAdapter];
}
