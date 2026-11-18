# Workbuddy 号池计量

在 DeepSeek Harness 侧栏底部（账户信息之上）显示 Workbuddy 号池的实时状态。

## 显示什么

折叠状态只有一行：剩余总积分 + 状态点。

- 灰点 = 号池空闲
- 绿点（呼吸）= 有请求在途
- 红点 = 连不上面板（此时数字显示 `—`，悬停可见错误原因）

点击展开：

| 行 | 内容 |
| --- | --- |
| 剩余总积分 | 号池所有账号 `credits` 之和 |
| 今日消耗 | 今日 0 点起消耗的积分与总 token |
| 在途账号 | 正在被调用的账号（多个时显示 `+N`）与阶段（等首 token / 生成中） |
| 调用模型 | 该在途请求实际使用的模型 |
| 生成速度 | 该请求的实时 tok/s 与已生成 token 数 |
| 账号明细 | 每个账号的剩余积分与最近一次请求速度，在途账号高亮 |
| 脚注 | 面板健康状态、最后更新时间、手动刷新 |

## 数据从哪来

浏览器不直接访问面板：面板的 `/panel/api/*` 没有 CORS 头，页面跨源会被挡。所以
Host 半替页面去拉，并把结果缓存在内存里，页面每 5 秒读一次本插件的
`GET /workbuddy-pool/api`（只读）。

页面用的是**文档相对路径**，由承载网页的那一层解析：

- Web：页面与 Host 同源，相对路径直连。
- Desktop：页面跑在 `dsh-app://app`，该协议处理器把非静态路径原样转发给 Host 的
  HTTP 服务并注入认证 Cookie，因此相对路径同样可用、天然同源。
- 兜底：页面不是从 Host 源加载时，退回 `__DSH_TRANSPORT__.fetch` 载体代理。

Host 侧轮询的端点（全部只读，`Authorization: Bearer <api_key>`）：

- `/panel/api/overview` — 账号、积分、在途数、健康状态
- `/panel/api/request_metrics` — `active[]`：在途请求的账号、模型、已生成 token、实时 tok/s
- `/panel/api/usage?from=<今日0点>` — 今日消耗（积分 / token）

`active[]` 与其中的实时速度来自配套的 workbuddy2api 补丁（`internal/reqlog` 的在途表）。
面板若是未打补丁的旧版本，本插件仍能工作，只是「在途账号 / 模型 / 速度」退化为
`in_flight` 计数与「最近一次请求」的模型，脚注会显示「空闲」或旧值。

## 安装时自动选位

插件加载时（即装好之后第一次运行）不写死槽位，而是问宿主要答案：

1. `ctx.slots.spec(key)` 读槽位声明（`single` / `list` / `keyed` / `hoc`）；
2. `ctx.slots.entriesOfSlot(key)` 读当前占用者；
3. `list` 类永远可叠加，`single`/`keyed`/`hoc` 只有空着才装 —— **不抢别人的位**；
4. 一个都装不了时打一行 `console.warn` 并放弃，而不是硬塞进去把界面搞坏。

落点之后还要算「空位」：读同一槽位里所有 occupant 的 `order`，把自己排在
**「远程控制」那一行（`agents-anywhere-next`）之上**；没有那一行就落在整摞最下面
（贴近账户行，也就是最初要求的"账户信息之上"）。这个计算幂等——把自己算出来的
结果再喂回去，答案不变，所以重复调用不会抖动。

激活顺序不确定（别的 occupant 可能比本插件晚注册），所以 `apply` 之后还会补一次
`setTimeout(0)` 复核，顺序变了就挪到新算出来的空位。

**诚实的边界**：左侧边栏一共有 6 个 `single` 座位（`brand.mark`、`brand.name`、
`toggle.badge`、`settings`、`workspaces`、`workspaces.directoryFlow`），全被宿主或
官方插件占着；其余 `list` 座位是「面板图标行」(`sidebar.panellist`) 和「更多菜单
行」(`sidebar.panellist.actions`)，形状对不上状态行。**唯一既可见、可点、又可叠加
的座位就是 `sidebar.footer.action`**，所以在本机它必然落在这里。检测的价值是：
换到没有 `ui-sidebar` 或没有该槽位的环境时不会盲注册失败，以及位置随占用者自动排。

## 版式与位置

折叠行紧贴 `sidebar.footer.action` 里「远程控制」那一行之上，尺寸与它逐项对齐：
外层 42px 高 + `8px` 上边距，按钮 42px 高、`gap 8px`、`padding 0 10px 0 8px`、
圆角 12px、主文字 14px，尾部「积分」12px 三级色 + `tabular-nums`；侧栏收起时
与邻居一样是 36×36 圆形。

**为什么要多一条样式**：`SidebarRoot.module.css` 的 `.footerActions` 是
`display: flex` 的**不换行横向行**，而每个 occupant 都按"独占一行"的尺寸写
（Cordis 徽标行 `width:100%; flex:none`，「远程控制」`width:calc(100%+4px)`）。
多个 occupant 挤在一行时会互相压扁：实测 240px 侧栏里「远程控制」被挤成 4px、
本插件那行盖在它上面。所以本插件注入一条最小的样式，只给那一行加
`flex-wrap: wrap`（选择器走 DSH 自己的 `[data-slot]` 寻址面，不猜宿主哈希类名），
并把自己声明为 `flex: 1 0 100%` 独占一行、`order: 10` 排在「远程控制」(26) 之前。

Chromium 实测（240px 侧栏，真实宿主 CSS + 两个邻居的真实 CSS + 本插件真实 DOM）：

```
cordis  y=16  w=240  可见=240
mine    y=66  w=240  可见=240   ← 本插件，独占一行
aa      y=112 w=244  可见=240   ← 远程控制，完整显示
OK 无重叠 / OK 本插件在远程控制之上
```

副作用：该行以后每个全宽 occupant 都会各占一行（这本就是它们 CSS 假定的布局）。

## 在设置界面里配置

装好后打开 **设置 → Workbuddy 号池**，全部是可直接编辑的控件，保存即生效（不需要重启）：

| 控件 | 说明 |
| --- | --- |
| 面板地址 | 留空 = 自动探测 `http://127.0.0.1:7863` / `localhost:7863`；填了就以它为准 |
| 面板 API Key | 只写不读：已配置时显示「已配置（来源：…）」，留空表示不修改；另有「清除密钥」 |
| 轮询间隔（秒） | Host 多久拉一次面板，2–300 |
| 今日用量刷新间隔（秒） | 比 overview 重，5–600 |
| 请求超时（秒） | 单次访问面板的超时，1–60 |
| 测试连接 / 保存 | 测试只探一次不动缓存；保存落盘并立即按新配置取数 |

设置写在 `$DSH_HOME/workbuddy-pool.json`（0600），密钥单独写在
`$DSH_HOME/workbuddy-panel.key`（0600）——设置文件里**不含任何秘密**。

为什么不用 `configEditor`：它会按 Loader 的常规生命周期重载插件，正在返回的那次
响应会被打断；而这些字段只需要就地生效。插件自有状态放 `$DSH_HOME` 下也有先例
（如 `dream-skin.json`），且不碰用户 profile 的 patch 文件。

配置优先级（后者覆盖前者）：内置默认值 < profile 的 `cordis.patch.yml` 行配置
< `workbuddy-pool.json`。密钥优先级：行配置 `apiKey` > 环境变量
`WORKBUDDY_PANEL_KEY` > `workbuddy-panel.key`。

写端点带来源栅栏：带非回环 `Origin` 或非 JSON `Content-Type` 的 POST 一律 403
（Desktop 的 `dsh-app` 转发会剥掉 `Origin`，属可信来源）。

## 配置（YAML 方式，可选）

在「插件」里打开本插件的配置（写入 profile 的 `cordis.patch.yml`，权限 0600）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://100.66.1.3:7863` | 面板根地址 |
| `apiKey` | 空 | 面板主密钥；留空则依次读 `WORKBUDDY_PANEL_KEY` 环境变量、`~/.dsh/workbuddy-panel.key` |
| `intervalMs` | `15000` | Host 轮询面板的间隔 |
| `usageIntervalMs` | `60000` | 今日用量的重取间隔（比 overview 重） |
| `timeoutMs` | `8000` | 单次上游请求超时 |

主密钥的推荐放法是单行文件（本机已按此配置）：

```sh
printf '%s\n' '<panel api_key>' > ~/.dsh/workbuddy-panel.key
chmod 600 ~/.dsh/workbuddy-panel.key
```

Host 每次轮询都重读这个文件，所以轮换密钥不用重启 Harness。密钥不会出现在
日志、页面或快照里，也不会写进 `cordis.patch.yml`。

## 边界

- 余额由面板每 5 分钟向上游刷新一次（面板配置 `schedule.balance_refresh_minutes`），
  所以「剩余总积分」最多滞后 5 分钟；在途与速度是实时的。
- 生成速度是**帧计数**估算：上游流式响应里每个带 delta 的帧约等于 1 个 token
  （实测 86 token == 86 帧），因此流结束前就能给出速度；流结束后面板的精确
  `usage.completion_tokens` 才是权威值。
- 面板不可达时插件显示「离线」并保留最后一次成功的数据，不会清空。
