import type { Environment } from '../shared/types.ts';

export function CleanupScope({ operation, kind = 'vm' }: { operation: 'browser' | 'rebuild' | 'delete'; kind?: Environment['kind'] }) {
  const browser = operation === 'browser' || kind === 'browser';
  return <div className="cleanup-scope">
    <div className="cleanup-scope-erase"><strong>永久清除</strong><p>{browser
      ? '此浏览器的网站登录、Cookie、缓存、历史、保存的密码及扩展。'
      : '整个 Linux 磁盘，Chrome / Claude / Grok / CLI 的登录、缓存和本地文件，以及本应用保存的环境快照。'}{operation === 'delete' && '环境配置也会删除。'}</p></div>
    <div><strong>保留内容</strong><p>{operation === 'browser'
      ? '虚拟机、桌面客户端与 CLI 资料、项目文件、线路及地区设置。'
      : operation === 'rebuild' ? '线路与地区设置；新环境使用空白资料，需要重新安装客户端。共享及宿主授权会取消。' : 'Mac 上的共享源文件。'}{operation === 'rebuild' && 'Mac 上的共享源文件保留。'}</p></div>
    <p className="cleanup-scope-note">{operation === 'browser' ? '旧快照和另存的导出备份仍可能包含原资料，恢复后会带回旧登录。' : '另存的导出备份和网站服务端记录不在删除范围内。'} 普通关闭重开、切换查看环境会保留资料。</p>
  </div>;
}
