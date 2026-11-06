# Molecule Workbench

自研的网页化学结构编辑组件，首版版本 `0.1.0`。目标是逐步兼容 ChemDraw 与 Marvin JS 的化学数据，同时保留独立的数据模型和编辑交互。

## 演示视频

[观看 AI 插件中文配音演示](media/molecule-ai-demo-voiceover.mp4)（约 69 秒，1080p，中文字幕与配音）。

演示使用本地 Qwen 3.6 27B 真实操作编辑器，涵盖模型连接、当前选区读取、氧-18 标记、结构检查、MRV 导出、撤销重做及结构旋转；配音由本地 Breeze TTS 2 生成，模型等待片段已标注加速。

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

构建产物：`dist/` 为演示工作台；`dist-sdk/chemical-editor.js` 为自带 Shadow DOM 样式的 ESM 组件，旁边提供 TypeScript 声明。使用本地化学计算时，须同时部署相邻的 `rdkit-2026.9.1/` 资源目录及许可证；约 7.4 MB 的 WASM 在首次计算时加载。默认编辑及化学计算不上传结构，可选 AI 插件按配置连接模型服务。

## 已实现

- 新版风格工作台：绘制／结构／视图功能栏、可收起属性面板、窄屏浮层与可选画布网格。
- 工具搜索（Ctrl / ⌘ K）：搜索绘图工具、全部 118 种元素、结构模板与工作台命令，支持方向键和 Enter。
- 分子预览模板库；选中结构的浮动工具栏；以选区中心旋转 30°、水平／垂直镜像及多原子元素／电荷批量编辑。
- 旋转、镜像与批量属性编辑接入撤销历史和本地草稿；完整片段镜像同步翻转内部楔键深度。

- 稳定 AtomId/BondId；分子图、二维坐标和键描绘分离；支持不连通图。
- 明确区分自动氢数与指定非图氢数，图中的 H 是独立原子。
- 原子放置、拖动成键、30° 方向吸附、已有原子连接、点击修改键级。
- 单／双／三键与二维实楔／虚楔描绘，苯环／六元环模板。
- 选择、框选、多原子移动、删除、撤销／重做、平移、缩放、适应画布。
- 元素、电荷、同位素、自由基自旋态、氢策略、原子映射编号属性编辑；支持模板外部连接点。
- 四面体几何和双键连接顺序进入可编辑模型；属性面板可修改、清除和反转，引用损坏或改变已记录可见构型的普通编辑会拒绝。
- 片段横排／竖排／环排、键长归一化插件；支持独立的虚线、粗线、等宽哈线与双键偏侧描绘。
- 本地 RDKit 化学计算：普通完整分子的自动二维清理、分子式、平均分子量、单同位素精确质量、LogP/tPSA、芳香原子及环统计、常见 R/S 与 E/Z 标签计算，以及 SMILES 输入／计算结果复制。清理前后核对异构 SMILES，失败不提交；修改可撤销。见 [计算功能与边界](docs/chemistry-engine.md)。
- 聚合物括号组：SRU／MultipleGroup 等类型、重复次数、连接／翻转模式、嵌套成员、跨括号键及组内原子可解析和编辑；支持 CDX/CDXML 来源保存和括号显示，不把重复单元误算成整个分子。见 [使用说明](docs/polymers.md)。
- 已定义缩写可展开一层或递归展开到主画布，按原端口连接真实原子，保护已有构型并支持撤销及 CDXML 来源保存。整体注释和不确定对应关系仍受保护。见 [展开说明](docs/abbreviation-expansion.md) 和 [与 ChemDraw JS 的对照](docs/chemdraw-js-comparison.md)。
- 连通选区可收起为可编辑缩写，保留内部原子、键、端口和受支持的立体关系；支持内部修改、重新展开、撤销重做，以及 CDXML 原生节点和样式的来源保存。电荷及同位素摘要递归统计已定义内部图。见 [收起说明](docs/abbreviation-collapse.md)。
- 残基、备选组和带引用的片段可展开为真实内部结构卡片，保留所有候选与整体注释；点击内部原子或键定位编辑，支持递归层级、撤销及 JSON/CDXML 保存重开。原子级提升另支持内外同阶单／双／三键。见 [群组展开与编辑](docs/expanded-groups.md)。
- 高级查询条件：具体元素或已有查询原子可设置非氢取代数、环键数、不饱和及反应变化／立体要求；键可设置环／链拓扑。提供属性面板、画布与 SVG 标记，支持 CDX/CDXML 增改清除、重建及跨格式保留。含查询的结构不冒充确定分子计算。见 [字段与边界](docs/query-constraints.md)。
- 4 个内置示例：阿司匹林、咖啡因、乙醇、苯。
- CDX 二进制普通二维分子导入与新建导出；JSON、CDXML、MRV、MOL V2000/V3000 的基础导入导出，以及 SVG 图片导出。
- 单步 RXN V2000/V3000 反应交换，保留普通分子的反应物／产物／试剂角色、映射、同位素、电荷及支持的反应键条件。见 [RXN 范围与验证](docs/rxn.md)。
- 文件选择、拖放导入、源码粘贴、源码复制、文件下载。
- 可选浏览器本地草稿；演示页默认开启，嵌入 SDK 默认关闭。按文档与页面保存恢复副本，跨标签保存冲突会保留双方版本；底栏“草稿版本”可恢复历史内容，旧版草稿保留原记录。详见 [可靠性修复与验证](docs/validation/ux-reliability-fixes/README.md)。
- 转换诊断、未知语义拒绝、默认阻止已知有损导出。

## 格式兼容范围

当前支持分子、查询、嵌套片段及反应文档模型；没有宣称完整兼容 ChemDraw 或 Marvin JS。尚未在这两款实际软件中完成全面往返认证。

| 格式 | 当前支持 | 边界 |
| --- | --- | --- |
| Molecule JSON | 首版模型、稳定 ID、布局、源文件及诊断 | `schemaVersion: 1`，未知模型字段会拒绝 |
| CDX | 普通化学图、查询、来源 CIP 缓存、立体排序、已有反应和图元的来源保存；基础新建导出 | 复杂模型的二进制重建／跨格式映射尚未完整覆盖 |
| CDXML | 查询、嵌套片段、反应角色、增强／轴立体排序、多中心连接、生物序列字段、独立三维坐标、文档对象及来源保存 | 部分专用图元只显示轮廓；复杂原子映射与通用聚合物适配尚未完整实现；本地计算限普通确定分子 |
| MRV | 普通分子、电荷、同位素、hydrogenCount、mrvMap、二维键描绘、基础压缩原子数组 | 压缩数组附加列、复杂原子/键语义、S-group/R-group 与反应暂拒绝 |
| MOL V2000 | 单结构、基础原子属性、M CHG/ISO/RAD、原子映射、二维键描绘 | 999 原子/键；查询、原子 parity、S-group 和三维暂拒绝；显式几何排序写入未实现 |
| MOL V3000 | ATOM/BOND、CHG/MASS/HCOUNT/RAD、原子映射、基础 CFG 描绘、续行 | COLLECTION、SGROUP、查询和三维暂拒绝；显式几何排序写入未实现 |
| RXN V2000/V3000 | 单步反应、分子角色、试剂、映射、普通二维化学图及支持的 RXCTR | 多步、查询、聚合物及高级反应约束暂拒绝；文档图元不属于 RXN 的保真范围 |
| SVG | 独立矢量图片 | 图片输出不承担化学文档往返 |

文本结构输入最多 20 MB、原生 JSON 80 MB、CDX 2 MB；每层化学图最多 2000 个原子与 2000 个键，本地计算每次最多 1000 个原子。已支持单条分子 SMILES 和普通分子的芳香性感知、二维清理及常见立体标签计算；尚未接入 SMARTS、SDF 多记录、通用 Markush／聚合物求值和全部立体类别的 CIP 计算。显式几何排序写入 MOL/MRV 时默认报告并阻止损失。

本机 687 份 ChemDraw 输入排除 2 份故意无效文件后，**685/685 有效文件通过导入及适用编辑后的源保存回读**：579 份化学修改、139 份图元修改、28 份反应角色修改，另有 1 份空白文档新增结构测试，各类别有重叠。3 处来源缺失内部图的标签明确标注未定义；专用 BioDraw 显示仍有边界。测试不证明任意文件和任意编辑组合均兼容。参见 [完整范围与验证报告](docs/engine-upgrade.md)。

CDX 可通过文件选择、拖放或 SDK 的 `Uint8Array` / `ArrayBuffer` 导入；原始二进制以 `cdx:base64,...` 文本存入 JSON 的 `source.raw`，便于草稿恢复。转换到其他格式仍受损失诊断保护。参见 [CDX 导入说明](docs/cdx.md)。

CDXML 可在“导出”对话框中选择并下载，也可将导入的 CDX 转换为 CDXML。使用范围、文件样例和独立验证步骤见 [CDXML 导出与验证](docs/cdxml.md)。

首版分子式和显示氢数采用有意受限的基础价态规则；未知情况显示待校验。编辑中允许暂时不合理的价态，引用损坏、重复键和无效数据会被拒绝。

### 源文件保留策略

- 导入时保留原始源文件、当前模型投影指纹和诊断。
- 对支持导出的文本格式，当文档未修改、导出格式等于源格式时，返回原始字符串；这表示**原样保留**，并不表示未解释特征已经可编辑。CDX 原始字节随 JSON 保存，可通过“下载原始文件”取回，或使用受限的“源格式保留保存”。
- CDX / CDXML 可在来源文档中保留支持的字段修改；CDX → CDXML 仅在所有字段都有映射时直接转换。无法保留时默认阻止，只有常规重建导出可明确设置 `allowLossy: true` 接受已报告的损失。详见 [保留保存机制](docs/preservation.md)。
- 保留保存支持普通化学标签同步、片段内增删原子和键及重新连接；未修改的对象与样式继续保留。自定义标签、未知引用和跨片段连接等仍会拒绝，见 [扩大编辑范围验证](docs/validation/preservation-expanded/README.md)。
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

## 基础与高级编辑

默认界面保留绘图工具、常用原子／键属性、模板、变换和导入导出。点击上方「高级编辑」可展开第二行分类栏：高级属性、查询条件、片段与缩写、文档与反应、扩展插件。右侧共用一个属性面板，点击「基本属性」即可返回常用编辑。

高级栏支持 Ctrl／⌘ K 搜索直达，显示当前选区及已设条件数量；同选区、同版本切换时保留草稿、折叠状态与分类滚动位置。

编辑器底部可切换中文／English，SDK 可传入 `locale: 'en'` 或调用 `setLocale('en')`。语言切换不改变输入值、化学内容或编辑历史。

收起高级栏只改变界面，不清除已设置的化学属性、画布标记、插件输入或编辑历史。AI 等插件入口会自动展开对应面板。SDK 可调用 `editor.showAdvancedEditor('queries')` 和 `editor.hideAdvancedEditor()`；见 [界面使用与验证](docs/advanced-editor.md)。

## 插件与公开 API

支持实例级插件注册、启停和卸载，插件可添加扩展命令、属性面板并订阅文档／选区事件。演示工作台在「高级编辑 → 扩展插件」中提供插件面板与快捷操作，高级栏右侧可管理插件；SDK 按需传入 `plugins`。

公开 API 包括独立快照、选区、基础诊断、带版本检查的批量编辑、导入导出及插件命令；`execute(request)` 提供统一的 JSON 调用入口。一个编辑批次作为一步撤销，失败时不修改画布。插件为可信的同页面代码，停用或销毁自动释放通过上下文注册的资源。

开发指南和完整示例见 [插件与 API 文档](docs/extensions.md)。结构编辑提供浏览器 JS/TS API；另有本地 AI 网关，不含 MCP Server。

## AI 助手与模型设置

演示工作台注册 AI 助手插件，初始收起高级栏。点击右上角「AI 助手」，或「高级编辑 → 扩展插件 → AI 助手」，在「模型设置」填写服务 Base URL、模型 ID 和可选密钥；支持 OpenAI Responses 与 OpenAI 兼容 Chat Completions。「测试连接」会验证模型是否支持工具调用。

也可从右上角「AI 设置」直接配置；「测试连接」会先保存当前填写的配置。助手实时预览当前文档、原子/键数、选区和版本，发送时读取最新上下文。自然语言操作覆盖 24 类严格校验的化学／文档操作，包括查询条件、片段显示／展开／收起、反应角色及聚合物属性；支持模板、文本源码导入、检查、导出及带版本检查的撤销／重做。可选「先预览编辑批次」展示修改前后与变更清单，确认后才提交；默认仍直接编辑。

内置提示词描述项目模型、稳定 ID、氢策略、二维描绘、可用工具和限制，并将当前画布、选区与基础诊断提供给模型。助手可读取、选中、批量编辑、加载模板、校验和导出结构，显示执行记录及下载文件。支持只读分析、停止、自定义提示词与撤销；尚未连接公司资料或三维引擎。

`npm run dev` 同时启动工作台和本地 AI 网关。构建后使用 `npm start` 在 `http://127.0.0.1:4173` 启动。本地服务会话内保存密钥，不写入浏览器存储或源码；更换服务来源时不会自动继承旧密钥。模型设置也可通过 `AI_PROTOCOL`、`AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY` 环境变量预设。

AI 还可调用本地 RDKit：只读计算分子性质与 SMILES、整理二维结构，以及导入用户提供的 SMILES。计算结果卡显示真实引擎数值、计算版本与范围，旧版本结果会标记过期；清理与导入沿用预览、撤销和版本保护。见 [AI 与本地化学计算](docs/ai-chemistry.md)。

详见 [AI 助手使用与开发指南](docs/ai-assistant.md)。未配置真实模型时不会生成模拟回复；自动测试覆盖受控工具流程，另已通过本机 Docker Qwen3.6 27B 的真实编辑、预览和撤销验证。

## 代码结构

```text
src/core/       化学模型、完整性校验、基础氢数/分子式、事务与模板
src/formats/    CDX 二进制读取、MOL/CDXML/MRV/JSON 适配器与转换诊断
src/editor/     SVG 渲染、Web Component、工具交互和组件样式
src/demo/       本地工作台与接入/兼容说明
src/index.ts   SDK 导出入口
public/examples/  可直接导入的乙醇 CDXML/MRV、二甲胺 CDX 样例
tests/         模型、跨格式、损失防护和多实例 SDK 测试
```

## 验证与后续重点

自动测试覆盖分子式样例、氢策略、无效引用、事务回滚、稳定 ID 撤销、四种交换格式两两转换、同位素/电荷/二维楔线锚点、原子映射、源文件原样返回与有损导出拦截、SDK 多实例隔离与草稿恢复。

浏览器操作验证覆盖绘制、元素替换、属性修改、撤销/重做、原子移动、键盘选择和删除、文件导入、MRV 下载、失败导入保留画布、草稿刷新恢复与窄屏布局。

后续优先用真实 ChemDraw/Marvin JS 文件扩充夹具，再逐项实现通用 CDX 写入、完整文档对象、拓扑立体语义、查询/Markush 和结构化反应。每个特征都需同时验证解析、编辑、重写和目标软件重新打开。

格式参考：[CDXML/CDX](https://docs.chemaxon.com/latest/formats_chemdraw-sketch-file-cdx-cdxml.html)、[MRV](https://docs.chemaxon.com/latest/formats_marvin-documents-mrv.html)。
