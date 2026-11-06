# AI 与本地化学计算

AI 助手可以调用已有的 RDKit WASM，执行分子性质分析、二维清理及用户提供的 SMILES 导入。计算模块按需从应用附带的资源加载，不调用外部化学计算服务；模型服务仍按原有 AI 配置接收编辑器上下文和工具结果。

## 使用

打开 AI 助手，可直接发送：

- “用本地 RDKit 计算当前完整分子的分子式、平均分子量、精确质量、LogP、tPSA 和 SMILES，不修改文档。”
- “整理当前完整分子的二维结构，保持原子、化学连接和指定构型，先给我预览。”
- “用我提供的 SMILES `N[C@@H](C)C(=O)O` 替换当前文档，先预览，确认后再应用。”

面板新增“计算分子性质”“整理二维结构”“导入 SMILES”快捷请求，支持中文和英文。导入快捷请求先询问具体 SMILES 和替换意图，不自行猜测结构。

计算成功后，面板直接显示 RDKit 的真实数值、版本、文档版本、计算范围、可复制的异构 SMILES 和计算立体标签。这张结果卡独立于模型回复，模型文字不会改变卡上的测量值。文档改变后，旧卡会标明结果属于过去版本；计算范围及原子 ID 保留用于核对。

## 工具

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `analyze_molecule` | `expectedRevision`、`atomIds` | 只读分析，返回分子式、分子量、精确质量、LogP、tPSA、氢键供受体、环数、氢数、SMILES 及适用的立体标签；不写入文档 |
| `cleanup_molecule_2d` | `expectedRevision`、`atomIds` | 生成并验证二维布局，应用原始布局操作，保留稳定原子 ID、化学语义、其它对象及来源记录 |
| `import_smiles` | `expectedRevision`、`smiles`、可选 `title` | 解析用户提供的 SMILES，验证成功后替换整份文档 |

`atomIds: []` 明确表示全文；非空列表必须形成用户要求的完整分子，不能切断化学键，也不能由 AI 自动扩展到未授权原子。每次最多计算 1000 个原子，SMILES 最长 50000 字符。

只读模式允许分析，拒绝清理和导入。开启“先预览编辑批次”时，清理和 SMILES 导入都先生成前后对比，批准后才提交。加载、计算和应用前都会检查文档版本；停止、拒绝或版本冲突不覆盖人工修改。成功的清理或导入作为一步撤销。

## 适用范围

沿用现有 RDKit 入口的保护：只支持已定义的普通完整分子。查询条件、内部或未定义片段、聚合物／重复单元、多中心连接、轴／增强立体及不支持的自旋态会明确拒绝，不为完成计算而删除或简化语义。可单独选择文档中组外的完整普通分子计算。

性质为计算值，独立三维坐标不参与；分析不把来源 CIP 缓存当作新结果，也不给未指定中心指定构型。名称转结构、反应预测、SMARTS／Markush 求值及三维计算不在这些工具范围内。详见 [本地计算引擎](chemistry-engine.md)。

## SDK

```ts
const result = await runAiAssistant(editor, client.transport, {
  message: '计算当前完整分子的分子量和 SMILES，不修改文档。',
  allowEdits: false,
  locale: 'zh-CN',
  onEvent(event) {
    if (event.type === 'chemistry-analysis') {
      console.log(event.analysis, event.revision, event.scope);
    }
  },
});
```

浏览器默认惰性加载本地 RDKit。宿主可通过 `loadChemistryEngine: async () => engine` 注入已经初始化的 `ChemistryEngine`，插件选项与运行器选项均支持。Node.js 调用者可注入 `createChemistryEngine(await initRDKit())`；编辑器和格式适配另需兼容 DOM。

## 验证

- `tests/ai-chemistry-contract.test.ts`：工具参数、能力声明与示例。
- `tests/ai-chemistry-tools.test.ts`：真实 RDKit、完整选区、语义保护、来源及加载取消。
- `tests/ai-chemistry-runner.test.ts`：真实工具循环、预览、撤销、只读与版本冲突。
- `tests/ai-analysis-panel.test.ts`：真实结果展示、过期状态、范围、双语和文本安全。
- `scripts/validate-ai-chemistry-browser.mjs`：真实 Chrome、RDKit、编辑器及受控模型，覆盖桌面／窄屏和中英文。
- `scripts/validate-ai-chemistry-local-model.mjs`：本机 Qwen 3.6 27B 真实自然语言；使用独立临时网关，不更改工作台已有连接或密钥。

本地报告与截图保存在 `.local/ai-chemistry/`。
