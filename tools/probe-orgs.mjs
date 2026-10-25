/**
 * 排查工具：遍历全部已登录组织，统计每个组织的应用数量，最后切回原组织。
 *
 * 只读宜搭侧数据（app-list），只改本地 auth profile 的当前组织，且会还原。
 *
 * 用法：node tools/probe-orgs.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 优先用插件目录里 npm 装好的 CLI，其次兼容本地开发时的 vendor 副本。 */
const CLI = [
  join(HERE, '..', 'node_modules', 'openyida', 'bin', 'yida.js'),
  join(HERE, '..', 'vendor', 'openyida', 'bin', 'yida.js'),
].find((candidate) => existsSync(candidate))

function run(args) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1', OPENYIDA_NO_BROWSER_HANDOFF: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => settle({ code, out, err }))
  })
}

function parseJson(text) {
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  for (let end = text.length; end > start; end -= 1) {
    try {
      return JSON.parse(text.slice(start, end))
    } catch {
      /* 继续收缩 */
    }
  }
  return undefined
}

const listed = await run(['org', 'list', '--json'])
const orgs = parseJson(listed.out)
if (!orgs || !Array.isArray(orgs.organizations)) {
  console.error('无法解析组织列表：', listed.out.slice(0, 400), listed.err.slice(0, 300))
  process.exit(1)
}

const original = orgs.current_corp_id
console.log(`当前组织：${original}，共 ${orgs.count} 个组织\n`)

for (const org of orgs.organizations) {
  await run(['org', 'switch', '--corp-id', org.corpId])
  const managed = await run(['app-list', '--type', 'managed', '--page', '1', '--size', '100'])
  const created = await run(['app-list', '--type', 'created', '--page', '1', '--size', '100'])
  const managedApps = parseJson(managed.out)
  const createdApps = parseJson(created.out)
  console.log(
    `${org.isCurrent ? '*' : ' '} ${org.corpName}\n    corpId=${org.corpId}\n` +
      `    我管理的：${Array.isArray(managedApps) ? managedApps.length : '解析失败'} 个；` +
      `我创建的：${Array.isArray(createdApps) ? createdApps.length : '解析失败'} 个`,
  )
  const sample = Array.isArray(managedApps) && managedApps.length > 0 ? managedApps : createdApps
  if (Array.isArray(sample)) {
    for (const app of sample.slice(0, 8)) {
      console.log(`      - ${app.name ?? app.appName ?? '(无名)'}  ${app.appType ?? app.appType_ ?? ''}`)
    }
  }
  console.log('')
}

await run(['org', 'switch', '--corp-id', original])
console.log(`已切回原组织：${original}`)
