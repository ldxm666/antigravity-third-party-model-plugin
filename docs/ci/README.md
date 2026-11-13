# 可选持续集成

本仓库当前以本地验证结果发布。发布使用的 GitHub CLI 授权不含 `workflow` 写入权限，因此没有为推送工作流扩大授权范围。

[github-actions.yml.example](github-actions.yml.example) 是未启用的模板。维护者可在自己审查后，通过具有相应权限的正常 GitHub 操作，将它放到 `.github/workflows/ci.yml`，然后在 Actions 页确认实际运行结果。模板本身不会执行。

模板使用 Node.js 24，分别在 Ubuntu 与 Windows 运行 `npm test`，并在 Windows 运行隔离安装测试。只授予 `contents: read`，不使用真实 API Key；官方 actions 固定到提交 SHA，checkout 不保留凭据。

在本地执行等价检查：

```text
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:installer
```

不要仅为本项目启用自动测试而分享个人令牌。账户、令牌权限与到期时间应由账户所有者在 GitHub 正常界面中管理。
