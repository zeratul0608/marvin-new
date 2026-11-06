# 高级编辑栏

默认保留现有基础绘图工具。点击编辑器顶部「高级编辑」展开分类栏，再次点击或使用分类栏右侧的关闭按钮收起。侧栏中的「基本属性」可返回常用属性，高级栏保持可用。

| 区域 | 内容 |
| --- | --- |
| 基础界面 | 单／双／三键、楔线、环、元素、选择与变换、撤销重做、模板、导入导出、原子电荷／同位素／氢数、普通键描绘、页面选择 |
| 高级属性 | 映射编号、自由基、来源编号、连接点编号、立体连接顺序、增强立体与化学注释 |
| 查询条件 | 元素列表与通用查询、非氢取代数、环键数量、不饱和条件、反应条件、键拓扑 |
| 片段与缩写 | 内部结构编辑、展开视图、提升为主图原子、收起选区、端口映射、命名片段与多中心连接 |
| 文档与反应 | 文本、箭头、图形、聚合物单元与反应角色 |
| 扩展插件 | 结构审阅、排版、化学计算、AI 助手；可展开「快捷操作」执行插件命令 |

基础侧栏会显示已选查询、缩写、连接点等对象的真实类型，并提供进入对应高级分类的入口。收起高级栏不会移除查询标记、立体信息、展开片段或其他化学数据，不会禁用插件或清空其输入，不会改变文档版本与撤销重做历史。高级分类选择及未提交的表单值不跨刷新保存；启用本地草稿后，已提交的文档修改可恢复。演示页面单独记住语言偏好。

桌面复用一个右侧属性面板；窄屏采用覆盖面板，并保留左侧工具轨。高级分类与插件标签可横向滚动，自动显示当前选中或聚焦项。左右方向键、Home、End 移动分类／插件焦点，Enter／空格确认；从高级栏关闭按钮收起后，焦点返回高级编辑开关。

## 查找与连续编辑

按 Ctrl／⌘ K 可搜索原子映射、自由基、内部结构、聚合物、查询等高级功能；结果会打开对应分类，并在所选对象具备相应控件时展开并聚焦它。搜索只导航，不执行化学修改。

侧栏会说明当前对象的真实类型，分类上的数字表示选区内已具有该类信息的对象数；文档分类的数字表示全文图文对象与反应步骤的总数。不同分类各自保留滚动位置。

同一文档版本、同一选区内切换分类、返回基本属性或收起高级栏时，表单节点、未提交草稿与折叠状态保持。选区、页面或外部文档版本改变后，字段从当前文档重新同步，避免将旧草稿用于其他对象。同选区提交字段时保留可继续使用的控件、折叠状态与键盘焦点，支持连续 Tab 和鼠标切字段。Ctrl／⌘ S 会校验并提交当前结构字段，再打开导出；无效字段会阻止导出。文本输入中的 Ctrl／⌘ Z 撤销文本编辑，画布、普通按钮和下拉框焦点下则撤销文档事务。

## 中英文界面

编辑器底部的语言菜单可在「中文」与「English」间切换，覆盖基础工具、高级分类、常用弹窗、内置插件和模型设置。演示页面的导航也同步切换，并将语言偏好保存到本地。

语言切换原地更新界面文字，不重建表单或插件，不改变输入值、文档标题、化学标签、SVG／源码、选区、文档版本或撤销历史。用户对话与模型回复保持原文。核心 API 返回的数据、错误码与原始文件不参与界面翻译。

## SDK

```ts
import { createChemicalEditor } from '../dist-sdk/chemical-editor.js';
import type { AdvancedEditorSection, EditorLocale } from '../dist-sdk/index';

const editor = createChemicalEditor({ container, locale: 'en' });
editor.setLocale('zh-CN');
editor.getLocale(); // 'zh-CN'

editor.showAdvancedEditor('fragments');
editor.hideAdvancedEditor();
editor.showPluginPanel('ai-assistant'); // 自动展开扩展插件
editor.showPluginPanel(); // 返回基本属性
```

`AdvancedEditorSection` 为 `properties | queries | fragments | document | extensions`。语言仅支持 `zh-CN` 与 `en`，也可通过组件 `lang` 属性配置。`localechange` 事件的 `detail.locale` 提供新值；同语言重复设置不重复发出事件。各编辑器实例独立，内部片段编辑器初始继承父编辑器语言。

业务插件可订阅组件的 `localechange` 自行翻译新文案。未知插件文字保持原样；用户正文、第三方标签或不可翻译数据可加 `data-i18n-skip`，输入值、源码和化学 SVG 默认受保护。

## 验证

- `tests/advanced-editor.test.ts` 检查默认收起、分类切换、特殊节点属性、插件生命周期和文档／选区／历史不变。
- `scripts/validate-advanced-ui-browser.mjs` 在真实 Chrome 的 1600、1280、768、390 像素宽度测试按钮与原生键盘操作、焦点恢复、可见查询字段编辑与撤销重做、插件输入／挂载保留、画布标记及横向溢出。
- `tests/advanced-workspace.test.ts`、`scripts/validate-advanced-workspace-browser.mjs` 验证草稿、滚动、焦点和高级搜索。
- `tests/editor-locale.test.ts`、`tests/editor-i18n-controller.test.ts`、`tests/editor-i18n-messages.test.ts` 和 `scripts/validate-editor-locale-browser.mjs` 验证中英文、动态界面与用户数据保护。
- 本地浏览器报告与截图：`.local/advanced-ui/`、`.local/advanced-workspace/`、`.local/editor-locale/`。不调用真实 AI 模型。

```powershell
node scripts/validate-advanced-ui-browser.mjs file:///C:/Users/admin/.codex/tools/playwright-mcp/node_modules/playwright/index.mjs
```
