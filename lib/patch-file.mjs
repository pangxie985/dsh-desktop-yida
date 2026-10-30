/**
 * `cordis.patch.yml` 的纯文本处理工具。
 *
 * 为什么不用 js-yaml 读-改-写：这个脚本要在**装得很干净的**机器上跑，
 * 不能假设 profile 里有 js-yaml。这里的操作只需要「找到我们的 insert 块并删掉」，
 * 用行级处理即可，但必须处理几种边界：
 *   - 文件内容是 `[]`（空文档）或空文件；
 *   - 块在中间 / 末尾 / 是最后一个块；
 *   - 旧包名（dsh-yida）残留；
 *   - 删除后只剩注释行 —— 这些注释可以保留，但绝不能残留孤立的 `- insert:`。
 *
 * @module dsh-desktop-yida/patch-file
 */

/** `- id: xxx` 行（允许前面有缩进、允许 id 带引号）。 */
const ID_LINE = /^\s*-\s*id:\s*(\S+)\s*$/

/** 去掉 id 两侧的引号。 */
function unquote(value) {
  return String(value).replace(/^['"]/, '').replace(/['"]$/, '')
}

/**
 * 判断文件内容是否只是「空文档」：空、`[]`、`null`、仅 `---`、或只有注释与空行。
 * @param {string} text - 文件内容。
 * @returns {boolean} 是否等价于空 overlay。
 */
export function isEmptyOverlay(text) {
  if (typeof text !== 'string') return true
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .every((line) => line === '[]' || line === '---' || line === 'null')
}

/**
 * 移除删除条目后失去子项的孤立 `- insert:` 行。
 *
 * 一段 patch 的结构是 `- insert:` + 更深缩进的子项；子项被删光后，
 * 这个 `- insert:` 就成了非法/无意义的空条目（DSH 会解析成 null）。
 * @param {string[]} lines - 行数组。
 * @returns {string[]} 处理后的行数组。
 */
function dropOrphanInserts(lines) {
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '- insert:') {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j += 1
      const next = lines[j]
      const hasChild = next !== undefined && /^\s+\S/.test(next) && !next.trim().startsWith('-')
      if (!hasChild) continue
    }
    out.push(line)
  }
  return out
}

/**
 * 删除配置里指定 id 的 insert 条目（连同紧随其后的 `name:` 行）。
 *
 * 不改变其余内容，也不会追加任何东西——调用方不要再用「读文本 + 末尾拼字符串」的方式写这个文件。
 *
 * @param {string} text - 原文件内容。
 * @param {string[]} names - 要删除的插件 id / 包名。
 * @returns {{text: string, removed: string[]}} 处理后的文本与被删除的 id 列表。
 */
export function stripPatchEntry(text, names) {
  const wanted = new Set(names)
  const commentPatterns = names.map((name) => new RegExp(`^\\s*#\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  const removed = []
  const lines = (text ?? '').split(/\r?\n/)
  const kept = []
  let skipName = false

  for (const line of lines) {
    // 安装器自己写过的说明注释也一并清掉，避免卸载后文件里还留着"幽灵"标记
    if (commentPatterns.some((pattern) => pattern.test(line))) continue
    if (skipName) {
      skipName = false
      if (/^\s*name:\s*/.test(line)) continue
    }
    const match = line.match(ID_LINE)
    if (match !== null && wanted.has(unquote(match[1]))) {
      removed.push(unquote(match[1]))
      skipName = true
      continue
    }
    kept.push(line)
  }

  const next = dropOrphanInserts(kept).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  return { text: next, removed }
}

/**
 * 删除指向本插件的注释行（安装器自己写过的说明注释）。
 * @param {string} text - 原文件内容。
 * @param {string[]} names - 插件 id / 包名。
 * @returns {string} 处理后的文本。
 */
export function stripPatchComments(text, names) {
  const patterns = names.map((name) => new RegExp(`^\\s*#\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  return (text ?? '')
    .split(/\r?\n/)
    .filter((line) => !patterns.some((pattern) => pattern.test(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s*$/, '\n')
}
