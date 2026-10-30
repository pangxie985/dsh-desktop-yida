/**
 * 安装 / 卸载 `dsh-desktop-yida` 到 DSH profile。
 *
 * 用 Node 而不是 PowerShell：JSON/YAML 必须写成不带 BOM 的 UTF-8。
 *
 * 做的事（幂等，改前备份）：
 *   0. 确保插件目录里有**能跑**的 OpenYida CLI：npm → pnpm → DSH 自带 pnpm（--cli-tarball 可指定离线包）；
 *      装不上或跑不起来就 **exit 1**，绝不打印「安装完成」。
 *   1. profile/node_modules/<包名>：建立目录联接（junction，无需管理员）
 *   2. profile/package.json：dependencies 加 "dsh-desktop-yida": "link:<插件目录>"，并加入 dsh.profile.bundles
 *   3. 清理 cordis.patch.yml 里的历史挂载行 —— 不再往里写新条目：
 *      `dsh.profile.bundles` 已经足够挂载（bundle 自带的 patch 会生效），
 *      再往 profile patch 里插一条同 id 会「挂载两次」，且容易把 `[]` 空文档写成非法 YAML。
 *
 * 用法：
 *   node scripts/install.mjs                      # 默认 desktop
 *   node scripts/install.mjs --profile web
 *   node scripts/install.mjs --uninstall
 *   node scripts/install.mjs --plugin D:/x/dsh-desktop-yida --dsh-home C:/Users/me/.dsh
 *   node scripts/install.mjs --skip-cli           # 不自动安装 openyida（自己保证 CLI 可用）
 *   node scripts/install.mjs --cli-tarball ./openyida-2026.10.30.tgz   # 离线安装 CLI
 *
 * ⚠️ 步骤顺序：桌面版会热监听 profile 配置，**任何提到新包名的配置一落地就会触发重载**。
 *   所以先把「新包名可被解析」（联接 + package.json 依赖）做好，最后才动配置里的挂载列表。
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripPatchEntry } from '../lib/patch-file.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_NAME = 'dsh-desktop-yida'
/** 旧包名：安装时顺手清理，避免两个 id 同时挂载。 */
const LEGACY_NAMES = ['dsh-yida']

function parseArgs(argv) {
  const out = {
    profile: 'desktop',
    uninstall: false,
    plugin: resolve(HERE, '..'),
    dshHome: '',
    skipCli: false,
    cliTarball: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--uninstall') out.uninstall = true
    else if (arg === '--skip-cli') out.skipCli = true
    else if (arg.startsWith('--profile=')) out.profile = arg.slice('--profile='.length)
    else if (arg === '--profile') out.profile = argv[++i]
    else if (arg.startsWith('--plugin=')) out.plugin = arg.slice('--plugin='.length)
    else if (arg === '--plugin') out.plugin = argv[++i]
    else if (arg.startsWith('--dsh-home=')) out.dshHome = arg.slice('--dsh-home='.length)
    else if (arg === '--dsh-home') out.dshHome = argv[++i]
    else if (arg.startsWith('--cli-tarball=')) out.cliTarball = arg.slice('--cli-tarball='.length)
    else if (arg === '--cli-tarball') out.cliTarball = argv[++i]
  }
  out.dshHome = out.dshHome || process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return out
}

const args = parseArgs(process.argv.slice(2))
const PLUGIN_DIR = resolve(args.plugin)
const PROFILE_DIR = join(resolve(args.dshHome), 'profiles', args.profile)
const PACKAGE_JSON = join(PROFILE_DIR, 'package.json')
const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml')
const NODE_MODULES = join(PROFILE_DIR, 'node_modules')

const log = (msg) => console.log('  ' + msg)
const step = (msg) => console.log('==> ' + msg)
const linkPathOf = (name) => join(NODE_MODULES, name)

/**
 * 路径是否「存在」——含悬空联接。
 * `existsSync` 对悬空 junction 返回 false，但那正是"插件目录被搬走"后的典型状态，
 * 不识别会导致重建联接时 EEXIST。用 lstat 判断更可靠。
 */
function pathPresent(target) {
  try {
    lstatSync(target)
    return true
  } catch {
    return false
  }
}

/** 建立（或重建）指向插件目录的目录联接。 */
function ensureJunction(name) {
  const linkPath = linkPathOf(name)
  if (pathPresent(linkPath)) {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      unlinkSync(linkPath)
    } else if (stat.isDirectory()) {
      // 部署时可能被真实目录占位，属于异常状态，直接报错让人处理
      throw new Error(`node_modules/${name} 已存在且不是联接，请手动处理：${linkPath}`)
    }
  }
  mkdirSync(NODE_MODULES, { recursive: true })
  symlinkSync(PLUGIN_DIR, linkPath, 'junction')
  log(`已建立联接 node_modules/${name} → ${PLUGIN_DIR}`)
}

/** 删除目录联接（不存在则跳过）。 */
function removeJunction(name) {
  const linkPath = linkPathOf(name)
  if (!pathPresent(linkPath)) return
  const stat = lstatSync(linkPath)
  if (stat.isSymbolicLink()) {
    unlinkSync(linkPath)
  } else {
    rmdirSync(linkPath)
  }
  log(`已移除 node_modules/${name}`)
}

/** 插件目录里是否已有可用的 OpenYida CLI。 */
function hasLocalCli() {
  return existsSync(join(PLUGIN_DIR, 'node_modules', 'openyida', 'bin', 'yida.js'))
}

if (!existsSync(PACKAGE_JSON)) {
  console.error(`找不到 profile 的 package.json：${PACKAGE_JSON}`)
  process.exit(2)
}
if (!args.uninstall && !existsSync(join(PLUGIN_DIR, 'package.json'))) {
  console.error(`插件目录里没有 package.json：${PLUGIN_DIR}`)
  process.exit(2)
}

step(`插件目录 ${PLUGIN_DIR}`)
step(`目标 profile ${PROFILE_DIR}`)

if (args.uninstall) {
  // ---- 卸载：先摘联接，再清配置（顺序与安装相反） -------------------------
  for (const name of [PKG_NAME, ...LEGACY_NAMES]) removeJunction(name)

  const stampU = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(PACKAGE_JSON, `${PACKAGE_JSON}.bak-${stampU}`)

  const pkgU = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  const removed = []
  for (const name of [PKG_NAME, ...LEGACY_NAMES]) {
    if (pkgU.dependencies && pkgU.dependencies[name]) {
      delete pkgU.dependencies[name]
      removed.push(name)
    }
  }
  if (pkgU.dsh && pkgU.dsh.profile && Array.isArray(pkgU.dsh.profile.bundles)) {
    pkgU.dsh.profile.bundles = pkgU.dsh.profile.bundles.filter((name) => ![PKG_NAME, ...LEGACY_NAMES].includes(name))
  }
  writeFileSync(PACKAGE_JSON, JSON.stringify(pkgU, null, 2) + '\n', 'utf8')
  log(`已从 package.json 移除：${removed.join(', ') || '（无）'}`)

  if (existsSync(PATCH_FILE)) {
    copyFileSync(PATCH_FILE, `${PATCH_FILE}.bak-${stampU}`)
    const before = readFileSync(PATCH_FILE, 'utf8')
    const { text, removed: removedEntries } = stripPatchEntry(before, [PKG_NAME, ...LEGACY_NAMES])
    if (removedEntries.length > 0 || text !== before) writeFileSync(PATCH_FILE, text, 'utf8')
    log(removedEntries.length > 0 ? `已从 cordis.patch.yml 移除挂载行：${removedEntries.join(', ')}` : 'cordis.patch.yml 无需清理')
  }

  console.log('\n卸载完成。重启 DSH 后该插件不再加载。')
  process.exit(0)
}

// ---- 0. OpenYida CLI（先备好，装不上就不要继续） ---------------------------
/**
 * 找一个可用的 DSH 自带运行时（node + pnpm）。
 *
 * 只有 DSH 的机器上 PATH 里既没有 npm 也没有 git，但 DSH 会自带 node + pnpm；
 * 用它们装 CLI 是这条路径唯一不靠外部环境的方式。
 * @returns {{node: string, pnpm: string}|null} 运行时路径。
 */
function findDshRuntime() {
  const roots = [join(args.dshHome, 'dsh-runtimes')]
  for (const root of roots) {
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const deps = join(root, entry.name, 'dependencies')
      const node = join(deps, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
      const pnpm = join(deps, 'pnpm', 'bin', 'pnpm.cjs')
      if (existsSync(node) && existsSync(pnpm)) return { node, pnpm }
    }
  }
  return null
}

/** 用指定的命令安装 openyida（失败返回 false，不抛）。 */
function tryInstallCli(label, command, commandArgs, options = {}) {
  log(`尝试用 ${label} 安装 openyida …`)
  const result = spawnSync(command, commandArgs, {
    cwd: PLUGIN_DIR,
    stdio: 'inherit',
    shell: options.shell === true,
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: 10 * 60 * 1000,
  })
  if (result.error !== undefined) {
    log(`${label} 不可用：${result.error.message}`)
    return false
  }
  if (result.status !== 0) {
    log(`${label} 安装失败（exit ${result.status}）`)
    return false
  }
  return hasLocalCli()
}

/** 真正执行一次 CLI，确认它可跑（「装上了」不等于「能用」）。 */
function verifyCli() {
  const cliPath = join(PLUGIN_DIR, 'node_modules', 'openyida', 'bin', 'yida.js')
  if (!existsSync(cliPath)) return { ok: false, error: '未找到 node_modules/openyida/bin/yida.js' }
  const result = spawnSync(process.execPath, [cliPath, 'agent-capabilities', '--json'], {
    cwd: PLUGIN_DIR,
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (result.error !== undefined) return { ok: false, error: result.error.message }
  if (result.status !== 0) {
    return { ok: false, error: `CLI 执行失败（exit ${result.status}）：${String(result.stderr ?? '').slice(-300)}` }
  }
  return { ok: true }
}

if (!args.skipCli && !hasLocalCli()) {
  step('安装 OpenYida CLI 到插件目录（node_modules/openyida）')
  const runtime = findDshRuntime()
  /** 安装尝试顺序：显式 tarball → npm → pnpm → DSH 自带 pnpm。 */
  const attempts = []
  if (args.cliTarball !== '') {
    attempts.push(['本地 tarball', 'npm', ['install', resolve(args.cliTarball), '--no-save', '--no-audit', '--no-fund'], { shell: true }])
  }
  attempts.push(['npm', 'npm', ['install', 'openyida@latest', '--no-save', '--no-audit', '--no-fund', '--loglevel=error'], { shell: true }])
  attempts.push(['pnpm', 'pnpm', ['add', 'openyida@latest', '--ignore-workspace', '--reporter=silent'], { shell: true }])
  if (runtime !== null) {
    attempts.push([
      'DSH 自带 pnpm',
      runtime.node,
      [runtime.pnpm, 'add', 'openyida@latest', '--ignore-workspace', '--reporter=silent'],
      { env: { PATH: `${dirname(runtime.node)}${delimiter}${process.env.PATH ?? ''}` } },
    ])
  }
  let installed = hasLocalCli()
  for (const [label, command, commandArgs, options] of attempts) {
    if (installed) break
    installed = tryInstallCli(label, command, commandArgs, options)
  }
  if (!installed) {
    console.error('')
    console.error('✗ 装不上 OpenYida CLI：这台机器上没有可用的 npm / pnpm，自动安装失败。')
    console.error('  插件本身已经就绪，但没有 CLI 时所有工具都不可用（会报 "openyida CLI 未找到"）。')
    console.error('')
    console.error('  请任选其一后再重跑本脚本：')
    console.error('    1) 安装 Node.js（自带 npm）：https://nodejs.org/')
    console.error('    2) 在能上网的机器上执行 `npm pack openyida`，把 tgz 拷过来：')
    console.error(`       node "${join(PLUGIN_DIR, 'scripts', 'install.mjs')}" --cli-tarball <openyida-x.y.z.tgz>`)
    console.error('    3) 手工把 openyida 及其依赖放进插件目录的 node_modules/openyida')
    console.error('')
    process.exit(1)
  }
  const verified = verifyCli()
  if (!verified.ok) {
    console.error('')
    console.error('✗ OpenYida CLI 装上了但跑不起来：' + verified.error)
    console.error('  请先修好 CLI（例如网络/权限问题）再重跑本脚本。')
    console.error('')
    process.exit(1)
  }
  log('OpenYida CLI 就绪，且已实测可执行')
} else if (hasLocalCli()) {
  const verified = verifyCli()
  log(verified.ok ? 'OpenYida CLI 已就绪（实测可执行），跳过安装' : 'OpenYida CLI 存在但执行失败：' + verified.error)
  if (!verified.ok && !args.skipCli) process.exit(1)
}

// ---- 1. 先建联接：让新包名在配置落地前就能被解析 -------------------------
step('建立 profile 联接')
ensureJunction(PKG_NAME)
// 旧包名的联接一并清掉（配置层面随后也会清理）
for (const legacy of LEGACY_NAMES) {
  if (existsSync(linkPathOf(legacy))) removeJunction(legacy)
}

// ---- 2. 再改 package.json ------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
copyFileSync(PACKAGE_JSON, `${PACKAGE_JSON}.bak-${stamp}`)
log(`已备份 package.json → package.json.bak-${stamp}`)

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
pkg.dependencies = pkg.dependencies ?? {}
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
let bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []

pkg.dependencies[PKG_NAME] = 'link:' + PLUGIN_DIR.replace(/\\/g, '/')
log(`dependencies.${PKG_NAME} = ${pkg.dependencies[PKG_NAME]}`)

// 清理旧包名，避免新旧两个 id 同时挂载
for (const legacy of LEGACY_NAMES) {
  if (pkg.dependencies[legacy]) {
    delete pkg.dependencies[legacy]
    log(`已移除旧依赖 ${legacy}`)
  }
  if (bundles.includes(legacy)) {
    bundles = bundles.filter((name) => name !== legacy)
    log(`已从 bundles 移除旧条目 ${legacy}`)
  }
}
if (!bundles.includes(PKG_NAME)) bundles = [...bundles, PKG_NAME]
pkg.dsh.profile.bundles = bundles
log(`bundles 末尾：${bundles.slice(-2).join(', ')}`)
writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

// ---- 3. 清理旧的 cordis.patch.yml 挂载行（不再往里写任何东西） --------------
// `dsh.profile.bundles` 已经足以挂载（bundle 自带 patch 会生效）；再往 profile patch 里
// 写一条同 id 的 insert 会造成「同一条目挂载两次」（他人反馈的第 4 条），所以这里只做清理。
if (existsSync(PATCH_FILE)) {
  const before = readFileSync(PATCH_FILE, 'utf8')
  const { text, removed } = stripPatchEntry(before, [PKG_NAME, ...LEGACY_NAMES])
  if (removed.length > 0) {
    copyFileSync(PATCH_FILE, `${PATCH_FILE}.bak-${stamp}`)
    writeFileSync(PATCH_FILE, text, 'utf8')
    log(`已清掉历史挂载行：${removed.join(', ')}（现在只靠 bundles 挂载，避免重复条目）`)
  } else if (before.includes(PKG_NAME)) {
    // 只剩注释之类，也顺手清掉，保证文件干净
    copyFileSync(PATCH_FILE, `${PATCH_FILE}.bak-${stamp}`)
    writeFileSync(PATCH_FILE, text, 'utf8')
    log('已清掉 cordis.patch.yml 里的历史残留')
  } else {
    log('cordis.patch.yml 无需改动（不写挂载行）')
  }
}

console.log('')
console.log('安装完成。接下来：')
console.log('  1) 硬刷新界面：Ctrl+Shift+R（client bundle 需要重新注入）')
console.log('  2) 右侧栏 Ctrl+Alt+B 展开 → guide / 新建标签 → 「宜搭工作台」')
console.log('  3) 未登录时点工作台工具栏的「登录」按钮（会用 DSH 内置浏览器打开钉钉授权）')
console.log('  4) 自检：让模型调用 yida_status，应返回 ok: true')
