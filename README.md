# pi-usage

[English](./README.md) | [简体中文](./README.zh-CN.md)

A [pi](https://github.com/earendil-works/pi) extension that shows the balances and usage windows of your subscription accounts — a footer status line for the account you are currently using, plus a `/usage` card with full details. Query methods adapted from [CodexBar](https://github.com/steipete/CodexBar); credentials come straight from pi's unified `auth.json`, nothing else is read.

## 0.3.0

- Added first-class usage adapters for Kimi Coding, MiniMax (Global/CN), Moonshot AI (Global/CN), OpenCode Go, and Vercel AI Gateway.
- Switched OpenRouter to the `/api/v1/key` endpoint so Workspace keys report key limits and usage instead of misreading `/credits` as a wallet balance.
- Improved Claude extra-usage accounting (Anthropic returns the amounts in cents) and optional Opus/Sonnet usage windows.
- Added richer Codex, GitHub Copilot, and DeepSeek response handling.
- x.ai consumer billing, Fireworks organization billing, and Baseten organization billing are not included yet.

## What you get

The footer status line (default mode) follows the model you are using and shows its quota windows, this session's consumption, and a 7-day token sparkline:

```
Codex 5h 13% used · weekly 2% used · session 10.0k tok $0.020 · 7d ▁▁▁▁▁█▂ 66k
```

`/usage` prints a card into the conversation (a custom entry — no popup, no focus steal) with a 30-day usage summary at the bottom:

```
 Usage · 02:15

 ● Codex (Plus)
   5h      ░░░░░░░░░░   0% used · resets in 4h 54m
   weekly  ░░░░░░░░░░   2% used · resets in 6d 17h
 ○ GLM
   Balance ¥21.46  recharged ¥118.00 · spent ¥96.54
 ○ DeepSeek
   Balance ¥38.48
 Last 30 days ────────────────────────────
 tokens ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂▆███ 66k
   gpt-5.6-luna  █████████████████░░░ 70%  34k
   gpt-5.6-terra █████░░░░░░░░░░░░░░░ 21%  10k
```

The dashboard opens on the **Charts** view; `v` cycles Charts → Heatmap → Insights → Table. Four views, one example each:

## Trends dashboard

Keyboard: `v` cycle views · `←→` period (7d / 30d / 90d / all) · `m` tokens ↔ cost · `g` group by provider / project (table) · `↑↓` + `enter` expand a provider row (table) · `esc` close.

**Charts** — braille time series grouped by model, plus the model distribution. Same model ids served by different providers stay separate (`model (provider)`):

```
 Usage trends   [Charts]  Heatmap  Insights  Table     7d  [30d]  90d  all
 Total 66k tok · Cost $0.04 · Peak 39k (9/13) · Streak 2d
   39k ┤                                              ⢸⡄
       │                                              ⣿⠘⡄
       │                                              ⡇⡇⢸
       │                                             ⢸⠇⢣⡎
   17k ┤                                             ⢸ ⢸⠃
       │                                             ⡏ ⢸⡆
       │                                             ⡇⢀⡇⢇
     0 └⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣸⣔⣱⠑⢼
        08-14                08-29                09-13
 ● Total  ● gpt-5.6-luna  ● gpt-5.6-terra  ● deepseek-flash
 Models · 30d
   gpt-5.6-luna (openai-codex) █████████████████░░░ 52%  34k
   gpt-5.6-terra (relay)    █████░░░░░░░░░░░░░░░ 24%  16k
   deepseek-flash              ██░░░░░░░░░░░░░░░░░░  7%  4.5k
 m metric · ←→ period · v view · g group · esc close
```

**Heatmap** — 12-week activity calendar with streaks:

```
 Activity · 12 weeks                Streak 2d
  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  █  ░
  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ▒  █
  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
 ░ none  ▒ light  ▓ mid  █ heavy
 Peak 39k tokens on 9/13 · Total 66k
```

**Table** — provider→model line items; `enter` expands a provider into its models:

```
 Provider / Model     Sessions  Msgs  Cost  Tokens  ↑In   ↓Out  Cache
 ▾ openai-codex               2    16 $0.04    44k   39k   5.3k   150k
    gpt-5.6-terra             1     2 $0.02    10k   10k     53   9.7k
    gpt-5.6-luna              1    14 $0.01    34k   29k   5.2k   140k
 ▸ deepseek                   1     8 $0.003   4.5k   3.2k   1.2k    16k
 ▸ relay                   1     4      -    17k   16k   1.1k    12k
 ─────────────────────────────────────────────────────────────────────
 Total                        4    28 $0.04    66k   58k   7.6k   177k
 Tokens = Input + Output + CacheWrite · ↑In = Input + CacheWrite
```

**Insights** — where the spend went, and waste patterns worth attention:

```
 What's contributing to your cost?  30d
 Where it went
      $0.02  gpt-5.6-terra (openai-codex) drives 57% of your spend
          ~ routing some traffic to a cheaper model is the biggest cost lever
      73%  of processed tokens came from cache reads
      48%  of output is reasoning (thinking) tokens
          ~ lowering the thinking level on routine tasks cuts this hidden spend
 Worth attention
      $0.50   2 likely cache misses re-read the prompt at full price
          ~ pauses over 5 minutes and mid-session model switches invalidate the prompt cache
```

Trends are aggregated from pi's session files (`<agentDir>/sessions/**/*.jsonl`) with an incremental disk cache; forked session copies are deduplicated. Token metric = input + output + cache write.

## Commands

| Command | Effect |
|---|---|
| `/trends` | Open the interactive trends dashboard (charts, heatmap, table, insights). Same as `/usage trends`. |
| `/usage` | Print the usage card (balances + 30-day summary) into the session. Re-running refreshes: served from cache within the 5-minute TTL, refetched afterwards (15 s timeout). Cards persist in the session and are re-rendered on `/reload` and session restore. |
| `/usage trends` | Open the interactive trends dashboard (Table / Charts / Heatmap / Insights; `m` metric, `←→` period, `v` view, `↑↓`+`enter` table expand). |
| `/usage active\|all\|off` | Switch the footer status line mode immediately and persist it to `usage.json` (tab-completed). |
| `pi --usage-status all` | Set the footer mode for this run only (overrides `usage.json`, not written back). |

Precedence: `/usage <mode>` (session) > `--usage-status` (this run) > `usage.json` (persistent).

## Footer status line

| Mode | Shows |
|---|---|
| `active` (default) | All windows and balance of the account matching the current model, plus the session consumption segment. Follows model switches. |
| `all` | Every account on one line — active account first at full brightness, the rest dimmed — consumption appended last. |
| `off` | Hidden entirely. |

- The consumption segment (`session <tokens> tok`) updates immediately after every turn (local data, same accounting as pi's footer). A real cost (`· $0.020`) is appended only when non-zero — subscription providers report 0, which is omitted.
- A failing account shows as `Label !` in the error color.

## Supported accounts

Accounts with a credential in pi's `auth.json` are detected automatically; nothing to configure:

| `auth.json` key | Query | Shows |
|---|---|---|
| `openai-codex` | `GET chatgpt.com/backend-api/wham/usage` | 5h/weekly/additional windows, credits, spend controls |
| `anthropic` | `GET api.anthropic.com/api/oauth/usage` | Claude 5h/weekly/model windows and extra-usage balance |
| `github-copilot` | `GET github.com/copilot_internal/user` | premium/chat quota windows, plan, reset date |
| `kimi-coding` | `GET api.kimi.com/coding/v1/usages` | Coding-plan quota windows and booster wallet |
| `minimax` / `minimax-cn` | Token Plan or account balance endpoints | Model quota windows or USD/CNY balance |
| `moonshotai` / `moonshotai-cn` | `GET api.moonshot.{ai,cn}/v1/users/me/balance` | USD/CNY account balance |
| `openrouter` | `GET openrouter.ai/api/v1/key` | API-key limit remaining and usage metrics |
| `opencode-go` | `GET opencode.ai/zen/go/v1/usage` | Rolling, weekly, and monthly windows |
| `vercel-ai-gateway` | `GET ai-gateway.vercel.sh/v1/credits` | Remaining credits and lifetime spend |
| `zai` | Z.AI quota endpoint; falls back to the BigModel balance endpoint | 5h/weekly/MCP windows or CNY balance |
| `deepseek` | `GET api.deepseek.com/user/balance` | Multi-currency account balance |
| any other configured provider | **Auto-detection** (see below) | Gateway balance or plan windows |
| any custom provider | Config-driven generic adapter (see below) | Balance / windows |

### Auto-detection for custom providers

Providers registered in pi without a built-in adapter (e.g. relays set up via
[pi-provider-hub](https://github.com/aaroncarry/pi-provider-hub) or `models.json`) are probed
automatically using their registry base URL and the stored credential:

- **New API** gateways: `dashboard/billing/subscription` + `dashboard/billing/usage` (plus
  `/api/usage/token/` when available) → remaining USD balance, used/total note.
- **Sub2API** gateways: `usage` → remaining balance.
- Hostname-pinned protocols for `api.deepseek.com`, MiniMax hosts, and `open.bigmodel.cn` / `api.z.ai`.

The winning protocol is pinned per session; if every candidate rejects the request
(e.g. HTTP 404/401), the account shows a "no balance endpoint detected" error without
re-probing on every refresh. Transient network errors are retried. Disable with
`"autoDetect": false` in `usage.json` or `providers.<id>.enabled: false` per account.

## Credentials and security

- OAuth tokens are resolved through pi's model registry (`getProviderAuth`), which refreshes them before expiry and writes them back to `auth.json`. Providers unknown to the registry fall back to reading `auth.json` directly.
- API keys reuse pi's interpolation rules (`$ENV` / `${ENV}`, `$$` / `$!` escapes, `!command`).
- The usage endpoints are undocumented provider APIs and may change or throttle; query frequency is capped by the TTL.

## Install

```sh
pi install npm:@aaroncarry/pi-usage
```

Or add the package to `settings.json` manually. To load this checkout directly while developing, run Pi from the repository root and add the project-local package with:

```sh
pi install -l .
```

This writes `.pi/settings.json` with the local package path. The repository includes the equivalent configuration:

```json
{
  "packages": [".."]
}
```

If Pi asks whether to trust the project, approve it so project-local packages can load. Remove any global `pi-usage` entry first—especially `git:github.com/aaroncarry/pi-usage` or `npm:@aaroncarry/pi-usage`—to avoid loading an older copy alongside this checkout (for example: `pi remove git:github.com/aaroncarry/pi-usage`).

## Configuration

Optional config file `<agentDir>/usage.json`:

```json
{
  "intervalMinutes": 5,
  "status": "active",
  "providers": {
    "zai": { "region": "cn", "label": "GLM" },
    "deepseek": { "enabled": false },
    "my-relay": {
      "label": "LingSuan",
      "custom": {
        "url": "https://relay.example/api/status",
        "headers": { "Authorization": "Bearer {token}" },
        "balancePath": "data.availableBalance",
        "currency": "CNY",
        "windowsPath": "data.limits",
        "windowFields": { "label": "name", "percent": "percentage", "resetsAt": "reset_at" }
      }
    }
  }
}
```

- `intervalMinutes`: background refresh interval (default 5, minimum 1).
- `status`: `active` (default) | `all` | `off`.
- `sparkline`: set `false` to drop the 7-day sparkline from the footer status line.
- `autoDetect`: set `false` to disable endpoint auto-detection for unknown providers.
- `providers.<id>.enabled: false`: hide an account from the status line and card.
- `providers.<id>.label`: display name override.
- `providers.<id>.region`: z.ai region — `auto` (default) | `global` | `cn`.
- `custom`: generic adapter for any JSON endpoint. Header values support `$ENV` interpolation and a `{token}` placeholder for the provider's own `auth.json` credential, if present. `balancePath` / `windowsPath` are JSON dot paths (e.g. `data.list[0].percent`).

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm test
```

After changing the code, `/reload` inside pi picks it up (local checkouts are referenced in place).

## Known limitations

- Kimi Coding, MiniMax, Moonshot, OpenCode Go, and Vercel AI Gateway use provider-specific APIs; quota semantics are kept separate from account balances and may change with undocumented server fields. MiniMax selects global/CN endpoints from the provider id or `providers.<id>.region`.
- x.ai consumer billing is not included: its OAuth login and CLI proxy identity flow are not exposed by pi's current credential registry, so the extension does not guess at API-key or prepaid-account values.
- DeepSeek exposes multiple currency balances; the primary balance is shown in the first valid currency and additional currencies are listed in the notes.
- Fireworks and Baseten organization billing are not included because their account-scoped billing APIs need extra account discovery and date-window handling.
- Claude's OAuth usage endpoint is undocumented and only subscription OAuth tokens can access it; API-key mode cannot report subscription windows.
- The `$` figure shown for subscription (OAuth) accounts is pi's list-price estimate, not an actual charge; real consumption is the server-side quota window.
- The panel and status line are TUI features; the `/usage` card itself is written in every mode.
