import {installBroker} from '../server/platform/windows/broker.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
await installBroker(windowsRuntimeDirectory());
console.log('Windows 权限代理已安装到受保护目录；未注册自动启动服务。');
