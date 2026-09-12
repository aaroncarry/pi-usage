# pi-usage

[English](./README.md) | [简体中文](./README.zh-CN.md)

A [pi](https://github.com/earendil-works/pi) extension that shows the balances and usage windows of your subscription accounts — a footer status line for the account you are currently using, plus a `/usage` card with full details. Query methods adapted from [CodexBar](https://github.com/steipete/CodexBar); credentials come straight from pi's unified `auth.json`, nothing else is read.

## What you get

The footer status line (default mode) follows the model you are using and shows its quota windows plus this session's consumption:

```
Codex 5h 13% · weekly 2% · session 10.0k tok $0.020
```

`/usage` prints a card into the conversation (a custom entry — no popup, no focus steal):

```
 Usage · 02:15

 ● Codex (Plus)
   5h      ░░░░░░░░░░   0% · resets in 4h 54m
   weekly  ░░░░░░░░░░   2% · resets in 6d 17h
 ○ GLM
   Balance ¥21.46  recharged ¥118.00 · spent ¥96.54
 ○ DeepSeek
   Balance ¥38.48
```

## Commands

| Command | Effect |
|---|---|
| `/usage` | Print the usage card into the session. Re-running refreshes: served from cache within the 5-minute TTL, refetched afterwards (15 s timeout). Cards persist in the session and are re-rendered on `/reload` and session restore. |
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

| auth.json key | Query | Shows |
|---|---|---|
| `openai-codex` | `GET chatgpt.com/backend-api/wham/usage` (Bearer OAuth token) | 5h/weekly windows, credits, monthly spend cap |
| `zai` | `GET api.z.ai/api/monitor/usage/quota/limit` (CN region: `open.bigmodel.cn`); falls back to the bigmodel.cn balance endpoint when the key has no coding plan | 5h/weekly/MCP windows, or CNY balance |
| `deepseek` | `GET api.deepseek.com/user/balance` | Account balance |
| any custom provider | Config-driven generic adapter (see below) | Balance / windows |

## Credentials and security

- OAuth tokens are resolved through pi's model registry (`getProviderAuth`), which refreshes them before expiry and writes them back to `auth.json`. Providers unknown to the registry fall back to reading `auth.json` directly.
- API keys reuse pi's interpolation rules (`$ENV` / `${ENV}`, `$$` / `$!` escapes, `!command`).
- The usage endpoints are undocumented provider APIs and may change or throttle; query frequency is capped by the TTL.

## Install

```sh
pi install npm:@aaroncarry/pi-usage
```

Or add the package to `settings.json` manually, or point at a local checkout while developing:

```json
{
  "packages": ["npm:@aaroncarry/pi-usage"]
}
```

## Configuration

Optional config file `<agentDir>/usage.json`:

```json
{
  "intervalMinutes": 5,
  "status": "active",
  "providers": {
    "zai": { "region": "cn", "label": "GLM" },
    "deepseek": { "enabled": false },
    "lingsuan": {
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

- DeepSeek usage data lives behind the platform web session and cannot be queried with the API key; only the balance is shown.
- The `$` figure shown for subscription (OAuth) accounts is pi's list-price estimate, not an actual charge; real consumption is the server-side quota window.
- The panel and status line are TUI features; the `/usage` card itself is written in every mode.
