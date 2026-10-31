# Windows 正式签名准备

当前 Windows 预览包保持未签名。`desktop/windows/builder.cjs` 和 `scripts/package-windows.ts` 默认关闭签名，避免开发机残留证书或环境变量改变预览包的行为。

正式发布前，在受控发布机准备带私钥的 Windows 代码签名证书和密码，然后设置 `MU_WINDOWS_SIGNING=1`，并按发布版本运行：

```powershell
$env:MU_WINDOWS_SIGNING = '1'
$env:WIN_CSC_LINK = '...'
$env:WIN_CSC_KEY_PASSWORD = '...'
node scripts/package-windows.ts --windows-version 0.4.66
```

签名模式会预先检查证书链接和密码；缺少任一项会在构建前直接失败。 签名模式会强制 electron-builder 签署可签名文件；证书或签名失败时打包直接失败。签名完成后仍需独立核对证书主题、时间戳、安装器和解包文件，再进行公证或发行平台验收。

回归检查：`node --test tests/windows-package-signing.test.ts` 覆盖预览默认不签名和显式模式强制签名两条配置路径。
