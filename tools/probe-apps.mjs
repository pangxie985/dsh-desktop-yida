/**
 * 排查工具：直接查宜搭「应用列表」接口，对比不同过滤条件。
 *
 * 动机：openyida 的 `app-list` 每次都硬编码 `creator: <我的 userId>`（见
 * vendor/openyida/lib/app/app-list.js:39），所以它只返回「我自己创建的应用」。
 * 本脚本用 CLI 自带的客户端（同一套登录态/CSRF 处理）打同一个接口，分别试：
 *   A. isAdmin=true,  带 creator  （= openyida app-list --type managed 的行为）
 *   B. isAdmin=false, 带 creator  （= --type created）
 *   C. isAdmin=true,  不带 creator（= 我是管理员的应用，不限创建者）
 *   D. isAdmin=false, 不带 creator（= 我能看到的全部应用）
 *
 * 只读；不写任何宜搭数据。
 *
 * 用法：node tools/probe-apps.mjs
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 优先用插件目录里 npm 装好的 CLI，其次兼容本地开发时的 vendor 副本。 */
const CLI_ROOT = [
  join(HERE, '..', 'node_modules', 'openyida'),
  join(HERE, '..', 'vendor', 'openyida'),
].find((candidate) => existsSync(join(candidate, 'package.json')))
const require = createRequire(join(CLI_ROOT, 'package.json'))
const { createAuthRef, createYidaClient } = require('./lib/core/yida-client.js')

const auth = createAuthRef()
console.log(`站点：${auth.baseUrl}`)
console.log(`userId：${auth.userId || '(空)'}`)
console.log('')

const client = createYidaClient({ authRef: auth })

async function query(label, extra) {
  const params = {
    _api: 'nattyFetch',
    _mock: 'false',
    pageIndex: 1,
    pageSize: 50,
    _stamp: Date.now(),
    ...extra,
  }
  let result
  try {
    result = await client.get('/query/app/getAppList.json', params)
  } catch (error) {
    console.log(`${label}\n    ❌ 请求失败：${error.message}\n`)
    return
  }
  const content = (result && result.content) || {}
  const apps = Array.isArray(content.data) ? content.data : []
  console.log(`${label}`)
  console.log(`    success=${result && result.success}  返回 ${apps.length} 个  totalCount=${content.totalCount}`)
  for (const app of apps.slice(0, 10)) {
    const name = (app.appName && app.appName.zh_CN) || app.appName || '(无名)'
    console.log(`      - ${name}  ${app.appType || ''}`)
  }
  if (apps.length === 0) {
    console.log(`      原始响应片段：${JSON.stringify(result).slice(0, 300)}`)
  }
  console.log('')
}

await query('A. isAdmin=true + creator=我（openyida app-list --type managed 的行为）', {
  isAdmin: true,
  creator: auth.userId,
})
await query('B. isAdmin=false + creator=我（openyida app-list --type created 的行为）', {
  isAdmin: false,
  creator: auth.userId,
})
await query('C. isAdmin=true，不限 creator（我是管理员的应用）', { isAdmin: true })
await query('D. isAdmin=false，不限 creator（我能访问的应用）', { isAdmin: false })
