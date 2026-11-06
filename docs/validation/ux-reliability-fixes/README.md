# 第一批用户体验可靠性修复

日期：2026-11-06。基线为 [化学工程师体验走查](../ux-engineer/README.md)；本次修复针对当前工作区，未提交或推送代码。

## 修复结果

完成第一批 6 项：**1 项 P1、5 项 P2**。原 68 项任务/操作检查全部复测，结果为 **62 项通过、3 项完成但有摩擦、3 项能力受限、0 项失败**。通过包含安全拒绝，也可能伴有体验问题；没有将剩余能力缺口算作已修复。

| 原问题 | 修改后的行为 | 验证 |
| --- | --- | --- |
| B-F04 / P1，多标签静默覆盖草稿 | 文档 ID 隔离；每个编辑器实例持有独立写入分支与同步恢复副本。IndexedDB 在同一读写事务中检查共享版本再保存；冲突保留双方版本并提示。旧 localStorage 原记录不删除 | 交错保存、并发保存、各页刷新、立即刷新、关闭原页后恢复非共享分支均通过 |
| B-F01 / P2，属性提交后的焦点与原生撤销交互 | 同选区属性更新保留可继续使用的控件，避免失焦提交删除刚点击的下一字段。文本输入保留原生 Undo；画布、普通按钮和下拉框执行文档 Undo | 连续 Tab、鼠标切字段、Ctrl+Z/Y，标题和结构结果正确 |
| B-F03 / P2，标题内 Ctrl+S 不导出 | 编辑器中的 Ctrl/⌘ S 先校验并提交当前结构字段，再打开导出。无效值阻止导出旧数据；遵守输入法组合输入和活动模态窗口 | 未失焦标题、同位素新值进入预览；同位素 0 阻止导出 |
| EX-F02 / P2，导入缺少整文替换提示 | 明示替换当前整份文档、不追加、可撤销；按钮显示“替换当前文档”。拖入文件也先确认，取消不改画布 | 文件选择、拖放确认、取消、替换和精确撤销通过 |
| EX-F01 / P2，转换诊断难理解、报告无直达入口 | 主提示使用可读说明；保留详细原始诊断供报告查看。导出中可直接打开本次报告，返回时保留原导出状态；提供源格式或 JSON 保存入口 | 样式 CDX→CDXML 报告直达、推荐源格式实际下载/重开保留同位素 |
| EX-F03 / P2，硬限制仍展示无效的有损许可 | 区分可保留保存、需要确认损失、暂不支持。只有实际适配器在许可后能生成结果，才展示许可；硬限制始终阻止转换，提供可执行替代保存 | 查询结构→MOL 隐藏且禁用许可；JSON 下载重开文档精确一致；可接受损失的格式仍可显式许可 |

新增提示与入口均提供英文；390px 英文草稿恢复和导出推荐入口可操作，未产生页面横向溢出。

## 草稿保存与恢复范围

- `storageKey` 仍由宿主按需开启。示例默认开启，SDK 默认关闭。
- 文档模型的 `id` 是草稿身份；不使用各标签页独立增长的编辑器 revision 比较共享版本。每次保存拥有独立 saveId，并记录父版本与写入者。
- 页面提交后先同步写入自己的恢复副本，再排队写入 IndexedDB。刷新优先恢复本页面副本；新页面可打开“草稿版本”查找其他分支。
- IndexedDB 保留每份文档最近 20 个历史版本，额外保留各分支最新版本和共享头。版本列表显示标题、毫秒时间、原子数、电荷及已有同位素标记，便于分辨分支；恢复后可一步撤销。
- 原始 localStorage 键作为旧版迁移来源保留。仅在验证旧文档有效后迁移；损坏记录不会被删除，并有提示。
- 恢复列表隔离缺少图映射、含空原子等损坏记录，不让单条坏记录阻挡其他健康版本；原始损坏记录仍保留。
- IndexedDB 不可用时明确显示“仅保存此页恢复副本”。共享保存成功但本页恢复副本不可用时也会说明；两者都失败则提示保存失败并建议导出 JSON。
- 本地草稿不是云端同步或备份。AI 会话、计算卡、未提交表单值和撤销历史仍不跨刷新保存；本次未改变这些边界。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 全量 Vitest | 820 / 820 |
| 服务端 Node 测试 | 18 / 18 |
| TypeScript、应用构建、SDK 构建及类型声明 | 通过 |
| 原 68 项场景与操作检查 | 62 通过、3 摩擦、3 受限、0 失败 |
| 专项真实 Chrome：原生 IndexedDB | 3 / 3，含跨页事务竞争与 45 次保存后的历史裁剪 |
| 专项真实 Chrome：草稿 UI | 7 / 7，含旧草稿迁移、恢复撤销及英文窄屏 |
| 专项真实 Chrome：焦点与保存 | 5 / 5 |
| 专项真实 Chrome：文件交换 | 6 / 6，含实际文件下载与重导入 |

全部最终浏览器结果未记录页面 JavaScript 异常。AI 组仍使用真实本地 qwen3.6-27b 和 RDKit，11 项定义任务通过；通过不表示本轮修复了其布局或追溯问题。大文档组仍为合成 600 原子样例，复测与其他检查并行，不据此比较前后性能。

完整机器汇总见 [summary.json](results/summary.json)；逐项结果见 [基础](results/basics.json)、[文件交换](results/exchange.json)、[高级](results/advanced.json)、[AI](results/ai.json)、[日常工作台](results/workbench.json)、[大文档](results/large.json)。专项结果见 [草稿后端](results/draft-backend-native.json)、[草稿 UI](results/draft-ui.json)、[焦点](results/focus.json)、[交换 UI](results/exchange-ui.json)。

关键截图：[双页独立恢复](evidence/draft-independent.png)、[英文草稿版本](evidence/draft-recovery-en.png)、[导入确认](evidence/import-confirmation.png)、[转换建议](evidence/export-guidance.png)、[英文硬限制与保存入口](evidence/export-hard-limit-en.png)、[无效字段阻止保存](evidence/invalid-field.png)。

## 复现脚本

先运行开发服务。浏览器脚本可传入 Playwright 模块；本机使用 `file:///C:/Users/admin/.codex/tools/playwright-mcp/node_modules/playwright/index.mjs`。

```powershell
node scripts/validate-draft-storage-browser.mjs <playwright-module>
node scripts/validate-draft-recovery-browser.mjs <playwright-module>
node scripts/validate-edit-focus-browser.mjs <playwright-module>
node scripts/validate-exchange-ux-fixes-browser.mjs <playwright-module>
```

原 `scripts/ux-engineer-*.mjs` 场景脚本继续可用；基础/交换/高级/工作台/大文档支持 `UX_OUTPUT_DIR`，AI 组支持 `UX_AI_OUTPUT`，可将复测保存到独立目录，避免覆盖首次证据。本轮原始输出位于 `.local/ux-fixes/`，关键证据已复制到本目录。历史诊断脚本中 `productionCodeModified:false` 表示脚本不修改生产源码，不代表本轮未实现修复。

首轮两处采集问题保留在本地：交换脚本的选择器同时匹配 SVG，已限定按钮；草稿迁移运行期间源码热更新影响保存状态等待，核心代码稳定后保留同一断言并连续两轮通过。未通过放宽化学或恢复断言来消除失败。

## 仍待后续批次处理

首次发现的其余 **15 项：13 项 P2、2 项 P3** 保留。包括反应概览/角色辨识、反应箭头与条件文字创建、箭头几何控件、递归片段路径、稠环便捷绘制、结构复制粘贴、问题原子定位、SMILES 入口、浮动条遮挡、AI 结果阅读/停止状态/会话追溯，以及搜索别名与文字框样式。本轮没有扩大 CDX/CDXML 格式解析范围，也没有新增 ChemDraw/Office 原生兼容认证。
