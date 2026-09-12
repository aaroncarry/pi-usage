/**
 * /usage result card: a custom session entry rendered inline in the chat
 * transcript (pi convention for info commands — no focus capture, survives
 * reload/session restore). Content mirrors what the old overlay showed:
 * per-account plan, usage window bars, monetary balances, and errors, with
 * the active account first.
 */

import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { formatBar, formatMoney, formatResetSuffix } from "../format.ts";
import type { AccountBalance } from "../types.ts";
import type { ThemeLike } from "./statusline.ts";

export interface UsageCardData {
	balances: AccountBalance[];
	activeProviderId?: string;
	/** Epoch ms when the snapshot was taken. */
	generatedAt: number;
}

function displayTitle(balance: AccountBalance): string {
	return balance.plan ? `${balance.label} (${balance.plan})` : balance.label;
}

export function buildUsageCard(data: UsageCardData, theme: ThemeLike): Component {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const time = new Date(data.generatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	box.addChild(new Text(`${theme.fg("accent", theme.bold("Usage"))} ${theme.fg("dim", `· ${time}`)}`, 0, 0));

	const ids = data.balances.map((balance) => balance.providerId);
	if (ids.length === 0) {
		box.addChild(new Text(theme.fg("muted", "No configured accounts (nothing usable in auth.json)"), 0, 1));
	}
	const ordered = orderActiveFirst(data.balances, data.activeProviderId);
	for (const balance of ordered) {
		const marker = balance.providerId === data.activeProviderId ? theme.fg("accent", "●") : theme.fg("dim", "○");
		const titleText =
			balance.providerId === data.activeProviderId
				? theme.fg("accent", theme.bold(displayTitle(balance)))
				: theme.fg("muted", displayTitle(balance));
		box.addChild(new Text(`${marker} ${titleText}`, 0, 1));
		for (const line of renderAccount(balance, theme)) {
			box.addChild(line);
		}
	}
	return box;
}

function orderActiveFirst(balances: AccountBalance[], activeProviderId?: string): AccountBalance[] {
	if (!activeProviderId) return [...balances];
	const active = balances.filter((balance) => balance.providerId === activeProviderId);
	const rest = balances.filter((balance) => balance.providerId !== activeProviderId);
	return [...active, ...rest];
}

function renderAccount(balance: AccountBalance, theme: ThemeLike): Text[] {
	if (balance.error) {
		return [new Text(theme.fg("error", `  ${balance.error}`), 0, 0)];
	}
	const children: Text[] = [];
	for (const window of balance.windows) {
		const color = window.usedPercent >= 90 ? "error" : window.usedPercent >= 70 ? "warning" : "accent";
		const barLine =
			`  ${theme.fg("dim", window.label.padEnd(8))}${theme.fg(color, formatBar(window.usedPercent))}` +
			` ${String(Math.round(window.usedPercent)).padStart(3)}%${theme.fg("dim", formatResetSuffix(window.resetsAt))}`;
		children.push(new Text(barLine, 0, 0));
	}
	if (balance.balance) {
		const note = balance.balance.note ? `  ${theme.fg("dim", balance.balance.note)}` : "";
		children.push(
			new Text(
				`  ${theme.fg("dim", "Balance")}${theme.fg("success", ` ${formatMoney(balance.balance)}`)}${note}`,
				0,
				0,
			),
		);
	}
	for (const noteEntry of balance.notes) {
		children.push(new Text(theme.fg("dim", `  ${noteEntry}`), 0, 0));
	}
	return children;
}
