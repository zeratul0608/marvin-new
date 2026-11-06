# 聚合物括号组与重复单元

本轮以本机 `CDXBracketedGroup::StoreAttribute` 静态记录（RVA `0x4257b0`）作为字段定位线索，核对公开 CDX/CDXML 规范后独立实现。使用了字段类型、成员列表和对象关联事实，没有复制函数伪代码或加载 ChemDraw DLL。

## 已实现

| 内容 | 解析与编辑 |
| --- | --- |
| 括号化学类型 | SRU、Monomer、Mer、共聚物、混合物组、MultipleGroup 等公开枚举 |
| 重复模式 | HeadToTail、HeadToHead、EitherUnknown |
| 翻转模式 | Unspecified、NoFlip、Flip |
| 数量与标签 | RepeatCount、ComponentOrder、SRULabel；重复次数支持规范允许的有限正小数 |
| 成员 | 原子、键端点、完整来源片段与嵌套括号组引用；可修改明确的成员原子列表 |
| 边界 | bracketattachment → crossingbond → 化学键及组内原子，另保留关联括号 GraphicID |
| 显示 | 方括号、圆括号、花括号；显示 SRU 标签或 MultipleGroup 次数；SVG 同步输出 |
| 保存 | CDX/CDXML 已有来源对象的修改、删除和保留保存；CDXML 模型重建；字段均有映射时 CDX → CDXML |

`RepeatCount` 在 CDX 中是 8 字节小端 FLOAT64，不能按整数读取。`MultipleGroup` 未写次数时，规范默认值为 2，界面可将其明确改写。参见 [RepeatCount 规范](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/properties/Bracket_RepeatCount.htm)。

## 操作

1. 导入带括号组的文件，打开右侧“结构”。
2. 在“文档对象”中选择 `bracketedgroup`。
3. 修改类型、次数、标签、连接／翻转模式或成员原子；边界键下拉框只列当前组的有效跨界键。
4. 使用源格式保留保存，或导出 CDXML。修改支持撤销／重做。

跨括号键必须恰好有一个端点在组内，`InnerAtomID` 必须是该端点。成员循环、悬空引用、非法次数及边界不一致会拒绝提交。可用同一批操作同时调整成员和边界，避免中间状态无效。删除成员原子或跨界化学键时，相应成员引用与边界记录会一并清理；不会删除剩余化学结构。

## SDK

```ts
const snapshot=editor.getSnapshot();
const group=Object.values(snapshot.document.depiction.objects??{})
  .find(object=>object.tag==='bracketedgroup');
editor.applyEdits({expectedRevision:snapshot.revision,operations:[{
  type:'update-polymer',objectId:group.id,
  changes:{usage:'MultipleGroup',repeatCount:5.25,repeatPattern:'HeadToHead'},
}]});
```

`getPolymerGroup(document,id)` 返回类型化视图，包括展开嵌套成员后的 `atomIds` 与 `crossings`。模型以现有 `DrawingObject.attributes/references` 为唯一存储，未增加重复字段或破坏旧 JSON。`update-polymer-crossing` 可修改跨界键及组内端点，成员操作支持同批次 `$name` 原子引用。

## 明确边界

这轮实现的是重复单元和边界的解析编辑，不是把任意聚合物展开为有限分子，也不计算分子量分布、共聚序列或 Markush 取值。不将不确定的重复单元当作整个分子给出分子量；基础概览标出“非整体分子式”，本地计算入口会拒绝涉及此类组的选区。已定义成员范围之外的独立普通分子仍可计算。

本轮没有增加从零绘制括号组的工具。复杂文档从零重建 CDX 仍受已有导出限制；新建／跨格式文档可使用 CDXML 或 JSON，已有 CDX 支持上述来源修改。CDX 的 SRULabel 改写目前支持 ASCII，其他字符请使用 CDXML。括号绘图为现有 SVG 实现，尚未做商业 ChemDraw 的排版认证。

实现：[化学语义](../src/core/polymers.ts)、[二进制字段](../src/formats/cdx-brackets.ts)、[测试与文件](validation/polymers/README.md)。公开规范：[BracketedGroup](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/BracketedGroup.htm)、[BracketAttachment](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/BracketAttachment.htm)、[InnerAtomID](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/properties/Bracket_InnerAtomID.htm)。
