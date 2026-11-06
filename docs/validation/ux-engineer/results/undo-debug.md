# B06 撤销异常定位

结论：没有证实历史栈或顶部撤销按钮损坏。原 B06 依赖前置 B05，实际没有成功提交同位素 19；19 被填入标题，Undo 撤销的是标题事务。

测试使用 6 个独立 Chrome 上下文：普通 18→19→18、每次 Tab 后 focus 画布、带 B05 前置（重复 3 次）、真实点击加键盘输入版本。所有文档变更均通过 UI，仅只读记录模型和内部历史。

## 对照

普通版本和 canvas.focus 版本：同位素依次 18、19、18，每次提交 revision 增加 1；past 最后项为 19；顶部 Undo 正确恢复 19，Redo 正确恢复 18。

## B05 前置稳定重现 3/3

1. 手绘乙醇，文档名设为“工艺研发 · 溶剂乙醇 V1”，Tab 提交。
2. 选氧，填写同位素 18，Tab 提交：revision 7，模型 O18，标题正式名称；Shadow DOM activeElement 为空。
3. Ctrl+Z：模型仍 revision 7 / O18，但浏览器原生编辑历史把 document-title 输入值改回“未命名结构”，并聚焦标题。模型标题尚未提交。
4. 调用可见同位素字段的 fill('19')：先触发标题失焦 change，提交“未命名结构”（revision 8）。属性栏重渲染影响目标的 focus；fill 返回后实际 activeElement 是 document-title，值为 19，同位素字段仍 18。
5. Tab：提交标题 19，revision 9，模型仍 O18。历史新增的是标题事务，past 不存在 O19。
6. 再设置同位素 18是相同值，没有新增同位素事务。顶部 Undo 到 revision 10，恢复标题“未命名结构”，O18 不变。这符合真实历史。

真实点击加键盘版也发现焦点丢失：B05 后点击同位素字段时标题失焦提交，属性栏替换导致 activeElement 为空，随后的物理键盘输入没有进入同位素字段，19 未提交；Undo 恢复标题。该版本没有把 19 输入标题，但同样说明焦点与原生历史的交互影响实际用户操作。

## 定性

- 建议按 P2 记录“属性提交后焦点丢失、Ctrl+Z 进入浏览器原生标题历史”，保留 B05 证据。
- 不应把原 B06 标为 P1 或“撤销损坏”：它没有验证每次 19 的真正提交结果，结论受前置操作污染。
- B06 作为独立测试应使用独立上下文，或先把焦点移到画布解决待提交标题，再选氧并填写，**每次**断言模型同位素值和标题；使用顶部 Undo 验证真正的 19→18 事务。
- 生产实现可能需要在属性 change 重绘时维护合理的下一焦点，并统一处理编辑器非输入焦点的 Ctrl+Z，避免原生历史跨入标题字段。此处未修改实现。

详细证据：本目录 `undo-debug.json`，包括每步 revision、title、isotope、field value、activeElement、canUndo/canRedo 和 past/future 摘要。截图 `undo-debug-native-undo-prelude-before-ctrlz.png`、`undo-debug-native-undo-prelude-after-ctrlz.png`、`undo-debug-native-undo-prelude.png`。独立脚本 `undo-debug.mjs`。
