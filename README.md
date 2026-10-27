# Molecule Workbench

自研的网页化学结构编辑组件，首版版本 `0.1.0`。目标是逐步兼容 ChemDraw 与 Marvin JS 的化学数据，同时保留独立的数据模型和编辑交互。

## 启动

需要 Node.js 22.12+（当前开发环境为 22.23.2）。

```powershell
npm install --legacy-peer-deps
npm run dev
```

访问 http://127.0.0.1:5173 。当前 npm 10 的可选 peer 依赖解析会触发 `edgesOut` 错误，安装时使用上述参数；锁文件已保留确切依赖版本。

```powershell
npm test
npm run build
```

构建产物：`dist/` 为演示工作台；`dist-sdk/chemical-editor.js` 为自带 Shadow DOM 样式的 ESM 组件，旁边提供 TypeScript 声明。SDK 没有生产运行时 npm 依赖；默认编辑不联网，可选 AI 插件按配置连接模型服务。

## 已实现

- 新版风格工作台：绘制／结构／视图功能栏、可收起属性面板、窄屏浮层与可选画布网格。
- 工具搜索（Ctrl / ⌘ K）：搜索绘图工具、全部 118 种元素、结构模板与工作台命令，支持方向键和 Enter。
- 分子预览模板库；选中结构的浮动工具栏；以选区中心旋转 30°、水平／垂直镜像及多原子元素／电荷批量编辑。
- 旋转、镜像与批量属性编辑接入原有撤销历史和本地草稿。镜像属于二维坐标变换，尚不提供拓扑立体化学保证。

- 稳定 AtomId/BondId；分子图、二维坐标和键描绘分离；支持不连通图。
- 明确区分自动氢数与指定非图氢数，图中的 H 是独立原子。
- 原子放置、拖动成键、30° 方向吸附、已有原子连接、点击修改键级。
- 单／双／三键与二维实楔／虚楔描绘，苯环／六元环模板。
- 选择、框选、多原子移动、删除、撤销／重做、平移、缩放、适应画布。
- 元素、电荷、同位素、氢策略、原子映射编号属性编辑。
- 4 个内置示例：阿司匹林、咖啡因、乙醇、苯。
- JSON、CDXML、MRV、MOL V2000/V3000 的基础导入导出，以及 SVG 图片导出。
- 文件选择、拖放导入、源码粘贴、源码复制、文件下载。
- 可选浏览器本地草稿；演示页默认开启，嵌入 SDK 默认关闭。
- 转换诊断、未知语义拒绝、默认阻止已知有损导出。

## 格式兼容范围

当前是**普通二维分子适配器**，并未宣称完整兼容 ChemDraw 或 Marvin JS。尚未在这两款实际软件中完成往返认证。

| 格式 | 当前支持 | 边界 |
| --- | --- | --- |
| Molecule JSON | 首版模型、稳定 ID、布局、源文件及诊断 | `schemaVersion: 1`，未知模型字段会拒绝 |
| CDXML | 普通元素、形式电荷、同位素、NumHydrogens、单/双/三/芳香键、二维楔线与锚点、坐标 | 当前不写原子映射；字体/页面/图形等未解释内容会报告 |
| MRV | 普通分子、电荷、同位素、hydrogenCount、mrvMap、二维键描绘、基础压缩原子数组 | 压缩数组附加列、复杂原子/键语义、S-group/R-group 与反应暂拒绝 |
| MOL V2000 | 单结构、基础原子属性、M CHG、M ISO、原子映射、二维键描绘 | 999 原子/键；查询、原子 parity、自由基、S-group 和三维暂拒绝 |
| MOL V3000 | ATOM/BOND、CHG/MASS/HCOUNT、原子映射、基础 CFG 描绘、续行 | COLLECTION、SGROUP、查询和三维暂拒绝 |
| SVG | 独立矢量图片 | 图片输出不承担化学文档往返 |

每个输入最多 2 MB、2000 个原子与 2000 个键。尚未接入 CDX 二进制、SMILES/SMARTS、SDF 多记录、反应与 Markush、聚合物、完整拓扑立体化学、CIP 标签、自动二维清理、融合环及完整芳香性感知。

首版分子式和显示氢数采用有意受限的基础价态规则；未知情况显示待校验。编辑中允许暂时不合理的价态，引用损坏、重复键和无效数据会被拒绝。

### 源文件保留策略

- 导入时保留原始源文件、当前模型投影指纹和诊断。
- 当结构与布局未修改、导出格式等于源格式时，返回原始字符串；这表示**原样保留**，并不表示未解释特征已经可编辑。
- 发生编辑或跨格式转换，且源文件存在未解释内容时，默认阻止导出。调用方必须明确设置 `allowLossy: true` 才能接受已报告的损失。
- JSON 可保存模型和完整源文件记录。源文件中的未知信息在相关编辑后不会被机械回填到新结构。
- 当前不会自动推断多步骤反应角色，也不会把未知伪原子当成碳。

## 接入 SDK

```ts
import {
  createChemicalEditor,
  type ChemicalDocument,
} from './dist-sdk/chemical-editor.js';

const editor = createChemicalEditor({
  container: document.querySelector<HTMLElement>('#editor')!,
  // storageKey: 'business-structure-draft', // 按需开启
});

const imported = editor.import({ data: cdxmlSource, format: 'cdxml' });
console.log(imported.issues);

try {
  const exported = editor.export({ format: 'mrv' });
  console.log(exported.data, exported.issues, exported.passthrough);
} catch (error) {
  // FormatError.issues 可用来展示兼容报告。
}

editor.addEventListener('change', event => {
  const { document, revision } = (event as CustomEvent<{
    document: ChemicalDocument;
    revision: number;
  }>).detail;
  // 在这里将 document 交给业务系统保存。
});

editor.getDocument(); // 返回独立副本
editor.setDocument(documentModel);
editor.setTool('select');
editor.undo();
editor.redo();
editor.fit();
editor.exportSvg();
editor.destroy();
```

`createChemicalEditor` 需要浏览器 DOM。组件使用 `chemical-editor` 标签，也可通过 `registerChemicalEditor('business-chemical-editor')` 注册自定义标签。每个实例的状态、历史、事件和样式独立。React/Vue 可在挂载时创建，卸载时调用 `destroy()`。

核心模型和适配器也可独立调用：

```ts
import { importDocument, exportDocument, emptyDocument } from './dist-sdk/chemical-editor.js';
const { document, issues } = importDocument({ data: source }); // 自动识别
const result = exportDocument(document, { format: 'mol-v3000' });
```

当前 XML 适配器使用浏览器 `DOMParser`；服务端调用需要提供兼容 DOM 实现。

## 插件与公开 API

支持实例级插件注册、启停和卸载，插件可添加扩展命令、属性面板并订阅文档／选区事件。演示工作台在「扩展」中提供插件管理，默认接入「结构审阅」示例；SDK 按需传入 `plugins`。

公开 API 包括独立快照、选区、基础诊断、带版本检查的批量编辑、导入导出及插件命令；`execute(request)` 提供统一的 JSON 调用入口。一个编辑批次作为一步撤销，失败时不修改画布。插件为可信的同页面代码，停用或销毁自动释放通过上下文注册的资源。

开发指南和完整示例见 [插件与 API 文档](docs/extensions.md)。结构编辑提供浏览器 JS/TS API；另有本地 AI 网关，不含 MCP Server。

## AI 助手与模型设置

演示工作台默认开启 AI 助手插件。点击右上角「AI 助手」或侧栏「AI 助手」，在「模型设置」填写服务 Base URL、模型 ID 和可选密钥；支持 OpenAI Responses 与 OpenAI 兼容 Chat Completions。「测试连接」会验证模型是否支持工具调用。

也可从右上角「AI 设置」直接配置；「测试连接」会先保存当前填写的配置。助手实时预览当前文档、原子/键数、选区和版本，发送时读取最新上下文。自然语言操作覆盖批量编辑、模板、导入用户提供的结构源码、检查、导出，以及带版本检查的撤销/重做。

内置提示词描述项目模型、稳定 ID、氢策略、二维描绘、可用工具和限制，并将当前画布、选区与基础诊断提供给模型。助手可读取、选中、批量编辑、加载模板、校验和导出结构，显示执行记录及下载文件。支持只读分析、停止、自定义提示词与撤销；尚未连接公司资料或三维引擎。

`npm run dev` 同时启动工作台和本地 AI 网关。构建后使用 `npm start` 在 `http://127.0.0.1:4173` 启动。本地服务会话内保存密钥，不写入浏览器存储或源码；更换服务来源时不会自动继承旧密钥。模型设置也可通过 `AI_PROTOCOL`、`AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY` 环境变量预设。

详见 [AI 助手使用与开发指南](docs/ai-assistant.md)。未配置真实模型时不会生成模拟回复；自动化验证使用模拟模型。

## 代码结构

```text
src/core/       化学模型、完整性校验、基础氢数/分子式、事务与模板
src/formats/    MOL、CDXML、MRV、JSON 适配器与转换诊断
src/editor/     SVG 渲染、Web Component、工具交互和组件样式
src/demo/       本地工作台与接入/兼容说明
src/index.ts   SDK 导出入口
public/examples/  可直接导入的乙醇 CDXML、MRV 样例
tests/         模型、跨格式、损失防护和多实例 SDK 测试
```

## 验证与后续重点

自动测试覆盖分子式样例、氢策略、无效引用、事务回滚、稳定 ID 撤销、四种交换格式两两转换、同位素/电荷/二维楔线锚点、原子映射、源文件原样返回与有损导出拦截、SDK 多实例隔离与草稿恢复。

浏览器操作验证覆盖绘制、元素替换、属性修改、撤销/重做、原子移动、键盘选择和删除、文件导入、MRV 下载、失败导入保留画布、草稿刷新恢复与窄屏布局。

后续优先用真实 ChemDraw/Marvin JS 文件扩充夹具，再逐项实现 CDX、完整文档对象、拓扑立体语义、查询/Markush 和结构化反应。每个特征都需同时验证解析、编辑、重写和目标软件重新打开。

格式参考：[CDXML/CDX](https://docs.chemaxon.com/latest/formats_chemdraw-sketch-file-cdx-cdxml.html)、[MRV](https://docs.chemaxon.com/latest/formats_marvin-documents-mrv.html)。
