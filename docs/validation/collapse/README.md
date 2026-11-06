# 选区收起验证

收起功能使用真实内部化学图和端口映射，详见[功能与边界说明](../../abbreviation-collapse.md)。

## 当前自动测试

- [collapse.test.ts](../../../tests/collapse.test.ts)：完整分子和部分选区的收起、原子／键身份恢复、双端口链、芳香与双键内部、内部和外部四面体／E/Z、同位素和电荷、聚合物与反应引用、内部端口修改、JSON、撤销重做及可见按钮。
- [preservation-collapse.test.ts](../../../tests/preservation-collapse.test.ts)：14 项原生 CDXML 来源测试，覆盖原始 `Z`、字体和线宽，内部修改及增加原子，父子原生 ID 冲突处理，完整分子与两次嵌套收起，原缩写展开后改名收起、原缩写整体搬移，原子与键 CIP 缓存清除，JSON 恢复，以及跨来源片段、私有引用、边界子对象、重复局部 ID 的保护。
- [expansion.test.ts](../../../tests/expansion.test.ts)：展开的既有兼容性，以及内部稳定 ID 优先保留、碰撞哈希、递归展开、增强组号和边界标签偏移。改绑端口展开后，即使再次收起也必须继续拒绝不可靠的来源保存。

来源文件重新导入后，使用[对象对应验证器](../../../scripts/document-correspondence.mjs)对齐身份并比较完整模型投影；原始样式另直接检查 XML 属性，避免只比较化学图漏掉字体或线宽丢失。四面体及双键案例同时使用应用 RDKit 化学计算比较异构 SMILES。这里的 RDKit 测试是本机自动测试，不是独立解析器或商业 ChemDraw 认证。

```powershell
npx vitest run tests/collapse.test.ts tests/preservation-collapse.test.ts tests/expansion.test.ts
npx tsc --noEmit
```

[适配结果](adapter-results.json)记录 6 种自建结构的原始、收起及再次展开，共 18 份 CDXML，逐项核对结构身份和递归化学概览。[浏览器结果](browser-results.json)覆盖这 6 种结构的实际文件导入、可见收起按钮、主画布原子数、内部电荷／同位素概览、撤销重做、来源下载回读及再次展开；未出现页面错误。

[独立结果](independent-results.json)由原生 Python RDKit 2025.03.6 比较异构 SMILES、原子／键数量和手性：16 份直接整文件验证；另外 2 份无外部连接的闭合缩写，以原样提取的内部 XML 片段验证。该版本原生解析器融合没有外联端口的缩写时会留下一个独立通配包装原子，脚本先断言额外成分恰为此单原子，再独立解析未经改写的原始 child。这 2 项明确标记为 `untouched-child-fragment`，不计为直接整文件互操作通过。独立运行时和解析器仍属于 RDKit 工具包，不是商业 ChemDraw 认证。

这一限制的实现依据为 [RDKit Release_2025_03_6 的 CDXMLParser.cpp](https://raw.githubusercontent.com/rdkit/rdkit/Release_2025_03_6/Code/GraphMol/FileParsers/CDXMLParser.cpp)：`Fragment`／`Nickname` 先建立通配包装原子，内部 `ExternalConnectionPoint` 使用父级融合标签，随后通过 molzip 融合。结合本次闭合片段的实际输出，可定位到无外联端口的包装节点融合范围；这不证明所有 RDKit 版本有相同表现。[CDX／CDXML Node_Type 规范](https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/properties/Node_Type.htm)要求 `Fragment` 节点包含标签和内部 Fragment，多外部连接时提供 BondOrdering；没有规定每个内部片段必须含有外联端口。因此保持原图和编码不变，并在验证报告中区分整文件与内部片段验证。

```powershell
npm run build
node scripts/prepare-collapse-test-files.mjs
python scripts/validate-collapse.py --dependencies .local/cdx-reference/validation-deps
# 要求另一个终端运行 npm run dev；Playwright 模块 URL 可作为首个参数传入。
node scripts/validate-collapse-browser.mjs
```

缩写展开的文件集审计另记录在 [expansion/corpus-results.json](../expansion/corpus-results.json)，其统计不能当作所有选区收起或所有 ChemDraw 内容均成功的证据。当前未声明全量文件集收起通过率。本轮不验证 AI 模型。

测试夹具为明确的自建结构；本地商业文件集不复制到此目录。保护案例要求明确报错且原文档保持不变，不能计入成功解析并编辑的结果。
