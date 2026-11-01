# 手动测试文件

建议先用乙醇 CDX：导入，选择 O 并修改同位素，然后在“导出”中选择“源格式保留保存”；下载后重新导入核对。选择“下载导入时的原始文件”会取回导入前的版本，不包含后续编辑。CDXML 优先保留原文档；CDX 转 CDXML 仅在全部字段可映射时直接转换，其余情况会报告损失。需要重排标签、新增或删除对象的修改会阻止保留保存，可先保存原生 JSON。最后测试错误文件，确认报错且画布不变。

- 01-basic-cdx/dimethylamine-simple.cdx — 二甲胺最小 CDX：应成功导入：C2H7N，3 个原子、2 条键。
- 01-basic-cdx/dimethylamine-styled.cdx — 二甲胺带样式 CDX：应成功导入；有样式兼容提示。转换导出需确认允许有损转换。
- 01-basic-cdx/rdkit-ethanol.cdx — 乙醇 CDX：应成功导入：C2H6O，3 个原子、2 条键；可能有显示样式提示。
- 01-basic-cdx/rdkit-benzene.cdx — 苯 CDX：应成功导入：C6H6，6 个原子、6 条键。
- 01-basic-cdx/rdkit-isotopes-charges.cdx — 同位素与电荷 CDX：应成功导入：13C、15N、N+、Cl−；3 个原子、1 条键。
- 02-cdxml/aspirin.cdxml — 阿司匹林 CDXML：应成功导入：C9H8O4，13 个原子、13 条键。
- 02-cdxml/cdxml-simple-edited.cdxml — 15N 二甲胺 CDXML：应成功导入；查看氮原子同位素为 15。
- 02-cdxml/wedge.cdxml — 楔线 CDXML：应成功导入：中心碳连接 F、Cl、Br、I，有一条实楔键。
- 02-cdxml/isotopes-charges-hydrogens.cdxml — 同位素、电荷和氢数 CDXML：应成功导入；包含 13C、15N、N+、Cl−，氯指定氢数为 0。
- 03-expected-errors/rdkit-ring-stereo1.cdx — 未实现复杂属性 CDX：应拒绝导入并保持当前画布；提示未实现属性 0x0445。
- 03-expected-errors/truncated-ethanol.cdx — 截断 CDX：应拒绝导入，提示截断，当前画布不变。

来源：二甲胺为公开归档 ChemDraw SDK 样例；乙醇、苯及同位素/电荷 CDX 由 RDKit 2025.03.6 独立写入器生成；ring-stereo1 为 RDKit 上游测试文件；CDXML 为本编辑器验证输出；截断文件为专门制作的错误样例。详见项目 docs/validation/cdx/README.md 与 docs/validation/cdxml/README.md。上游 RDKit 许可附于本目录。

## 保留保存样例

- 04-preservation/original-styled.cdx — 原始带样式 CDX：与归档输入字节完全一致；可测试“下载导入时的原始文件”。
- 04-preservation/styled-moved.cdx — 保留编辑后的 CDX：二甲胺的 N 已微移；样式和标签原文保留，仍可导入编辑。
- 04-preservation/ethanol-18o-anion.cdx — 18O 阴离子 CDX：乙醇 O 已改为 18O、−1 电荷和固定零氢；由源格式保留保存生成。
- 04-preservation/ethanol-18o-anion.cdxml — 完整映射后的 CDXML：由上一份 CDX 转换，参考结构 CC[18O-]，未确认有损重建。
- 04-preservation/annotated-moved.cdxml — 含文字图形的 CDXML：导入后移动原子，再导出 CDXML。输出中应保留 Courier 字体、独立文字、图形、注释和 CDATA；这些文档对象不一定显示在画布上。
