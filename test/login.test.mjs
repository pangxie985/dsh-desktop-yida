/**
 * `lib/yida-login.js` 的单元测试：授权 URL 抽取、登录进程状态机。
 *
 * 用假的 spawn 实现，不真正启动 openyida，也不联网。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { __resetLoginState, cancelLogin, extractAuthUrl, loginState, startLogin } from '../lib/yida-login.js'

let passed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

/** 造一个假的子进程：stderr/stdout 是 EventEmitter，带 kill()。 */
function fakeChild() {
  const child = new EventEmitter()
  const stderr = new EventEmitter()
  const stdout = new EventEmitter()
  stderr.setEncoding = () => {}
  stdout.setEncoding = () => {}
  child.stderr = stderr
  child.stdout = stdout
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  return child
}

test('extractAuthUrl：识别 openyida 的授权 URL 标记', () => {
  const text = 'some log\nOpen this URL to login:\nhttps://login.dingtalk.com/oauth2/auth?client_id=x&state=y\nWaiting...'
  assert.equal(extractAuthUrl(text), 'https://login.dingtalk.com/oauth2/auth?client_id=x&state=y')
})

test('extractAuthUrl：标记与 URL 在同一行也能识别', () => {
  const text = 'Open this URL to login: https://a.example.com/x?y=1'
  assert.equal(extractAuthUrl(text), 'https://a.example.com/x?y=1')
})

test('extractAuthUrl：没有标记时退回第一个 http(s) 链接', () => {
  const text = 'logo https://cdn.example.com/a.png then https://login.example.com/auth'
  assert.equal(extractAuthUrl(text), 'https://cdn.example.com/a.png')
})

test('extractAuthUrl：没有 URL 返回 undefined', () => {
  assert.equal(extractAuthUrl('nothing here'), undefined)
  assert.equal(extractAuthUrl(undefined), undefined)
})

test('startLogin：拿到 URL 后 resolve，进程保持运行', async () => {
  __resetLoginState()
  const child = fakeChild()
  let spawned = null
  const spawnImpl = (command, args) => {
    spawned = { command, args }
    setTimeout(() => child.stderr.emit('data', 'Open this URL to login:\nhttps://login.example.com/auth?state=zz\n'), 5)
    return child
  }
  const result = await startLogin({}, { spawnImpl, timeoutMs: 2000 })
  assert.equal(result.ok, true)
  assert.equal(result.url, 'https://login.example.com/auth?state=zz')
  assert.equal(spawned.args[spawned.args.length - 1], 'login')
  const state = loginState()
  assert.equal(state.running, true)
  assert.equal(state.url, 'https://login.example.com/auth?state=zz')
  assert.equal(cancelLogin(), true)
  assert.equal(child.killed, true)
})

test('startLogin：重复调用复用已有 URL', async () => {
  __resetLoginState()
  const child = fakeChild()
  const spawnImpl = () => {
    setTimeout(() => child.stderr.emit('data', 'Open this URL to login:\nhttps://login.example.com/auth?state=reuse\n'), 5)
    return child
  }
  const first = await startLogin({}, { spawnImpl, timeoutMs: 2000 })
  assert.equal(first.ok, true)
  const second = await startLogin({}, { spawnImpl, timeoutMs: 2000 })
  assert.equal(second.ok, true)
  assert.equal(second.reused, true)
  cancelLogin()
})

test('startLogin：等不到 URL 时超时失败', async () => {
  __resetLoginState()
  const child = fakeChild()
  const result = await startLogin({}, { spawnImpl: () => child, timeoutMs: 60 })
  assert.equal(result.ok, false)
  assert.match(result.error, /超时/)
  assert.equal(loginState().running, false)
  cancelLogin()
})

test('startLogin：进程退出且没给 URL 时失败', async () => {
  __resetLoginState()
  const child = fakeChild()
  const spawnImpl = () => {
    setTimeout(() => child.emit('close', 3), 5)
    return child
  }
  const result = await startLogin({}, { spawnImpl, timeoutMs: 1000 })
  assert.equal(result.ok, false)
  assert.match(result.error, /code 3/)
})

for (const [name, fn] of cases) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error && error.stack}`)
    process.exitCode = 1
  }
}
console.log(`\nlogin.test.mjs: ${passed}/${cases.length} 通过`)
