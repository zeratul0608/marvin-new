# 本地化学计算

本轮在独立编辑模型之上接入开源 RDKit WASM。安装包版本固定为 `@rdkit/rdkit@2026.9.1`，运行时报告 `2026.09.1`，BSD 3-Clause 许可证见 [许可证](../licenses/RDKit.BSD-3-Clause.txt)。没有调用 ChemDraw 桌面版或 DLL。

## 使用

打开工作台右侧的“化学计算”标签：

- **自动二维清理**：重新生成链、常见环、融合环、桥环和螺环的二维坐标。选择时须包含完整连通分子；没有选区时处理整份文档。各不连通片段保留原质心，不会重新排布反应箭头、条件或页面。
- **计算分子性质**：显示分子式、平均分子量、单同位素精确质量、总形式电荷、环数、芳香原子、未指定立体中心、计算 LogP 和 tPSA。输出框提供可复制的异构 SMILES。
- **计算并写入立体标签**：从当前二维分子和楔键重新计算适用的 R/S、r/s、E/Z，写入原子／键属性并显示在画布与 SVG。未指定的中心不会被自动指定构型。
- **从 SMILES 建立结构**：输入单条分子 SMILES，可用点分隔多个片段；点击“用 SMILES 替换画布（可撤销）”。支持普通芳香分子、常见电荷、同位素、显式氢、双重态自由基及常见立体标记。解析、验证成功后才替换画布。

首次点击才从应用本地加载约 7.4 MB 的 WASM。计算和排版不会向外部服务发送结构，之后仍需正常部署静态资源，不能删除该目录。

## 保留与校验

自动清理临时给原子分配连续映射编号，将生成坐标和楔线映射回原有稳定 ID，不覆盖原始用户映射、同位素、电荷、独立三维坐标或其他文档对象。清理前后重新解析并比较带映射的异构 SMILES，不一致就拒绝提交。

明确指定的非图氢数与 MDL HCOUNT 查询含义不同。适配器检查 RDKit 实际氢数；必要时加入临时真实 H 顶点再移除临时氢，保留原本就存在的显式 H 原子。元素、电荷、同位素、自由基和指定氢数均需验证一致，无法可靠传递时拒绝计算。

写入使用编辑器版本检查，加载期间文档修改或插件停用时不提交旧结果。清理、标签修改和 SMILES 替换均支持撤销／重做。分析为只读操作，文档或选区变化后清除过期结果。

## 适用边界

单次最多 1000 个原子，SMILES 最多 50000 字符。当前入口限已定义的普通完整分子，拒绝查询／SMARTS、内部缩写或备选片段、模板边界、多中心连接、轴手性、增强立体组、单重／三重自由基自旋态，以及不能由当前二维描绘可靠表达的显式立体约束。原文档仍可使用已有编辑和保存功能。

不支持反应 SMILES、多记录导入、名称转结构、通用 Markush／聚合物计算或所有 CIP 立体类别。独立三维坐标不参与本轮计算。性质是计算值；RDKit 的成功解析不等于实验正确或经过 ChemDraw 官方认证。已有来源 CIP 标签仅为缓存，不会作为新指派的依据。

涉及聚合物、重复或混合物括号组时，拒绝将所画单元作为完整分子计算或清理；成员范围已明确的组之外，可选择独立完整的普通分子计算。只有旧式图形括号而无成员范围时，计算入口采取保守拒绝。括号语义编辑不需要经过此计算入口，见 [聚合物功能](polymers.md)。

## SDK

AI 助手也已接入本模块，可通过自然语言执行只读分析、二维清理和用户提供的 SMILES 导入，仍沿用这里的适用边界与本地 WASM 资源。详见 [AI 与本地化学计算](ai-chemistry.md)。

```ts
import {createChemicalEditor,createChemistryPlugin} from './chemical-editor.js';
const editor=createChemicalEditor({
  container:document.querySelector('#editor'),
  plugins:[createChemistryPlugin()],
});
editor.showPluginPanel('chemistry-engine');
await editor.executeCommand('chemistry-engine.import-smiles','CCO');
const analysis=await editor.executeCommand('chemistry-engine.analyze');
await editor.executeCommand('chemistry-engine.clean-2d');
await editor.executeCommand('chemistry-engine.assign-stereo');
```

须把 `dist-sdk/rdkit-2026.9.1/` 和许可证与 JS 一起部署。CSP 须允许同源脚本、WASM 获取及 WASM 编译。浏览器也可调用 `loadChemistryEngine()` 获取独立计算 API；Node.js 使用 `createChemistryEngine(await initRDKit())` 注入模块，格式解析另需兼容 DOM。

实现：[计算适配器](../src/chemistry/engine.ts)、[资源加载](../src/chemistry/runtime.ts)、[界面插件](../src/plugins/chemistry-engine.ts)。复现和样例见 [验证报告](validation/chemistry-engine/README.md)。
