import type { ProviderAdapter } from "../types.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { codexAdapter } from "./codex.ts";
import { deepseekAdapter } from "./deepseek.ts";
import { githubCopilotAdapter } from "./github-copilot.ts";
import { kimiCodingAdapter } from "./kimi-coding.ts";
import { minimaxAdapter, minimaxCnAdapter } from "./minimax.ts";
import { createMoonshotAdapter } from "./moonshot.ts";
import { opencodeZenAdapter } from "./opencode-zen.ts";
import { openrouterAdapter } from "./openrouter.ts";
import { vercelAIGatewayAdapter } from "./vercel-ai-gateway.ts";
import { zaiAdapter } from "./zai.ts";

export function getBuiltinAdapters(): ProviderAdapter[] {
	return [
		codexAdapter,
		anthropicAdapter,
		githubCopilotAdapter,
		kimiCodingAdapter,
		minimaxAdapter,
		minimaxCnAdapter,
		createMoonshotAdapter("moonshotai"),
		createMoonshotAdapter("moonshotai-cn"),
		opencodeZenAdapter,
		openrouterAdapter,
		vercelAIGatewayAdapter,
		zaiAdapter,
		deepseekAdapter,
	];
}
