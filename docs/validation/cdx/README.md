# CDX 二进制文件验证

验证日期：2026-11-01。此处的 `.cdx` 是**测试输入的原始字节副本**，不是本编辑器生成的 CDX 导出文件；编辑器目前仅支持 CDX 导入。对应 `.cdxml`、`.mol` 是导入后由编辑器实际转换生成的文件。

## 结果

| 原始 CDX | 来源 | 插件导入 | 独立 RDKit 直接读取 CDX |
| --- | --- | --- | --- |
| [二甲胺最小样例](dimethylamine-simple.cdx) | 公开归档 SDK，165 字节 | 通过，C2H7N，3 原子 / 2 键 | 返回空结果，**未计为交叉验证通过** |
| [二甲胺带样式样例](dimethylamine-styled.cdx) | 公开归档 SDK，820 字节 | 通过，C2H7N，3 / 2；报告未解释样式 | 通过，`CNC` |
| [乙醇](rdkit-ethanol.cdx) | RDKit 独立二进制写入器，170 字节 | 通过，C2H6O，3 / 2 | 通过，`CCO` |
| [苯](rdkit-benzene.cdx) | RDKit 独立二进制写入器，338 字节 | 通过，C6H6，6 / 6 | 通过，`c1ccccc1` |
| [同位素与电荷](rdkit-isotopes-charges.cdx) | RDKit 独立二进制写入器，186 字节 | 通过，13C、15N、N+、Cl−，3 / 1 | 通过，`[13CH3][15NH3+].[Cl-]` |
| [环立体结构](rdkit-ring-stereo1.cdx) | RDKit 上游测试文件，1812 字节 | 按预期拒绝未实现属性 `0x0445`，画布不变 | 能读取，证明此文件并非损坏文件 |

5 个普通结构的浏览器文件选择、解析、编辑、撤销、原生 JSON 恢复和源字节逐一比对均通过。另验证了真正的浏览器拖放。独立 RDKit 2025.03.6 直接读取了上述原始二进制，而非先经本项目转换；4 个普通结构与预设参考结构匹配，最小 SDK 样例的空结果作为外部读取器限制单独保留，未包装成通过。

全部 5 个普通结构转换出的 CDXML 和 MOL V3000，均由 RDKit 独立重新读取，并与预设参考结构比较，5/5 通过，包括同位素、电荷和氢数：

| 输入 | CDXML 输出 | MOL 输出 |
| --- | --- | --- |
| 最小二甲胺 | [CDXML](dimethylamine-simple.cdxml) | [MOL](dimethylamine-simple.mol) |
| 带样式二甲胺 | [CDXML](dimethylamine-styled.cdxml) | [MOL](dimethylamine-styled.mol) |
| 乙醇 | [CDXML](rdkit-ethanol.cdxml) | [MOL](rdkit-ethanol.mol) |
| 苯 | [CDXML](rdkit-benzene.cdxml) | [MOL](rdkit-benzene.mol) |
| 同位素与电荷 | [CDXML](rdkit-isotopes-charges.cdxml) | [MOL](rdkit-isotopes-charges.mol) |

转换脚本明确选择允许有损转换，以核对分子数据；样式警告和完整原始字节仍随 JSON 保留，不代表重建格式保留所有 ChemDraw 排版。

浏览器还通过文件选择入口验证了 4 类拒绝：上述未实现化学内容、截断、错误版本和伪装 CDX 文本。每次都展示错误并保留原画布。44 项 CDX 专项测试通过；全套 194 项 Vitest + 18 项服务器测试，共 **212 项通过**，应用、SDK 和类型构建通过。

## 修复

第三方文件验证发现并修复了头部兼容问题：原读取器只接受归档 SDK 的 28 字节头部，现在也支持这些已验证文件使用的 22 字节前导区加显式 Document 对象。版本号、保留字节、长度、对象结束和引用校验保持有效，补充了对应损坏输入测试。

## 记录与复现

- [浏览器结果与输入 SHA-256](browser-results.json)
- [独立二进制及转换结果](rdkit-results.json)
- [输入来源、生成方法和上游许可](../../../tests/fixtures/cdx/README.md)
- [浏览器验证脚本](../../../scripts/validate-cdx-browser.mjs)：启动 `npm run dev` 后运行 `node scripts/validate-cdx-browser.mjs`。需另行安装 Playwright 和本机 Chrome，也可将 Playwright 模块 URL 作为第一个参数；使用独立浏览器，不修改用户已有草稿。
- [独立验证脚本](../../../scripts/validate-cdx.py)：另行安装含二进制 CDX 支持的 RDKit，运行 `python scripts/validate-cdx.py`；独立目录安装时可传 `--dependencies 路径`。该工具明确设置 CDX 格式，避免默认按 XML 读取二进制文件。

这些结果覆盖列出的样例与失败场景，不表示完整 CDX 文档兼容。尚未在 ChemDraw / Marvin JS 商业软件中逐项验证，也没有增加 CDX 导出。
