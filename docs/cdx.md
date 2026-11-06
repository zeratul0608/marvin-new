# CDX 二进制读写

本项目支持在浏览器本地解析和生成普通二维分子的 ChemDraw CDX 文件，不依赖模型服务或外部转换接口。已有 CDX 可原样取回或受限保留编辑；新建结构可选择“ChemDraw 二进制”导出，不表示完整兼容全部 ChemDraw 文档。详见 [保留保存机制](preservation.md) 与 [引擎升级](engine-upgrade.md)。

## 工作台使用

1. 点击“导入”，选择 `.cdx` 文件；界面显示文件名称与大小，点击“导入画布”。也可将文件拖到画布直接导入。
2. 导入成功后可以使用现有原子属性、选区、变换、撤销重做和 AI 工具。
3. 查看兼容报告。文档排版、文字或附加信息未完整表示时会产生警告；遇到不支持的化学语义时，导入失败并保留当前画布。
4. 使用“源格式保留保存”保存受支持的 CDX 编辑，或使用原生 JSON 保存文档和原始 CDX；需要交换其他格式时，可以选择 CDXML、MRV 或 MOL。存在已知损失时默认阻止转换，手动导出可在阅读报告后明确允许有损转换，AI 导出不绕过保护。

可用样例：[二甲胺 CDX](../public/examples/dimethylamine.cdx)。该文件来自公开归档的 ChemDraw SDK 示例，来源见 [测试夹具说明](../tests/fixtures/cdx/README.md)。

CDX 转 CDXML 的实际下载文件和独立化学验证，见 [CDXML 导出与验证](cdxml.md)。

原始 CDX 二进制的文件选择、拖放、独立读取与转换验证，见 [CDX 文件验证报告](validation/cdx/README.md)。报告保留 6 份原始输入，包括 5 个普通结构与 1 个按预期拒绝的复杂文件，并明确记录独立读取器无法读取的最小规范样例。

## 支持的化学内容

- 页面、普通分子片段以及仅作为容器使用的分组；多页普通结构在同一画布显示并报告提示。
- 普通元素原子，以及未写 Element 字段时规范默认的碳；不会把未知伪原子或缩写当作碳。
- 形式电荷，包括 ChemDraw 8.0 四字节 Fixed 电荷字段的兼容读法。
- 同位素质量数、自然丰度值、明确指定的非图氢数（包括零），以及单重／双重／三重态自由基。
- 有符号 16.16 定点二维坐标，正确处理 CDX 的 y/x 存储顺序和画布 y 轴方向。
- 单、双、三、芳香键；正确区分 CDX 键级位标志，例如三键为 `0x0004`。
- 普通、实楔、虚楔、波浪、虚线、粗线和等宽哈线描绘，以及楔线锚点、双键偏侧。
- 四面体原子 Geometry/BondOrdering 与双键 BondCircularOrdering，均采用模型中的稳定键引用并检查邻接关系。
- 菱形模板外部连接点，区别于碳或查询通配原子。
- 同一文件中多个不连通片段；跨片段重复使用的外部原子 ID 按所属片段隔离。

现已实现元素列表／NOT、通用名称／任意原子查询、任意查询键与 2.5 键，以及已有 CDX 反应步骤、参与者、箭头、条件和图元的来源解析与保存。AS/BS 的实际标签以来源缓存进入模型，化学编辑后失效；可在 [本地化学计算](chemistry-engine.md) 中为普通完整分子重新计算适用的 R/S/E/Z。

新增 `0x8017/0x8018/0x8019` 括号组、括号连接与跨界键的解析及来源编辑保存，覆盖重复次数 FLOAT64、连接／翻转模式、嵌套成员、GraphicID、BondID、InnerAtomID。字段均可映射时可转 CDXML；完整新建复杂 CDX 文档仍有限制。见 [聚合物说明](polymers.md)。

CDX 原子映射、嵌套化学片段、通用聚合物／Markush、三维化学及全部特殊对象仍未完整覆盖。CDXML 的嵌套、增强立体、独立三维坐标等扩展不意味着 CDX 新建写入器已经具备相同覆盖。未实现的化学属性继续明确拒绝。

独立文字、标签排版、图形、页面样式及未知文档附加信息会列入诊断并保留在源文件记录中。原子映射、完整化学文档和全部对象属性尚不在 CDX 适配范围内。没有二维坐标的文件会明确报错，当前不进行自动布局。

## SDK 导入

`Format` 和 `ImportFormat` 均包含 `'cdx'`。导入接口统一接受 `ImportInput`，其 `data` 可以是字符串、`Uint8Array` 或 `ArrayBuffer`。导出结果的 `data` 为 `cdx:base64,...` 传输文本，保存文件前用 `decodeCdx` 还原二进制；工作台自动处理。

```ts
import { createChemicalEditor, importDocument } from './dist-sdk/chemical-editor.js';

const buffer = await file.arrayBuffer();
const result = importDocument({ data: buffer, format: 'cdx', name: file.name });
console.log(result.document, result.issues);

// File contents can also be auto-detected from their CDX signature.
const detected = importDocument({ data: new Uint8Array(buffer) });

const editor = createChemicalEditor({ container });
editor.import({ data: buffer, name: file.name });
```

### JSON 传输与原始字节保留

```ts
import { encodeCdx, decodeCdx } from './dist-sdk/chemical-editor.js';

const encoded = encodeCdx(new Uint8Array(buffer)); // cdx:base64,...
await editor.execute({ method: 'import', params: { data: encoded, name: file.name } });

const nativeJson = editor.export({ format: 'json' }).data;
const originalBytes = decodeCdx(editor.getDocument().source!.raw);
```

当 `source.format === 'cdx'` 时，`source.raw` 是带 `cdx:base64,` 前缀的无损字节编码，不是按字符集解码的原始文本。`decodeCdx` 可恢复原始文件字节。JSON 文档仍使用 `schemaVersion: 1`；旧版 SDK 可能不认识新增的 CDX 来源类型。

默认格式识别支持二进制签名和带前缀的字符串。未带前缀的 Base64 字符串仅在明确指定 `format: 'cdx'` 时接受。二进制不应通过 `file.text()` 读取，也不要把它粘贴为乱码文本。

当前文件和字符串导入大小上限仍适用；包含 Base64 源文件的 JSON 会大于原始二进制，保存临近大小上限的文件时需注意 JSON 的大小。AI 上下文会移除完整 `source` 记录，因此不会自动把 CDX 原文发送给模型。

## 资源与错误保护

解析器校验文件签名、固定头部、小端字段、对象结束标记、常规及扩展属性长度、重复属性、同容器重复 ID 和无效键引用。它限制输入为 2 MB、嵌套深度小于 64、对象不超过 20000，并在分子投影前限制 2000 个原子与 2000 条键。

头部兼容归档 SDK 的 28 字节形式，以及已验证的第三方文件使用的 22 字节前导区加显式 Document 对象形式。

只解释明确支持的化学字段；未知化学属性会阻止导入，未知显示或文档信息会产生警告。失败时返回 `FormatError` 和诊断，不提交部分结构。

## 规范与验证

- [CDX 二进制规范](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/IntroCDX.htm)
- [对象与属性表](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/TableOfProperties.htm)
- [ChemDraw 8.0 电荷字段兼容说明](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/properties/Atom_Charge.htm)
- 实现：[cdx.ts](../src/formats/cdx.ts)；测试：[cdx.test.ts](../tests/cdx.test.ts)。

规范为 IUPAC FAIRSpec 项目保存的历史 ChemDraw SDK 归档。测试包含原始公开二进制样例及独立构造的字段、异常和限额用例；尚未在实际 ChemDraw 软件中进行全面往返认证。
