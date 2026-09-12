import type { ProviderAdapter } from "../types.ts";
import { codexAdapter } from "./codex.ts";
import { deepseekAdapter } from "./deepseek.ts";
import { zaiAdapter } from "./zai.ts";

export function getBuiltinAdapters(): ProviderAdapter[] {
	return [codexAdapter, zaiAdapter, deepseekAdapter];
}
