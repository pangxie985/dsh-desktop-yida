/**
 * 安装 / 卸载 `dsh-desktop-yida` 到 DSH profile。
 *
 * 用 Node 而不是 PowerShell：JSON/YAML 必须写成不带 BOM 的 UTF-8。
 *
 * ⚠️ 步骤顺序很重要（踩过坑）：
 *   桌面版会热监听 profile 配置与 bundle patch，**任何提到新包名的配置一落地就会触发重载**。
 *   所以必须先把「新包名可被解析」（node_modules 联接 + package.json 依赖）做好，
 *   **最后**才改 cordis.patch.yml。反过来做会让加载器去解析一个还不存在的包，
 *   轻则插件不加载，重则宿主直接重启。
 *
 * 做的事（幂等，改前备份）：
 *   0. 确保插件目录里有可用的 OpenYida CLI（node_modules/openyida，没有就 npm install）
 *   1. profile/node_modules/<包名>：建立目录联接（junction，无需管理员）
 *   2. profile/package.json：dependencies 加 "dsh-desktop-yida": "link:<插件目录>"，并加入 dsh.profile.bundles
 *   3. profile/cordis.patch.yml：追加挂载行，并清理旧包名（dsh-yida）残留
 *
 * 用法：
 *   node scripts/install.mjs                      # 默认 desktop
 *   node scripts/install.mjs --profile web
 *   node scripts/install.mjs --uninstall
 *   node scripts/install.mjs --plugin D:/x/dsh-desktop-yida --dsh-home C:/Users/me/.dsh
 *   node scripts/install.mjs --skip-cli           # 不自动安装 openyida
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_NAME = 'dsh-desktop-yida'
/** 旧包名：安装时顺手清理，避免两个 id 同时挂载。 */
const LEGACY_NAMES = ['dsh-yida']

function parseArgs(argv) {
  const out = { profile: 'desktop', uninstall: false, plugin: resolve(HERE, '..'), dshHome: '', skipCli: false }
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
    const lines = readFileSync(PATCH_FILE, 'utf8').split(/\r?\n/)
    const names = [PKG_NAME, ...LEGACY_NAMES]
    const kept = []
    let skipName = false
    for (const line of lines) {
      if (skipName) {
        skipName = false
        if (/^\s*name:\s*/.test(line)) continue
      }
      const idMatch = line.match(/^\s*-\s*id:\s*(\S+)\s*$/)
      if (idMatch && names.includes(idMatch[1])) {
        skipName = true
        continue
      }
      kept.push(line)
    }
    writeFileSync(PATCH_FILE, kept.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8')
    log('已从 cordis.patch.yml 移除挂载行')
  }

  console.log('\n卸载完成。重启 DSH 后该插件不再加载。')
  process.exit(0)
}

// ---- 0. OpenYida CLI（先备好，避免装完插件却跑不起来） -------------------
if (!args.skipCli && !hasLocalCli()) {
  step('安装 OpenYida CLI 到插件目录（node_modules/openyida）')
  const result = spawnSync('npm', ['install', 'openyida@latest', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: PLUGIN_DIR,
    stdio: 'inherit',
    shell: true,
  })
  if (result.status !== 0 || !hasLocalCli()) {
    console.warn('    ⚠ 自动安装失败。请手动执行：npm install --prefix "' + PLUGIN_DIR + '" openyida')
  } else {
    log('OpenYida CLI 就绪')
  }
} else if (hasLocalCli()) {
  log('OpenYida CLI 已就绪，跳过')
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

// ---- 3. 最后改 cordis.patch.yml（此时包已可解析，重载才是安全的） --------
if (existsSync(PATCH_FILE)) {
  copyFileSync(PATCH_FILE, `${PATCH_FILE}.bak-${stamp}`)
  log(`已备份 cordis.patch.yml → cordis.patch.yml.bak-${stamp}`)
}
const allNames = [PKG_NAME, ...LEGACY_NAMES]
const patchLines = existsSync(PATCH_FILE) ? readFileSync(PATCH_FILE, 'utf8').split(/\r?\n/) : []
const keptLines = []
let skippingName = false
let removedLegacy = false
for (const line of patchLines) {
  if (skippingName) {
    skippingName = false
    if (/^\s*name:\s*/.test(line)) continue
  }
  const idMatch = line.match(/^\s*-\s*id:\s*(\S+)\s*$/)
  if (idMatch && allNames.includes(idMatch[1])) {
    skippingName = true
    if (idMatch[1] !== PKG_NAME) removedLegacy = true
    continue
  }
  keptLines.push(line)
}
const keptText = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
const addition = [
  '',
  '# dsh-desktop-yida：AI 辅助创建/编辑钉钉宜搭应用 + 右侧栏「宜搭工作台」',
  '- insert:',
  `    - id: ${PKG_NAME}`,
  `      name: ${PKG_NAME}`,
  '',
].join('\n')
writeFileSync(PATCH_FILE, keptText + addition, 'utf8')
log(`已写入挂载行（${removedLegacy ? '并清理了旧包名残留' : '幂等重写'}）`)

console.log('')
console.log('安装完成。接下来：')
console.log('  1) 重启 DSH（Host 半要重新加载；重启会中断当前会话）')
console.log('  2) 右侧栏 Ctrl+Alt+B 展开 → guide / 新建标签 → 「宜搭工作台」')
console.log('  3) 若未登录：终端执行 openyida login')
