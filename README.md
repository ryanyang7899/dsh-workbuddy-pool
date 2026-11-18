# dsh-workbuddy-pool

DeepSeek Harness 插件：在**左侧边栏底部**显示 Workbuddy（workbuddy2api）号池的实时状态。

- **折叠态**：一行 `● 10,035 积分`，状态点灰=空闲 / 绿=有请求在途 / 红=面板连不上
- **点击展开**：剩余总积分、今日消耗（积分 + tokens）、在途账号、调用模型、
  实时生成速度（tok/s）、每个账号的积分与最近速度、面板健康与更新时间、手动刷新

## 安装

插件是一个标准 DSH bundle，两种装法任选：

**A. 图形界面**（推荐）

1. 解压 `dsh-workbuddy-pool-1.0.0.tgz`，或直接用解压后的目录
2. 打开 DSH → **插件** → **添加插件** → 选择该目录
3. 在插件列表里确认 `Workbuddy 号池计量` 已启用，然后 **整页刷新**（Cmd/Ctrl+R）

**B. 命令行**

```sh
dsh plugin --profile <你的 profile> add /path/to/dsh-workbuddy-pool
```

装好后**整页刷新**一次：client 模块是新增的，热更新覆盖不到。

## 配置（设置界面里直接改）

装好后打开 **设置 → Workbuddy 号池**：

| 控件 | 说明 |
| --- | --- |
| 面板地址 | 留空 = 自动探测本机 `7863`；面板在别的机器就填 `http://地址:7863` |
| 面板 API Key | 只写不读，已配置时只显示来源；有「清除密钥」 |
| 轮询间隔 / 今日用量间隔 / 请求超时 | 秒为单位，保存即生效，不用重启 |
| 测试连接 | 只探一次，不动缓存，失败会说明是「不可达」还是「密钥被拒(401)」 |

设置存在 `$DSH_HOME/workbuddy-pool.json`（0600），密钥单独存在
`$DSH_HOME/workbuddy-panel.key`（0600）——设置文件不含任何秘密。

## 配置（YAML 方式，可选）

面板地址和密钥都在插件配置里（写入 profile 的 `cordis.patch.yml`）：

```yaml
- id: workbuddy-pool
  name: 'dsh-workbuddy-pool'
  config:
    baseUrl: 'http://100.66.1.3:7863'   # 面板地址；留空 = 自动探测本机 7863
    apiKey: ''                          # 留空 = 读下面的密钥文件
    intervalMs: 15000                   # Host 轮询间隔
    usageIntervalMs: 60000              # 今日用量重取间隔
    timeoutMs: 8000
```

密钥（面板 `config.json` 里的 `api_key`，等同管理员权限）按优先级取：

1. 配置里的 `apiKey`
2. 环境变量 `WORKBUDDY_PANEL_KEY`
3. 文件 `~/.dsh/workbuddy-panel.key`（**推荐**，一行、权限 600）

```sh
printf '%s\n' '<panel api_key>' > ~/.dsh/workbuddy-panel.key
chmod 600 ~/.dsh/workbuddy-panel.key
```

Host 每次轮询都重读密钥文件，轮换密钥不用重启 Harness。密钥不进日志、不进页面、
不随快照下发。

## 面板端要求

本插件只读调用面板已有的管理 API，**不需要改面板**：

| 端点 | 用途 |
| --- | --- |
| `GET /panel/api/overview` | 账号、积分、在途数、健康状态 |
| `GET /panel/api/request_metrics` | `active[]`：在途请求的账号、模型、已生成 token、实时 tok/s |
| `GET /panel/api/usage?from=<今日0点>` | 今日消耗（积分 / tokens） |

`active[]` 是 workbuddy2api 的一个补丁字段（`internal/reqlog` 的在途表）。
面板若是**未打该补丁的旧版本**，插件仍能工作，只是「在途账号 / 模型 / 速度」会退化成
`in_flight` 计数与「最近一次请求」的模型。

## 版式与位置

插件加载时自动选位：读 `ctx.slots.spec()` / `ctx.slots.entriesOfSlot()`，
`list` 类槽位可叠加、`single` 类只在空着时才装（不抢别人的位），一个都装不了就
打日志放弃而不是硬塞。落点之后按同槽 occupant 的 `order` 把自己排在
「远程控制」那一行**之上**（没有它则落在最下面、贴近账户行）。

行高、字号、圆角、内边距都对齐同一槽位里紧邻的那一行（42px 高、`padding 0 10px 0 8px`、
圆角 12px、主文字 14px、尾部计数 12px tabular-nums；侧栏收起时 36×36 圆形）。

细节见 [docs/DETAIL.md](docs/DETAIL.md)。

## 边界

- 余额由面板每 5 分钟向上游刷新一次（面板配置 `schedule.balance_refresh_minutes`），
  所以「剩余总积分」最多滞后 5 分钟；在途与速度是实时的。
- 生成速度是**帧计数**估算（上游流式响应一帧≈一 token），流结束后面板的
  `usage.completion_tokens` 才是权威值。
- 面板不可达时显示「离线」并保留最后一次成功的数据，不会清空。

## License

MIT
