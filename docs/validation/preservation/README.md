# 保留保存验证

日期：2026-11-01。以下文件由真实浏览器中的导出对话框下载。

| 输出 | 验证 |
| --- | --- |
| [original-styled.cdx](original-styled.cdx) | 编辑后下载原始文件，与 820 字节输入逐字节相同，SHA-256 一致 |
| [styled-moved.cdx](styled-moved.cdx) | 微移带样式二甲胺中的 N，保留其余字节，独立 RDKit 读取为 `CNC` |
| [styled-isotope.cdx](styled-isotope.cdx) | 带样式 N 改为 15N，同步标签并保留字体与文档内容，独立读取为 `C[15NH]C` |
| [ethanol-18o-anion.cdx](ethanol-18o-anion.cdx) | 在乙醇原始 CDX 中修改 O 的质量数、电荷和氢数；独立 RDKit 读取为 `CC[18O-]` |
| [ethanol-18o-anion.cdxml](ethanol-18o-anion.cdxml) | 修改后的 CDX 全字段映射到 CDXML，未经有损确认；独立 RDKit 化学内容匹配 |
| [annotated-moved.cdxml](annotated-moved.cdxml) | 移动原子后保留字体、独立文字、图形、注释、CDATA、DOCTYPE 和原子 ID；浏览器与独立 XML 解析检查通过 |

普通标签修改现已支持；验证脚本改为检查自定义原子文字不能自动改写时阻止保留保存，而“下载原始文件”仍可用。提示明确说明原始文件不含后续编辑。CDX 二进制预览禁止复制占位文本，下载结果是真实二进制数据。

20 项基础保留机制测试覆盖原字节恢复、字节修改范围、稳定 ID、原生 JSON 恢复、XML 命名空间、键级、楔线锚点、数值范围、损坏基线、基础新增对象和有限跨格式转换。更多标签、增删与引用保护场景见扩展验证报告。

记录：[浏览器结果](browser-results.json)、[独立解析结果](independent-results.json)。

复现：启动开发服务器，运行 `node scripts/validate-preservation-browser.mjs`（需另行安装 Playwright 与 Chrome，可传 Playwright 模块 URL）；然后运行 `python scripts/validate-preservation.py --dependencies RDKit目录`。应用运行时不依赖这些验证工具。

扩展验证见 [标签与连接关系编辑](../preservation-expanded/README.md)，边界与 SDK 用法见 [保留保存说明](../../preservation.md)。这些结果不代表所有 CDX/CDXML 已完整无损互转，也未在 ChemDraw 或 Marvin JS 实际商业软件中验证排版。
