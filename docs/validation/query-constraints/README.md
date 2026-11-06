# 高级查询条件验证

本轮范围为原子查询条件及键拓扑的解析、属性编辑、显示、保存与回读。它不代表完整 Markush 求值、SMARTS 匹配或结构数据库检索已经实现。字段定义与语义见[功能说明](../../query-constraints.md)。

## 原生输入与应用输出

[原生夹具清单](native-fixtures.json)记录 7 种自建场景、14 份原生 CDX/CDXML。文件由 Python 标准库独立写出；CDX 使用 28 字节原生头及隐式文档容器，独立解码器也接受 SDK 常用的 22 字节头及显式文档容器。

场景覆盖全部相关枚举、计数 0／255、显式 Unspecified、明确的 RingOrChain，以及 CDX RxnChange 的零长度属性。条件附加在明确的 C 元素上；与已画结构矛盾的条件仍保留，没有改造成任意原子或自动纠正成另一个分子。

[SDK 适配报告](adapter-results.json)记录原生导入、新建重建、条件新增／变更及反应标志移除、严格跨格式交换，以及全部条件清除。另由应用核对完整模型回读、JSON 恢复和撤销重做。

## 独立原生字段验证

2026-11-05，最终统一构建后的 **70/70 文件通过，0 失败**，包括 35 份 CDXML 和 35 份 CDX。结果见[独立报告](independent-results.json)。

| 阶段 | 独立验证通过 |
| --- | ---: |
| Python 原生输入 | 14 / 14 |
| SDK 从模型新建重建 | 14 / 14 |
| 新增／变更条件及清除 RxnChange 后来源保存 | 14 / 14 |
| 严格跨格式保存 | 14 / 14 |
| 移除全部查询条件后来源保存 | 14 / 14 |

[独立验证脚本](../../../scripts/validate-query-constraints.py)只使用 Python 标准库 `ElementTree`、`struct` 和基本文件 I/O，不调用 SDK 解析器、模型投影、对象对应工具或 RDKit。它直接核对：

- 具体元素身份、原子／键数量和键连接。
- 两个取代数的原生 UINT8 编码，包含有效的 0 及最大值 255。
- 环键数、不饱和及反应立体条件的 INT8 编码和全部已知枚举。
- 键拓扑的枚举值，尤其显式 RingOrChain 与未指定的区别。
- RxnChange 仅能以零长度 CDX 属性表示 true，缺失表示无此限制；不会接受一个真假数值字节代替该数据类型。
- 条件修改后的原生值及清除后的字段缺失，不以“文件可以打开”代替条件内容核对。

这个独立检查专门验证本轮七类原生字段的表示和往返，不判断查询能否匹配数据库内容、反应是否可行或所有 ChemDraw 文档样式是否保真，也不属于商业 ChemDraw 的官方认证。字体、图元、立体与完整复杂文档另有既有回归。

## 自动测试与真实浏览器

本轮统一自动测试通过 **653 项 Vitest 测试及 18 项服务端测试**，类型检查与构建通过。[核心专项](../../../tests/query-constraints.test.ts)覆盖原生枚举、具体元素身份、0／255 及矛盾条件保留、无效输入回滚、批次临时引用、JSON 和历史、查询摘要与计算保护，以及收起／展开时的属性保留和边界冲突检查。

[Chrome 浏览器报告](browser-results.json)在最终标记布局修改后复跑，**CDXML 与 CDX 两个场景均通过，4 次真实源文件下载，0 失败、0 页面错误、0 控制台错误**。实际操作包括：

- 通过文件选择器导入两份 `native-all-fields` 原生夹具，选择具体的 C 元素，打开可见高级查询面板。
- 修改两个取代数为 0／255、环键数为 AsDrawn、不饱和条件为 MustBeAbsent、反应立体条件为 Retention；取消并重新勾选反应变化限制，取消后对应字段必须缺失。
- 核对 C 没有被改成任意原子，画布显示 Q；输入超限 256 后，模型保持不变。
- 通过可见选择框依次设置 RingOrChain、清除、显式 Unspecified、再次设置 RingOrChain，核对字段存在与缺失的区别，并使用真实撤销／重做按钮。
- 实际下载带查询条件的源文件，由 SDK 重新解析并比较完整化学模型投影；查询结构进入普通分子计算时明确拒绝。
- 清除键拓扑及全部原子查询约束，实际撤销重做，确认查询标记消失、摘要恢复完整，本地 RDKit WASM 模块重新计算得到普通分子 SMILES `CN`。
- 实际下载清除条件后的源文件，再通过文件选择器导入该下载文件，确认普通模型及连接保持一致。

浏览器脚本为 [validate-query-constraints-browser.mjs](../../../scripts/validate-query-constraints-browser.mjs)，截图为本地 `.local/query-constraints-editor.png`。该截图同时显示展开的完整查询表单、具体元素及分离的原子／键查询标记。本轮不验证 AI 模型。

## 复现

```powershell
npm test
npm run build
python scripts/validate-query-constraints.py --prepare
node scripts/prepare-query-constraint-test-files.mjs
python scripts/validate-query-constraints.py
# 在另一个终端运行 npm run dev，提供 127.0.0.1:5173。
node scripts/validate-query-constraints-browser.mjs "file:///C:/Users/admin/.codex/tools/playwright-mcp/node_modules/playwright/index.mjs"
```

脚本不需要安装 Python 第三方包。测试文件均为自建数据，不包含商业软件样本或其复制内容。
