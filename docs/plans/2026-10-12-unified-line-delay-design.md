# 用户纠正：主数值为 Clash 式线路延迟

用户提供 Clash Verge 节点列表，明确要节点右侧几十 / 几百 ms 的值。0.4.13 的首次 HTTPS 响应时间不符合该主指标需求，保留原始证据，不把它改称线路延迟。

核对本机 Mihomo 1.19.31、只读运行配置：unified-delay=true。官方 URLTest 实现先发 HEAD 建立连接，然后复用同一连接发第二次 HEAD；成功时计第二次请求往返。参考 https://github.com/MetaCubeX/mihomo/blob/v1.19.31/adapter/adapter.go#L244 。没有改 Clash 的订阅、节点、模式或全局配置。

实现采用同类计算方式，在当前受保护 Linux 环境经当前线路测三轮，每轮两个 HTTP/1.1 HEAD。curl 自身计时，排除管理命令耗时；第二次必须 num_connects=0，否则失败，不混入新连接耗时。主数值用第二次请求总时长的中位数；第一次的首次响应作为“网页首次响应耗时”补充。仍验证 HTTPS，固定站点、不跟随重定向、不传账户和 Cookie、不退回直连。保持检测前后批准出口核验与停止 / 改配置取消。

这不是直接读取 Clash 另一条节点的数字，也不声称与截图不同节点或不同测试地址的数值完全相等。当前沙箱用自有美国 VPS 的 SSH 代理，Clash 截图 / 只读状态为另一条台湾节点。

初步真实配对测量：建连响应1423ms、复用线路190ms，第二次新建连接0，HTTP204；原件 `test-results/access-latency/warm-line-preflight.json`。随后按新版本测试完整三轮和本机界面，结果见验收报告。
