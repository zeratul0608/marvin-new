# AI 助手使用与开发指南

AI 助手是可选插件，通过模型的工具调用完成真实的结构编辑。它读取当前画布的数据，选择已有编辑器 API 操作，再根据执行结果回答；模型返回的文字本身不会直接修改文档。

## 启动

开发时运行：

```powershell
npm run dev
```

打开终端显示的本地地址，默认是 `http://127.0.0.1:5173`。开发服务已经挂载 AI 网关。

使用构建后的工作台时运行：

```powershell
npm run build
npm start
```

访问 `http://127.0.0.1:4173`。`npm start` 同时提供网页和 AI 网关；Vite 的 `npm run preview` 也挂载了相同接口。单纯托管 `dist` 静态文件不会提供 AI 网关。

点击工作台右上角 **AI 设置**，或打开 **AI 助手 → 模型设置**。首次未配置模型时会直接显示设置页，不会生成演示回答。

## 模型设置

模型必须支持工具调用。按模型服务提供方的实际接口选择协议：

| 字段 | 填写方法 |
| --- | --- |
| 接口协议 | `OpenAI Responses API` 对应 `responses`；OpenAI 兼容 Chat Completions 对应 `chat-completions`。服务仅兼容其中一种时必须选对应项。 |
| 服务 Base URL | 填服务 API 根地址，例如 `https://api.openai.com/v1`。若提供方使用 `/v1`，需要包含它；不要再加 `/responses` 或 `/chat/completions`，网关会自动拼接。 |
| 模型 | 自填该服务实际可用且支持工具调用的模型 ID，不是产品显示名。 |
| 兼容服务思考模式 | Chat Completions 协议下可选“使用服务默认值／关闭／开启”。只对支持 `chat_template_kwargs.enable_thinking` 的服务（例如 vLLM）设置，其余服务保持默认，默认不会发送该扩展参数。 |
| API 密钥 | 第一次填写密钥；再次保存时留空仅在同一服务来源下保留已有密钥。切换域名、端口或 HTTP/HTTPS 时会自动清空旧密钥，明确输入新密钥时使用新值。无密钥的本地服务可以留空。勾选“删除已保存的密钥”可清除。 |

填写设置后可直接点击“测试连接”：它会先保存当前表单，再要求模型返回一个 `ping` 工具调用，不发送当前分子、选区或实验资料。也可以只点击“保存设置”。保存失败时不会继续测试；测试失败时已保存的设置仍保留供修改。测试通过表示该连接能完成基础工具调用，不能代表该模型在所有编辑任务上的表现。

密钥仅保存在当前本地服务进程的内存中。配置读取接口只返回 `hasApiKey`，不会回传密钥；密钥不写入浏览器 `localStorage`。服务重启后手动填写的设置和密钥不保留。

也可以在启动服务前设置环境变量：

| 环境变量 | 作用 |
| --- | --- |
| `AI_PROTOCOL` | `responses` 或 `chat-completions`，默认 `responses`。 |
| `AI_BASE_URL` | 模型 API 根地址，默认 `https://api.openai.com/v1`。 |
| `AI_MODEL` | 模型 ID，默认未配置。 |
| `AI_API_KEY` | 服务端使用的密钥，默认空。 |

环境变量在服务启动时读取，可用来预设企业内部兼容网关。不要把真实密钥写入前端代码、文档或版本库。

模型设置属于本地服务进程。同一进程下的多个浏览器页面会使用同一份连接配置。本版是本机单用户网关，不是多人企业托管服务，也不是 MCP Server。

### 本机 Docker Qwen 3.6 27B

本机使用已有的 `Qwen3.6-27B` 权重与 vLLM 镜像，工具调用容器为 `qwen36-27b-vllm-tools`，原容器 `qwen36-27b-vllm` 保留并停止。两者使用同一端口，请只启动其中一个。

Docker Desktop 就绪后启动：

```powershell
docker start qwen36-27b-vllm-tools
```

模型设置选择 `OpenAI 兼容 Chat Completions`，Base URL 填 `http://127.0.0.1:8000/v1`，模型填 `qwen3.6-27b`，思考模式选“关闭”，密钥留空。本机模板默认关闭思考，显式发送该设置让 vLLM 的推理解析器与模板一致。冷启动需要等待权重加载和引擎初始化；`http://127.0.0.1:8000/v1/models` 返回该模型后再测试连接。

工具调用容器在原有启动参数基础上开启 `--enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3`，复用原有模型目录且以只读方式挂载。检查和停止：

```powershell
docker logs --tail 30 qwen36-27b-vllm-tools
docker stop qwen36-27b-vllm-tools
```

## 开始编辑

可以直接输入：

- “检查当前分子结构，解释基础校验提示。”
- “把选中的氧原子标记为氧-18，保留其他属性。”
- “把选中的片段向右旋转一次，然后适应画布。”
- “撤销上一步编辑。”或“重做刚才撤销的操作。”
- “将下面的 MOL 源码导入当前画布：……”（会替换当前文档，可撤销）。
- “用乙醇模板替换当前结构，把氧标记为氧-18，检查后导出 MRV。”

点击“发送”或按 `Ctrl + Enter`。面板会显示执行的工具、成功或失败结果，以及导出文件的下载链接。模型服务未配置、连接失败或不支持工具调用时，会明确报告问题。

“允许 AI 修改结构”默认打开。关闭后启用强制只读模式：程序会拒绝修改结构、选区和视图的工具调用，不依赖模型自觉遵守提示词。读取、检查和导出仍然可用。

同一批 `apply_edits` 修改采用一个编辑器事务，校验失败整批不执行，成功后可一步撤销。一次对话可能提交多个批次，需要按批次撤销。“停止”会取消后续请求和操作，已经执行的批次仍然保留；界面会提示检查画布并按需撤销。

对话历史只保存在当前面板内存中。停止、请求失败或保存新的模型设置后，后续请求会开启新的模型上下文，以免未完成的工具记录或不同协议的历史影响下一次操作。清空对话、卸载插件或刷新页面也会清除历史。清空对话不清除当前结构。

## 内置提示词与数据范围

内置规则位于 [`src/ai/prompts.ts`](../src/ai/prompts.ts)，包括：

- 分子数据模型、稳定原子和键 ID、二维坐标、楔线和氢数量字段的含义。
- 编辑前读取当前结构和版本号，批量修改必须带 `expectedRevision`，冲突后重新读取。
- 使用白名单工具；不执行模型生成的 JavaScript、脚本或任意插件命令。
- 文档标题、属性和诊断内容按数据处理，不当作用户或系统指令。
- 明确模板替换、只读权限、导出损失保护、失败说明及当前能力边界。

模型设置页可以查看完整内置规则，并填写补充工作提示词，例如“用中文回复，优先操作选区，完成后简要说明修改”。补充内容不会扩大工具权限。它保存在当前浏览器的 `molecule-ai:instructions:v1` 存储项中；这里适合放工作偏好，不适合填写密钥。

实际请求路径是：

```text
浏览器 AI 面板 → 同源 /api/ai 网关 → 模型设置中的 Base URL
```

助手顶部的“当前上下文”实时显示原子数、键数和选区；展开可查看与请求共用的结构化上下文，包括当前文档、分子式、版本号、撤销/重做状态和诊断。手动修改或切换选区后自动更新，每次发送仍重新读取最新画布。

对话请求会发送内置规则、自定义提示词、当前分子模型、选区、文档版本、基础诊断和本次对话历史，后续还会发送工具返回的结构或结果。发送前会移除文档的 `source` 字段，包括 `source.raw`；不会自动上传导入文件全文。用户主动粘贴到对话中的源码属于对话内容，会发送给模型。导出工具只将产物名称、类型、大小和诊断返回给模型，不把导出文件全文放进对话。

面板顶部显示当前模型服务的域名。填写外部服务地址后，上述数据就会发往该服务；填写内部兼容网关地址则发往该内部网关。此助手不会自行检索公司文件、实验系统或未连接的数据库。

## 工具与编辑约束

当前开放 11 个工具，定义及执行逻辑位于 [`src/ai/assistant.ts`](../src/ai/assistant.ts)：

| 工具 | 功能与限制 |
| --- | --- |
| `read_structure` | 读取当前完整二维模型、稳定 ID、文档版本和选区；移除来源原文。 |
| `read_selection` | 读取当前选中的原子或键，以及文档版本。 |
| `select_atoms` | 根据真实 ID 选择原子或一条键，也可以清空选区；只读模式拒绝。 |
| `apply_edits` | 批量增删改原子和键、调整位置、旋转镜像、重命名；必须带 `expectedRevision`，支持 `$name` 临时引用，整批校验和撤销；只读模式拒绝。 |
| `check_structure` | 返回现有基础结构诊断，不代表完整化学正确性认证。 |
| `load_template` | 使用 `aspirin`、`caffeine`、`ethanol` 或 `benzene` 模板替换整个文档；必须带 `expectedRevision`，只读模式拒绝。 |
| `import_structure` | 导入用户提供的 JSON、MOL、MRV 或 CDXML 源码，自动识别格式；必须带当前 `expectedRevision`，校验失败保留画布，只读模式拒绝。工具源码上限 250000 字符，对话输入框上限 16000 字符，大文件请使用编辑器文件导入。 |
| `undo_edit` / `redo_edit` | 撤销或重做一步已有编辑，必须带当前 `expectedRevision`；历史可能包含手动操作，无可用历史时明确报错，只读模式拒绝。 |
| `fit_canvas` | 调整画布视图以显示完整结构；只读模式拒绝。 |
| `export_structure` | 生成 JSON、MOL V2000/V3000、MRV、CDXML 或 SVG 下载产物；禁止已知有损导出。 |

每次用户请求最多进行 8 轮模型调用、执行 24 次工具调用。达到上限后会说明任务可能尚未完成。结构或对话超过大小限制时会报错，不会静默截断结构。

网关将工具声明发送为 `strict: false`，因为编辑操作 schema 含可选字段和多种操作结构；返回参数仍会经过本地 schema 校验和编辑器领域校验。未知字段、错误类型、非法枚举及不允许的工具都不能直接进入编辑 API。相关工具调用协议可参考 [OpenAI Function calling 官方文档](https://developers.openai.com/api/docs/guides/function-calling)。

## SDK 集成

SDK 不会默认注册 AI 插件，也不会自行访问模型服务。宿主需要显式安装：

```ts
import {
  createChemicalEditor,
  createAiAssistantPlugin,
} from '@molecule-workbench/editor';

const editor = createChemicalEditor({
  container: document.getElementById('editor')!,
});

const uninstall = editor.registerPlugin(createAiAssistantPlugin({
  endpoint: '/api/ai',
}));

// 卸载时会取消在途请求、清理面板和下载链接。
// uninstall();
```

默认 `endpoint` 是 `/api/ai`。嵌入其他应用时需要在宿主服务中提供对应网关；SDK 构建不会替宿主自动部署服务端。

宿主已有模型连接时，可以向 `createAiAssistantPlugin({ transport: hostTransport })` 注入自己的 `AiTransport`。其 `complete(request, signal)` 接收系统提示词、消息及工具 schema，返回 `AiTurn`。宿主应实现请求取消并正确保留工具调用 ID。注入后插件不调用默认网关的配置接口，连接由宿主管理，面板内的工作提示词仍可使用。

不需要面板时，可直接使用运行器和客户端：

```ts
import { createAiClient, runAiAssistant } from '@molecule-workbench/editor';

const client = createAiClient('/api/ai');
const result = await runAiAssistant(editor, client.transport, {
  message: '检查当前结构并解释基础诊断',
  allowEdits: false,
  instructions: '用中文简洁说明。',
});

console.log(result.text);
// 连续对话时，可把 result.messages 作为下一次调用的 history。
```

`createAiClient` 提供 `getConfig`、`saveConfig`、`test` 和 `transport`；`runAiAssistant` 提供受限的工具循环、版本检查和 `onEvent` 执行事件。两者均从 SDK 入口导出，相关类型见 [`src/ai/types.ts`](../src/ai/types.ts)。

本次验证使用模拟模型响应测试工具执行、参数校验、版本冲突、取消、只读权限和两种网关协议。尚未配置真实模型凭据，不能据此声称已实测所有模型或所有兼容服务。AI 当前围绕结构编辑工作，不具备三维生成、名称转结构或化学结论预测引擎。
