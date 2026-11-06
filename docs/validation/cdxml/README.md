# CDXML 导出文件验证

验证日期：2026-11-01。

这些 `.cdxml` 文件由真实浏览器中的编辑器导出对话框下载，不是手写的预期输出。浏览器脚本检查默认损失保护、确认后下载、文件后缀及重新导入结果。记录见 [browser-results.json](browser-results.json)。

验证结果：8/8 文件通过独立 XML 语法、对象 ID、键引用及有限二维坐标检查；8/8 通过 RDKit 2025.03.6 的读取与化学有效性检查，并与预先指定的参考结构匹配，包括同位素、电荷及氢数。楔线样例还被 RDKit 识别为一个确定的手性中心。独立结果见 [rdkit-results.json](rdkit-results.json)。RDKit 的 [CDXML 读取接口](https://www.rdkit.org/docs/source/rdkit.Chem.rdmolfiles.html) 同样只覆盖格式的一部分，不能代替 ChemDraw 文档排版验证。

全部自动化测试为 189 项 Vitest 和 18 项服务器测试，共 207 项通过；TypeScript、应用和 SDK 构建通过。

| 文件 | 输入与操作 | 预期结构 |
| --- | --- | --- |
| [cdx-simple.cdxml](cdx-simple.cdxml) | 归档 SDK 最小二进制 CDX → CDXML | 二甲胺，3 原子 / 2 键 |
| [cdx-styled.cdxml](cdx-styled.cdxml) | 归档 SDK 带样式 CDX → 确认转换损失 → CDXML | 二甲胺，3 / 2 |
| [cdxml-simple-edited.cdxml](cdxml-simple-edited.cdxml) | SDK 最小 CDXML → 氮同位素改为 15 → 重写 | 15N 二甲胺，3 / 2 |
| [cdxml-styled-edited.cdxml](cdxml-styled-edited.cdxml) | SDK 带样式 CDXML → 氮同位素改为 15 → 保留标签样式和文档内容后保存 | 15N 二甲胺，3 / 2 |
| [ethanol-mrv.cdxml](ethanol-mrv.cdxml) | 项目乙醇 MRV → CDXML | 乙醇，3 / 2 |
| [aspirin.cdxml](aspirin.cdxml) | 内置阿司匹林模板 → CDXML | C9H8O4，13 / 13 |
| [isotopes-charges-hydrogens.cdxml](isotopes-charges-hydrogens.cdxml) | 独立属性样例 → CDXML | `[13CH3][15NH3+].[Cl-]`，包括固定零氢，3 / 1 |
| [wedge.cdxml](wedge.cdxml) | 碳连接 F/Cl/Br/I，一条实楔键 → CDXML | 5 / 4，保留楔线与端点 |

公开样例来源及提取方式见 [CDX](../../../tests/fixtures/cdx/README.md) 和 [CDXML](../../../tests/fixtures/cdxml/README.md) 夹具说明。MRV 与属性样例为项目内置或自行构造的测试输入。

复现命令及支持范围见 [CDXML 说明](../../cdxml.md)。本报告不代表已通过 ChemDraw / Marvin JS 桌面或商业版本认证。
