# RXN 验证

2026-11-05 实测：SDK 生成 12 个文件，原生独立解析 12 / 12 通过；Chrome 完成两版导入、属性编辑、撤销／重做及 4 次实际下载验证，页面运行错误为零。详细记录见 [实测报告](report.md)。

专项测试见 [rxn.test.ts](../../../tests/rxn.test.ts)，覆盖两版角色、agent、原子映射、同位素、电荷、坐标、楔线、反应键条件、修改与 JSON 恢复、计数／闭合／尾部检查，以及不支持语义的严格拒绝。

自建样例由明确的分子图和 Reaction SMILES 生成，不包含商业软件文件。原生 RDKit 另生成两版单步映射反应，再由应用导入并重建；独立验证比较反应物、产物、agents 三个角色各自的分子及数量，避免只比较合并后的结构掩盖角色变化。

```powershell
npm run build
python scripts/validate-rxn.py --dependencies .local/cdx-reference/validation-deps --prepare
node scripts/prepare-rxn-test-files.mjs
python scripts/validate-rxn.py --dependencies .local/cdx-reference/validation-deps
npx vitest run tests/rxn.test.ts
# 另一个终端运行 npm run dev，Playwright 模块路径也可作为首个参数传入。
node scripts/validate-rxn-browser.mjs
# 本机运行时的 Playwright 参数：
node scripts/validate-rxn-browser.mjs file:///C:/Users/admin/.codex/tools/playwright-mcp/node_modules/playwright/index.mjs
```

[适配结果](adapter-results.json)记录格式与原子映射自检；[独立结果](independent-results.json)由原生 Python RDKit 2025.03.6 检查映射的异构 SMILES、同位素、试剂角色与 RXCTR。独立运行时及解析器不等于完整商业 ChemDraw 或全部 RXN 特性的认证。

[浏览器结果](browser-results.json)覆盖两版真实文件输入导入、点击选择反应物、可见属性输入框把碳-13 改成碳-14、界面撤销／重做，再分别选择两版 RXN 实际下载。下载文件重新解析后核对反应物／产物／试剂三个角色、映射编号与配对、修改的同位素及反应键条件；导出不勾选有损选项。浏览器脚本不启动或验证 AI。

显式 VAL 等已有 MOL 边界仍明确拒绝；原生夹具使用相同化学身份的普通隐式氢表示，不把拒绝项计为成功。
