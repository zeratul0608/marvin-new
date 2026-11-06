# RXN 反应文件

支持单步 RXN V2000 与 V3000 导入／重建导出。保留反应物、产物、试剂的分子分块、普通二维分子、同位素、电荷、映射编号、楔线及受支持的反应键中心条件。

## 使用与模型

- 导入 `$RXN` 或 `$RXN V3000` 文件；原始组件坐标保留，不自动重新排版或生成格式中不存在的箭头。
- 每个组件进入独立的 `molecule` 角色引用。试剂作为 `above` 中的分子引用保存，不会把文字条件当作分子。
- 相同编号的反应物／产物原子建立 `specified` 一对一映射。映射数字仍分别保存在原子上；用户指定的成对关系可在导出时分配一致编号，不修改当前文档。
- 导出选择“RXN V2000”或“RXN V3000”。未修改的同格式文件可原样返回；编辑后属于重建导出。现有“源格式保留保存”入口只支持 CDX/CDXML 的修改保留，编辑后的 RXN 使用明确的 RXN 格式选项。

V2000 试剂使用数量行第三项，分子块按反应物、产物、试剂顺序保存。V3000 导出使用常见的 `AGENT` 分块，并兼容导入较新 BIOVIA `REAGENT` 拼写。Native RDKit 2025.03.6 仅接受 `AGENT`；与原生互操作验证使用该拼写。

支持的 `RXCTR` 是 `-1 / 1 / 2 / 4 / 8 / 12`，分别对应非反应中心、一般中心、无变化、生成／断裂、键级变化、两者兼有。组合值 `5 / 9 / 13` 尚不能完整进入当前单值模型，会拒绝而不是丢弃。

## 明确边界

当前依赖现有 MOL 适配器，限制同样适用：查询、S-group／聚合物、内嵌缩写、三维、增强立体集合及显式 VAL 价态约束尚不支持。原子 `INVRET`／`EXACHG` 等反应约束非零时明确拒绝。原子映射限制在精确的非负 32 位范围，V2000 另受三位映射字段限制。

多步反应、角色重叠、跨参与者化学键、未指定角色的化学内容、映射冲突，以及手动／自动映射来源模式不会被静默合并。条件文字、箭头下方角色和复杂专用图元不能转换为试剂。一般图形、文字、箭头、分组样式及显式立体排序等不能保留时，默认阻止导出并报告具体损失；只有可审阅的表示损失可通过 `allowLossy: true` 明确接受，化学语义不支持的情况仍拒绝。

RXN V3000 的当前 CTAB 写入器不写组件名称；V2000 源组件名称改写到 V3000 时会报告该表示损失。RXN 本身不承担完整 ChemDraw 文档排版保真。

```ts
editor.import({data:rxnText});
const result=editor.export({format:'rxn-v3000'});
// 默认严格检查，查看 result.issues 或 FormatError.issues。
```

实现：[适配器](../src/formats/rxn.ts)、[专项测试](../tests/rxn.test.ts)、[可复现样例与独立验证](validation/rxn/README.md)。规范核对依据：[MDL CTfile 规范](https://mdli.com/downloads/literature/ctfile.pdf)、[RDKit 官方 RXN 解析器](https://raw.githubusercontent.com/rdkit/rdkit/master/Code/GraphMol/ChemReactions/MDLParser.cpp)、[RDKit API](https://www.rdkit.org/docs/source/rdkit.Chem.rdChemReactions.html)。
