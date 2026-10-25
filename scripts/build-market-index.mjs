/**
 * 生成并校验 DSH 官方插件市场索引（format 1）。
 *
 * 用运行中的 DSH 自带的校验器 `@deepseek-ai/dsh-plugin-market-index` 验证输出，
 * 保证生成的文件能被「插件 → 发现 → 添加索引源」直接接受。
 *
 * 约束（来自校验器源码）：
 *   - 根节点必须 `format: 1`，且 `title` 必需；
 *   - 多语言文本的 key 必须是小写语言 id，且必须包含 `en`；
 *   - 每个 version 必须有 `version`（精确 SemVer）、`publishTimestamp`（Unix 秒）、`source`；
 *   - git 源必须是 40 位小写 commit SHA。
 *
 * 注意：本脚本不派生子进程（DSH 沙箱内会 spawn EPERM），git 信息直接读文件。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VALIDATOR = 'E:/work/dsh-impl/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 从 .git 目录直接读 HEAD 指向的 commit（不调用 git）。 */
function readHeadCommit() {
  const gitDir = join(ROOT, '.git')
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  if (!head.startsWith('ref: ')) return head
  const ref = head.slice('ref: '.length).trim()
  try {
    return readFileSync(join(gitDir, ref), 'utf8').trim()
  } catch {
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      const match = line.match(/^([0-9a-f]{40})\s+(.+)$/)
      if (match && match[2].trim() === ref) return match[1]
    }
    throw new Error(`找不到 ref ${ref} 对应的 commit`)
  }
}

const commit = readHeadCommit()
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`读到的 commit 不像 40 位 SHA：${commit}`)

const remote = String(pkg.repository?.url ?? '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '')
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(remote)) {
  throw new Error(`package.json 的 repository.url 不可用：${remote}`)
}

const index = {
  format: 1,
  title: {
    en: 'dsh-desktop-yida index',
    zh: 'dsh-desktop-yida 官方索引',
  },
  description: {
    en: 'A DSH plugin that creates and edits DingTalk Yida apps with AI.',
    zh: '用 AI 创建、修改钉钉宜搭（Yida）应用的 DSH 插件。',
  },
  plugins: [
    {
      name: pkg.name,
      title: {
        en: 'Yida AI (dsh-desktop-yida)',
        zh: '宜搭 AI 开发（dsh-desktop-yida）',
      },
      description: {
        en: 'Create and edit DingTalk Yida apps from DeepSeek Harness with natural language: 14 tools for apps, forms, pages, schema and data, plus a sidebar workbench. Built on the OpenYida CLI.',
        zh: '在 DeepSeek Harness 里用自然语言创建/修改钉钉宜搭应用：14 个工具覆盖建应用、建改表单、发布页面、读 Schema、查数据；右侧栏「宜搭工作台」可直接打开应用查看。基于开源 CLI OpenYida。',
      },
      author: 'pangxie985',
      homepage: remote,
      repository: { url: remote },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'git', url: remote, commit },
          engines: { dsh: '>=0.2.0-rc.1' },
        },
      ],
    },
  ],
}

const { parseMarketIndex } = await import('file:///' + VALIDATOR.replace(/\\/g, '/'))
const validated = parseMarketIndex(
  index,
  'https://raw.githubusercontent.com/pangxie985/dsh-desktop-yida/main/market/index.json',
)

const outDir = join(ROOT, 'market')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'index.json')
writeFileSync(outFile, JSON.stringify(index, null, 2) + '\n', 'utf8')

console.log('官方校验器通过 ✅')
console.log('  插件：', validated.plugins[0].name, '→', validated.plugins[0].versions.map((v) => v.version).join(', '))
console.log('  提交：', commit)
console.log('  安装 spec：', `git+${remote}.git#${commit}`)
console.log('  写入：', outFile)
