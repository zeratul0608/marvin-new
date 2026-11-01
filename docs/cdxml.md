# CDXML 导出与验证

## 使用

点击编辑器“导出”，在格式选择框选择 **ChemDraw XML（CDXML）**，预览后点击下载。SDK 可调用：

```ts
const result = editor.export({ format: 'cdxml' });
// result.data 是 UTF-8 XML；保存为 .cdxml。
```

CDX 导入后的普通二维分子也可通过这一入口转换到 CDXML。CDXML 来源的受支持编辑会优先保留原文档；CDX 来源只有全字段均可映射时才直接转换。其余情况默认阻止重建导出，并展示损失报告，详见 [保留保存机制](preservation.md)。手动确认允许有损转换后可以导出当前可编辑分子；完整原始文件请另外保存为原生 JSON。AI 导出保持同样的保护，不自动确认损失。

## 范围

- 普通元素、二维坐标、形式电荷、同位素质量数、指定氢数（包括零）。
- 单、双、三、芳香键，以及实楔、虚楔、波浪键和楔线锚点。
- 支持的编辑优先在原文档中修改字段，保留其余对象与 ID；明确接受有损重建时才重新生成基础分子文档。未修改的来源仍可原样返回。
- 读取公开 SDK 示例中省略键 ID 的写法；读取无实际立体构型含义的 `AS/BS="U"` 或 `"N"` 缓存。

当前不写原子映射，含原子映射时默认阻止 CDXML 转换。反应、查询、Markush、聚合物、完整文档排版以及拓扑立体化学尚未实现；`AS="R/S"`、`BS="E/Z"` 等实际构型会拒绝导入。楔线表示二维描绘，编辑器不据此计算 CIP 标签。

## 文件验证

已下载的 [8 份输出文件和验证报告](validation/cdxml/README.md) 可直接检查。

自动化测试位于 [cdxml-export.test.ts](../tests/cdxml-export.test.ts)，参考文件来源见 [夹具说明](../tests/fixtures/cdxml/README.md)。测试明确修改文档以触发实际写入器，避免仅靠原样返回源文件通过测试，并比较化学属性、键描绘和坐标。

可复现步骤：

1. 运行 `npm test`、`npm run build`。
2. 启动 `npm run dev`。单独安装 Playwright 后，运行 `node scripts/validate-cdxml-browser.mjs`；也可以将 Playwright 模块的 `file:///.../index.mjs` URL 作为第一个参数。脚本使用本机 Chrome 的独立无头浏览器，通过真实导出对话框下载文件，更新 `docs/validation/cdxml/`。
3. 单独安装 RDKit，运行 `python scripts/validate-cdxml.py`。如安装到独立目录，传入 `--dependencies 路径`。此脚本以独立 XML 解析器和 RDKit 读取下载文件，对照预先指定的参考结构验证化学内容；应用运行时不依赖这些验证工具。

测试通过不等于已在 ChemDraw 或 Marvin JS 商业软件中逐项验证，仍需用实际业务文件扩充覆盖。
