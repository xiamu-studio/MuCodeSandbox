"""Generate a source/document inventory. Does not inspect private runtime data."""
from pathlib import Path
import subprocess, json, datetime
from collections import defaultdict
from zoneinfo import ZoneInfo

root=Path(__file__).resolve().parent.parent
index=root/'docs/project-files.md'
stats=root/'docs/project-file-stats.json'
index.touch(exist_ok=True)
if not stats.exists():stats.write_text('{}\n')
files=subprocess.run(['rg','--files','--hidden','-g','!.git','-g','!node_modules','-g','!dist',
    '-g','!dist-server','-g','!release','-g','!test-results','-g','!native/bin','-g','!build-info.json'],
    cwd=root,capture_output=True,text=True,check=True).stdout.splitlines()
files=sorted(files)
groups=defaultdict(list)
for file in files:groups[file.split('/')[0] if '/' in file else '(root)'].append(file)
generated=datetime.datetime.now(ZoneInfo('Asia/Taipei')).isoformat(timespec='seconds')
lines=['# MuCodeSandbox 源码与文档文件清单','',f'生成时间：{generated}（台北时间）。',
       f'项目根目录：`{root}`。',f'本次共 **{len(files)} 个文件**，包含工作区中尚未提交的实际文件。','',
       '该清单覆盖源码、配置、文档、测试、脚本和资源；遵循项目忽略规则，',
       '依赖、编译产物、测试原件、Git 内部文件、原生二进制和真实 VM 数据不逐文件展开。',
       '这些目录的位置和用途在文末单独列出。文件存在不代表功能或测试已通过。','',
       '[项目总览](../PROJECT_OVERVIEW.md) · [待办](TODO.md) · [文档导航](README.md)','',
       '## 目录统计','','| 目录 | 文件数 |','| --- | --- |']
for group in sorted(groups):lines.append(f'| {group} | {len(groups[group])} |')
def role(file):
    if file.startswith('scripts/audit-claude'):return 'CLI 环境审计脚本；非已安装 GUI 常驻功能'
    if file.startswith('scripts/verify-'):return '专项验证 / 证据复核；结果以报告限定范围为准'
    if file.startswith('scripts/'):return '构建、检查、夹具或开发辅助；运行前查看脚本和对应方案'
    if file.startswith('tests/'):return '单元 / API / 回归测试文件'
    if file.startswith('docs/plans/'):return '设计 / 实施方案；不是验证通过证明'
    if file.startswith('docs/archive/') or 'history-' in file:return '历史记录；不作为当前配置或执行指令'
    if file.startswith('docs/'):return '说明 / 状态 / 待办 / 验证；具体版本见文件内容'
    if file.startswith('server/'):return '本机服务、VM、网络、权限或恢复模块'
    if file.startswith('src/'):return '前端界面、交互、样式或 API 调用'
    if file.startswith('shared/'):return '公共类型、校验、配置或版本'
    if file.startswith('desktop/'):return '桌面启动、窗口或本地页面资源'
    if file.startswith('native/'):return 'Mac 原生助手、沙箱配置或边界探针'
    if file.startswith('assets/'):return '界面 / 应用资源'
    if file.startswith('examples/'):return '示例项目文件'
    return '项目入口、依赖、构建配置或说明'
for group in sorted(groups):
    lines+=['',f'## {group}','', '| 文件（相对项目根目录） | 用途 |','| --- | --- |']
    for file in groups[group]:
        lines.append(f'| [{file}](../{file}) | {role(file)} |')
lines+=['','## 单独管理的目录 / 文件','','| 位置 | 用途与范围 |','| --- | --- |',
 '| `node_modules/` | 开发依赖，按 package-lock 安装；不是应用手写源码 |',
 '| `dist/`、`dist-server/` | 前端和服务端编译产物，由构建生成 |',
 '| `native/bin/` | 已编译的本机助手；由原生构建步骤生成 |',
 '| `build-info.json` | 对构建内容计算出的标识与构建时间 |',
 '| `release/` | 桌面候选与历史副本；当前交付路径见总览 |',
 '| `test-results/` | 原始报告、截图、抓包、日志与受校验审计包；不是全部公开分享材料 |',
 '| `.mu-data/` | 隔离的源码开发数据；使用时才生成，不与正式试用目录混用 |',
 '| `/Users/staff/.mucodesandbox/` | 真实环境配置、数据库、密钥、VM 磁盘与运行组件 |',
 '| `/Users/staff/Applications/MuCodeSandbox.app` | 已安装的本机应用副本 |',
 '| `/Users/staff/Desktop/MuCodeSandbox.app` | 指向已安装副本的桌面快捷链接 |','',
 '## 更新与核对','',
 '在项目根目录运行 `python3 scripts/write-project-files.py` 可重新生成本清单。',
 '这一步只读取工作区文件名与大小并写文档，不启动 VM、不构建或下载依赖。',
 '统计数据见 [project-file-stats.json](project-file-stats.json)。生成的清单与统计',
 '自身不计入文件字节总量，避免自引用导致统计不断变化。']
index.write_text('\n'.join(lines)+'\n')
logical=sum((root/file).stat().st_size for file in files if root/file not in [index,stats])
stats.write_text(json.dumps({'generatedAtTaipei':generated,'projectRoot':str(root),'fileCount':len(files),
    'directoryCounts':{g:len(v) for g,v in sorted(groups.items())},
    'logicalBytesExcludingGeneratedIndexAndStats':logical,
    'excluded':['Git internals','dependencies','compiled outputs','test-results','native binaries','VM runtime data']},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'fileCount':len(files),'sourceAndDocumentLogicalBytes':logical,'index':str(index)},ensure_ascii=False))
