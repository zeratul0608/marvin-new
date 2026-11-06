# 高级原子查询条件与键拓扑

查询条件可以附加在明确的元素原子（例如 C）上，也可以与已有元素列表、通用／任意原子条件组合。它们约束目标结构的匹配范围，不会把当前原子自动变为碳或任意原子。查询对象仍可以绘制、修改属性和保存；不能因为导入成功就把它当作一个确定分子进行性质计算。

## 本轮字段

| 模型字段 | CDXML 名称 | CDX 字段／类型 | 含义 |
| --- | --- | --- | --- |
| `substituentsExactly` | SubstituentsExactly | 0x0436 / UINT8 | 非氢邻接取代数恰好为指定值 |
| `substituentsUpTo` | SubstituentsUpTo | 0x0435 / UINT8 | 非氢邻接取代数至多为指定值 |
| `ringBondCount` | RingBondCount | 0x0425 / INT8 | 未指定、无环键、按图、恰好 2、恰好 3、至少 4 条环键 |
| `unsaturatedBonds` | UnsaturatedBonds | 0x0426 / INT8 | 未指定、必须无不饱和键、必须至少存在一条不饱和键 |
| `reactionChange` | RxnChange | 0x0427 / CDXBooleanImplied | 要求原子反应变化与指定条件一致（Exact Change） |
| `reactionStereo` | RxnStereo | 0x0428 / INT8 | 未指定、Inversion、Retention 反应立体查询声明 |
| 键 `topology` | Topology | 0x0606 / INT8 | 未指定、必须为环键、必须为链键、显式允许环或链 |

取代数为 0–255 的整数，**0 是有效约束**；两个取代数条件可以同时存在，取交集。取代数计非氢邻接，不是键阶之和。即使设置与所画结构矛盾，公开规范仍允许保留该查询；这种模式可能匹配不到任何结构，不应自动纠正或简化当前文件。

环键数原生枚举依次为 `-1: Unspecified`、`0: NoRingBonds`、`1: AsDrawn`、`2: SimpleRing`、`3: Fusion`、`4: SpiroOrHigher`。最后一项表示至少四条环键；`AsDrawn` 是按所画结构的环键数量，不等于普通原子度数。

`UnsaturatedBonds` 的原生枚举为 `0: Unspecified`、`1: MustBeAbsent`、`2: MustBePresent`。标准名称不是 `Unsaturated`。反应立体枚举为 `0: Unspecified`、`1: Inversion`、`2: Retention`，只记录查询声明，不执行编辑器已有的立体反转操作。

键拓扑原生枚举为 `0: Unspecified`、`1: Ring`、`2: Chain`、`3: RingOrChain`。显式 `RingOrChain` 与未指定有区别，不得为了合并默认值而删除。具体数据库对未指定拓扑的解释可能不同。

`RxnChange` 在 CDX 中采用零长度属性：属性存在代表 true，缺失代表 false／无此限制，不能写为一个真假数值字节。CDXML 使用 yes/no；no 可归一化为未设置，以保证转换到 CDX 的含义一致。

## 保存与计算边界

在“结构与属性”选择原子，展开“高级查询条件”即可修改；选择键后使用“键拓扑查询”。画布和 SVG 中，`Q` 标记表示原子附有独立查询约束，键旁显示环／链要求。设置查询条件不会自动添加原子、闭环或执行立体翻转；每次修改、清除均可撤销重做。

```ts
editor.applyEdits({operations:[
  {type:'update-atom',atomId,changes:{queryConstraints:{
    substituentsExactly:2,
    ringBondCount:'SimpleRing',
    unsaturatedBonds:'MustBePresent',
    reactionChange:true,
  }}},
  {type:'set-bond-annotations',bondId,changes:{topology:'RingOrChain'}},
]});
```

`queryConstraints` 按整个条件对象替换；对象至少包含一项。`reactionChange` 只使用 `true`，取消时移除此字段；完全清除使用 `queryConstraints:null`。键拓扑使用 `topology:null` 清除，显式 `Unspecified` 与字段缺失分别保存。SDK 同时导出 `atomRingBondCounts`、`atomUnsaturatedBonds`、`atomReactionStereos` 和 `bondTopologies` 供集成界面使用。

条件进入类型化模型，可由已有编辑事务、JSON 和支持的 ChemDraw 格式适配器处理。源格式保存应检查各条件的新增、变更和移除，同时保留无关原生属性与样式。无法表示这些条件的其他格式不能将其悄悄丢弃。

纯查询条件修改不重新生成原有化学标签。涉及真实元素、同位素或电荷的修改仍执行标签和氢数保护；不能可靠解释的混合字体或氢文字不会被覆盖。查询约束附于整个缩写时，群组展开继续保留其作用域，原子级提升不能猜测内部归属。当前 MOL、MRV、RXN 适配器未映射这些新字段，会明确拒绝，即使允许有损导出也不会丢弃查询语义。

本轮范围是条件的**解析、属性编辑、显示、保存与回读**。它不等于实现了完整 Markush 求值、结构数据库查询引擎、所有 SMARTS 语义或反应可行性计算。实际匹配能力需要另行建立规则和验收用例；不能拿忽略查询条件后的 RDKit 普通分子解析当作完整查询认证。

## 规范与独立验证

依据[公开 CDX 属性表](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/TableOfProperties.htm)、[当前 ChemDraw CDXML DTD](https://static.chemistry.revvitycloud.com/cdxml/CDXML.dtd)、[取代数定义](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/properties/Atom_RestrictSubstituentsExactly.htm)、[键拓扑定义](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/properties/Bond_RestrictTopology.htm)及[布尔数据类型](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/DataType/CDXBoolean.htm)。[RDKit 官方 CDXML 解析器](https://raw.githubusercontent.com/rdkit/rdkit/master/Code/GraphMol/FileParsers/CDXMLParser.cpp)提供查询处理的另一份实现参考，但不是本轮独立验证器。

[独立 Python 脚本](../scripts/validate-query-constraints.py)直接读取 XML 与小端 CDX，不调用 SDK 或 RDKit，检查原生字段宽度、枚举、取代数 0／255、显式 RingOrChain 和零长度 RxnChange。`--prepare` 生成自建原生夹具，SDK 的导入／编辑输出再由同一独立解码器核对。

2026-11-05 正式独立验证通过 **70/70 文件，0 失败**：14 份 Python 原生输入、14 份 SDK 新建重建、14 份实际条件修改后的来源保存、14 份严格跨格式输出及 14 份全部条件清除后的来源保存，共 35 份 CDXML 与 35 份 CDX。具体元素身份、原生字段值及字节宽度均核对通过。见[验证说明](validation/query-constraints/README.md)与[独立逐项结果](validation/query-constraints/independent-results.json)。
