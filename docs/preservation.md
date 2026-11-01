# 原文件恢复与保留保存

这是一套有明确边界的保存机制，不表示任意 CDX 与 CDXML 可以完整互转。它区分原始文件、保留编辑和跨格式映射，不通过取消损失提示来宣称无损。

## 界面使用

“导出”对话框新增：

- **下载导入时的原始文件**：返回原始 CDX 字节或原始文本，之后的编辑不包含在这个文件里。适合取回导入前的版本。
- **源格式保留保存（CDX / CDXML）**：未修改时原样保存；支持的编辑直接修改原文档中的对应字段。CDX 下载为真正的二进制 `.cdx`，不会把 Base64 另存为文件。此路径不能用“允许有损”选项绕过检查。

常规 **ChemDraw XML（CDXML）** 导出也会优先走保留路径。CDX 转 CDXML 时，只有整棵对象树中每个字段都已有映射，才直接转换并报告“均已映射”。存在未实现字段时默认阻止；明确允许有损重建后才会生成基础分子版本。

## 已支持的保留编辑

- 保留现有原子、键、文档对象及其 ID；允许修改已有原子的元素、电荷、同位素、指定氢数，以及现有键的键级和描绘。
- 允许移动原子，并同步其附属标签的二维位置和包围框。来源存在页面或片段包围框时，超出该框的移动会拒绝，避免猜测未解释的排版。
- CDX 保留写入按字节范围替换或插入属性，不重新生成其余属性和对象。测试对带标签样例逐字节核对了修改范围之外的内容。
- CDXML 使用原始 XML 文档树修改属性，保留独立文字、图形、字体、注释、CDATA、命名空间、对象 ID 和外部 DOCTYPE；编辑后可能规范化引号、空元素等 XML 表面写法，因此不承诺编辑后的整份文本逐字节一致。
- 来源基线利用已有指纹中的稳定 ID 关联对象，原生 JSON 恢复后仍可使用。写入后重新解析并核对化学内容。
- 化学属性或键描绘改变时清除旧的非构型立体缓存，避免保存过期 AS/BS 结果；编辑器不计算 CIP。

存在原子标签时，化学修改可能需要重排字体、上下标、显式氢或电荷图形。当前会拒绝这类保留保存，避免保留与新化学属性矛盾的旧标签。新建、删除或重新连接对象、原子映射变更，以及无法表示的数值也会拒绝；此时仍可保存原生 JSON 或下载原始文件。

CDX 坐标使用有符号 16.16 定点数，写入按其精度舍入，模型坐标误差上限约 `0.5 / 65536 / 20`。保留保存指其余来源内容保留，不表示任意浮点编辑都能在二进制格式中无限精确地表示。JSON 可以保留编辑器的浮点值。

## 当前跨格式映射

已实现普通文档、页面、分组、片段、原子、键，以及 ID、Z 顺序、包围框、二维点、键长、元素、电荷、同位素、氢数、键级、二维楔线和非构型 AS/BS 缓存的 CDX → CDXML 映射。该路径不嵌入隐藏 Base64 来冒充完整转换。

最小二甲胺、独立 RDKit 生成的乙醇、苯及同位素/电荷样例通过全字段转换。带样式的归档二甲胺仍有未实现的文档字段，因此**不能声称该文件能无损转为 CDXML**；可以保留为原 CDX，或执行受支持的源格式编辑。任意 CDXML → CDX 和从新建结构生成 CDX 尚未实现。

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

`SourceFileExportResult.preservation` 为 `original` 或 `preserved`。常规导出的 `ExportResult.preservation` 可报告 `preserved`、`converted` 或 `rebuilt`；旧的同格式原样返回仍以 `passthrough` 表示。`Format` 继续表示常规文本导出格式，CDX 源格式保存使用独立接口。

## 验证

[实际下载文件与报告](validation/preservation/README.md) 包含原始字节核对、浏览器下载、独立 RDKit 化学复核和 XML 附加内容复核。未在 ChemDraw / Marvin JS 商业软件中完成兼容认证。
