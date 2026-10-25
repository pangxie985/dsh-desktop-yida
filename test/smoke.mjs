/**
 * 冒烟测试：用真实的 OpenYida CLI（子进程）验证 `lib/yida-cli.js` 的调用链。
 *
 * 只跑只读命令（`agent-capabilities` / `commands`），不会登录、不会写任何宜搭数据。
 * 需要能派生子进程的环境（DSH 的 pwsh 沙箱内会 `spawn EPERM`，需放开权限运行）。
 *
 * 用法：
 *   node test/smoke.mjs
 *   OPENYIDA_CLI=D:\path\to\yida.js node test/smoke.mjs
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseJsonOutput, resolveCli, runCli } from '../lib/yida-cli.js'

const candidates = [
  process.env.OPENYIDA_CLI,
  // 插件本地安装（npm install --prefix <插件目录> openyida）后的位置
  fileURLToPath(new URL('../node_modules/openyida/bin/yida.js', import.meta.url)),
  // 本地开发时的 vendor 副本（.gitignore 已排除，不随仓库分发）
  fileURLToPath(new URL('../vendor/openyida/bin/yida.js', import.meta.url)),
].filter(Boolean)

const cliPath = candidates.find((candidate) => existsSync(candidate))
if (!cliPath) {
  console.error('未找到 openyida：请先 npm i -g openyida，或设置 OPENYIDA_CLI 指向 bin/yida.js')
  process.exit(2)
}

console.log('使用 CLI：' + cliPath)
const resolved = resolveCli({ cliPath })
console.log('执行方式：' + resolved.command + ' ' + resolved.prefix.join(' ') + '（来源 ' + resolved.source + '）')

let failures = 0

for (const [label, args] of [
  ['只读：agent-capabilities --summary-json', ['agent-capabilities', '--summary-json']],
  ['只读：commands', ['commands']],
]) {
  const result = await runCli(args, { resolved, timeoutMs: 60000 })
  const parsed = parseJsonOutput(result.stdout)
  const ok = result.code === 0 && parsed !== undefined
  if (!ok) failures += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label} → 退出码 ${result.code}，解析到 JSON：${parsed === undefined ? '否' : '是'}` +
      (result.spawnError ? `，spawnError=${result.spawnError}` : '') +
      (result.stderr ? `，stderr=${result.stderr.trim().slice(0, 160)}` : ''),
  )
  if (ok && label.includes('agent-capabilities')) {
    console.log(
      `      版本 ${parsed.version}，登录态 ${parsed.login?.status}，工作目录 ${parsed.workdir}`,
    )
  }
  if (ok && label.includes('commands')) {
    console.log(`      命令组 ${parsed.groups?.length} 个，命令清单版本 ${parsed.version}`)
  }
}

if (failures > 0) {
  console.error(`\nsmoke: ${failures} 项失败`)
  process.exit(1)
}
console.log('\nsmoke: 全部通过（未做任何登录与写入）')
