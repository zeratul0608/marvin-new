# 本地化学计算验证

- 31 项专项测试：真实 RDKit WASM 的分子性质、氢数、电荷、同位素、芳香性、常见立体化学、融合／桥／螺环清理、原子身份、选区、撤销、异步版本与停用保护，以及聚合物整体计算拒绝和组外普通分子计算。
- [浏览器报告](browser-results.json)：开发页面、生产构建及独立 SDK，真实点击 SMILES 输入、二维清理、立体标签、撤销／重做和 CDXML 下载；仅本地请求，按需加载 WASM。
- [适配回读报告](adapter-results.json)：10 种自行构建的结构，各导出清理前后 CDX 和 CDXML，共 40 份，重新解析后核对化学身份。
- [原生运行时复核](independent-results.json)：Python RDKit 2025.03.6 使用自身 CDX/CDXML 解析器读取上述 40 份文件，核对异构 SMILES、平均／精确质量及 R/S、E/Z。它与浏览器 WASM 是独立运行时和解析路径，但仍基于 RDKit，不能视作不同化学工具包或 ChemDraw 认证。

样例涵盖阿司匹林、萘、桥环、螺环、S-丙氨酸、E/Z-丁烯、吡咯、同位素与铵离子。所有文件均由自己的 SMILES 输入生成，不含商业样本。

```powershell
npm test
npm run build
node scripts/prepare-chemistry-test-files.mjs
python scripts/validate-chemistry-engine.py --dependencies .local/cdx-reference/validation-deps
node scripts/validate-chemistry-browser.mjs
python scripts/prepare-engine-test-files.py
```

浏览器脚本需要 5173 开发服务及 Playwright，可用首个参数传入模块路径。Python 参数指向已有 RDKit 安装目录。手动测试访问 `/test-files/index.html` 的 `09-chemistry-engine`；可导入 `*-before.*` 后点击自动二维清理，与 `*-clean.*` 对照。
