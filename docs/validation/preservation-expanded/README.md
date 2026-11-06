# 扩大 CDX / CDXML 保留保存范围验证

日期：2026-11-01。全部输出来自浏览器导出对话框中的“源格式保留保存”，没有勾选有损重建。两种输入均由归档 SDK 的带样式二甲胺添加独立矩形而来；CDXML 还加入了独立文字、注释和 CDATA，供检查编辑时的保留效果。

原始测试输入：[CDX](input-annotated.cdx)、[CDXML](input-annotated.cdxml)。

| 操作 | CDX 输出 | CDXML 输出 | 独立参考结构 |
| --- | --- | --- | --- |
| N 改为 15N、+1 电荷和指定 2 个 H | [下载](cdx-isotope-charge.cdx) | [下载](cdxml-isotope-charge.cdxml) | `C[15NH2+]C` |
| N 改为 P，同步化学标签 | [下载](cdx-element.cdx) | [下载](cdxml-element.cdxml) | `CPC` |
| 新增 O 和 C–O 键 | [下载](cdx-add-atom.cdx) | [下载](cdxml-add-atom.cdxml) | `CNCO` |
| 给带标签的 N 新接一个 C，N 改为 +1 | [下载](cdx-add-to-label.cdx) | [下载](cdxml-add-to-label.cdxml) | `C[NH+](C)C` |
| 删除一个 C 和其连接键，N 氢数改为自动 | [下载](cdx-delete-atom.cdx) | [下载](cdxml-delete-atom.cdxml) | `CN` |
| 删除一条键，保留两个断开组分 | [下载](cdx-delete-bond.cdx) | [下载](cdxml-delete-bond.cdxml) | `C.CN` |
| 片段内改接现有键，保留原键 ID | [下载](cdx-rewire-bond.cdx) | [下载](cdxml-rewire-bond.cdxml) | `CCN` |
| 先打开导出窗口，再将 N 改为 15N | [下载](cdx-live-preview.cdx) | [下载](cdxml-live-preview.cdxml) | `C[15NH]C` |

16/16 输出成功重新导入，原子数、键数和分子式与编辑后的文档一致；16/16 由独立 RDKit 2025.03.6 直接读取并与预先指定的参考结构匹配，包括同位素、电荷和氢数。最后两份还验证了导出预览会随文档变化刷新。

CDX 独立矩形对象 `id=30` 的原始字节在所有操作后均一致；CDXML 的矩形、独立文字、字体表、颜色表、注释和 CDATA 均保持一致。已编辑标签复用了字体、字号、颜色；上标、下标、标签文字和相关派生缓存按新的化学属性更新，不声称标签新旧排版像素相同。

自动化测试另覆盖外部 `represent` 引用、未知 CDX 属性、厂商 XML 字段、自定义标签、多字体标签、跨片段连接和空文档等拒绝场景。模型的原始来源记录始终可以取回。

当前测试：245 项 Vitest + 18 项服务器测试，共 263 项全部通过；TypeScript、应用和 SDK 构建通过。

记录：[浏览器结果](browser-results.json)、[独立解析结果](independent-results.json)。复现：启动开发服务器后，运行 `scripts/validate-preservation-editing-browser.mjs`（可传入 Playwright 模块 URL），再运行 `python scripts/validate-preservation-editing.py --dependencies RDKit目录`。

边界见 [保留保存说明](../../preservation.md)。本次扩展的是源格式保留编辑，带未实现字段的 CDX 跨格式转换仍受保护；尚未在 ChemDraw / Marvin JS 商业软件中认证排版。
