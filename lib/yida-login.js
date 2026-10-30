/**
 * 登录 / 登出的 Host 侧支持。
 *
 * 设计要点：
 *   - `openyida login` 在 `OPENYIDA_NO_BROWSER=1` 时不会拉起系统浏览器，而是把授权 URL 打到 stderr：
 *       `Open this URL to login:` + 换行 + URL
 *     我们抓这个 URL 交给「DSH 内置浏览器」打开，用户在内置浏览器里完成钉钉授权，
 *     回调打到 CLI 自己起的 127.0.0.1 loopback 端口（默认 5 分钟超时），登录即完成。
 *   - 关键实现细节：登录进程要**活到用户完成授权**，但宿主在工具调用 / HTTP 请求结束后可能回收子进程树。
 *     所以这里用 `detached: true` + 把 stdout/stderr 重定向到临时日志文件，再**轮询日志文件**拿 URL：
 *     不依赖管道生命周期，也不依赖调用上下文存活。
 *   - 全程不依赖浏览器代理插件，也不依赖系统浏览器。
 *
 * @module dsh-desktop-yida/yida-login
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCli } from './yida-cli.js'

/** 等待登录 URL 出现的上限。 */
const URL_WAIT_MS = 20_000
/** 轮询日志文件的间隔。 */
const POLL_MS = 200

/** 当前登录进程（同一时间只允许一个）。 */
let active = null

/**
 * 从 CLI 输出里抽取登录 URL。
 * @param {string} text - CLI 的 stdout/stderr 文本。
 * @returns {string|undefined} 授权 URL。
 */
export function extractAuthUrl(text) {
  if (typeof text !== 'string') return undefined
  const labelled = text.match(/Open this URL to login:\s*\r?\n?\s*(https?:\/\/[^\s"'<>]+)/i)
  if (labelled !== null) return labelled[1]
  const any = text.match(/https?:\/\/[^\s"'<>]+/)
  return any === null ? undefined : any[0]
}

/** 读日志文件（可能还没创建）。 */
function readTail(path, max = 4000) {
  try {
    return readFileSync(path, 'utf8').slice(-max)
  } catch {
    return ''
  }
}

/** 进程是否还活着。 */
function processAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 当前登录流程状态。
 * @returns {{running: boolean, url?: string, pid?: number, startedAt?: number, exitCode?: number|null, signal?: string, tail?: string}} 状态。
 */
export function loginState() {
  if (active === null) return { running: false }
  const alive = active.exitCode === undefined && processAlive(active.pid)
  return {
    running: alive,
    ...(active.url === undefined ? {} : { url: active.url }),
    ...(active.pid === undefined ? {} : { pid: active.pid }),
    ...(alive ? {} : { exitCode: active.exitCode === undefined ? null : active.exitCode }),
    ...(active.signal === undefined ? {} : { signal: active.signal }),
    startedAt: active.startedAt,
    // 诊断用：进程输出末尾，便于排查「进程提前退出」
    ...(active.tail === undefined || active.tail === '' ? {} : { tail: active.tail.slice(-800) }),
  }
}

/**
 * 中止进行中的登录流程（用户点取消时用）。
 * @returns {boolean} 是否确实中止了一个进程。
 */
export function cancelLogin() {
  if (active === null) return false
  const entry = active
  active = null
  try {
    if (processAlive(entry.pid)) process.kill(entry.pid)
  } catch {
    /* 进程可能已退出 */
  }
  try {
    if (entry.logPath) unlinkSync(entry.logPath)
  } catch {
    /* 日志文件可能已不存在 */
  }
  return true
}

/**
 * 启动登录：spawn `openyida login`（禁用自动开浏览器），拿到授权 URL 后返回。
 *
 * 进程以 detached 方式在后台等待 loopback 回调；用户完成授权后进程自行退出。
 *
 * @param {{cliPath?: string, projectDir?: string}} [settings] - 插件设置。
 * @param {{timeoutMs?: number, spawnImpl?: Function, pollMs?: number}} [options] - 覆盖项（测试用）。
 * @returns {Promise<{ok: true, url: string, reused?: boolean} | {ok: false, error: string, tail?: string}>} 结果。
 */
export function startLogin(settings = {}, options = {}) {
  const aliveCheck = typeof options.isAlive === 'function' ? options.isAlive : processAlive
  if (active !== null && active.url !== undefined && aliveCheck(active.pid)) {
    return Promise.resolve({ ok: true, url: active.url, reused: true })
  }
  if (active !== null) cancelLogin()

  let resolved
  try {
    resolved = options.resolved ?? resolveCli(settings)
  } catch (error) {
    return Promise.resolve({ ok: false, error: String(error && error.message ? error.message : error) })
  }

  const limit = Number.isFinite(options.timeoutMs) ? options.timeoutMs : URL_WAIT_MS
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : POLL_MS
  const isAlive = typeof options.isAlive === 'function' ? options.isAlive : processAlive
  const spawnImpl = options.spawnImpl ?? spawn
  const logPath = options.logPath ?? join(tmpdir(), `dsh-yida-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`)

  let child
  let fd
  try {
    fd = options.logPath === undefined ? openSync(logPath, 'a') : undefined
    child = spawnImpl(resolved.command, [...resolved.prefix, 'login'], {
      cwd: settings.projectDir || process.cwd(),
      env: {
        ...process.env,
        OPENYIDA_NO_BROWSER: '1',
        OPENYIDA_NO_BROWSER_HANDOFF: '1',
        NO_COLOR: '1',
      },
      windowsHide: true,
      // detached：让登录进程不绑在调用上下文上；输出落文件，避免依赖管道
      detached: true,
      stdio: [options.logPath === undefined ? 'ignore' : 'pipe', options.logPath === undefined ? fd : 'pipe', options.logPath === undefined ? fd : 'pipe'],
    })
  } catch (error) {
    try {
      if (typeof fd === 'number') closeSync(fd)
    } catch {
      /* ignore */
    }
    return Promise.resolve({ ok: false, error: String(error && error.message ? error.message : error) })
  } finally {
    try {
      if (typeof fd === 'number') closeSync(fd)
    } catch {
      /* ignore */
    }
  }

  const entry = { child, pid: child.pid, url: undefined, startedAt: Date.now(), exitCode: undefined, tail: '', logPath }
  active = entry
  // 不等待子进程，也不让它拖住宿主进程退出
  try {
    child.unref()
    if (child.stdout !== null && typeof child.stdout.unref === 'function') child.stdout.unref()
    if (child.stderr !== null && typeof child.stderr.unref === 'function') child.stderr.unref()
  } catch {
    /* 测试替身可能没有 unref */
  }

  return new Promise((settle) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearInterval(timer)
      settle(value)
    }

    child.on('exit', (code, signal) => {
      entry.exitCode = typeof code === 'number' ? code : null
      if (signal !== null && signal !== undefined) entry.signal = signal
    })

    const deadline = Date.now() + limit
    const timer = setInterval(() => {
      // 1) 日志里出现 URL 就算成功
      const text = readTail(logPath)
      if (text !== '') {
        entry.tail = text
        const url = extractAuthUrl(text)
        if (url !== undefined) {
          entry.url = url
          finish({ ok: true, url })
          return
        }
      }
      // 2) 进程已经没了、又没 URL → 失败（把输出尾巴带回去便于排查）
      const gone = entry.exitCode !== undefined || !isAlive(entry.pid)
      if (gone) {
        finish({
          ok: false,
          error: `登录进程已退出（code ${entry.exitCode === undefined ? '?' : entry.exitCode}），未拿到授权 URL`,
          tail: entry.tail.slice(-600),
        })
        return
      }
      // 3) 超时
      if (Date.now() > deadline) {
        cancelLogin()
        finish({ ok: false, error: `等待登录 URL 超时（${Math.round(limit / 1000)}s）` })
      }
    }, pollMs)
  })
}

/** 供测试重置模块状态。 */
export function __resetLoginState() {
  if (active !== null && active.pid !== undefined) {
    try {
      process.kill(active.pid)
    } catch {
      /* ignore */
    }
  }
  active = null
}
