# 可编辑群组展开视图验证

展开视图保留原有包装节点、残基注释、外部连接映射和全部候选，将真实内部原子与键显示为独立卡片。点击卡片中的原子或键，会进入同一引擎的片段编辑器；保存作为主文档的一步历史记录。此操作不会把多个候选合并成一个确定分子，也不会把整体注释分配给任意内部原子。“转为主图原子”是另外的操作，仍需满足明确的化学映射条件。

## 自动测试

2026-11-05 本轮统一测试通过 **550 项 Vitest 测试及 18 项服务端测试**，类型检查与构建通过。相关专项测试包括：

- [substructure-display.test.ts](../../../tests/substructure-display.test.ts)：显示状态、递归候选、节点身份与引用、JSON、撤销重做、原生 CDXML 保存、视图标记校验，以及未修改图元的原始几何数字格式保留。
- [expanded-render.test.ts](../../../tests/expanded-render.test.ts)：真实子图与交互命中元素、多列无重叠布局、外键与端口编号、完整嵌套路径、局部 ID 碰撞、边界与 SVG 导出、长标签和递归保护。
- [expanded-editor.test.ts](../../../tests/expanded-editor.test.ts)：内部原子点击定位、全部候选分别编辑、嵌套路径、取消修改及主文档的一步撤销。

## 自建文件与真实浏览器

[适配报告](adapter-results.json)记录 **5 种自建场景、10 个 CDXML 文件**，每种场景各有 original 和 expanded 文件。测试文件由[准备脚本](../../../scripts/prepare-expanded-group-test-files.mjs)生成，不含本地商业样本的复制内容。

[Chrome 浏览器报告](browser-results.json)在本轮源保存修复及重新构建后复跑，结果为 **5/5 场景通过、6 次实际内部化学编辑、0 个失败、0 个页面错误**。

| 自建场景 | 实际验证内容 | 内部同位素编辑次数 |
| --- | --- | ---: |
| own-peptide | 保留残基编号、生物连接类型及双端口映射 | 1 |
| own-alternatives | 两个候选分别点击、编辑和保存，候选全部保留 | 2 |
| own-referenced | 保留指向原包装节点的文档引用 | 1 |
| own-inconsistent | 保留内外不一致的边界键；在群组层级内编辑 | 1 |
| own-nested | 通过两层完整路径定位内部原子及键 | 1 |

每个场景均通过真实文件选择器导入 original 文件，点击展开按钮，点击真实子图命中元素，修改子编辑器的同位素输入并保存；同时核对主图节点、整体注释、全部候选、边界映射和文档引用。展开操作及每次内部保存均实际执行撤销、重做。

4 个含键的场景额外实际点击内部键并核对选中位置；备选场景中的两个单原子候选没有键，该项明确记为不适用。随后从导出对话框实际下载源 CDXML，重新解析比较完整模型投影，并再次通过文件选择器导入下载文件，确认修改及展开卡片恢复。10 个自建 original/expanded 文件均经过实际导入。

浏览器脚本为 [validate-expanded-groups-browser.mjs](../../../scripts/validate-expanded-groups-browser.mjs)。本地截图位于 `.local/expanded-group-views.png` 和 `.local/expanded-group-nested-editor.png`。本轮不验证 AI 模型。

## 原受保护的 250 个目标

[固定目标清单](targets.json)按文件及原生节点 ID 标识上一轮的 250 个受保护对象，避免同名缩写选错对象。[应用全量报告](corpus-results.json)记录本轮最终构建的结果：

| 检查 | 通过／适用 |
| --- | ---: |
| 保留身份的群组展开与 SVG 内部结构呈现 | 250 / 250 |
| 展开状态来源保存、回读完整模型对应 | 250 / 250 |
| 每个候选实际化学／查询修改并来源保存回读 | 264 / 264 分支 |
| 全部候选编辑通过的目标 | 250 / 250 |
| 完整模型及来源记录的 JSON 恢复 | 250 / 250 |
| 展开／内部保存的主历史撤销重做 | 250 / 250 |

264 个分支包括 12 个备选组的全部 26 个候选；其余目标各有一个分支。实际修改优先变更普通原子的同位素；只有查询内容时修改真实查询名称，存在更深内部图时按明确路径修改内部内容。保存回读比较完整模型投影，JSON 恢复比较完整序列化模型及来源记录，不能仅靠数量相同通过。

验证由四个独立 Node 进程分区运行。[合并脚本](../../../scripts/merge-expanded-group-audits.mjs)核对范围连续、无重叠、目标身份及所有证明字段，并确认覆盖全部 250 个目标；失败不会被合并为成功。单进程运行同样覆盖完整清单。

这里的成功指群组展开及内部编辑。原子级提升的另一份 532 组审计为 **283 成功、249 受保护、0 保存失败**，其中本轮新增实际 NR 的同阶双键提升。两种展开的统计不能相加，也不能把 12 个多分支查询强行称为一个确定分子。原始 CO2R 的内外键型冲突保留，可分别选择编辑，没有自动纠正原文件。

独立 XML 检查使用 [Python 标准库脚本](../../../scripts/validate-expanded-groups.py)，不调用应用解析器、投影或对象对应工具。它严格核对整份视图文件仅添加合法显示标记，另按原生节点／键／片段 ID 检查每个候选的预期化学编辑、整体注释、端口、键阶、立体排序和对象引用。结果见 [独立报告](independent-results.json)。该检查不是商业 ChemDraw 的往返认证。

正式严格全量结果为 **250/250 目标、264/264 分支，0 失败**；独立比较 250 份展开文件及 250 份实际编辑文件。实际修改包含 261 次同位素变更及 3 次查询条件修改，12 个备选组的全部 26 个候选通过。视图文件与原始整份 XML 仅相差合法显示标记，未放宽原生化学或引用校验规则。

## 复现

```powershell
npm test
npm run build
node scripts/prepare-expanded-group-test-files.mjs

# 需要本机已有 .local/chemdraw26-unpacked/files；商业原文件不随项目发布。
node --expose-gc scripts/audit-expanded-groups.mjs
python scripts/validate-expanded-groups.py

# 在另一个终端运行 npm run dev，提供 http://127.0.0.1:5173/。
node scripts/validate-expanded-groups-browser.mjs "file:///C:/Users/admin/.codex/tools/playwright-mcp/node_modules/playwright/index.mjs"
```

浏览器脚本使用本机 Chrome。首个参数是 Playwright 模块路径；若本地已能直接导入 `playwright`，可省略该参数。专项测试也可单独运行：

```powershell
npx vitest run tests/substructure-display.test.ts tests/expanded-render.test.ts tests/expanded-editor.test.ts
```
