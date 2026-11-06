# 聚合物括号验证

- [单元测试](../../../tests/polymers.test.ts)：20 项，覆盖双格式的成员、嵌套、FLOAT64 小数次数、连接／翻转模式、来源保存、边界改绑、原子删除清理、新成员批量引用、可见属性、撤销、反向方括号和水平花括号。
- 另在化学计算测试中验证：拒绝把整个重复结构当作普通分子计算；仍可计算组外的独立完整分子。
- [适配报告](adapter-results.json)：8 份自建二进制和 XML 文件，包含 SRU、MultipleGroup、嵌套组、修改后的源文件及 CDX 转 CDXML；没有商业样本。
- [独立验证](independent-results.json)：Python 标准库 `struct` 直接读取二进制 CDX，`ElementTree` 读取 XML。未调用应用解析器或 RDKit，核对类型、重复次数、嵌套成员、括号图形、跨界键及组内原子引用。
- [浏览器验证](browser-results.json)：3 份文件真实导入、属性修改、括号显示、撤销／重做、非法次数拒绝、实际下载与重新解析；未运行 AI 模型。
- 既有 685 份有效商业样本全部继续通过原有适用编辑／保存回读检查。其通过不代表已经验证任意聚合物结构或任意编辑组合。

```powershell
npm test
npm run build
node scripts/prepare-polymer-test-files.mjs
python scripts/validate-polymers.py
node scripts/validate-polymer-browser.mjs
python scripts/prepare-engine-test-files.py
```

浏览器脚本需启动 5173 服务，并安装 Playwright；可用首个参数指定模块路径。手动文件位于 `/test-files/index.html` 的 `10-polymers`，导入 `original` 文件后，在“结构”的文档对象中选择 `bracketedgroup`。完整支持边界见 [说明](../../polymers.md)。
