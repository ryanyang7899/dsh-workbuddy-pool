/**
 * dsh-workbuddy-pool — Client half.
 *
 * 在侧栏底部（`sidebar.footer.action`，正好在左下角账户信息之上）画一行号池状态：
 * 折叠时只显示剩余总积分，点击展开显示在途账号 / 模型 / 生成速度 / 今日消耗。
 *
 * 数据来自本插件 Host 半的 `/workbuddy-pool/api`（Host 侧缓存 + 轮询面板），
 * 这里只做 5 秒一次的同源读取，不直接打面板（面板没有 CORS 头）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-pool',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /**
     * 侧栏里**可叠加**（list 类）且用户能看见、能点的座位。`single` 类座位
     * （brand.mark / brand.name / toggle.badge / settings / workspaces）都由宿主
     * 或官方插件占着，抢不了也不该抢；其余 list 座位是「面板图标行」和「更多菜单
     * 行」，形状对不上状态行。所以候选只有这一个——检测的作用是**确认它存在、
     * 确认它是 list**，而不是盲写一个 key 进去。
     */
    const SLOT_CANDIDATES = ['sidebar.footer.action']

    /** 用来认出「远程控制」那一行的注册 id（@agents-anywhere/dsh-bridge-next）。 */
    const REMOTE_CONTROL_ID = /agents-anywhere/i

    /**
     * 让 `sidebar.footer.action` 的容器允许换行。
     *
     * 宿主 `.footerActions` 是 **nowrap 的横向 flex 行**，而每个 occupant 都按
     * "独占一行"的尺寸写（Cordis 徽标行 `width:100%;flex:none`，「远程控制」
     * `width:calc(100%+4px)`）。多个 occupant 挤在一行会互相压扁：实测 240px
     * 侧栏里「远程控制」被挤成 4px、本插件那行盖在它上面。
     *
     * 选择器走 DSH 自己的 `[data-slot]` 寻址面（渲染层把它当动态样式的接缝），
     * 不猜宿主哈希类名；只加 `flex-wrap`，不覆盖任何其他样式。
     */
    function footerWrapCss(slotKey) {
      return `div:has(> [data-slot="${slotKey}"]) { flex-wrap: wrap; }`
    }

    /** 读槽位声明（kind / children）；API 缺失时返回 undefined 而不是抛。 */
    function slotSpec(slots, key) {
      try {
        return typeof slots.spec === 'function' ? slots.spec(key) : undefined
      } catch {
        return undefined
      }
    }

    /** 读槽位当前的占用者（影子赢家）；失败一律当空列表。 */
    function slotOccupants(slots, key) {
      try {
        const rows = typeof slots.entriesOfSlot === 'function' ? slots.entriesOfSlot(key) : []
        return Array.isArray(rows) ? rows : []
      } catch {
        return []
      }
    }

    /**
     * 挑一个能装的座位：
     *  - 声明存在；
     *  - list 类永远可叠加；single/keyed/hoc 类只有空着才装（不抢别人的位）。
     * 返回 `{ key, kind, occupants }`，全都不可用时返回 null。
     */
    function pickSlot(slots) {
      for (const key of SLOT_CANDIDATES) {
        const spec = slotSpec(slots, key)
        const occupants = slotOccupants(slots, key)
        if (spec === undefined) {
          // 声明还没出现：inject 会等它出现，这里按 list 语义先占位，不因为读不到就放弃。
          return { key, kind: 'list', occupants }
        }
        const kind = typeof spec.kind === 'string' ? spec.kind : 'list'
        // list 永远可叠加；single/keyed/hoc 只有空着才装——不抢别人的位。
        if (kind === 'list' || occupants.length === 0) return { key, kind, occupants }
      }
      return null
    }

    /**
     * 算一个「空闲位置」的 order：紧挨在「远程控制」那一行**之上**（这就是它上方
     * 那格空位）；没有那一行时落在整摞的最下面（贴近账户行，即最初要求的
     * "账户信息之上"）。occupied 里的自己会被排除，所以重复计算是幂等的。
     */
    function pickOrder(occupants, selfId) {
      const others = occupants
        .filter((entry) => entry && entry.options && entry.options.id !== selfId)
        .map((entry) => ({
          id: String(entry.options.id ?? ''),
          order: Number.isFinite(entry.options.order) ? entry.options.order : 0,
        }))
      const remote = others.find((entry) => REMOTE_CONTROL_ID.test(entry.id))
      if (remote !== undefined) return remote.order - 1
      if (others.length === 0) return 0
      return Math.max(...others.map((entry) => entry.order)) + 1
    }

    const ROUTE = '/workbuddy-pool/api'
    const CLIENT_POLL_MS = 5000
    const POPOVER_WIDTH = 320

    /* ── 取数 ──────────────────────────────────────────────────────── */

    /** 浏览器本地的「今日 0 点」unix 秒，交给 Host 去切 /panel/api/usage。 */
    function localMidnight() {
      const now = new Date()
      return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime() / 1000)
    }

    /**
     * 读 Host 的快照。路径一律用**文档相对路径**，由承载网页的那一层去解析：
     *
     *  - Web：页面与 Host 同源，相对路径直连。
     *  - Desktop：页面跑在 `dsh-app://app`，该协议处理器把非静态路径转发给 Host
     *    的 HTTP 服务并注入 Cookie（见桌面 main.js 的 protocol.handle），所以相对
     *    路径同样可用，且天然同源、不涉及 CORS。
     *  - 兜底：若页面不是从 Host 源加载，`__DSH_TRANSPORT__.fetch` 是载体提供的
     *    同签名代理，按契约接收"文档相对路由"。
     */
    async function requestJson(path, init) {
      const options = Object.assign({ credentials: 'same-origin' }, init)
      const transport = globalThis.__DSH_TRANSPORT__
      const attempts = [() => fetch(path, options)]
      if (transport && typeof transport.fetch === 'function') {
        attempts.push(() => transport.fetch(path, options))
      }
      let lastError = new Error('没有可用的取数通道')
      for (const attempt of attempts) {
        try {
          const res = await attempt()
          if (!res) throw new Error('空响应')
          const data = await res.json().catch(() => undefined)
          if (!res.ok) throw new Error((data && data.error) || `接口返回 HTTP ${res.status}`)
          if (data && typeof data === 'object') return data
          throw new Error('响应不是 JSON')
        } catch (failure) {
          lastError = failure
        }
      }
      throw lastError
    }

    async function readSnapshot(refresh) {
      const path = `${ROUTE}?from=${localMidnight()}${refresh ? '&refresh=1' : ''}`
      const data = await requestJson(path, { method: 'GET', headers: { accept: 'application/json' } })
      if (!('ok' in data)) throw new Error('响应不是本插件的快照')
      return data
    }

    /* ── 格式化 ───────────────────────────────────────────────────── */

    function fmtInt(value) {
      return Number.isFinite(value) ? Math.round(value).toLocaleString('zh-CN') : '—'
    }

    function fmtCredits(value) {
      if (!Number.isFinite(value)) return '—'
      return value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    }

    function fmtTokens(value) {
      if (!Number.isFinite(value)) return '—'
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
      return String(Math.round(value))
    }

    function fmtRate(value) {
      return Number.isFinite(value) && value > 0 ? `${value.toFixed(1)} tok/s` : '—'
    }

    function bareModel(model) {
      const text = String(model || '')
      if (text === '') return '—'
      return text.replace(/^(cn|global):/i, '')
    }

    function nickOf(label, nickname) {
      if (nickname) return nickname
      const text = String(label || '')
      const matched = /^(.*?)\(([0-9a-zA-Z]{4,})\)$/.exec(text)
      if (matched) return matched[1] !== '' ? matched[1] : matched[2].slice(0, 8)
      return text !== '' ? text : '—'
    }

    function clockOf(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    function stageText(active) {
      if (!active) return '空闲'
      if (active.stage === 'streaming') return '生成中'
      if (active.stage === 'waiting_first_token') return '等首 token'
      if (active.stage === 'awaiting_sync_result') return '等上游结果'
      return '调用中'
    }

    /* ── 视觉 ─────────────────────────────────────────────────────── */

    const COLOR = {
      primary: 'var(--dsw-alias-label-primary, #1f2329)',
      secondary: 'var(--dsw-alias-label-secondary, #4e5969)',
      tertiary: 'var(--dsw-alias-label-tertiary, #86909c)',
      border: 'var(--dsw-alias-border-l2, rgba(0,0,0,.08))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))',
      surface: 'var(--dsw-alias-bg-layer-2, #ffffff)',
      success: 'var(--dsw-alias-state-success-primary, #00b42a)',
      warn: 'var(--dsw-alias-state-warn-primary, #ff7d00)',
      error: 'var(--dsw-alias-state-error-primary, #f53f3f)',
      idle: 'var(--dsw-alias-label-tertiary, #86909c)',
    }

    function Btn(props) {
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        title: props.title,
        className: props.className,
        style: Object.assign({
          appearance: 'none',
          border: '1px solid transparent',
          background: 'transparent',
          color: COLOR.secondary,
          font: 'inherit',
          fontSize: 11,
          lineHeight: '18px',
          padding: '0 6px',
          borderRadius: 6,
          cursor: 'pointer',
        }, props.style || {}),
      }, props.children)
    }

    function Row(props) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: 12, padding: '3px 0',
        },
      },
      h('span', { style: { color: COLOR.tertiary, fontSize: 11, whiteSpace: 'nowrap' } }, props.label),
      h('span', {
        style: {
          color: props.strong === true ? COLOR.primary : COLOR.secondary,
          fontSize: props.strong === true ? 12.5 : 12,
          fontWeight: props.strong === true ? 600 : 400,
          textAlign: 'right', wordBreak: 'break-word',
        },
      }, props.children))
    }

    function Divider() {
      return h('div', { style: { height: 1, background: COLOR.border, margin: '6px 0' } })
    }

    /** 展开面板：在途 → 账号明细 → 状态脚注。 */
    function Details(props) {
      const snap = props.snapshot
      const totals = snap ? snap.totals : null
      const accounts = snap ? snap.accounts : []
      const activeList = snap ? snap.active : []
      const today = snap ? snap.today : null
      const panel = snap ? snap.panel : null
      const active = activeList.length > 0 ? activeList[0] : null

      const statusColor = props.error !== ''
        ? COLOR.error
        : panel && panel.healthy !== false
          ? COLOR.success
          : COLOR.warn
      const statusText = props.error !== ''
        ? '离线'
        : panel && panel.healthy !== false
          ? '正常'
          : '异常'

      return h('div', {
        style: {
          position: 'fixed',
          left: props.anchor.left,
          bottom: props.anchor.bottom,
          width: POPOVER_WIDTH,
          maxHeight: '70vh',
          overflowY: 'auto',
          background: COLOR.surface,
          border: `1px solid ${COLOR.border}`,
          borderRadius: 12,
          boxShadow: '0 10px 30px rgba(0,0,0,.16)',
          padding: '10px 12px 8px',
          zIndex: 2147483000,
          color: COLOR.primary,
          fontSize: 12,
          lineHeight: 1.5,
          backgroundClip: 'padding-box',
        },
      },
      h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
      },
      h('span', { style: { fontWeight: 600, fontSize: 12.5 } }, 'Workbuddy 号池'),
      h(Btn, {
        title: '立即刷新',
        onClick: (event) => { event.stopPropagation(); props.onRefresh() },
        style: {
          opacity: props.busy ? 0.5 : 1,
          pointerEvents: props.busy ? 'none' : 'auto',
        },
      }, props.busy ? '刷新中…' : '刷新')),

      h(Row, { label: '剩余总积分', strong: true }, totals ? fmtInt(totals.credits) : '—'),
      h(Row, { label: '今日消耗' }, today
        ? `${fmtCredits(today.credits)} 积分 · ${fmtTokens(today.tokens)} tokens`
        : '—'),

      h(Divider),

      h(Row, { label: '在途账号' }, active
        ? `${nickOf(active.account)} · ${stageText(active)}${activeList.length > 1 ? ` +${activeList.length - 1}` : ''}`
        : '空闲'),
      h(Row, { label: '调用模型' }, active ? bareModel(active.model) : '—'),
      h(Row, { label: '生成速度' }, active
        ? `${fmtRate(active.tokensPerSecond)}${active.completionTokens > 0 ? ` · ${fmtInt(active.completionTokens)} tok` : ''}`
        : '—'),

      accounts.length > 0 ? h(Divider) : null,
      accounts.length > 0
        ? h('div', {
          style: { display: 'flex', justifyContent: 'space-between', color: COLOR.tertiary, fontSize: 10.5, padding: '0 0 2px' },
        }, h('span', null, '账号'), h('span', null, '积分 / 最近速度'))
        : null,
      ...accounts.map((account) => h('div', {
        key: account.uid || account.nickname,
        style: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '2px 0' },
      },
      h('span', {
        style: {
          color: account.inFlight > 0 ? COLOR.success : COLOR.secondary,
          fontWeight: account.inFlight > 0 ? 600 : 400,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      }, nickOf('', account.nickname) + (account.disabled ? '（停用）' : '')),
      h('span', { style: { color: COLOR.secondary, whiteSpace: 'nowrap' } },
        `${fmtInt(account.credits)} / ${fmtRate(account.rate)}`))),

      h(Divider),
      h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 10.5, color: COLOR.tertiary },
      },
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
        h('span', {
          style: {
            width: 6, height: 6, borderRadius: '50%', background: statusColor,
            display: 'inline-block',
          },
        }),
        `${statusText}${props.stale ? '（旧数据）' : ''}`),
      h('span', null, `更新 ${clockOf(props.fetchedAt)}`)),

      props.error !== ''
        ? h('div', { style: { marginTop: 6, color: COLOR.error, fontSize: 10.5, wordBreak: 'break-all' } }, props.error)
        : null)
    }

    /* ── 组件 ─────────────────────────────────────────────────────── */

    function PoolWidget(props) {
      const wide = props.wide !== false
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState({ left: 8, bottom: 8 })
      const [hover, setHover] = useState(false)
      const [busy, setBusy] = useState(false)
      const triggerRef = useRef(null)
      const popoverRef = useRef(null)

      const apply = useCallback((result) => {
        if (result && typeof result === 'object') {
          setData(result)
          setError(typeof result.error === 'string' && result.snapshot === null ? result.error : '')
        }
      }, [])

      const load = useCallback(async (force) => {
        try {
          apply(await readSnapshot(force === true))
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        }
      }, [apply])

      useEffect(() => {
        let cancelled = false
        const tick = async () => {
          if (document.hidden) return
          try {
            const result = await readSnapshot(false)
            if (!cancelled) apply(result)
          } catch (failure) {
            if (!cancelled) setError(failure && failure.message ? failure.message : String(failure))
          }
        }
        void tick()
        const timer = setInterval(tick, CLIENT_POLL_MS)
        const onVisibility = () => { if (!document.hidden) void tick() }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          cancelled = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [apply])

      // 展开时关闭：点外面、按 Esc、侧栏收起。
      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const target = event.target
          if (triggerRef.current && triggerRef.current.contains(target)) return
          if (popoverRef.current && popoverRef.current.contains(target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      useEffect(() => { if (!wide) setOpen(false) }, [wide])

      const toggle = () => {
        if (open) { setOpen(false); return }
        const rect = triggerRef.current ? triggerRef.current.getBoundingClientRect() : null
        if (rect !== null) {
          const maxLeft = Math.max(8, window.innerWidth - POPOVER_WIDTH - 8)
          setAnchor({
            left: Math.min(Math.max(8, rect.left), maxLeft),
            bottom: Math.max(8, window.innerHeight - rect.top + 8),
          })
        }
        setOpen(true)
        void load(false)
      }

      const snapshot = data && data.snapshot ? data.snapshot : null
      const totals = snapshot ? snapshot.totals : null
      const activeCount = snapshot && Array.isArray(snapshot.active) ? snapshot.active.length : 0
      const credits = totals ? totals.credits : null
      const offline = error !== '' && snapshot === null

      const dotColor = offline
        ? COLOR.error
        : activeCount > 0
          ? COLOR.success
          : COLOR.idle

      const compact = credits === null
        ? (offline ? '—' : '…')
        : (credits >= 1000 ? `${(credits / 1000).toFixed(1)}k` : fmtInt(credits))

      const triggerTitle = snapshot
        ? [
          `剩余总积分 ${fmtInt(totals.credits)}`,
          `今日消耗 ${snapshot.today ? fmtCredits(snapshot.today.credits) : '—'} 积分`,
          activeCount > 0
            ? `在途 ${nickOf(snapshot.active[0].account)} · ${bareModel(snapshot.active[0].model)} · ${fmtRate(snapshot.active[0].tokensPerSecond)}`
            : '当前空闲',
        ].join('\n')
        : (offline ? `连不上 Workbuddy 面板：${error}` : '正在读取 Workbuddy 号池…')

      // 版式对齐紧邻的 `sidebar.footer.action` 邻居（dsh-client-ui-cordis 的徽标行）：
      // 外层 42px 高 + 8px 上边距，按钮 42px 高、gap 8、padding 0 10px 0 8px、
      // 圆角 12、字号 14，尾部计数 12px 三级色 + tabular-nums；收起态是 36×36 圆形。
      // wide：flex-basis 100% 让自己独占一行（配合上面的 wrap），绝不与邻居抢同一行。
      const layerStyle = wide
        ? { position: 'relative', flex: '1 0 100%', minWidth: 0, display: 'flex', alignItems: 'center', height: 42, margin: '8px 0 0' }
        : { position: 'relative', flex: 'none', display: 'flex', alignItems: 'center', width: 36, height: 36, margin: 0 }
      const rowStyle = wide
        ? { display: 'flex', alignItems: 'center', width: '100%' }
        : { display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center', width: '100%' }
      const badgeStyle = wide
        ? {
          display: 'inline-flex', alignItems: 'center', gap: 8,
          width: 'calc(100% + 4px)', height: 42, margin: '0 -2px', padding: '0 10px 0 8px',
          border: 'none', borderRadius: 12, background: hover || open ? COLOR.hover : 'transparent',
          color: COLOR.primary, fontFamily: 'inherit', fontSize: 14, textAlign: 'left',
          cursor: 'pointer', overflow: 'hidden',
        }
        : {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 0,
          width: 36, height: 36, padding: 0, margin: 0,
          border: 'none', borderRadius: '50%', background: hover || open ? COLOR.hover : 'transparent',
          color: COLOR.primary, fontFamily: 'inherit', fontSize: 12,
          cursor: 'pointer', overflow: 'hidden',
        }

      return h(React.Fragment, null,
        h('div', { key: 'layer', style: layerStyle },
          h('div', { style: rowStyle },
            h('button', {
              ref: triggerRef,
              type: 'button',
              title: triggerTitle,
              'aria-expanded': open,
              'aria-label': `Workbuddy 号池，剩余总积分 ${credits === null ? '未知' : fmtInt(credits)}`,
              onClick: toggle,
              onMouseEnter: () => setHover(true),
              onMouseLeave: () => setHover(false),
              style: badgeStyle,
            },
            // 邻居在这个位置放 16px 图标（收起态 18px）；用一个等宽盒子装状态点，
            // 这样文字基线、左右内边距与它完全对齐。
            h('span', {
              style: {
                flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: wide ? 16 : 18, height: wide ? 16 : 18,
              },
            },
            h('span', {
              style: {
                width: wide ? 6 : 8, height: wide ? 6 : 8, borderRadius: '50%',
                background: dotColor, display: 'inline-block',
                boxShadow: activeCount > 0 ? '0 0 0 3px rgba(0, 180, 42, .18)' : 'none',
              },
            })),
            wide
              ? h('span', {
                style: {
                  flex: '1 1 auto', minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontSize: 14, lineHeight: '20px', fontWeight: 400,
                  fontVariantNumeric: 'tabular-nums',
                  color: offline ? COLOR.tertiary : COLOR.primary,
                },
              }, compact)
              : h('span', {
                style: {
                  fontSize: 12, lineHeight: '16px', fontVariantNumeric: 'tabular-nums',
                  color: offline ? COLOR.tertiary : COLOR.primary,
                },
              }, compact),
            wide
              ? h('span', {
                style: {
                  flex: 'none', marginLeft: 'auto', color: COLOR.tertiary,
                  fontSize: 12, lineHeight: '16px', fontVariantNumeric: 'tabular-nums',
                },
              }, '积分')
              : null))),

        open
          ? h('div', { key: 'popover', ref: popoverRef },
            h(Details, {
              snapshot,
              anchor,
              fetchedAt: data ? data.fetchedAt : 0,
              stale: data ? data.stale === true : false,
              error,
              busy,
              onRefresh: async () => {
                setBusy(true)
                await load(true)
                setBusy(false)
              },
            }))
          : null)
    }

    /* ── 设置页（设置 → Workbuddy 号池） ───────────────────────────── */

    // 版式照抄宿主设置页的行：16px 上下内边距、0.5px 分隔线、14px 标题 / 12px 描述。
    const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }
    const ROW_TEXT_STYLE = { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 24 }
    const ROW_TITLE_STYLE = { fontSize: 14, fontWeight: 400, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' }
    const ROW_DESC_STYLE = { fontSize: 12, fontWeight: 400, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
    const INPUT_STYLE = {
      width: 220, height: 36, boxSizing: 'border-box', padding: '0 12px',
      border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md, 8px)',
      background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14,
    }

    function buttonStyle(primary, disabled) {
      return {
        height: 36, padding: '0 16px', boxSizing: 'border-box',
        border: primary ? 'none' : '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: primary ? 'var(--dsw-alias-button-primary-fill)' : 'transparent',
        color: primary ? 'var(--dsw-alias-label-on-color)' : 'var(--dsw-alias-label-primary)',
        font: 'inherit', fontSize: 14, cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }
    }

    function Field(props) {
      return h('div', { style: ROW_STYLE },
        h('div', { style: ROW_TEXT_STYLE },
          h('span', { style: ROW_TITLE_STYLE }, props.title),
          props.desc ? h('span', { style: ROW_DESC_STYLE }, props.desc) : null),
        props.children)
    }

    const TONE_COLOR = {
      info: 'var(--dsw-alias-label-tertiary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    /** 设置 → Workbuddy 号池：面板地址、密钥、三个间隔，全部就地生效。 */
    function SettingsSection() {
      const [config, setConfig] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [form, setForm] = useState({ baseUrl: '', apiKey: '', intervalSec: '15', usageSec: '60', timeoutSec: '8' })
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')

      const applyConfig = useCallback((cfg) => {
        setConfig(cfg)
        setForm({
          baseUrl: cfg.baseUrl ?? '',
          apiKey: '',
          intervalSec: String(Math.round((cfg.intervalMs ?? 15000) / 1000)),
          usageSec: String(Math.round((cfg.usageIntervalMs ?? 60000) / 1000)),
          timeoutSec: String(Math.round((cfg.timeoutMs ?? 8000) / 1000)),
        })
      }, [])

      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const data = await requestJson(`${ROUTE}/config`, { method: 'GET', headers: { accept: 'application/json' } })
            if (cancelled) return
            if (data?.config) applyConfig(data.config)
            // 拿到 200 却没有 config：几乎总是宿主里跑的还是旧版 Host 模块
            // （替换已安装的包需要重启 DSH 才会加载新的 JS 模块代）。
            else setLoadError('Host 半没有返回配置——如果刚升级过插件，请重启 DSH 再试')
          } catch (failure) {
            if (!cancelled) setLoadError(failure?.message ?? String(failure))
          }
        })()
        return () => { cancelled = true }
      }, [applyConfig])

      const body = (extra) => JSON.stringify(Object.assign({
        baseUrl: form.baseUrl,
        intervalMs: Math.round(Number(form.intervalSec) * 1000),
        usageIntervalMs: Math.round(Number(form.usageSec) * 1000),
        timeoutMs: Math.round(Number(form.timeoutSec) * 1000),
      }, form.apiKey.trim() !== '' ? { apiKey: form.apiKey.trim() } : {}, extra ?? {}))

      const save = async (extra) => {
        setBusy('save')
        setStatus({ tone: 'info', text: '正在保存…' })
        try {
          const data = await requestJson(`${ROUTE}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: body(extra),
          })
          if (data?.ok && data.config) {
            applyConfig(data.config)
            setStatus({ tone: 'ok', text: '已保存并生效' })
          } else {
            setStatus({ tone: 'error', text: data?.error ?? '保存失败' })
          }
        } catch (failure) {
          setStatus({ tone: 'error', text: failure?.message ?? String(failure) })
        } finally {
          setBusy('')
        }
      }

      const test = async () => {
        setBusy('test')
        setStatus({ tone: 'info', text: '正在连接…' })
        try {
          const data = await requestJson(`${ROUTE}/test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: body(),
          })
          if (data?.ok) {
            setStatus({
              tone: 'ok',
              text: `连接成功：${data.baseUrl}（${data.latencyMs} ms，${data.accounts} 个账号${data.version ? '，' + data.version : ''}）`,
            })
          } else {
            const detail = Array.isArray(data?.tried) && data.tried.length > 0 ? `：${data.tried.join('；')}` : ''
            setStatus({ tone: 'error', text: `连接失败${detail}` })
          }
        } catch (failure) {
          setStatus({ tone: 'error', text: failure?.message ?? String(failure) })
        } finally {
          setBusy('')
        }
      }

      if (loadError !== '') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%' } },
          h('p', { style: Object.assign({}, ROW_DESC_STYLE, { color: TONE_COLOR.error }) }, `读取配置失败：${loadError}`))
      }
      if (config === null) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%' } },
          h('p', { style: ROW_DESC_STYLE }, '正在读取配置…'))
      }

      const keyHint = config.apiKeyConfigured
        ? `已配置（来源：${config.apiKeyFrom === 'config' ? '配置行' : config.apiKeyFrom === 'env' ? '环境变量' : '密钥文件'}）· 留空表示不修改`
        : '未配置 · 粘贴面板 config.json 里的 api_key'

      return h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%' } },
        h(Field, { title: '面板地址', desc: `留空则自动探测 ${config.candidates.join(' / ')}${config.effectiveBaseUrl ? ` · 当前生效 ${config.effectiveBaseUrl}` : ''}` },
          h('input', {
            style: INPUT_STYLE,
            type: 'text',
            value: form.baseUrl,
            placeholder: 'http://192.168.1.10:7863',
            spellCheck: false,
            onChange: (event) => setForm({ ...form, baseUrl: event.target.value }),
          })),
        h(Field, { title: '面板 API Key', desc: keyHint },
          h('input', {
            style: INPUT_STYLE,
            type: 'password',
            value: form.apiKey,
            placeholder: config.apiKeyConfigured ? '••••••••（不修改请留空）' : '粘贴 api_key',
            autoComplete: 'off',
            onChange: (event) => setForm({ ...form, apiKey: event.target.value }),
          })),
        h(Field, { title: '轮询间隔（秒）', desc: 'Host 多久拉一次面板；2–300 秒' },
          h('input', {
            style: INPUT_STYLE,
            type: 'number', min: 2, max: 300, value: form.intervalSec,
            onChange: (event) => setForm({ ...form, intervalSec: event.target.value }),
          })),
        h(Field, { title: '今日用量刷新间隔（秒）', desc: '比 overview 重，5–600 秒' },
          h('input', {
            style: INPUT_STYLE,
            type: 'number', min: 5, max: 600, value: form.usageSec,
            onChange: (event) => setForm({ ...form, usageSec: event.target.value }),
          })),
        h(Field, { title: '请求超时（秒）', desc: '单次访问面板的超时；1–60 秒' },
          h('input', {
            style: INPUT_STYLE,
            type: 'number', min: 1, max: 60, value: form.timeoutSec,
            onChange: (event) => setForm({ ...form, timeoutSec: event.target.value }),
          })),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0 0', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: buttonStyle(true, busy !== ''), disabled: busy !== '', onClick: () => { void save() } }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { type: 'button', style: buttonStyle(false, busy !== ''), disabled: busy !== '', onClick: () => { void test() } }, busy === 'test' ? '测试中…' : '测试连接'),
          config.apiKeyConfigured
            ? h('button', {
              type: 'button',
              style: buttonStyle(false, busy !== ''),
              disabled: busy !== '',
              onClick: () => { void save({ clearApiKey: true }) },
            }, '清除密钥')
            : null),
        status !== null
          ? h('p', { style: Object.assign({}, ROW_DESC_STYLE, { color: TONE_COLOR[status.tone] ?? TONE_COLOR.info, paddingTop: 8, wordBreak: 'break-all' }) }, status.text)
          : null,
        h('p', { style: Object.assign({}, ROW_DESC_STYLE, { paddingTop: 12 }) },
          `设置保存在 ${config.settingsFile}（密钥单独存 ${config.keyFile}，权限 600）。这些值就地生效，不需要重启 Harness。`))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        const SELF_ID = 'workbuddy-pool'

        // 设置 → Workbuddy 号池：地址/密钥/间隔的可交互控件。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SELF_ID,
          order: 60,
          label: () => 'Workbuddy 号池',
        }, SettingsSection))

        let current = null // { key, order, disposeInject, disposeStyle }
        let disposed = false

        const mountStyle = (slotKey) => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-workbuddy-pool'
          style.textContent = footerWrapCss(slotKey)
          document.head.appendChild(style)
          return () => { style.remove() }
        }

        /** 装到当前检测出来的位置；位置没变就什么都不做（幂等）。 */
        const resolve = () => {
          if (disposed) return
          const picked = pickSlot(slots)
          if (picked === null) {
            console.warn('[dsh-workbuddy-pool] 没有可用的侧栏座位，本次不注册。')
            return
          }
          const order = pickOrder(picked.occupants, SELF_ID)
          if (current !== null && current.key === picked.key && current.order === order) return

          if (current !== null) {
            current.disposeInject()
            current.disposeStyle()
            current = null
          }
          const disposeStyle = mountStyle(picked.key)
          const disposeInject = slots.inject(picked.key, () => slots.register({
            name: picked.key,
            id: SELF_ID,
            order,
          }, PoolWidget))
          current = { key: picked.key, order, disposeInject, disposeStyle }
        }

        resolve()
        // 激活顺序不确定：别的 occupant 可能在本插件之后才注册。补一次复核
        // （只跑一次，不会循环），顺序变了就挪到新算出来的空位。
        const timer = setTimeout(resolve, 0)

        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            disposed = true
            clearTimeout(timer)
            if (current !== null) {
              current.disposeInject()
              current.disposeStyle()
              current = null
            }
          }, 'dsh-workbuddy-pool: slot placement')
        }
      },
    }
  },
})
