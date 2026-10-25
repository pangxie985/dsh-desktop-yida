# 安装 / 卸载 dsh-desktop-yida 到 DSH profile（薄封装，实际逻辑在 install.mjs）
#
#   powershell -File scripts/install.ps1
#   powershell -File scripts/install.ps1 -Profile web
#   powershell -File scripts/install.ps1 -Uninstall
#
# 用 Node 落地文件写入：JSON/YAML 必须是无 BOM 的 UTF-8。

[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$PluginDir = (Split-Path -Parent $PSScriptRoot),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'install.mjs'
if (-not (Test-Path -LiteralPath $installer)) { throw "找不到 $installer" }

$nodeArgs = @($installer, '--profile', $Profile, '--plugin', $PluginDir)
if ($Uninstall) { $nodeArgs += '--uninstall' }

& node @nodeArgs
exit $LASTEXITCODE
