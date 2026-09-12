/** Shared response-field parsing helpers for provider adapters. */

/** Accept numbers or numeric strings ("0.00" style). */
export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/**
 * Normalize timestamps across providers: epoch seconds, epoch milliseconds,
 * or ISO-8601 strings. Returns epoch milliseconds, or undefined.
 */
export function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}
