# 桌面客户端与 Chrome 启动分离

问题：桌面客户端先调用 browser.open，Chrome 负责启动 X/VNC/音频，导致打开客户端却出现浏览器首页。

调整：独立 mucodesandbox-display.service 管理 X/VNC/xsettings/音频；Chrome 与桌面客户端均依赖显示服务，但彼此不依赖。桌面启动不安装、不启动、不读取 Chrome 资料。浏览器“关闭”只关闭 Chrome，停止/重启/隔离环境仍撤销全部显示和客户端。

验证：单元验证桌面路径不调用 browser.open，显示服务不含 Chrome；实际 VM 从浏览器关闭状态打开未登录客户端，确认 Chrome 服务未启动、renderer 防护通过，画面可用；再确认 Chrome 开关不结束客户端，环境停止结束全部服务。本机打包更新并检查。全程不设置 keyring 密码、不清空资料、不登录、不降级加密。
