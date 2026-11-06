# 手动测试文件

建议先用乙醇 CDX：导入，选择 O 并修改同位素，然后在“导出”中选择“源格式保留保存”；下载后重新导入核对。选择“下载导入时的原始文件”会取回导入前的版本，不包含后续编辑。CDXML 优先保留原文档；CDX 转 CDXML 仅在全部字段可映射时直接转换，其余情况会报告损失。普通化学标签、片段内增删和改接已支持；自定义标签、混合字体、外部引用和跨片段连接仍可能阻止保留保存。最后测试错误文件，确认报错且画布不变。

- 01-basic-cdx/dimethylamine-simple.cdx — 二甲胺最小 CDX：应成功导入：C2H7N，3 个原子、2 条键。
- 01-basic-cdx/dimethylamine-styled.cdx — 二甲胺带样式 CDX：应成功导入；有样式兼容提示。转换导出需确认允许有损转换。
- 01-basic-cdx/rdkit-ethanol.cdx — 乙醇 CDX：应成功导入：C2H6O，3 个原子、2 条键；可能有显示样式提示。
- 01-basic-cdx/rdkit-benzene.cdx — 苯 CDX：应成功导入：C6H6，6 个原子、6 条键。
- 01-basic-cdx/rdkit-isotopes-charges.cdx — 同位素与电荷 CDX：应成功导入：13C、15N、N+、Cl−；3 个原子、1 条键。
- 02-cdxml/aspirin.cdxml — 阿司匹林 CDXML：应成功导入：C9H8O4，13 个原子、13 条键。
- 02-cdxml/cdxml-simple-edited.cdxml — 15N 二甲胺 CDXML：应成功导入；查看氮原子同位素为 15。
- 02-cdxml/wedge.cdxml — 楔线 CDXML：应成功导入：中心碳连接 F、Cl、Br、I，有一条实楔键。
- 02-cdxml/isotopes-charges-hydrogens.cdxml — 同位素、电荷和氢数 CDXML：应成功导入；包含 13C、15N、N+、Cl−，氯指定氢数为 0。
- 03-expected-errors/rdkit-ring-stereo1.cdx — 未实现复杂属性 CDX：应拒绝导入并保持当前画布；提示未实现属性 0x044a。
- 03-expected-errors/truncated-ethanol.cdx — 截断 CDX：应拒绝导入，提示截断，当前画布不变。

来源：二甲胺为公开归档 ChemDraw SDK 样例；乙醇、苯及同位素/电荷 CDX 由 RDKit 2025.03.6 独立写入器生成；ring-stereo1 为 RDKit 上游测试文件；CDXML 为本编辑器验证输出；截断文件为专门制作的错误样例。详见项目 docs/validation/cdx/README.md 与 docs/validation/cdxml/README.md。上游 RDKit 许可附于本目录。

## 保留保存样例

- 04-preservation/original-styled.cdx — 原始带样式 CDX：与归档输入字节完全一致；可测试“下载导入时的原始文件”。
- 04-preservation/styled-moved.cdx — 保留编辑后的 CDX：二甲胺的 N 已微移；样式和标签原文保留，仍可导入编辑。
- 04-preservation/ethanol-18o-anion.cdx — 18O 阴离子 CDX：乙醇 O 已改为 18O、−1 电荷和固定零氢；由源格式保留保存生成。
- 04-preservation/ethanol-18o-anion.cdxml — 完整映射后的 CDXML：由上一份 CDX 转换，参考结构 CC[18O-]，未确认有损重建。
- 04-preservation/annotated-moved.cdxml — 含文字图形的 CDXML：导入后移动原子，再导出 CDXML。输出中应保留 Courier 字体、独立文字、图形、注释和 CDATA；这些文档对象不一定显示在画布上。

## 扩大的标签与连接关系保留保存

- 05-expanded-preservation/input-annotated.cdx — 带图形的 CDX 输入：建议从此文件开始，修改 N 同位素、接入 O 或删除一个 C，然后选择源格式保留保存。
- 05-expanded-preservation/input-annotated.cdxml — 带字体、图形和独立文字的 CDXML 输入：编辑化学结构后保存 CDXML；独立图形、文字、字体和 CDATA 应仍在输出文件中。
- 05-expanded-preservation/cdx-isotope-charge.cdx — 15N、正电荷与氢数标签（CDX）：预期参考结构 C[15NH2+]C；保留原独立图形和样式。
- 05-expanded-preservation/cdx-add-atom.cdx — 新增 O 和连接键（CDX）：预期参考结构 CNCO；保留原独立图形和样式。
- 05-expanded-preservation/cdx-delete-atom.cdx — 删除一个 C 后的甲胺（CDX）：预期参考结构 CN；保留原独立图形和样式。
- 05-expanded-preservation/cdx-rewire-bond.cdx — 改接键后的乙胺（CDX）：预期参考结构 CCN；保留原独立图形和样式。
- 05-expanded-preservation/cdxml-isotope-charge.cdxml — 15N、正电荷与氢数标签（CDXML）：预期参考结构 C[15NH2+]C；保留原独立图形和样式。
- 05-expanded-preservation/cdxml-add-atom.cdxml — 新增 O 和连接键（CDXML）：预期参考结构 CNCO；保留原独立图形和样式。
- 05-expanded-preservation/cdxml-delete-atom.cdxml — 删除一个 C 后的甲胺（CDXML）：预期参考结构 CN；保留原独立图形和样式。
- 05-expanded-preservation/cdxml-rewire-bond.cdxml — 改接键后的乙胺（CDXML）：预期参考结构 CCN；保留原独立图形和样式。

## 引擎升级测试样例

- 06-engine-adaptation/：26 份 CDX／CDXML，自由基、连接点与键描绘。
- 07-stereochemistry/：10 份 CDX／CDXML，四面体与双键构型。
- 08-document-editing/：5 份 CDXML，反应步骤、内部片段与多页文档。
- 09-chemistry-engine/：40 份 CDX／CDXML，二维清理、分子性质与 SMILES（40 份）。
- 10-polymers/：8 份 CDX／CDXML，聚合物括号组、重复次数与跨括号连接（8 份）。
- 11-abbreviation-expansion/：12 份 CDX／CDXML，缩写原子级展开、端口连接与立体构型（12 份）。
- 12-abbreviation-collapse/：18 份 CDXML，选区收起、可编辑缩写与再展开（18 份）。
- 13-rxn/：12 份 RXN，RXN 双版本反应、试剂与原子映射（12 份）。
- 14-expanded-groups/：10 份 CDXML，残基、备选及引用片段的群组展开与编辑（10 份）。
- 15-query-constraints/：70 份 CDX／CDXML，高级查询条件、键拓扑及跨格式保存（70 份）。

tetra-original 为 S，tetra-inverted 为 R，tetra-mirrored 整体镜像后仍为 S；alkene-trans 为 E，alkene-cis 为 Z。以上标签由独立 RDKit 验证；普通分子可在“化学计算”中重新计算常见 CIP 标签。导入后选择中心原子或双键，打开右侧“结构”标签，查看连接顺序并点击反转；再测试撤销、重做和源格式保留保存。已记录约束的删除或改键级可能被阻止，请先清除相关约束。模板外部连接点显示为菱形，不是碳或查询通配原子。09 目录可导入 before 文件，打开“化学计算”，点击自动二维清理，再与 clean 文件对照；另可测试性质、立体标签和 SMILES 输入。10 目录导入 original 文件，在右侧“结构”的文档对象中选择 bracketedgroup，修改重复次数、类型、连接模式、成员及边界键，测试源保存和撤销。11 目录导入 original 文件，选择缩写节点，点击“展开一层到主画布”或“递归展开当前缩写”；对照 expanded 文件，测试撤销和源格式保存。12 目录导入 original 后选择连通片段，在“收起为缩写”输入名称并收起；也可导入 collapsed，打开内部编辑或展开。13 目录导入 .rxn，检查反应物／产物／试剂和映射；修改后选择明确的 RXN V2000/V3000 导出，不能把图元或文字条件静默转成试剂。14 目录导入 original 后选择片段，点击“展开结构并编辑”；点击卡片中的真实原子或键进行修改并保存。alternatives 会展示全部候选，nested 可展开全部内部层级；expanded 文件已保存展开状态。15 目录导入 native 文件，选择C原子并展开“高级查询条件”，测试取代数0/255、环键数、不饱和和反应条件；选择键测试“键拓扑查询”。edited/converted为修改与跨格式输出，cleared已清除条件。测试保存回读、撤销重做，含查询时不会计算为确定分子。
