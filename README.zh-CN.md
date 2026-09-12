# pi-usage

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个 [pi](https://github.com/earendil-works/pi) 扩展：查看各订阅账号的余额与用量窗口——footer 状态行常显当前账号，`/usage` 卡片查看全部明细。查询方法参考
[CodexBar](https://github.com/steipete/CodexBar)，凭据直接复用 pi 统一存储的
`auth.json`，不读取任何第三方凭据文件。

## 效果

footer 状态行（默认模式）跟随当前模型，显示其额度窗口、本次会话消耗和 7 天迷你趋势：

```
Codex 5h 13% · weekly 2% · session 10.0k tok $0.020 · 7d ▁▁▁▁▁█▂ 66k
```

`/usage` 向会话流打印一张卡片（自定义条目渲染——非弹窗、不抢焦点）：

```
 Usage · 02:15

 ● Codex (Plus)
   5h      ░░░░░░░░░░   0% · resets in 4h 54m
   weekly  ░░░░░░░░░░   2% · resets in 6d 17h
 ○ GLM
   Balance ¥21.46  recharged ¥118.00 · spent ¥96.54
 ○ DeepSeek
   Balance ¥38.48
 Last 30 days ────────────────────────────
 tokens ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂▆███ 66k
   gpt-5.6-luna  █████████████████░░░ 70%  34k
   gpt-5.6-terra █████░░░░░░░░░░░░░░░ 21%  10k
```

`/usage trends` 打开交互式仪表盘（Charts / Heatmap / Table 三个视图），基于全部会话历史——盲文时间序列（按模型分组）、12 周活动热力图（含连续天数）、厂商→模型明细表（会话/消息/费用/tokens/缓存）：

```
 Usage trends      [Charts]  Heatmap  Table
 Total 66k tok · $0.04 · peak 39k (9/13)
   39k ┤                                      ⢸⡄
       │                                      ⣿⠘⡄
     0 └⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣸⣔⣱⠑⢼
        08-28                  09-13
 Provider / Model     Sessions  Msgs  Cost  Tokens  ↑In   ↓Out  Cache
 ▾ openai-codex               -    16 $0.04    44k   39k   5.3k   150k
    gpt-5.6-luna              1    14 $0.01    34k   29k   5.2k   140k
```

趋势数据聚合自 pi 的会话文件（`<agentDir>/sessions/**/*.jsonl`），带增量磁盘缓存；分叉会话副本自动去重。Token 口径 = input + output + cache 写入。

## 命令

| 命令 | 作用 |
|---|---|
| `/usage` | 向会话流打印用量卡片（余额 + 30 天摘要）。重复执行即刷新：5 分钟 TTL 内秒回，过期则重新拉取（15 秒超时）。卡片留存在会话里，`/reload`、恢复旧会话时自动重放 |
| `/usage trends` | 打开交互式趋势仪表盘（Charts / Heatmap / Table；`m` 切指标，`←→` 切周期，`v` 切视图，`↑↓`+`enter` 展开表格） |
| `/usage active\|all\|off` | 立即切换 footer 状态行模式，并持久化到 `usage.json`（输入时有补全） |
| `pi --usage-status all` | 指定本次运行的 footer 模式（覆盖 `usage.json`，不写回文件） |

优先级：`/usage <mode>`（会话内）> `--usage-status`（本次启动）> `usage.json`（持久）。

## footer 状态行

| 模式 | 显示内容 |
|---|---|
| `active`（默认） | 当前模型对应账号的全部窗口 + 余额，末尾追加会话消耗。切换模型即时跟随 |
| `all` | 全部账号压成一行——当前账号在前、正常亮度，其余置灰，消耗段固定在行尾 |
| `off` | 整行隐藏 |

- 消耗段（`session <tokens> tok`）每轮对话结束**即时更新**（本地数据，与 pi footer 同口径）。真实费用仅在非零时追加（`· $0.020`）——订阅账号恒为 0，自动省略。
- 账号查询失败时显示红色的 `账号名 !`。

## 支持的账号

auth.json 里有凭据的自动识别，无需配置：

| auth.json key | 查询接口 | 显示内容 |
|---|---|---|
| `openai-codex` | `GET chatgpt.com/backend-api/wham/usage`（Bearer OAuth token） | 5h/周窗口、credits、月度花销上限 |
| `anthropic` | `GET api.anthropic.com/api/oauth/usage`（Claude Code OAuth token，`anthropic-beta: oauth-2025-04-20`） | 5h/周窗口、extra usage |
| `github-copilot` | `GET github.com/copilot_internal/user`（GitHub OAuth token，`token` scheme） | premium/chat 配额窗口、计划、重置日期 |
| `openrouter` | `GET openrouter.ai/api/v1/credits`（API key 或 OAuth token） | 预付余额 |
| `zai` | `GET api.z.ai/api/monitor/usage/quota/limit`（CN 区 `open.bigmodel.cn`），无 coding plan 时回退 bigmodel.cn 余额接口 | 5h/周/MCP 窗口或人民币余额 |
| `deepseek` | `GET api.deepseek.com/user/balance` | 账户余额 |
| 其他任意已配置厂商 | **自动探测**（见下）：依次尝试 New API（`/dashboard/billing/*`）、Sub2API（`/usage`）、MiniMax、智谱等中转计费协议 | 余额或计划窗口，取决于网关暴露的接口 |
| 任意自定义 provider | 配置驱动的通用适配器（见下） | 余额 / 窗口 |

### 自定义厂商的自动探测

pi 里没有专用适配器的厂商（例如通过
[pi-provider-hub](https://github.com/aaroncarry/pi-provider-hub) 或 `models.json` 配置的中转），
会基于 registry 中的 baseUrl 和已存凭据自动探测：

- **New API** 网关：`dashboard/billing/subscription` + `dashboard/billing/usage`
  （可用时再加 `/api/usage/token/`）→ 剩余美元余额与 used/total 明细。
- **Sub2API** 网关：`usage` → 剩余余额。
- `api.deepseek.com`、MiniMax 各域名、`open.bigmodel.cn` / `api.z.ai` 按域名固定协议。

命中的协议在会话内固定；所有候选都拒绝（如 HTTP 404/401）时显示
"no balance endpoint detected"，且不会每次刷新都重复探测；瞬时网络错误会自动重试。
在 usage.json 里设 `"autoDetect": false` 可全局关闭，或 `providers.<id>.enabled: false` 单独隐藏。

## 凭据与安全

- OAuth token 经 pi 的 model registry 解析（`getProviderAuth`），临期自动刷新并写回 auth.json；registry 不认识的 provider 回退为直读 auth.json。
- API key 复用 pi 的插值规则（`$ENV`/`${ENV}`、`$$`/`$!` 转义、`!command`）。
- 用量接口均为未公开接口，可能随服务商改版失效；查询频率受 TTL 限制。

## 安装

```sh
pi install npm:@aaroncarry/pi-usage
```

或在 settings.json 的 `packages` 里手动添加，开发期也可以指向本地目录：

```json
{
  "packages": ["npm:@aaroncarry/pi-usage"]
}
```

## 配置

可选配置文件 `<agentDir>/usage.json`：

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

- `intervalMinutes`：后台刷新间隔（默认 5，最小 1）。
- `status`：`active`（默认）/ `all` / `off`。
- `sparkline`：设为 `false` 移除 footer 状态行的 7 天迷你趋势。
- `autoDetect`：设为 `false` 关闭对未知厂商的余额端点自动探测。
- `providers.<id>.enabled: false`：从状态行和卡片隐藏某账号。
- `providers.<id>.label`：显示名覆盖。
- `providers.<id>.region`：z.ai 区域 `auto`（默认）/`global`/`cn`。
- `custom`：通用适配器，接入任意 JSON 接口——`headers` 支持 `$ENV` 插值和 `{token}` 占位符（取该 provider 在 auth.json 里的凭据，若有）；`balancePath`/`windowsPath` 为 JSON 点路径（如 `data.list[0].percent`）。

## 开发

```sh
npm install --ignore-scripts
npm run typecheck
npm test
```

改完代码在 pi 里 `/reload` 即可生效（本地路径是原地引用）。

## 已知限制

- Kimi Coding（`kimi-coding`）暂不支持：pi 存的是 `api.kimi.com/coding` 的 token，尚未验证到接受它的用量接口。
- Claude、Copilot、OpenRouter 适配器的端点与响应结构照搬 CodexBar 的实现，尚未用真实账号验证过；欢迎带实际响应 payload 提 issue。
- DeepSeek 的用量数据在平台网页 session 后面，API key 查不到，只显示余额。
- 订阅账号（OAuth 登录）显示的 `$` 是 pi 按模型目录单价估算的理论费用，并非真实扣费；真实消耗以服务端额度窗口为准。
- 状态行是 TUI 特性；`/usage` 卡片在任意模式下都会写入会话。
