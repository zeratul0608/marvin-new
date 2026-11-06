# 原文件恢复与保留保存

这是一套有明确边界的保存机制，不表示任意 CDX 与 CDXML 可以完整互转。它区分原始文件、保留编辑和跨格式映射，不通过取消损失提示来宣称无损。

## 界面使用

“导出”对话框新增：

- **下载导入时的原始文件**：返回原始 CDX 字节或原始文本，之后的编辑不包含在这个文件里。适合取回导入前的版本。
- **源格式保留保存（CDX / CDXML）**：未修改时原样保存；支持的编辑直接修改原文档中的对应字段。CDX 下载为真正的二进制 `.cdx`，不会把 Base64 另存为文件。此路径不能用“允许有损”选项绕过检查。

常规 **ChemDraw XML（CDXML）** 导出也会优先走保留路径。CDX 转 CDXML 时，只有整棵对象树中每个字段都已有映射，才直接转换并报告“均已映射”。存在未实现字段时默认阻止；明确允许有损重建后才会生成基础分子版本。

## 已支持的保留编辑

- 保留仍存在的原子、键、文档对象及其 ID；允许修改元素、电荷、同位素、自由基、指定氢数、键级和描绘，以及四面体几何／双键连接顺序。
- 支持在同一来源片段内新增原子和键、删除原子和键、重新连接现有键。新增对象使用未占用的 ID，删除原子会连同其原子标签一起移除；无关文字、图形、字体及其他对象继续保留。
- 普通化学标签可同步改写：同位素和电荷使用上标，氢数使用下标，复用原标签的字体、字号、颜色和基础样式。新增连接或断键改变邻接原子的自动氢数时，也会同步更新相关标签。
- 允许移动原子，并同步其附属标签的二维位置。修改影响标签布局、片段范围或旧包围框时，清除相关 BoundingBox、LineStarts 等派生缓存，让目标软件重新计算；不再因超出旧包围框而一律拒绝。独立图形自己的包围框不会被清除。
- CDX 保留写入按字节范围替换或插入属性，不重新生成其余属性和对象。测试对带标签样例逐字节核对了修改范围之外的内容。
- CDXML 使用原始 XML 文档树修改属性，保留独立文字、图形、字体、注释、CDATA、命名空间、对象 ID 和外部 DOCTYPE；编辑后可能规范化引号、空元素等 XML 表面写法，因此不承诺编辑后的整份文本逐字节一致。
- 来源基线利用已有指纹中的稳定 ID 关联对象，原生 JSON 恢复后仍可使用。写入后重新解析并核对化学内容。
- 化学属性、连接关系或键描绘改变时清除过期 AS/BS 和化学警告缓存；普通完整分子可在“化学计算”中重新计算适用的立体标签。图形、文字等未修改对象保持原内容，已编辑标签的排版不承诺像素不变。

支持删除全部原子后保存空文档，并在页面归属明确时新增孤立片段。仍会拒绝不明自定义原子文字、部分混合字体化学标签、无法同步的外部派生引用、原子映射编号变更、跨来源片段合并，以及无法表示的数值。

CDXML 的独立文字、图元、页面分组和反应角色进入可编辑模型；内部缩写与备选片段可递归编辑并保留保存。CDX 已有图元和反应步骤支持来源保存；新增复杂 CDX 对象与完整跨格式转换仍有限制。来源缓存 CIP 及其派生说明文字失效时会清理，不会假装完成新的 CIP 计算。详见 [引擎升级与逐文件回归](engine-upgrade.md)。

在删除或改变相关化学属性之前，会检查文档引用：已知的对象引用指向受影响原子、键、标签或片段时，若不能同步维护就阻止保存；引用类型未知的 CDX 属性、厂商 XML 字段或自定义文档对象同样会阻止相关保存。普通字体、颜色、坐标等字段按公开规范区分，不会仅因数值恰好等于某个对象 ID 就认作引用。此时仍可保存原生 JSON 或下载原始文件。

导出窗口打开后，编辑器或 API 更新文档会刷新预览并撤销旧的有损确认；切换格式也需重新确认，下载不会沿用旧文档预览。

CDX 坐标使用有符号 16.16 定点数，写入按其精度舍入，模型坐标误差上限约 `0.5 / 65536 / 20`。保留保存指其余来源内容保留，不表示任意浮点编辑都能在二进制格式中无限精确地表示。JSON 可以保留编辑器的浮点值。

## 当前跨格式映射

已实现普通文档、页面、分组、片段、原子、键，以及 ID、Z 顺序、包围框、二维点、键长、元素、电荷、同位素、自由基、氢数、键级、基础键描绘、双键偏侧、外部连接点、四面体几何、双键连接顺序和非构型 AS/BS 缓存的 CDX → CDXML 映射。字体表、颜色表、默认标签样式及已知字符集的分段文本也可映射；未知字段仍阻止。该路径不嵌入隐藏 Base64 来冒充完整转换。

最小二甲胺、独立 RDKit 生成的乙醇、苯及同位素/电荷样例通过全字段转换。带样式的归档二甲胺仍有未实现字段，不能声称任意文档均可无损转换。新建结构支持生成 CDX；任意 CDXML 文档对象完整映射到 CDX 尚未实现，常规 CDX 重建只写入已支持的模型内容并受损失报告保护。

## SDK

```ts
import { exportOriginalSource, exportSourceFile, decodeCdx } from './dist-sdk/chemical-editor.js';

const original = exportOriginalSource(editor.getDocument());
const current = exportSourceFile(editor.getDocument());
// current.format === 'cdx' 时，current.data 为 cdx:base64,... 传输文本。
const bytes = current.format === 'cdx' ? decodeCdx(current.data) : undefined;

// JSON 命令入口；original 默认 false。
await editor.execute({ method: 'export_source', params: { original: false } });
```

`SourceFileExportResult.preservation` 为 `original` 或 `preserved`。常规导出的 `ExportResult.preservation` 可报告 `preserved`、`converted` 或 `rebuilt`；同格式原样返回仍以 `passthrough` 表示。`Format` 包含 CDX；它的 `data` 使用 Base64 传输，其他文件格式使用文本。源格式保存也可使用独立接口。

## 验证

[基础保留保存验证](validation/preservation/README.md) 和 [扩大编辑范围验证](validation/preservation-expanded/README.md) 包含原始字节核对、浏览器实际下载、独立 RDKit 化学复核和 XML 附加内容复核。后者覆盖两种格式共 16 组修改。未在 ChemDraw / Marvin JS 商业软件中完成兼容认证。

标签格式和引用类型依据归档 SDK 的 [CDXString](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/DataType/CDXString.htm) 与 [属性类型表](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/TableOfProperties.htm)。
