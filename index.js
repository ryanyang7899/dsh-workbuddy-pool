/**
 * dsh-workbuddy-pool — Host half.
 *
 * 职责：
 *  1. 替浏览器去拉 Workbuddy 面板的既有管理 API（面板没有 CORS 头，页面直连会被挡），
 *     聚合成**一份**缓存快照，通过 `/workbuddy-pool/api` 交给 Client 半。
 *  2. 提供设置界面的读写端点：`GET/POST /workbuddy-pool/api/config` 与
 *     `POST /workbuddy-pool/api/test`，让用户在 DSH 设置里改地址/密钥/间隔。
 *
 * 配置来源（后者覆盖前者）：
 *   内置默认值  <  profile 的 cordis.patch.yml 行配置  <  $DSH_HOME/workbuddy-pool.json
 * 密钥单独存放，永不进配置/日志/快照：配置 apiKey > WORKBUDDY_PANEL_KEY > $DSH_HOME/workbuddy-panel.key
 *
 * 为什么设置写自己的 JSON 而不是走 configEditor：`configEditor.edit()` 会按 Loader 的
 * 常规生命周期**重载插件**，正在返回的那次 HTTP 响应会被打断；而这些字段（地址、间隔、
 * 超时、密钥）都只需要就地生效。插件自有状态放 `$DSH_HOME` 下也有先例（如 dream-skin.json），
 * 不碰用户 profile 的 patch 文件。
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Host 对外暴露的唯一路由（前缀匹配）。 */
const ROUTE = '/workbuddy-pool/api'

/** Host 需要的服务：只用到 HTTP 路由注册。 */
export const inject = ['webServer']

/** 插件自有设置文件名（放在 $DSH_HOME 下）。 */
const SETTINGS_FILE = 'workbuddy-pool.json'
/** 面板主密钥文件名（一行、0600）。 */
const KEY_FILE = 'workbuddy-panel.key'

/**
 * 面板地址的自动探测顺序。面板默认监听 7863，绝大多数人把它跑在本机或同一台
 * 机器上，所以先试回环地址；都不通就报错，提示去设置里填地址。
 */
const CANDIDATE_BASE_URLS = ['http://127.0.0.1:7863', 'http://localhost:7863']

/** POST 请求体上限。设置项都是小 JSON，64 KiB 绰绰有余。 */
const MAX_BODY_BYTES = 64 * 1024

/** 把任意值收敛成范围内的整数。 */
function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 只接受有限数字，其它（null/undefined/字符串）一律回落，避免把 NaN 塞进 JSON。 */
function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** DSH 的用户数据目录。 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

function settingsPath() {
  return join(dshHome(), SETTINGS_FILE)
}

function keyPath() {
  return join(dshHome(), KEY_FILE)
}

/** 读插件自有设置；文件不存在/损坏时返回空对象（不让坏文件拖垮插件）。 */
function readSettingsFile() {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 原子写设置文件（先写临时文件再改名），权限 0600。 */
function writeSettingsFile(values) {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(path, readFileSync(tmp), { mode: 0o600 })
  rmSync(tmp, { force: true })
}

/** 把 Loader 传进来的行配置 + 插件自有设置合成完整配置。 */
function resolveConfig(rowConfig, fileConfig) {
  // 文件里**显式出现**的键优先，哪怕值是空串：这样"在设置里清空地址"才真的表示
  // "改为自动探测"，而不是悄悄回落到行配置里写死的地址。
  const hasFileKey = (key) => fileConfig !== null && typeof fileConfig === 'object'
    && Object.prototype.hasOwnProperty.call(fileConfig, key)
  const pick = (key) => {
    if (hasFileKey(key)) {
      const fromFile = fileConfig[key]
      return typeof fromFile === 'string' ? fromFile.trim() : ''
    }
    const fromRow = rowConfig?.[key]
    return typeof fromRow === 'string' ? fromRow.trim() : ''
  }
  const pickInt = (key, min, max, fallback) => {
    if (hasFileKey(key)) {
      const fromFile = Number(fileConfig[key])
      if (Number.isFinite(fromFile)) return clampInt(fromFile, min, max, fallback)
    }
    return clampInt(rowConfig?.[key], min, max, fallback)
  }
  return {
    // 空 = 自动探测本机面板（见 CANDIDATE_BASE_URLS）
    baseUrl: pick('baseUrl').replace(/\/+$/, ''),
    apiKey: typeof rowConfig?.apiKey === 'string' ? rowConfig.apiKey.trim() : '',
    intervalMs: pickInt('intervalMs', 2000, 300000, 15000),
    usageIntervalMs: pickInt('usageIntervalMs', 5000, 600000, 60000),
    timeoutMs: pickInt('timeoutMs', 1000, 60000, 8000),
  }
}

/**
 * 解析面板主密钥，优先级：行配置 → 环境变量 → `$DSH_HOME/workbuddy-panel.key`。
 * 每次取数都重读（文件很小），这样在设置里换密钥不用重启 Harness。
 */
function resolveApiKey(cfg) {
  if (cfg.apiKey !== '') return cfg.apiKey
  const fromEnv = typeof process.env.WORKBUDDY_PANEL_KEY === 'string' ? process.env.WORKBUDDY_PANEL_KEY.trim() : ''
  if (fromEnv !== '') return fromEnv
  try {
    const text = readFileSync(keyPath(), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed !== '' && !trimmed.startsWith('#')) return trimmed
    }
  } catch {
    // 文件不存在 = 未配置，交给调用方报错。
  }
  return ''
}

/** 本机当天 00:00 的 unix 秒。面板 /usage 的 from 就是按这个口径切的。 */
function startOfLocalDayUnix(date = new Date()) {
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime() / 1000)
}

/** 组装快照。字段名保持面板原义，避免插件与面板之间出现第二套词汇表。 */
function composeSnapshot(overview, metrics, usage) {
  const rawAccounts = Array.isArray(overview?.accounts) ? overview.accounts : []
  const accounts = rawAccounts.map((a) => {
    const usageOfAccount = a?.token_usage ?? {}
    return {
      uid: typeof a?.uid === 'string' ? a.uid : '',
      nickname: typeof a?.nickname === 'string' ? a.nickname : '',
      realm: typeof a?.realm === 'string' ? a.realm : '',
      credits: num(a?.credits),
      creditsTotal: num(a?.credits_total),
      inFlight: num(a?.in_flight),
      disabled: a?.disabled === true,
      cooling: a?.cooling === true,
      model: typeof usageOfAccount.last_model === 'string' ? usageOfAccount.last_model : '',
      rate: num(usageOfAccount.last_tokens_per_second),
      lastUsedAt: typeof usageOfAccount.last_used_at === 'string' ? usageOfAccount.last_used_at : '',
    }
  })

  const rawActive = Array.isArray(metrics?.active) ? metrics.active : []
  const active = rawActive.map((r) => ({
    requestId: typeof r?.request_id === 'string' ? r.request_id : '',
    path: typeof r?.path === 'string' ? r.path : '',
    uid: typeof r?.uid === 'string' ? r.uid : '',
    account: typeof r?.account === 'string' ? r.account : '',
    model: typeof r?.model === 'string' ? r.model : '',
    startedAt: typeof r?.started_at === 'string' ? r.started_at : '',
    elapsedMs: num(r?.elapsed_ms),
    mode: typeof r?.mode === 'string' ? r.mode : '',
    stage: typeof r?.stage === 'string' ? r.stage : '',
    ttfbMs: num(r?.ttfb_ms),
    promptTokens: num(r?.prompt_tokens),
    completionTokens: num(r?.completion_tokens),
    tokensPerSecond: num(r?.tokens_per_second),
    attempts: num(r?.attempts),
  }))

  const totals = { credits: 0, accounts: accounts.length, inFlight: num(metrics?.in_flight) }
  for (const a of accounts) totals.credits += a.credits

  return {
    fetchedAt: new Date().toISOString(),
    panel: {
      version: typeof overview?.version === 'string' ? overview.version : '',
      healthy: overview?.healthy !== false,
      inFlightFull: overview?.in_flight_full === true,
      paused: overview?.paused === true,
      disabled: overview?.disabled === true,
      uptimeSec: num(overview?.uptime_sec),
      balanceRefreshedAt: typeof overview?.balance_refreshed_at === 'string' ? overview.balance_refreshed_at : '',
      balanceRefreshSec: num(overview?.balance_refresh_sec),
    },
    totals,
    accounts,
    active,
    today: usage
      ? { credits: num(usage?.totals?.credits), tokens: num(usage?.totals?.total_tokens) }
      : null,
  }
}

/**
 * 写操作的来源栅栏：宿主 webServer 自身不带鉴权，所以任何会改状态的 POST 都必须
 * 拒绝非本机来源的浏览器请求。两条便宜但有效的检查：
 *  - 带 Origin 且主机不是回环 → 拒绝（Desktop 的 dsh-app 转发会剥掉 Origin，属于可信来源）；
 *  - Content-Type 不是 JSON → 拒绝（跨站表单无法伪造，会先被 CORS 预检挡住）。
 */
function fencedWrite(req) {
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let host
    try {
      host = new URL(origin).hostname
    } catch {
      return false
    }
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') return false
  }
  const type = req.headers?.['content-type']
  if (typeof type === 'string' && !type.toLowerCase().includes('application/json')) return false
  return true
}

/** 读有上限的 JSON 请求体。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed
}

export function apply(ctx, config) {
  const fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined

  /** 当前生效配置（行配置 + 设置文件合成）；设置保存后就地更新。 */
  let cfg = resolveConfig(config, readSettingsFile())

  /** 缓存与状态：多个页面共享同一份，一次刷新只打一轮上游。 */
  const state = {
    snapshot: null,
    fetchedAt: 0,
    error: '',
    usageRaw: null,
    usageAt: 0,
    usageFrom: 0,
  }

  let inflight = null
  /** 解析出的面板根地址；配置为空时由 probeBaseUrl 探测并缓存。 */
  let baseUrl = cfg.baseUrl
  let baseUrlProbing = null
  /** 轮询定时器；改间隔时重建。 */
  let pollTimer = null

  function rehydrate() {
    cfg = resolveConfig(config, readSettingsFile())
    baseUrl = cfg.baseUrl
    baseUrlProbing = null
    state.error = ''
  }

  async function fetchWithTimeout(url, init, timeoutMs) {
    if (fetchImpl === undefined) throw new Error('this runtime has no fetch')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 探测一个可用的面板地址；只探一次，成功后缓存到 baseUrl。 */
  async function probeBaseUrl() {
    if (baseUrl !== '') return baseUrl
    if (baseUrlProbing !== null) return baseUrlProbing
    baseUrlProbing = (async () => {
      for (const candidate of CANDIDATE_BASE_URLS) {
        try {
          const res = await fetchWithTimeout(`${candidate}/healthz`, {}, Math.min(cfg.timeoutMs, 3000))
          // 面板的 /healthz 不需要鉴权：200 或 503（池子暂不可服务）都说明是它。
          if (res.ok || res.status === 503) {
            baseUrl = candidate
            return baseUrl
          }
        } catch {
          // 换下一个候选
        }
      }
      throw new Error(
        `找不到 Workbuddy 面板（试过 ${CANDIDATE_BASE_URLS.join('、')}）：请在设置里填写面板地址`,
      )
    })()
    try {
      return await baseUrlProbing
    } finally {
      baseUrlProbing = null
    }
  }

  async function getJSON(pathAndQuery, override) {
    const apiKey = override?.apiKey ?? resolveApiKey(cfg)
    if (apiKey === '') {
      throw new Error('还没配置面板 api_key：在设置里填写，或设置 WORKBUDDY_PANEL_KEY / $DSH_HOME/workbuddy-panel.key')
    }
    const origin = override?.baseUrl ?? await probeBaseUrl()
    const res = await fetchWithTimeout(origin + pathAndQuery, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    }, override?.timeoutMs ?? cfg.timeoutMs)
    if (!res.ok) throw new Error(`${pathAndQuery.split('?')[0]} → HTTP ${res.status}`)
    return await res.json()
  }

  /**
   * 拉一轮数据。
   * @param forceUsage - 无论间隔是否到期都重取今日用量（展开/手动刷新时用）。
   * @param from - 调用方所在的「今日 0 点」（unix 秒）。
   */
  async function refresh(forceUsage = false, from = 0) {
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        const todayFrom = Number.isFinite(from) && from > 0 ? Math.floor(from) : startOfLocalDayUnix()
        const usageStale = forceUsage
          || state.usageRaw === null
          || todayFrom !== state.usageFrom
          || Date.now() - state.usageAt > cfg.usageIntervalMs
        const [overview, metrics] = await Promise.all([
          getJSON('/panel/api/overview'),
          getJSON('/panel/api/request_metrics'),
        ])
        if (usageStale) {
          state.usageRaw = await getJSON(`/panel/api/usage?from=${todayFrom}`)
          state.usageAt = Date.now()
          state.usageFrom = todayFrom
        }
        state.snapshot = composeSnapshot(overview, metrics, state.usageRaw)
        state.snapshot.todayFrom = todayFrom
        state.fetchedAt = Date.now()
        state.error = ''
      } catch (error) {
        // 保留上一份好数据；页面据 stale 显示「离线」。
        state.error = error instanceof Error ? error.message : String(error)
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  function payload() {
    return {
      ok: state.snapshot !== null,
      fetchedAt: state.fetchedAt,
      stale: state.snapshot !== null && state.error !== '',
      error: state.error,
      intervalMs: cfg.intervalMs,
      snapshot: state.snapshot,
    }
  }

  /** 设置界面的读模型：永远不回传密钥本身，只回"有没有配"。 */
  function configPayload() {
    const fileConfig = readSettingsFile()
    return {
      baseUrl: cfg.baseUrl,
      intervalMs: cfg.intervalMs,
      usageIntervalMs: cfg.usageIntervalMs,
      timeoutMs: cfg.timeoutMs,
      apiKeyConfigured: resolveApiKey(cfg) !== '',
      apiKeyFrom: cfg.apiKey !== '' ? 'config' : (typeof process.env.WORKBUDDY_PANEL_KEY === 'string' && process.env.WORKBUDDY_PANEL_KEY.trim() !== '' ? 'env' : (resolveApiKey(cfg) !== '' ? 'file' : 'none')),
      effectiveBaseUrl: baseUrl,
      candidates: CANDIDATE_BASE_URLS,
      settingsFile: settingsPath(),
      keyFile: keyPath(),
      overriddenByFile: Object.keys(fileConfig).length > 0,
      /** 行配置里写死的字段（设置界面的值会覆盖它，但值得让用户看见）。 */
      rowConfig: {
        baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl : '',
        intervalMs: Number.isFinite(Number(config?.intervalMs)) ? Number(config.intervalMs) : null,
      },
    }
  }

  /** 校验并落盘一次设置；返回落盘后的读模型。 */
  function saveConfig(body) {
    const next = readSettingsFile()

    if (typeof body.baseUrl === 'string') {
      const trimmed = body.baseUrl.trim().replace(/\/+$/, '')
      if (trimmed !== '' && !/^https?:\/\//i.test(trimmed)) {
        throw new Error('面板地址必须以 http:// 或 https:// 开头')
      }
      next.baseUrl = trimmed
    }
    if (body.intervalMs !== undefined) next.intervalMs = clampInt(body.intervalMs, 2000, 300000, cfg.intervalMs)
    if (body.usageIntervalMs !== undefined) next.usageIntervalMs = clampInt(body.usageIntervalMs, 5000, 600000, cfg.usageIntervalMs)
    if (body.timeoutMs !== undefined) next.timeoutMs = clampInt(body.timeoutMs, 1000, 60000, cfg.timeoutMs)

    // 密钥单独落 0600 文件，永不写进设置 JSON（设置文件不含任何秘密）。
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
      mkdirSync(dirname(keyPath()), { recursive: true })
      writeFileSync(keyPath(), `${body.apiKey.trim()}\n`, { mode: 0o600 })
    } else if (body.clearApiKey === true) {
      rmSync(keyPath(), { force: true })
    }

    writeSettingsFile(next)
    rehydrate()
    // 立刻按新配置取一次，页面拿到的就是新地址下的数据。
    void refresh(true)
    return configPayload()
  }

  /** 连接测试：只探一次，不动缓存与轮询。 */
  async function testConnection(body) {
    const baseUrlInput = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : ''
    const apiKeyInput = typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey.trim() : ''
    const apiKey = apiKeyInput !== '' ? apiKeyInput : resolveApiKey(cfg)
    const timeoutMs = clampInt(body.timeoutMs, 1000, 60000, cfg.timeoutMs)
    const candidates = baseUrlInput !== ''
      ? [baseUrlInput]
      : (cfg.baseUrl !== '' ? [cfg.baseUrl] : CANDIDATE_BASE_URLS)

    const startedAt = Date.now()
    const tried = []
    for (const candidate of candidates) {
      try {
        // 先看是不是面板（/healthz 免鉴权），再用 overview 验证密钥。
        const health = await fetchWithTimeout(`${candidate}/healthz`, {}, timeoutMs)
        if (!health.ok && health.status !== 503) {
          tried.push(`${candidate} → /healthz HTTP ${health.status}`)
          continue
        }
        if (apiKey === '') {
          tried.push(`${candidate} → 面板可达，但没配置 api_key`)
          continue
        }
        const res = await fetchWithTimeout(`${candidate}/panel/api/overview`, {
          headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        }, timeoutMs)
        if (res.status === 401) {
          tried.push(`${candidate} → 面板可达，但 api_key 被拒绝（401）`)
          continue
        }
        if (!res.ok) {
          tried.push(`${candidate} → /panel/api/overview HTTP ${res.status}`)
          continue
        }
        const data = await res.json()
        const accounts = Array.isArray(data?.accounts) ? data.accounts.length : 0
        return {
          ok: true,
          baseUrl: candidate,
          latencyMs: Date.now() - startedAt,
          accounts,
          version: typeof data?.version === 'string' ? data.version : '',
          tried,
        }
      } catch (error) {
        tried.push(`${candidate} → ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { ok: false, latencyMs: Date.now() - startedAt, tried, error: tried[tried.length - 1] ?? '没有可尝试的地址' }
  }

  /** 按当前 intervalMs 起停轮询。 */
  function startPolling() {
    stopPolling()
    void refresh(false)
    pollTimer = setInterval(() => { void refresh(false) }, cfg.intervalMs)
    // 不让这个定时器拖住宿主进程退出。
    if (typeof pollTimer?.unref === 'function') pollTimer.unref()
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      let url
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        url = new URL('http://127.0.0.1/')
      }
      // 前缀路由交给 handler 的 URL 可能已被剥掉前缀（也可能没有），两种都接受。
      const trimmed = url.pathname.replace(/\/+$/, '')
      const route = (trimmed.startsWith(ROUTE) ? trimmed.slice(ROUTE.length) : trimmed) || '/'

      // ── 设置读 ────────────────────────────────────────────────────
      if (route === '/config' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, { ok: true, config: configPayload() })
        return
      }

      // ── 设置写 / 连接测试 ────────────────────────────────────────
      if (route === '/config' || route === '/test') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' })
          return
        }
        if (!fencedWrite(req)) {
          sendJson(res, 403, { ok: false, error: '拒绝非本机来源的写请求' })
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        try {
          if (route === '/test') {
            sendJson(res, 200, await testConnection(body))
            return
          }
          const saved = saveConfig(body)
          // 间隔可能变了：重建轮询定时器。
          startPolling()
          sendJson(res, 200, { ok: true, config: saved })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      // ── 快照（只读） ─────────────────────────────────────────────
      if (route === '/' || route === '') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const wantsRefresh = url.searchParams.get('refresh') === '1'
        const from = Number(url.searchParams.get('from') ?? '0')
        if (wantsRefresh || state.snapshot === null) {
          await refresh(wantsRefresh, from)
        }
        sendJson(res, 200, payload())
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口 ${route}` })
    },
  }), 'dsh-workbuddy-pool: /workbuddy-pool/api route')

  // 轮询：随插件卸载一起停止。
  ctx.effect(() => {
    startPolling()
    return () => stopPolling()
  }, 'dsh-workbuddy-pool: panel poll timer')
}
