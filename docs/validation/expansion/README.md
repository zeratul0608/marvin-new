# 缩写展开验证

- 28 项专项测试：[expansion.test.ts](../../../tests/expansion.test.ts)，包含内部稳定 ID 优先保留、原子／键冲突哈希、递归碰撞、增强组号与边界标签偏移。
- [自建文件报告](adapter-results.json)：12 个文件，4 份原始嵌套 CDXML 与 8 份展开 CDX/CDXML。
- [原生解析验证](independent-results.json)：原生 Python RDKit 独立解释原始缩写，并比较展开文件的异构 SMILES、数量及 R/S。四种结构为醚、双端口链、内部手性和递归缩写。
- [浏览器验证](browser-results.json)：真实点击展开、撤销、重做、计算和源下载，重新解析比较。
- [本机文件集](corpus-results.json)：逐个顶层缩写测试展开和源保存；不支持的整体注释、备选结构和其他歧义单独列为保护，不计成功。

2026-11-05 加入同阶双／三键端口后重新完整审计 673 个 CDXML 文件：532 个顶层缩写中，283 个完成原子提升及源保存回读，249 个保持提升保护，0 个保存失败。本轮新增 NR 的实际同阶双键案例。保护包括 12 个未选定备选组、1 个内外键型冲突、234 个整体电荷／映射／生物语义等注释，以及 2 个无法一对多改写的单对象引用。另新增[群组展开编辑路径](../expanded-groups/README.md)，保留原包装节点及所有候选；群组视图不冒充普通原子提升，也不是商业 ChemDraw 的认证。

本轮同时重新生成自建样例：原生 Python RDKit 验证 4 份原始嵌套 CDXML 与 8 份展开 CDX/CDXML 的化学身份、数量和手性一致；Chrome 的 4 个真实展开、撤销重做及源下载回读案例通过，未出现页面错误。改名后重新收起的来源保存回归见 [collapse 验证](../collapse/README.md)。

展开会改变结构在 XML 中的序列化顺序，文件集验证先按属性、坐标、成员范围和拓扑建立对象对应，再比较完整模型投影；不会把同一化学图的不同节点排列误报为化学变化。源码：[对应验证器](../../../scripts/document-correspondence.mjs)。

```powershell
npm test
npm run build
node scripts/prepare-expansion-test-files.mjs
python scripts/validate-expansion.py --dependencies .local/cdx-reference/validation-deps
node scripts/validate-expansion-browser.mjs
node --expose-gc scripts/audit-abbreviation-expansion.mjs
python scripts/prepare-engine-test-files.py
```

浏览器要求 5173 服务，可传入 Playwright 模块 URL 为首个参数。本轮不验证 AI 模型。商业样本仅在本地忽略目录，发布文件均为自建结构。
