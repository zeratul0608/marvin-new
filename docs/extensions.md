# 插件与公开 API

Molecule Workbench 将编辑器能力开放为浏览器 JavaScript API，并提供插件命令和面板扩展点。插件可以给项目增加结构摘要、内部编号、实验关联、杂质台账等功能，业务数据和后端连接由应用方实现。

当前结构编辑公开的是 **JS SDK 和 JSON 形状的调用入口**。项目还提供可选的 [AI 助手与本地模型网关](ai-assistant.md)，通过工具调用复用这些编辑接口；尚未提供结构编辑 HTTP API 或 MCP Server。

## 快速接入

```ts
import {
  createChemicalEditor,
  structureReviewPlugin,
} from './dist-sdk/chemical-editor.js';

const editor = createChemicalEditor({
  container: document.querySelector<HTMLElement>('#editor')!,
  plugins: [structureReviewPlugin],
});

const summary = await editor.executeCommand('structure-review.review');
console.log(summary);
console.log(editor.getPlugins(), editor.getCommands());
```

示例插件会增加一个「基础结构摘要」面板和两个命令：

| 命令 ID | 行为 |
| --- | --- |
| `structure-review.review` | 读取原子数、键数、不连通片段数、总形式电荷、同位素标记原子数、选区、基础分子式及现有诊断，返回结构化摘要 |
| `structure-review.neutralize-selection` | 将选中原子的形式电荷设为 0；使用版本检查，整批作为一步撤销 |

电荷归零只修改形式电荷，不推断 pH 或质子化状态，不增加、删除氢。分子式使用项目现有的有限价态规则；该插件不承担完整化学合理性、拓扑立体化学或工艺适用性校验。

## 编写插件

```ts
import type { EditorPlugin } from './dist-sdk/chemical-editor.js';

export const projectIdPlugin: EditorPlugin = {
  id: 'project-id',
  name: '项目结构编号',
  version: '1.0.0',
  apiVersion: 1,
  description: '展示选中原子的稳定 ID。',
  activate(context) {
    const unregister = context.registerCommand({
      id: 'show-selection',
      title: '查看选中原子编号',
      execute() {
        const { atomIds } = context.editor.getSelection();
        context.notify(atomIds.length ? atomIds.join(', ') : '尚未选择原子');
        return { atomIds };
      },
    });
    return unregister;
  },
};

editor.registerPlugin(projectIdPlugin);
await editor.executeCommand('project-id.show-selection');
```

插件的 `id` 是实例内唯一的稳定标识。`apiVersion` 必须是当前支持的 `1`；`version` 描述插件本身的版本。插件、命令和面板的 ID 只使用英文字母、数字、下划线与连字符。命令使用插件内局部 ID 注册，对外 ID 为 `插件ID.命令ID`，例如 `project-id.show-selection`。同一插件内，命令 ID 和面板 ID 各自在自己的类别中保持唯一。

`activate(context)` **必须同步返回** `void` 或清理函数，不应声明为 `async`。需要异步读取业务系统时，将工作放在命令的 `execute` 中；命令可以返回 Promise。避免在命令运行时重复提交相同任务。禁用插件不会自动撤销已经完成的文档编辑。

上下文提供以下能力：

| 接口 | 用途 |
| --- | --- |
| `context.editor` | 获取文档、快照和选区，进行批量编辑、导入导出、撤销重做和适应画布 |
| `registerCommand({ id, title, description?, execute })` | 注册命令，返回注销函数；命令会出现在插件命令列表中 |
| `addPanel({ id, title, mount })` | 在编辑器的插件区域挂载面板，返回注销函数；`mount(container)` 可返回面板清理函数 |
| `on('change', listener)` | 订阅文档变化，事件数据含 `document`、`revision`，返回取消订阅函数 |
| `on('selectionchange', listener)` | 订阅选区变化，事件数据含 `selection`、`revision`，返回取消订阅函数 |
| `notify(message)` | 在编辑器显示简短提示 |

面板只操作传入的 `container`，不应依赖编辑器内部 Shadow DOM 或私有字段。显示项目名、结构名等外部文本时使用 `textContent`；使用 `addEventListener` 管理交互，并在 `mount` 返回的函数里移除监听器或其他资源。

```ts
context.addPanel({
  id: 'project',
  title: '项目关联',
  mount(container) {
    const label = container.ownerDocument.createElement('p');
    const render = () => {
      label.textContent = `当前结构：${context.editor.getSnapshot().document.title}`;
    };
    container.append(label);
    render();
    const unsubscribe = context.on('change', render);
    return () => { unsubscribe(); label.remove(); };
  },
});
```

## 生命周期与信任边界

```ts
editor.registerPlugin(projectIdPlugin, { enabled: false });
editor.setPluginEnabled('project-id', true);  // 激活并注册面板、命令
editor.setPluginEnabled('project-id', false); // 清理并停用
editor.unregisterPlugin('project-id');       // 清理并移除登记
editor.destroy();                           // 销毁实例并清理插件
```

默认注册即启用。停用、注销或销毁时，插件宿主会清理通过上下文注册的命令、面板和订阅；插件返回的清理函数用于释放额外资源，例如计时器、网络连接和业务系统订阅。清理函数应可安全调用，重新启用时会重新执行 `activate`。插件运行中的异步任务也应有自己的取消或失效处理。

**这是可信代码的同页面插件机制，不是安全沙箱。** 插件 JavaScript 与应用运行在同一页面中，能够使用页面权限和浏览器 API。插件面板与封装 API 是工程边界，不是权限隔离。当前没有在线插件市场、远程脚本加载器、插件签名或按能力授权系统。部署时由应用方决定可加载的插件，并在业务服务端执行真实的项目权限与数据访问控制。

## 文档与编辑 API

`getSnapshot()` 返回独立快照：`apiVersion`、`revision`、`document`、`selection`、`canUndo`、`canRedo`。修改返回的对象不会改变画布。原子和键使用稳定 ID；原子映射编号 `atomMap` 是业务／交换格式注释，不替代原子 ID。

| API | 用途 |
| --- | --- |
| `getDocument()` / `setDocument(document)` | 获取独立文档副本／替换文档 |
| `getSelection()` / `setSelection({ atomIds, bondId? })` | 获取／更新选区 |
| `getDiagnostics()` | 获取现有文档和导入信息的基础诊断 |
| `applyEdits({ operations, expectedRevision? })` | 验证并提交一批编辑，返回 `{ snapshot, created }` |
| `import({ data, format?, name? })` | 导入结构，返回文档和格式诊断 |
| `export({ format, allowLossy? })` / `exportSvg()` | 输出化学文件或 SVG；化学导出默认阻止已知有损转换 |
| `undo()` / `redo()` / `fit()` | 撤销、重做、适应画布 |
| `getPlugins()` / `getCommands()` | 列出插件信息／当前可用命令信息 |
| `executeCommand(id, input?)` | 异步执行已注册的插件命令，返回命令结果 |

### 批量操作、临时引用与版本检查

```ts
const before = editor.getSnapshot();
const result = editor.applyEdits({
  expectedRevision: before.revision,
  operations: [
    { type: 'add-atom', ref: '$c', element: 'C', position: { x: 0, y: 0 } },
    { type: 'add-atom', ref: '$o', element: 'O', position: { x: 1.5, y: 0 } },
    { type: 'add-bond', ref: '$co', atoms: ['$c', '$o'], order: 1 },
    { type: 'update-atom', atomId: '$o', changes: { isotope: 18 } },
  ],
});

editor.setSelection({ atomIds: [result.created.atoms.$o] });
// 本批次的所有结构修改可用一次 undo() 撤销。
```

支持的操作包括 `add-atom`、`update-atom`、`remove-atom`、`set-position`、`add-bond`、`update-bond`、`remove-bond`、`transform` 和 `rename`。精确参数以导出的 `EditOperation` 类型为准。`transform` 使用现有的 `rotate-left`、`rotate-right`、`mirror-horizontal`、`mirror-vertical`，旋转角为 30°，镜像仅变换二维坐标。

`$name` 引用必须匹配 `$` 加字母开头的字母／数字／下划线名称，只在当前批次内有效，并且必须先创建后引用。返回值 `created.atoms` 和 `created.bonds` 将临时引用映射为真实 ID。需要跨请求引用时保存真实 ID。

每批最多 1000 项操作。整个批次先在独立文档中执行并验证，任意操作失败时原文档和历史保持不变；成功修改只进入一次撤销历史。删除原子同时删除其关联键。将 `isotope` 或 `atomMap` 设为 `null` 可以移除对应属性。

读取后经过异步处理的客户端应始终提交 `expectedRevision`。如果文档已被用户或其他调用修改，会抛出 `RevisionConflictError`，其 `code` 为 `REVISION_CONFLICT`，并带有 `expectedRevision` 和 `actualRevision`。发生冲突时重新读取快照、重新判断目标，再决定是否提交；不要盲目去掉版本检查重试。`revision` 用于文档并发检查，不能替代业务记录版本或选区一致性判断。

## JSON 调用入口

```ts
const snapshot = await editor.execute({ method: 'get_snapshot' });
const result = await editor.execute({
  method: 'execute_command',
  params: { id: 'structure-review.review' },
});
```

`execute(request): Promise<unknown>` 接受可序列化请求对象，返回操作结果，失败时拒绝 Promise。它并非 JSON-RPC 或 HTTP 路由，不包含传输、用户认证、请求 ID 或服务端错误封装。应用适配器可以在捕获异常后按自己的协议包装错误。

| `method` | `params` |
| --- | --- |
| `get_snapshot`、`get_selection`、`get_diagnostics` | 无 |
| `set_selection` | `{ atomIds, bondId? }` |
| `apply_edits` | `{ operations, expectedRevision? }` |
| `import` | `{ data, format?, name? }` |
| `export` | `{ format, allowLossy? }` |
| `export_svg`、`undo`、`redo`、`fit` | 无 |
| `list_plugins`、`list_commands` | 无 |
| `execute_command` | `{ id, input? }` |

后续接入 MCP 时，可将 `get_snapshot`、`get_selection`、`apply_edits`、`get_diagnostics`、`export` 和允许执行的插件命令分别映射为工具。传输桥接、权限校验和结构数据流向需要由部署应用实现。基础编辑 SDK 默认不联网；启用 AI 助手后，用户发起的请求会将当前结构上下文发送到配置的模型服务，详见 AI 指南。
