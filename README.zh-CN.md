[English](README.md) | 简体中文

# dsh-agent-hub

DeepSeek Harness 插件：把多个不同的 agent（Claude、Codex、MiniMax……）集成到一处，长期目标是在它们之间协调多任务。

目前的模块：**连接器（Linear、Notion 等外部服务）**、**看板（Sentry 告警、Linear ticket 与本地任务）**、**阅读（RSS 与 GitHub 星标）**、**订阅用量**、**Claude Agent**、**Cursor**、**Qoder 与眼镜**、**Hermes**、**接力（查看与接管 Qoder、Hermes 在别处的对话）**、**手机访问**、**源代码管理（Git，含工作树）**、**代码编辑器**、**Bots 与群聊（多 agent 协作）**、**配置同步（多台机器经 Git 远程仓库共享配置）**、**审核（等我 review 的 PR，以及回应我自己 PR 收到的评审）**、**脚本任务（原生定时任务驱动的受限 helper）**。

其中 **阅读**、**接力**、**剪贴板浮窗**、**Cardputer** 和 **Codex** 是可选模块，在 设置 → Agent Hub 顶部的 **功能模块** 卡片里逐个开关：默认只开 Codex，其余四个默认关闭。关闭的模块停止后台工作，侧栏面板或页面、以及它在设置里的分组都会隐藏；开关立即生效，不用重启。详见[配置：设置 → Agent Hub](#配置设置--agent-hub)。

设置页按模块折叠：每组收起时只占一行，显示组名和当前状态摘要（如"Linear 已连接 · Notion 登录已失效"），点整行展开；展开状态按浏览器记住，顶部可"全部展开 / 全部收起"。某组出现需要处理的问题（登录失效、数值无效）时会自动展开并标出。

> [!IMPORTANT]
> **Codex 需要另装插件 `dsh-codex-subscription`。** Codex 模型、Codex 的订阅用量和账号切换都由 [dsh-codex-subscription](https://github.com/WSL043/dsh-codex-subscription) 提供，本插件只读取它的账号库、调用它的接口。请在 DSH 的插件管理中安装并启用 `dsh-codex-subscription`，然后在 **设置 → Codex 订阅** 中登录。未安装或未启用时，订阅用量里的 Codex 卡片和 设置 → Agent Hub → Codex 的模型设置会显示提示，经 DSH 的插件管理一键 **安装**（已安装但未启用时为 **启用**）；按提示重启 DSH 后，在 设置 → Codex 订阅 中登录。

## 配置：设置 → Agent Hub

插件自己的选项集中在 DSH 设置里的 **Agent Hub** 一页（在"订阅用量"下方），顶部是**功能模块**卡片，各分组排在四个小标题下：**Agent 与模型**（Claude Agent、Qoder 与眼镜、模型选择、Bots）、**工作流**（连接器、审核、脚本任务、看板、Git 提交）、**对话与界面**（对话、字体与字号）、**访问与设备**（手机访问；Cardputer 与剪贴板与翻译在对应模块开启后出现）。页头工具条始终固定在顶部：只要还有展开的分组，按钮就是"全部收起"（在页面下方点击时会回到顶部），全部收起后变为"全部展开"；窄屏只显示图标。整个 profile 的配置同步与插件升级不在这一页，见[同步与更新](#设置--同步与更新)。

**功能模块**：工具条下方、四个小标题之上固定着一张 **功能模块** 卡片，每个可选模块一个开关：

- **阅读**、**接力**、**Codex**：随[配置同步](#模块配置同步)在多台机器间同步。
- **剪贴板浮窗**、**Cardputer**：只对本机生效，不随配置同步。

关闭某个模块后，它停止后台工作（定时刷新、守护进程、原生助手、设备端口等），侧栏里的面板或页面、以及它在设置里的分组都会隐藏；再打开即恢复。开关立即生效，不用重启。配置在 `cordis.patch.yml` 的 `modules` 分区，旧版的 `palette.enabled` 由 `modules.palette` 取代。

下表按模块列出选项（配置的存储位置与旧版相同，分组调整不需要迁移）：

| 模块 | 选项 | 默认 | 说明 |
| --- | --- | --- | --- |
| 功能模块 | 阅读 | 关 | 左侧边栏的 **阅读**：订阅、定时刷新和阅读页面；随配置同步 |
| | 接力 | 关 | 左侧边栏的「接力」面板与完成通知；随配置同步 |
| | 剪贴板浮窗 | 关 | 剪贴板与翻译悬浮窗、全局快捷键和剪贴板记录（`modules.palette`，取代旧版 `palette.enabled`）；仅桌面端，只在本机生效，不随配置同步 |
| | Cardputer | 关 | Cardputer 设备的配对、端口与听写（`modules.device`）；只在本机生效，不随配置同步 |
| | Codex | 开 | Codex 模型设置与订阅用量里的 Codex 卡片；需要另装 `dsh-codex-subscription` 插件；随配置同步 |
| 对话 | 全局指令（Markdown） | 空 | 每次与任何模型对话时注入：DSH 模型放在系统提示词末尾，Claude Agent 追加到 Claude Code 的系统提示词，bot 在其人设之后也会收到；留空不注入。Claude Agent 会话在下一轮以新进程恢复以应用改动 |
| | 画布 | 开 | 让所有模型把独立的图表、表格、仪表盘做成可交互、自包含的 HTML 文件，存到 `~/.dsh/canvases`，在回复里给出链接，并可在左侧「画布」面板集中浏览 |
| | Archify 结构图 | 开 | 开启画布时，让模型用 [Archify](https://github.com/tt-a1i/archify) skill 画架构、流程、时序、数据流、状态、ERD 等图，仍存为画布。需自行把 Archify 装进各模型的 skill 目录，并有 Node 和本机 Chrome 或 Edge；比手写画布更慢、更耗 token |
| | 选区讨论 | 开 | 选中聊天正文或代码块后显示“问一下”；临时讨论不运行工具、不读取完整主会话 |
| | 讨论模型 | 自动 | 复用后台辅助模型路由，或指定普通文本模型；不支持 Claude Agent、Cursor 和 Bots，修改只影响新讨论 |
| 连接器 | 已连接的服务 | 空 | 远程 MCP 服务器（Linear、Notion、Sentry、GitHub 或任意地址），连接一次所有模型可用；详见[模块：连接器](#模块连接器) |
| Bots | bot 列表 | 空 | 每个 bot 是名称、一句话介绍、模型、人设和（高级）可用工具；详见[模块：Bots 与群聊](#模块bots-与群聊多-agent-协作) |
| 审核 | 审核的仓库 | 空 | 勾选的仓库里等我 review 的 PR 会被分析；空 = 关闭。只在本机生效，不随配置导出；详见[模块：审核](#模块审核) |
| | 自动定时同步 | 开 | 由 DSH 官方自动化任务管理；首次迁移默认 09:00，此后在宿主编辑时间和时区；设置页提供状态与管理入口 |
| | 审核 Bot | reviewer | 分析用这个 bot 的模型，它的人设就是分析提示词 |
| | 辅助模型 | 自动 | 自动同步协调和审阅单上"深挖""改写"的模型（不能是 Claude Agent）；"自动"用 Claude Agent 的后台请求模型；PR 分析仍使用审核 Bot |
| | 评论风格 | 内置 | 英文评论和总结的写法，分析与改写都遵守 |
| | 附加规则 | 空 | 每次审核都附加；仓库的 `.reviews/RULES.md` 和单个审阅单的规则接在后面 |
| | 每次最多分析 | 10 | 一次同步最多开始分析几个 PR；同时最多运行 2 个 |
| 看板 | Sentry Issues 地址 | 空 | `https://<org>.sentry.io/issues/?project=<id>` 或 `https://sentry.io/organizations/<org>/issues/`；只读取 organization/project，数据区域（US/EU）由 Sentry 连接器按组织自动识别；环境固定为 prod，看板支持 7d/14d。空 = 隐藏告警列 |
| | 分析仓库路径 | 空 | 本机仓库主工作树；只在本机生效，不随配置导出 |
| | 默认分析 Bot | reviewer | 开始分析前仍可切换；此设备记住最近选择，且不提供 Seer |
| Claude Agent | Remote Control | 开 | 给每个会话开启 Remote Control；对之后新启动的会话生效 |
| | 新会话默认完全权限 | 关 | 新启动的会话以完全权限运行（Claude Code 的 bypass 模式）：执行工具不再请求批准，包括写文件和运行命令，只在信任的工作区开启；开启只改变新启动会话的默认权限；关闭后，已有全权限会话在下一安全的 DSH 对话轮次以新进程恢复审批，正在执行及由 Remote Control 跟随的轮次不会被打断 |
| | 常驻在线会话数 | 3 | 开启 Remote Control 时，最近活跃的这么多个会话不因空闲关闭；0 表示都按空闲时间关闭 |
| | 空闲关闭时间（小时） | 2 | 会话空闲超过这么久就关闭 Claude Code 进程，下一轮从 transcript 恢复（0.25–168） |
| | 后台请求模型 | 自动 | DSH 对 Claude Agent 和 Cursor 会话发出的非对话请求（上下文压缩、生成会话标题）交给这个模型回答。"自动"使用新建 agent 的默认模型；默认模型是 Claude Agent、Cursor 或 Bot 时，用第一个其他模型 |
| Qoder 与眼镜 | 眼镜可派任务的工作区 | 无 | 勾选的仓库在 DSH 运行期间各常驻一个 `qoderclicn remote-control` 守护进程，千问眼镜、Qoder App 和 qoder.cn 派来的任务在本机执行。只在电脑上修改 |
| | 每个工作区的任务名额 | 8 | 一个工作区同时保留的任务数（1–32）。回答完的任务仍占名额以便追问，直到在 App 里归档 |
| | 随 DSH 启动 | 开 | 关闭后在「接力」面板的“眼镜工作区与云端”里手动启动 |
| 模型选择 | 显示的提供方 | 全部 | 取消勾选即把该提供方（如默认的 DeepSeek）的全部模型从模型选择中隐藏；DSH 的后台调用和 Git 提交信息仍可用它们。若新建 agent 的默认模型属于被隐藏的提供方，要先换一个默认模型 |
| | 各 Agent 可用模型 | 全部 | Claude Agent、Codex、Cursor、Qoder 的模型和 Hermes 的 persona，各自勾选哪些出现在 DSH 的模型选择里；全部勾选（默认）时以后新增的模型也会出现。只影响模型列表，不改变已有会话或后台调用 |
| | 默认思考等级 | 各模型自带默认 | 在模型选择里切换到某个模型时，推理等级（reasoning effort）自动设为这一档，对所有模型生效。模型没有这一档时取它有的最近较低档（off < minimal < low < medium < high < xhigh < max），没有较低档则取最近较高档。已有会话保持当前等级，切换模型时才应用 |
| | 按模型设置 | 跟随统一设置 | 为单个模型另设默认思考等级，优先于统一设置；Bot 沿用它所用模型的等级 |
| | 快捷键：打开模型菜单 | 未设置 | 光标在会话输入框里时直接打开模型列表：↑/↓ 浏览模型，回车选定，Esc 返回；关闭后光标回到输入框。点击键位框后按下组合键即绑定（须含 Ctrl、Alt/⌥ 或 ⌘），Esc 取消。注册在 DSH 自己的快捷键服务里：与 DSH 快捷键统一检查冲突，也出现在 DSH 的「快捷键」速查（Mod+/）中；键位按设备保存在 DSH 的 keybindings 里，不写入 `cordis.patch.yml`，也不随配置同步 |
| | 快捷键：切换思考等级 | 未设置 | 光标在会话输入框里时把当前模型切到它的下一档思考等级，最高档之后回到最低档；绑定方式同上 |
| 字体与字号 | 界面字体 | 默认 | 默认字体，或 ui-ux-pro-max 推荐的 Roboto Mono、JetBrains Mono、Source Code Pro、Fira Code、IBM Plex Mono；字体随插件提供并按需加载 |
| | 代码字体 | 默认 | 代码块、编辑器、diff 和 Git 终端使用的字体；缺少的字符自动回退到系统字体 |
| | 界面文字大小 | 100% | 80–130%，每次 5%；按比例缩放侧栏、菜单、按钮、设置等界面里写死的 px 字号，各处原有的大小层级不变，间距和布局不动。会话正文字号不在此列，仍由 DSH「通用设置 → 字号大小」决定 |
| | 分区微调 | 跟随整体 | 左侧栏、主区域、右侧面板、设置窗口、菜单与弹窗可各自在整体上 ±20%；每项可单独恢复，「全部恢复默认」一次还原 |
| 手机访问 | HTTPS 端口 | 443 | 443 时网址不带端口；已开启时修改会自动迁到新端口 |
| Git 提交 | 严格身份模式 | 开启 | 没有自己提交身份的仓库一律拒绝提交（终端、agent 同样生效）。开启时设置全局 `user.useConfigOnly`，并把全局 `user.name/email/signingkey` 移到 `~/.gitconfig` 的 `agent-hub.*` 暂存；关闭时原样恢复，也不会撤销你自己设置的 `useConfigOnly` |
| | 预设提交身份 | 空 | 姓名、邮箱、可选签名密钥，随设置同步到其他设备。Git 面板为仓库选择身份时提供这些选项 |
| | 模型 | 默认 | 下拉列表列出 DSH 当前注册的全部模型（与模型选择器同一份目录，按提供方分组；不含只回答会话的 Claude Agent）。选"默认"时使用新建 agent 的默认模型；已保存但当前未注册的模型会保留并标注 |
| | 额外要求 | 空 | 附加到提示词，例如"使用 Conventional Commits，主题用中文" |

修改会自动保存：开关、模型选择及恢复默认立即保存，输入文字或数值在暂停输入或失焦后保存；每项可单独"恢复默认"。离开页面会保存有效修改并丢弃该次访问留下的无效或保存失败草稿，不影响重新进入页面后的新编辑。保存经由 DSH 的 settings 服务写入当前 profile 的 `cordis.patch.yml`（以 desktop profile 为例：`$DSH_HOME/profiles/desktop/cordis.patch.yml`），**立即生效，不用重启**。也可以直接编辑该文件（改后需重启 DSH）：

```yaml
- id: agent-hub
  config:
    modules:                        # 功能模块开关（以下为默认值）
      reader: false                 # 阅读；随配置同步
      relay: false                  # 接力；随配置同步
      palette: false                # 剪贴板浮窗；只在本机生效（取代旧版 palette.enabled）
      device: false                 # Cardputer；只在本机生效
      codex: true                   # Codex；需要 dsh-codex-subscription 插件；随配置同步
    prompt:
      instructions: |               # 全局指令（Markdown），注入每次对话
        ## 沟通
        - 用中文回答，代码和标识符保留英文
      canvas: true                  # 画布：图表、表格、仪表盘做成 ~/.dsh/canvases 里的 HTML
      archify: true                 # 用 Archify skill 画结构图（需开启画布）
    connectors:
      servers:                      # 只有 id 和地址；登录凭据在 DSH 凭据库
        - id: linear
          url: https://mcp.linear.app/mcp
          repos: [C:\pro\app]       # 可选：这个 Linear 账户用于哪些本地仓库（主目录）；不写 = 全部仓库
    claude:
      remoteControl: true
      fullAccess: false             # true = 新进程完全权限；关闭后已有全权限进程在下一安全轮次恢复审批
      keepOnline: 3
      idleHours: 2
      models: [opus, sonnet]        # 空 = 全部
      helperProvider: deepseek-official   # 后台请求（压缩、标题）的模型；两项都留空 = 自动
      helperModel: deepseek-v4-flash
    codex:
      models: [gpt-6.1-sol]          # 空 = 全部；["(none)"] = 全部隐藏
    models:
      hiddenProviders: [deepseek-official, deepseek-account]
      effort: high                  # 切换到模型时的默认思考等级；不写 = 各模型自带默认
      efforts:                      # 单个模型另设，优先于 effort
        - provider: claude-agent
          model: opus
          effort: max
    appearance:
      uiFont: default              # default / roboto-mono / jetbrains-mono / source-code-pro / fira-code / ibm-plex-mono
      codeFont: jetbrains-mono
      uiScale: 100                 # 80–130（%）；界面文字整体缩放，各处原有大小层级不变；会话正文字号仍由 DSH 通用设置 → 字号大小 决定
      regions:                     # 分区微调，在整体上加减百分点（−20–20），0 = 跟随整体
        sidebar: 10                # sidebar / main / panel / settings / popup
    remote:
      httpsPort: 443
    git:
      provider: deepseek-official
      model: deepseek-v4-flash
      instructions: 使用 Conventional Commits，主题用中文
    team:
      agents:
        - id: reviewer
          description: 只读审查 diff
          provider: claude-agent
          model: opus
          persona: 你是严谨的代码审查者……
        - id: coder
          provider: openai-codex
          model: gpt-5.6-terra
          tools: [read, edit, bash]
    sync:
      remote: git@github.com:me/dsh-settings.git
      branch: main
      fetchOnStart: true
      localSettings: [terminal-controller, ui-theme.config.preference]   # 整个条目，或条目内的设置
    review:
      repos: [/Users/vi/pro/app]    # 本机的仓库主目录；不导出
      at: "09:00"                 # 仅首次迁移；之后在宿主自动化任务中编辑时间
      bot: reviewer                 # 模型 + 人设（分析提示词）都来自这个 bot
      commentBot: en                # 看板「改动」里手写评论点 ✦ 处理时默认用的 bot；留空 = 不处理
      helperProvider: minimax-cn    # 自动同步协调、深挖、改写；两项都留空 = Claude Agent 的后台请求模型
      helperModel: MiniMax-M3
      style: |
        评论使用英文，先肯定实现，简短口语化，不用破折号
      rules: |
        - 忽略 generated/ 下的文件
      explain: |                    # 看板「改动」里 ✦ 解释的回答要求；留空 = 目的 / 作用 / 如何生效
        分三部分回答：**目的**、**影响范围**、**风险**，每部分不超过两句
      explainBot: reviewer          # ✦ 解释和追问用这个 bot 的人设和模型；留空 = 辅助模型
      maxPerRun: 10
    alerts:
      url: https://acme.sentry.io/issues/?environment=prod&project=1234567&statsPeriod=14d
      repo: C:\\pro\\app            # 本机仓库主工作树；不导出
      bot: reviewer
```

实现上，`Config` 的每个分区都声明为 `.volatile()`（[src/config.ts](src/config.ts)）：DSH 只允许设置界面编辑 volatile 字段，Loader 把新值直接提交给运行中的插件而不重新挂载，各模块每次使用时读取最新值；手机访问在端口变化时重建转发。

页面顶部的 **导出配置 / 导入配置…** 用于把设置带到另一台机器（Windows、macOS、Linux 之间均可）：

- 导出下载 `agent-hub-config-<日期>.json`，只包含当前 profile 改过的设置；保持默认的选项不写入，导入后跟随目标机器的默认值。登录凭据和令牌在 DSH 凭据库，不会写入文件，导入的连接器要在本机重新连接。
- 连接器的“关联仓库”会以可移植形式导出：写成 `{ "name": "app", "path": "C:/pro/app" }`（路径统一用 `/`）。导入时先找本机路径相同的已注册仓库，再找唯一同名的仓库；都找不到时保留原路径并提示，稍后可在连接器里重新关联。Sentry 告警的“分析仓库路径”只在本机有效，和审核仓库列表一样不导出。多行文本（全局指令、人设等）统一为 LF 换行。
- 导入前会列出将应用几项、几项恢复默认，以及跳过了哪些本版本不认识或无效的设置；确认后一次性替换当前 profile 的设置，未保存的草稿会被丢弃。

## 模块：脚本任务

**设置 → Agent Hub → 脚本任务**：将可信本地脚本绑定到 DSH 原生定时任务，由可选模型或兼容 Bot 的专用会话调用唯一受限工具。程序、参数、工作目录显式保存，默认不创建任务、不执行；时间和时区在原生任务管理器中编辑。随附 Qoder 中国版每日积分模板：只在装有 Qoder 中国版桌面端的 Windows 上出现，默认只检查，只有显式添加领取参数才允许领取；不切换国际版。执行以当前用户权限运行，不是脚本沙箱。

参见[使用方式、结果协议与恢复边界](docs/script-tasks.md)。

## 设置 → 同步与更新

整个 profile 的**配置同步**和**插件升级**在 DSH 设置里单独的 **同步与更新** 页（在 Agent Hub 下方）。两者改动的都是所有插件，也都可能要等重启才生效：有这类改动时，页面顶部的横幅说明原因，列出排队等重启的升级，并提供 **立即重启**（仅 DSH Desktop；`dsh web` 下提示手动重启）。

| 分组 | 选项 | 默认 | 说明 |
| --- | --- | --- | --- |
| 配置同步 | 远程仓库 | 空 | git 能识别的任意地址（GitHub、Gitee、自建服务器、本地或网络路径），使用本机 git 的登录方式；留空不同步。详见[模块：配置同步](#模块配置同步) |
| | 分支 | main | 远程仓库上使用的分支 |
| | 启动时自动拉取 | 开 | DSH 启动时拉取远程仓库：没有冲突就直接应用远端的改动（不推送本机的改动）；有冲突只提示 |
| | 不参与同步 | terminal-controller、review.auto、remote.phoneSettings | 每台机器各自保留的整个条目或条目内的设置；从本机和远端配置中勾选，不用手填 |

这些选项的存储键与旧版相同（仍在 `agent-hub` 条目的 `config.sync` 下），从 Agent Hub 页移过来不需要迁移。手机上只显示提示，配置同步只能在电脑上设置。

**插件更新**：

1. 点击 **检查更新**，从当前 profile 的 Registry 读取已安装插件的最新版本，不会自动安装。
2. 勾选要升级的插件（支持全选），查看当前版本与目标版本，再确认。
3. **普通模式**：经 DSH 原生安装器逐项串行安装，实时显示进度、安装输出及失败原因，失败项可以重试；保留配置和原来的启用状态，不自动批准构建脚本。Agent Hub 自己排在最后，队列不会被中途替换。安装完成后重启 DSH 生效。
4. **HMR 热重载模式**：DSH 拒绝原位替换已安装的插件，按钮变为 **重启时升级所选**。所选的确切版本写入待重启列表（`$DSH_HOME/dsh-agent-hub/pending-upgrades.json`），可以继续排队，也可以逐项取消。重启时，DSH 完全退出后由重启辅助进程在 profile 目录运行一次 `pnpm add <name>@<version> --save-exact`；失败就还原 `package.json` 和锁文件。DSH 重新打开后右下角提示结果，此页保留 pnpm 输出，点"知道了"清除。

内置、只读、本地链接和 Git 来源的插件不参与升级，列表会说明跳过原因。配置同步要升级的插件也走同一个待重启列表。

## 模块：连接器

把外部服务（Linear、Notion、Sentry、GitHub……）以远程 MCP 服务器的形式**在这里连接一次**，DSH 里的所有模型都能用它们的工具：DeepSeek、Codex、MiniMax 等 DSH 模型直接使用，Claude Agent 通过桥接使用。入口是 **设置 → Agent Hub → 连接器**。

- **添加**：点预设（Linear、Notion、Sentry、GitHub），或"其他 MCP 服务器"填一个 Streamable HTTP 地址。添加后立即开始连接，每张卡片只给出下一步：
  - 支持浏览器登录的服务（按 MCP 规范的 OAuth：RFC 9728 资源元数据 → RFC 8414 授权服务器 → RFC 7591 动态注册 → PKCE）会打开授权页，完成后卡片自动变为"已连接 · N 个工具"。回调落在只为这次登录临时打开的 `127.0.0.1` 端口（RFC 8252），所以桌面版和浏览器里都能用。弹窗被拦截时点"重新打开授权页"。
  - 不支持浏览器登录的服务（如 GitHub）直接要求填访问令牌；支持的服务也可以点"使用令牌"改用 API key（Linear 的个人 API key 即可）。令牌先实际连接验证，被拒绝时不会保存。
  - 授权失效时显示"登录已失效"，一键重新连接。OAuth 令牌在过期前自动刷新。
- **断开 / 移除**：删除凭据并撤下该服务的所有工具。
- **凭据**：OAuth 令牌和 API key 存在 DSH 的凭据库（`$DSH_HOME/.credentials.yaml` 中的 `dsh-agent-hub/connector-<id>`），不写入 `cordis.patch.yml`，也不发给浏览器。配置文件里只有 id 和地址。凭据与具体 MCP 地址绑定，改地址后需要重新连接；旧版 API key / 无认证记录会在首次读取时绑定当前地址，旧 OAuth 会校验资源标识后迁移。旧记录不含历史地址，升级前若已改过地址，应先断开再重新连接。
- **工具名**：连接器 `<id>` 的工具在所有模型里都叫 `mcp__<id>__<tool>`（例如 `mcp__linear__list_issues`）。每次调用都经过 DSH 的工具策略和审批。
- **Claude Agent**：每个连接器在 Claude Code 里是一个同名的进程内 MCP 服务器，工具名与 DSH 侧一致，并放在 Claude Code 的工具搜索后面按需加载。Claude Agent 会话**只使用这里的连接器**：插件以 `--strict-mcp-config` 启动 Claude Code，并关闭 claude.ai 连接器，Claude Code 自己配置的 MCP 服务器（`~/.claude`、插件、claude.ai）都不会加载，所有模型通过同一套连接器访问外部服务。连接器有增减时，下一轮以新进程恢复会话。
- **Linear 与工作树**：连接 Linear 后，Git 面板的"新建工作树"对话框里，分支名输入框同时可以搜索 issue：打开时列出分配给我的未完成 issue，输入编号（`ENG-123`）或关键词即时过滤。选中后分支名填成 Linear 建议的分支名（如 `vi/eng-123-fix-login`），其余按原来的流程创建工作树；新会话的输入框预填 issue 编号、标题和链接，确认后发送，agent 可以用 `mcp__linear__get_issue` 读取最新内容。工作树和 ticket 的关联**只靠分支名**（Linear 自己的约定），不另外存储：分支名里含有工作区团队前缀的编号时，工作树列表在该行显示 issue 编号和状态，点击在 Linear 中打开。
- **Linear 账户与仓库**：Linear 连接器卡片上有"关联仓库"，勾选这个账户用于哪些本地仓库（按主目录识别，同一仓库的所有工作树都算）。在某个仓库里新建工作树、查看工作树的 ticket 时，使用关联到该仓库的账户；没有关联的账户用于其余所有仓库。可以同时连接多个 Linear 账户（按地址识别，id 不限于 `linear`）。

## 模块：看板

左侧边栏"自动化任务"下方的 **看板**，在中间区域打开。它参考 `@linxin666/dsh-client-ui-task-board` 的看板做了轻量实现：只有列、卡片、详情和本地任务，不包含定时执行、子任务和权限确认。看板把任务卡片放在同一组列里（待规划 / 待办 / 进行中 / 已完成 / 已取消），并可在最左侧显示告警与审核：

- **Sentry 告警**：配置 Sentry Issues 地址和本机仓库后，最左侧显示 unresolved `prod` issues；可切换 `7d` / `14d`，按 Last Seen / Age / Events 升降序排列。卡片显示标题、错误预览、可能的 `path:line`、时间和事件量；读取失败（未连接 Sentry、权限等）时原因直接显示在告警列里；详情按分析结论、源码位置、异常链、事件证据展开，源码位置会打开 issue 工作树中的代码。
  - 开始分析时选择 bot（本设备记住最近一次选择，不提供 Seer）。点击后卡片立即进入“准备中”（同时最多 2 个分析，其余排队），未能开始时原因显示在卡片上并可重试；随后 fetch 并从最新 `origin/<默认分支>` 创建或复用包含规范化 issue ID 的分支与工作树。Sentry 证据限制在约 60 KB，记录写入 `<repo>/.reviews/sentry-<ID>.md`；分析阶段只能写记录。
  - 点“修复”会在同一工作树、同一 bot 和同一会话上下文中继续，允许修改代码并要求一个包含 `Fixes <ID>` 的提交，随后恢复只读。Last Seen 晚于分析/修复时记录的时间（已扣除列表“3 hours ago”这类取整误差）时，卡片标为“有新事件”，可再次修复。
  - “解决”由界面明确调用 Sentry，提供 10 秒撤销；模型不得写 Sentry。撤销期结束后，只清理插件自己创建、仍干净且相对 base 没有新提交的工作树和分支，其他情况一律保留。
- **Linear ticket**：来自所有已连接的 Linear 账户，默认"我的"，可切换"全部成员"；已完成和已取消的只保留最近 14 天。状态保存在 Linear。把卡片拖到另一列时，会移到该团队里这一类状态中的普通工作状态，例如拖到"进行中"会选 In Progress 而不是 In Review；在详情里可以选择具体状态。
- **本地任务**：给 Linear 之外的工作用，只保存在本机的 `$DSH_HOME/dsh-agent-hub/board.json`。点列头的 ＋ 或"新建任务"直接在列里输入，可以拖动、改标题、写说明、换仓库、删除。
- **待我审**：在 设置 → Agent Hub → 审核 勾选了仓库时，在告警列之后（未配置告警时为最左侧）显示这一列，列头可切换 待我审 | 我的 | 全部：等我 review 的 PR（点开是审阅单）、我自己提的 PR（点开是回应单）、所有开放的 PR；这一列的卡片不能拖动。详见[模块：审核](#模块审核)。
- **PR 与 ticket 配对**：PR 的分支名里带有看板上某张 Linear ticket 的编号时，PR 卡片上显示这张 ticket 的芯片（Linear 标志、编号和表示其状态的小圆点），点击打开 ticket 并把它的卡片滚到可见处；鼠标悬停或键盘聚焦任一张卡，另一张在别的列里同时描边。不经过 Linear、不额外请求。
- **按仓库筛选**：顶栏选择仓库后，只显示该仓库的本地任务，以及关联到该仓库（或未关联任何仓库）的账户的 ticket。
- **开始**：卡片右下角的"开始"（鼠标悬停或键盘聚焦时出现，触屏上常显），详情里也有同样的按钮。仓库自动确定：本地任务用自己的仓库；顶栏选了仓库就用它；账户只关联一个仓库就用那个；有多个可选时弹出菜单（窄屏为底部弹出）。随后：
  - **工作树**：先找已有的——分支名相同，或分支名里带着这个 ticket 编号（没登记为工作区的顺便登记）；没有才用 Linear 推荐的分支名（建工作树前重新读取一次 ticket；本地任务为 `task/<标题>`）新建。新建的工作树会开一个会话，输入框预填 ticket 内容；已有的只跳转过去，不新开会话。
  - **同步 ticket**：还没开始的移到该团队的"进行中"状态；Linear 明确说**没有负责人**时分配给自己，有人负责或读不出负责人时不动。两项改动合并成一次保存。
  - **可靠性**：同一张卡在同一仓库里同时开始多次（连点、多个窗口、看板和 Git 面板同时）只执行一次，后来的直接拿到同一结果；Linear 连不上时仍用看板上已有的分支名建好工作树，并提示 ticket 未更新；工作树建好但 ticket 更新失败时只显示警告，不会假装已移到"进行中"。
  - Git 面板"新建工作树"里选中 ticket（且没改分支名）时走的是同一套流程，也会同步状态。
- **卡片上的工作树**：哪张卡已有工作树，由浏览器根据已登记的工作区按分支名推导，不经过 Linear、不额外存映射。从侧边栏、Git 面板或任何地方建好、删掉工作树，卡片在约 300ms 内更新；卡片上显示分支名，点击直接进入那个工作区（不新开会话）。
- 移动会立即显示在界面上，如果 Linear 拒绝就撤回并提示。页面可见时每分钟刷新一次，窗口重新获得焦点时也会刷新。
- **布局**：宽屏时各列并排，详情从右侧滑出；Sentry 告警、已完成、已取消三列可独立折叠（旧版已取消列偏好会自动迁移）。页面宽度小于 640px（手机或窄窗口）时一次显示一列：顶部是带数量的状态标签，可左右滑动切换，详情改为底部弹出。

实现上，每个已连接的服务是 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 插件的一个实例，由本插件以子插件挂载（带上 `Authorization: Bearer` 头），所以工具命名、结果投影、MCP 资源与服务器说明、断线重连都沿用 DSH 的实现；令牌刷新时重新挂载该实例。

## 模块：订阅用量

在一处查看 Claude、Codex（多账号）、Cursor、Qoder 和 MiniMax 订阅套餐的剩余额度与重置时间。

- **设置 → 订阅用量**：每个账号一张卡片。按窗口（5 小时 / 本周 …）显示**剩余**百分比和重置倒计时；进度条上的刻度表示"按时间均匀消耗，此刻应剩多少"。MiniMax 额外显示已用次数和套餐到期日。Cursor 显示本账期包含额度的剩余（Auto、API 两个池子折叠在"其他额度"里）和按需消费（"按需 $219.48 · 不封顶"，有上限时为"按需 $12.30 / $50.00"，接近或超过上限时变色）。Qoder 按 Credits 池子（套餐、加油包、团队、专属资源包）各显示一行剩余百分比和"已用 84 / 1,800 Credits"。
- **侧栏速览卡**（"设置"上方）：每个账号一格，显示名称、它最紧张的那个窗口的剩余百分比和一条细进度条（Qoder 的各池子依次消耗，速览格显示全部 Credits 的剩余比例，浮层里每个池子一行，末列是剩余 Credits 数）。详情浮层在侧栏右侧弹出，各账号的窗口、剩余量和重置倒计时按列对齐：鼠标悬停时打开、移开后自动隐藏；点击则固定显示，需点 ×、按 Esc 或再次点击速览卡关闭。浮层底部的"查看详情"打开详情页。
- **浮层快捷切换账号**：浮层里 Claude 账号下方还有 Codex 账号列表（装有 dsh-codex-subscription 且登录了两个以上账号时显示），点"切换"即通过 Codex 插件自己的接口切换当前账号，下一次 Codex 请求生效，用量随即刷新。切换过程不会改动 Codex 的凭据。
- **Codex 插件缺失时**：没装或没启用 `dsh-codex-subscription` 时，Codex 卡片显示提示，一键 **安装** 或 **启用**（按提示重启 DSH 后，在 设置 → Codex 订阅 中登录）。在 **功能模块** 卡片里关闭 Codex 后，不再显示 Codex 卡片。

本地 Token 统计按 Bot 实际使用的提供方与模型归集；Claude 的累计值按账号和会话区分基线。升级会重扫仍存在的会话日志，保留已删除会话的历史汇总；已删除日志无法重新还原其旧版 Bot 归属。

### 数据来源

| 订阅 | 方式 | 说明 |
| --- | --- | --- |
| Claude | `claude -p /usage --output-format json --no-session-persistence` | CLI 内置的本地命令，不消耗 token；OAuth 刷新由 CLI 自己负责。套餐和邮箱来自 `claude auth status` |
| Codex | 只读 [dsh-codex-subscription](https://github.com/WSL043/dsh-codex-subscription) 的账号库，逐个账号调用 `wham/usage` | **从不刷新、也不写入凭据**（refresh token 会轮换，代刷会把 Codex 插件挤掉登录）。非当前账号的 token 过期后显示最后一次的快照，并提示"切换到该账号使用一次即可更新" |
| Cursor | Cursor 的 `DashboardService`：`GetCurrentPeriodUsage`、`GetPlanInfo`、`GetHardLimit`（与 CLI 的 `/usage` 相同的调用和算法） | 用 Cursor CLI 自己的登录 token（macOS 上在钥匙串的 `cursor-access-token`，其它平台在 `auth.json`）**只读**调用，从不刷新、也不写入；token 被拒或未登录时提示运行 `agent login`。没装 CLI 也没登录时不显示卡片。这些接口未公开，Cursor 改版可能失效 |
| Qoder | Qoder CLI CN 自己记录的读数：交互式 `qodercn` 每次启动（以及 `/usage`）都会请求 `/api/v2/quota/usage`，并把完整响应写进 `~/.qoder-cn/logs/runs/*/qodercli.log` | Qoder 的登录凭据和请求签名都在 CLI 内部加密，插件不代为请求，只**增量读取**交互式运行的日志（`--acp`、`-p`、远程控制守护进程和子命令不会读额度，直接跳过），取最新一条，按日志时间标注数据时间（超过 10 分钟显示"x 小时前的数据"）。装了 CLI 但还没有读数时，提示在终端打开一次 `qodercn` |
| MiniMax | `GET /v1/api/openplatform/coding_plan/remains` | key 依次取自 pi-ai 凭据记录（`minimax-cn` / `minimax`）和 `MINIMAX_CN_API_KEY` / `MINIMAX_API_KEY`，只在宿主侧使用，不会进入浏览器 |

宿主不跑后台定时器：浏览器每 60 秒拉取一次（仅在页面可见时），各数据源带 TTL 缓存（Claude 5 分钟，Cursor 2 分钟，Qoder 30 秒，其余 60 秒）。Claude 每次读取都要冷启动一次 CLI（数秒 CPU、几百 MB 内存），所以空闲时读得少；Claude Agent 每跑完一轮，下一次拉取就会在后台重读（距上次超过 60 秒时）。套餐和邮箱（`claude auth status`）缓存 30 分钟；`/usage` 带 `--strict-mcp-config`，不会为此拉起你配置的 MCP 服务器。缓存过期时先返回旧值、后台刷新，只有点"刷新"才会等待最新结果。读取失败时用持久化在 `$DSH_HOME/dsh-agent-hub/usage.json` 的上一次成功结果兜底，并标注数据时间。

## 模块：Claude Agent

在 DSH 现有的模型选择（composer 模型位与 `/model` 弹窗）里出现 **Claude Agent** 分组，选中其中的模型后，这个会话的每一轮都交给一个常驻的 Claude Code 会话执行，用的是 Claude Code 订阅额度。

- **怎么跑**：通过官方 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 驱动本机已安装、已登录的 `claude` CLI。Claude Code 用它自己的工具、skills、`~/.claude` 设置和权限规则完成这一轮；回复以文本和思考流式回到 DSH，内部的每个工具调用显示为一行推理备注（`→ Bash: ls`，失败为 `✗ …`）。
- **多账号**：设置 → Agent Hub → Claude 账号可添加账号并复制专用登录命令；在终端执行该命令，随后在 Claude 内用 `/login` 完成官方浏览器登录。侧栏用量浮层直接选择账号，下一轮生效，不中断正在运行的轮次。新增账号使用官方 `CLAUDE_CONFIG_DIR` 隔离登录与设置，默认账号保留原来的 CLI 目录；切换账号时绝不跨账号恢复 Claude session，而是把 DSH 对话作为新账号的上下文。移除只取消登记，不删除 Claude 自己的文件。每个账号的用量分别缓存，切换时不会重复冷启动；需要刷新时最多同时冷启动两个 CLI。
- **审批**：Claude Code 需要询问的工具调用，会弹出 DSH 原生的审批对话框；DSH 会话审批策略为 `never` 时直接拒绝。
- **会话延续**：每条回复在 `replayState` 里记下 Claude Code 的 session id，下一轮只发送它还没见过的内容（中途换过别的模型，其间的对话会作为上下文一并带上）；宿主重启后从 Claude Code 自己的记录恢复。推理强度或桥接的工具（连接器、团队工具）变化会以新进程恢复会话，模型变化则就地切换。
- **`/` 调用 DSH skill**：输入框里用 `/name` 调用的 DSH skill（含 `.cursor` 里的命令），其说明随这一轮的提示词一起发给 Claude Code，放在你的原话之前，以免 `/name` 被 Claude Code 当成它自己的命令；回复开头显示一行备注 `⚡ Skill /name`。与 Claude Code 自带命令重名时以 DSH 的 skill 为准，没有对应 DSH skill 的 `/命令` 照常交给 Claude Code。
- **后台请求**：Claude Agent 只回答会话本身。DSH 对 Claude Agent 会话发出的其他请求，例如对话太长时的上下文压缩、生成会话标题，交给 **设置 → Agent Hub → Claude Agent → 后台请求模型** 回答，不会再因为 `UNSUPPORTED_REQUEST` 让整轮失败。选"自动"时用新建 agent 的默认模型；默认模型是 Claude Agent 或 Bot（Bot 可能也运行在 Claude Agent 上）时，用第一个可用的其他模型。Claude Agent 自己的上下文仍由 Claude Code 管理，这些请求只影响 DSH 保存的对话记录和标题。
- **MCP**：只使用 DSH 提供的 MCP（[连接器](#模块连接器)和团队工具），不加载 Claude Code 自己配置的 MCP 服务器。
- **Remote Control**（可在设置 → Agent Hub 中关闭）：每个会话的 Claude Code 进程启动时开启 Remote Control（与官方 VS Code 扩展同一调用），第一轮回复开头给出 claude.ai/code 链接，之后可在 Claude App 或 claude.ai 上查看进度、继续推进。
  - **手机发起的轮次会同步回 DSH**：插件按该轮的 user message uuid 从 Claude Code 的 transcript 读出提示词，以插件来源的 follow-up 投递到 DSH 会话；由此开始的 DSH 轮次直接接上 Claude Code 正在执行的这一轮，**不会重新发送提示词**。所以手机这一轮的提问和流式回复会原样出现在 DSH 里，之后换别的模型时也能作为上下文。读不到提示词时（例如 slash 命令、没有用户消息的内部轮次），就退回到在 DSH 下一轮注明"有 N 轮在远端运行"。**非默认账号**的 transcript 存在独立目录，SDK 的 `getSessionMessages` 暂不提供每次调用指定配置目录的参数；为避免读错账号，不同步这类 Remote Control 提问的内容，只在下一轮提示远端轮次数。
  - **审批**：DSH 正在跟随的轮次，审批会同时出现在 DSH 对话框和手机上，哪边先回答都有效；还没被 DSH 跟随的手机轮次，在手机上审批。
  - **在线时长**：进程空闲一段时间（默认 2 小时）后关闭，下一轮再从 transcript 恢复。最近活跃的若干个（默认 3）会话不受这条限制，一直在线，方便从手机继续。宿主重启后要在 DSH 里再发一轮，会话才会重新上线。
- **模型目录**：来自 Claude Code 的 `supportedModels()`（只做初始化，不产生模型调用，探测进程不启动 MCP 服务器），连同各模型的 effort 档位。目录持久化在 `$DSH_HOME/dsh-agent-hub/claude-models.json`，过期后先用旧目录、后台刷新（有在线会话时直接问它），所以一轮对话不会因为读目录而等待。

**登录失效提示**：Claude Agent 的某一轮如果因为本机 Claude Code 未登录或登录过期而失败，聊天里会写明原因和修复命令（不再显示笼统的"API 密钥无效"），同时弹出重新登录的对话框，列出步骤：在侧栏打开终端，运行 `claude`，输入 `/login` 并在浏览器完成登录，然后点"重新检测"。重新检测会实际调用一次 CLI 的本地命令确认登录有效（不消耗 token），通过后重新发送即可。这类失败使用独立的错误码 `CLAUDE_AUTH`，不会被自动重试。

配置（Remote Control、常驻在线数、空闲关闭时间）见 [设置 → Agent Hub](#配置设置--agent-hub)。

### 合规边界

- 插件**从不读取、保存或转发任何 Claude 凭据**，也不实现登录；认证与 token 刷新完全由官方 CLI 负责。
- 启动 CLI 时移除 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`CLAUDE_CODE_OAUTH_TOKEN`，保证请求始终走 CLI 自己的 claude.ai 登录（这也是 Remote Control 的前提）。
- 不替换 Claude Code 的系统提示词，不改请求头，不把它当成裸 API 代理：只有用户在会话里发起的轮次才会到达 Claude Code，会话标题、压缩摘要等辅助请求一律拒绝，由 DSH 自行兜底。
- 仅供个人在自己的机器上使用。Anthropic 规定第三方产品未经批准不得向他人提供 claude.ai 登录或订阅额度，**请勿将此功能分发给他人使用**。
- 显示名为 "Claude Agent"（按品牌规范不使用 "Claude Code"）。

## 模块：Cursor

在 DSH 的模型选择（composer 模型位与 `/model` 弹窗）里出现 **Cursor** 分组，选中其中的模型后，这个会话的每一轮都交给本机 Cursor CLI 的 agent 执行，用的是 Cursor 账号自己的额度。需要先安装 [Cursor CLI](https://cursor.com/cli) 并运行 `agent login`。

- **怎么跑**：插件启动一个常驻的 `agent acp` 进程（Cursor CLI 的 [Agent Client Protocol](https://cursor.com/docs/cli/acp) 服务端），DSH 的每个会话对应其中一个 ACP 会话。Cursor 用它自己的工具、rules、MCP 服务器和登录完成这一轮；回复以文本和思考流式回到 DSH，内部的每个工具调用显示为一行推理备注（`→ Shell: npm test`，失败为 `✗ Shell: npm test: exit 1, …`），计划清单也显示为一条备注。进程 30 分钟没有对话就关闭，下一轮再加载会话。Windows 上直接运行 CLI 最新版本目录里自带的 node，不经过 `agent.cmd` 的 PowerShell 包装。
- **模型与推理强度**：模型列表和每个模型的推理选项来自 CLI（参数化模型选择）。Cursor 各模型的推理选项名称不一（`effort`、`reasoning`、`reasoning_effort`，有的还带 `thinking` 开关），统一折成 DSH 推理强度选择器里的一列：`Off`（关掉思考，或选 `none`）加上该模型自己的档位；只有开关的模型显示 `Off / On`。所以"设置 → Agent Hub → 模型选择"里的默认思考等级对 Cursor 同样生效。速度（Fast）、上下文长度（1M）和 Auto 的 `optimize_for` 保持 CLI 默认，不在 DSH 里调。模型或档位变化时在当前会话里就地切换，不重启进程。
- **不改你的 Cursor 设置**：CLI 会把在 ACP 里选的模型参数存成它自己的默认值（`~/.cursor/cli-config.json`）。插件每次设置后把这个文件原样写回，会话里的选择照样生效，你在终端里用 `agent` 时的默认模型和档位不受 DSH 影响。
- **模型目录**：第一次读取时在临时目录开一个探测会话（不发送提示词，不产生费用），列出模型后立即可用，各模型的推理选项在后台逐个读出（每个约 1.5 秒）；正被选中的模型优先读。目录持久化在 `$DSH_HOME/dsh-agent-hub/cursor-models.json`，12 小时后后台刷新；探测会话用完即从 Cursor 的会话记录里删除。
- **审批**：Cursor 需要询问的工具调用（不在它的允许列表里的命令、写文件等）弹出 DSH 原生的审批对话框，每次只给"允许这一次"，不会替你点"总是允许"。DSH 会话审批策略为 `never`、或没有审批通道（如 headless）时直接拒绝。全局"禁止的命令"同样生效：被禁的命令不弹框直接拒绝。
- **会话延续**：每条回复在 `replayState` 里记下 ACP 会话 id，下一轮（包括宿主重启后）用 `session/load` 接上，只发送 Cursor 还没见过的内容；中途换过别的模型，其间的对话作为上下文一并带上。加载不到时（会话已被删除）新开一个，把整段对话作为上下文。Cursor 不读 DSH 的系统提示词，所以全局指令（和 Bot 的人设）写在首条消息开头，内容变化后的下一轮再发一次。
- **`/` 调用 DSH skill**：与 Claude Agent 相同，被调用 skill 的说明放在提示词开头发给 Cursor，回复开头显示 `⚡ Skill /name`。
- **消耗**：每一轮结束后，插件按这个 ACP 会话的 id 读取 Cursor 记录的用量事件（通常 1–2 秒后可读，最多等 6 秒），回复末尾附一条备注：`Cursor usage: 7.81K in · 38 out · 7.26K cache read · $0.028 (composer-2.5-fast)`，括号里是实际计费的模型变体。没赶上的事件由下一轮补上，不重不漏。每个会话的累计 token 写在 `replayState` 里，由本地 Token 统计按差值计入（与 Claude Agent 相同）；本账期的额度和按需消费见[订阅用量](#模块订阅用量)。DSH 自带的用量统计只计输出 token：DSH 把 usage 的输入部分当作上下文占用，而 Cursor 自己管理上下文。
- **登录失效**：CLI 未登录时这一轮失败并写明"在终端运行 `agent login`"，错误码 `CURSOR_AUTH`，不会被自动重试。
- **Bot**：Bot 的模型可以选 Cursor 的模型，人设随全局指令一起写进首条消息。作为团队成员时它还不能使用 DSH 的团队工具（`send_message` 等），回报需要由 Lead 读取它的会话。
- **`/` 命令**：本地 `.cursor` 文件夹里的命令和 skill 作为 DSH skill 注册，任何模型的会话里输入 `/` 都能选到，不需要选 Cursor 模型。扫描会话目录所在项目（最近的 `.git` 上级目录）和用户目录的 `.cursor/commands/*.md` 与 `.cursor/skills/<name>/SKILL.md`（也认 `skills/<name>.md`）。名称取 frontmatter 的 `name`，没有或不合法时取文件（skill 取文件夹）名转成小写短横线形式（`Fix_Lint.md` → `/fix-lint`）；描述取 frontmatter 的 `description`，没有时取正文第一行。命令只供手动调用，不进模型的 skill 目录；skill 遵守 `disable-model-invocation` 与 `user-invocable`。与 DSH 自己的 skill 重名时 DSH 的优先（项目 `.dsh`、`.agents` 之后，用户 `~/.dsh`、`~/.agents` 之后）。Cursor 自带的 `~/.cursor/skills-cursor` 操作的是 Cursor 编辑器，不注册。文件夹受监视，新增、改名、删除或修改 frontmatter 后下一次 `/` 菜单即更新，不用重启。

> **已知问题（Cursor CLI 2026.10.01，Windows）**：Cursor CLI 会加载 Claude Code 的 hooks（`~/.claude/settings.json`）。它把 hook 命令包成 PowerShell 语法却交给 Git Bash 执行，结果语法错误，每个 shell 工具调用都被拦下（回复里会说 "Hook blocked … syntax error near unexpected token `&'"）。这与 DSH 无关，在终端里直接用 `agent` 也一样。CLI 内部有关闭第三方配置加载的开关（`thirdPartyExtensibility`），但还没确认它对用户暴露的设置项；在 Cursor 修复之前，配置了 Claude Code hooks 的 Windows 机器上 Cursor 执行不了 shell 命令，读写文件不受影响。

## 模块：Cardputer
 
先在 设置 → Agent Hub 顶部的 **功能模块** 卡片里打开 **Cardputer**（默认关闭，只在本机生效，不随配置同步；关闭后端口和听写进程都会停止）。设置 → Agent Hub → Cardputer 可添加、核对数字配对、重命名和移除设备。已配对设备经一条 TLS-PSK WebSocket 查看会话、发送消息、停止/继续任务、处理审批，以及上传 PCM 语音识别。无设备也不在配对时不开端口；无在线设备时不运行心跳检查定时器。密钥仅保存在本机，不随配置同步。
 
- 状态更新合并到 250ms，审批立即推送；重复快照不重发。连接、消息、音频、命令、文件名缓存都有上限；断线取消语音识别，插件卸载清理审批和听写进程。
- 听写用独立 Rust `dsh-type`，按需启动，空闲五分钟退出。自动/逐字均使用 Unicode 事件，不碰剪贴板；**粘贴暂不支持**，旧设置需改为自动。输入失败不自动重试，以免重复输入。
- 在目标系统运行 `node scripts/build-native.mjs` 构建当前平台 helper，产物会随插件打包。macOS Intel/ARM64 源码已通过 Rust 类型检查，但尚未完成 macOS 原生链接、签名、权限与输入法实机验证；Windows 的测试也未向真实应用注入文字。
- **当前仓库只有宿主实现和 Node 模拟器，没有可烧录固件。** ESP32 的 PSK/WebSocket、屏幕交互、麦克风和硬件长按防误触仍需固件实现与联调。高风险检测是保守启发式，不是通用命令安全解析器；设备不得替代电脑上的安全策略。
 
[协议、构建与验证边界](docs/device-protocol.md) · [交互式模拟器](scripts/device-sim.ts)

## 模块：剪贴板与翻译

在 设置 → Agent Hub 顶部的 **功能模块** 卡片里打开 **剪贴板浮窗**（默认关闭，仅桌面端，只在本机生效、不随配置同步；手机上不显示也不可改），快捷键等选项在 设置 → Agent Hub → 剪贴板与翻译。开启后，一个全局快捷键（默认 `Ctrl+Alt+V`，可在设置里按下新组合录制）呼出悬浮窗，同一个窗口里两个模式，`Tab` 切换：

- **剪贴板**：记录文字复制历史，保存在本机的 SQLite（`~/.dsh/dsh-agent-hub/clipboard.db`，历史不随设置同步，只有置顶项随[配置同步](#模块配置同步)带到其他设备）。左栏「置顶」按置顶先后排列、编号固定，`Ctrl/⌘ 1–9` 直接输入对应的置顶项；右栏「最近」按时间排列；下方固定高度的预览区显示选中项全文和来源。顶部搜索同时过滤两栏，有置顶项匹配时选中落在「置顶」第一项，否则落在「最近」，清空搜索回到「最近」；`↑↓` 选择，`← →` 切换栏（搜索框里有文字时只在光标位于两端才切换），`Enter` 输入到打开窗口前的那个应用，`Ctrl/⌘ C` 复制并关闭，`Ctrl/⌘ P` 置顶 / 取消，`Del` 删除（6 秒内可撤销，不弹确认框）。窗口开着时新复制的内容实时出现在「最近」顶部并闪一下；还没动过选择时它直接成为选中项。窄窗口（< 600 px）两栏改为上下排列。
- **编辑**：预览框本身就是编辑框——直接点击预览里的文字（光标落在点击处），或按 `Ctrl/⌘ E`、点行上或预览栏的铅笔按钮，预览框向上展开盖住列表、变成可编辑状态，保存后收回；`Ctrl/⌘ Enter`（或 `Ctrl/⌘ S`）保存，`Esc` 取消（放弃的修改可在提示里撤销）。保存后原地更新，位置、来源、置顶状态和编号都不变；置顶项改了内容，其他设备下次配置同步时跟着更新。改成与另一条已有记录相同的文字时两条合并为一条（保留置顶）。超过 8000 字被截断预览的长文本会先读取全文再允许编辑；窗口中途失去焦点关闭时，未保存的内容会保留，下次打开可以「继续编辑」。图片不能编辑。
- **图片**：复制的图片（截图、浏览器里「复制图片」等）也进「最近」，显示缩略图、尺寸、来源和剩余时间。图片是临时的：**5 小时内没再复制或使用就自动清除**，最多留 100 张，不能置顶，不随配置同步，所以不占同步仓库、也不会让数据库无限变大。`Enter` 把图片放回剪贴板并向目标应用发送一次 `⌘V / Ctrl+V`（图片无法“输入”，这是窗口里唯一会模拟粘贴的地方，听写仍不碰剪贴板）；`Ctrl/⌘ C` 只复制；`Space` 或点击预览图看大图，`Space`/`Esc` 收起；搜索「图片」或尺寸可筛出图片。同时有文字和图片的复制（如表格单元格）按文字记；Finder 里复制文件时附带的图标不记。统一存为 PNG（Windows 上没有 PNG 格式时由 DIB 转换），放回剪贴板时 Windows 同时提供 PNG 与 DIB；单张超过 16 MB 不记。
- **翻译**：中 / English / Français，「自动」把中文译成英文、其他语言译成中文。用所选 bot 的模型翻译并带上它的人设（不选则用辅助模型，无人设）；上次选的语言和 bot 会记住。`Enter` 先翻译，译文是最新结果时再按 `Enter` 输入到目标应用；`Ctrl/⌘ Enter` 翻译后直接输入。输入失败（目标窗口没了、被管理员权限的程序挡住、修饰键没松开、超过 4000 字）时译文改为复制到剪贴板并提示，绝不会输入到别的窗口。翻译中途关闭窗口、再次翻译都会取消上一次，已取消的结果不会触发输入；最近 50 条译文缓存在内存里。

实现与资源占用：

- 窗口、快捷键、剪贴板监听和历史都在原生助手 `dsh-type --palette` 里（与 Cardputer 听写共用同一个二进制，两个运行模式、两个进程，输入通过一把跨进程锁互斥，忙时直接拒绝）。Host 只负责拉起、重启（1 s 起指数退避，10 分钟内连续崩溃 5 次则停止并在设置里显示原因）、下发设置和翻译，打开窗口、搜索、置顶、输入都不经过 Host。
- 剪贴板监听：Windows 用 `AddClipboardFormatListener`，系统通知才醒来，空闲时 CPU 为 0，80 ms 合并一次复制的多次通知。手机互联、远程桌面这类同步工具常用延迟渲染（先宣告格式，被读取时才从网络取数据），一时读不到或剪贴板被占用时按 120 ms、300 ms、0.7 s、1.5 s、3 s 重试，确定无须记录（非文字、敏感、被忽略）才算处理完；每次呼出窗口还会按剪贴板序列号再核对一次，漏掉的复制随窗口打开补上。macOS 没有变化通知，只读 `changeCount`（一个整数），刚复制过 250 ms，之后放宽到 1 s、2 s。系统标记为敏感的内容（Windows 的 `ExcludeClipboardContentFromMonitorProcessing`、`CanIncludeInClipboardHistory=0`；macOS 的 `ConcealedType`、`TransientType`）在读内容之前就跳过；也可按程序名忽略。文字单条超过 64 KB 不记；重复内容（图片按字节比较）只顶到最前。
- 窗口尺寸按屏幕的逻辑像素取：宽为屏幕的 50%（640–860），高为 56%（420–600），同一块屏幕上始终一致；换到另一块缩放比例不同的屏幕时先移过去再定尺寸，并接管系统的 DPI 缩放回调，不再出现窗口忽大忽小。行高、预览区、页眉页脚都是固定高度，选择和数据变化不会引起布局跳动。
- 助手向页面只发增量：数据库记着最近 128 次变更涉及的行，页面落后几步时只收到这些行（以及被删掉的 id），清理旧记录或落后太多才发整个列表。列表虚拟化并复用行节点，只更新内容有变化的行。
- 界面是一个约 25 KB 的单文件页面（无框架），首次使用时才创建，用后隐藏并让 WebView2 挂起（Windows），闲置 30 分钟释放，之后只剩原生小进程。在本机 Windows 上实测：只有快捷键和监听时助手约 2 MB 私有内存；页面隐藏挂起后工作集合计约 60 MB（WebView2 进程提交内存仍有 130 MB 左右，由系统换出）。冷启动后第一次呼出会慢一些（创建 WebView）；功能开启 5 秒后 Host 会通知助手预热。
- 快捷键只在 DSH 运行时有效（Host 退出，助手随之退出）。新组合注册成功后才释放旧组合；被其他程序占用时设置里显示原因，原快捷键保持有效。法语键盘上 `Ctrl+Alt` 即 AltGr，请换其他组合。
- 粘贴只统计「经窗口使用」的记录（输入或复制），不监听系统范围内的 `Ctrl+V`。
- Windows 需要 WebView2 运行时（Win11 自带）；macOS 构建同 Cardputer 模块，需要辅助功能权限才能输入，较新的 macOS 在后台读取剪贴板时可能询问一次。macOS 部分已通过 Rust 类型检查，尚未实机验证。
- macOS 开发构建：`npm run build:native` 先在临时路径签名、验证，再原子替换助手，失败时保留旧版本。优先保持已安装助手的签名证书，不会静默换成其他证书或 ad-hoc；有意换证书时才设置 `DSH_SIGN_IDENTITY`，首次迁移可能需要重新授权。**构建不等于重启**：构建后在 **功能模块** 卡片里关闭再开启 **剪贴板浮窗**，以加载新版本。TCC 的授权对象取决于启动链路；由 DSH 启动时通常是 DeepSeek Harness.app，从终端启动时可能是终端，不是只看助手签名。已开启权限仍失败时先重载助手，必要时重启启动它的应用，不要直接重置所有授权。排查时可向助手标准输入发送 `{"id":1,"op":"perm"}`，返回 AX、PostEvent 两项独立状态、PID 和实际路径；无需发送键盘事件。

## 模块：Qoder 与眼镜

需要先安装 Qoder CLI CN（`irm https://qoder.com.cn/install.ps1 | iex`，macOS / Linux 用 `curl -fsSL https://qoder.com.cn/install | bash`），并运行 `qodercn` 后 `/login`。

- **模型路由**：模型选择里出现 **Qoder** 分组（Qwen、GLM、Kimi、DeepSeek、MiniMax 等，名称后是每次调用的 credit 倍率，如 `GLM-5.3 · 0.5×`）。选中后这一轮交给常驻的 `qoderclicn --acp` 进程，和 Cursor 走同一套通用 ACP 层（`src/acp/`）：工具审批弹 DSH 的对话框，回复流式显示，会话用 `session/load` 延续，30 分钟无对话关闭进程。模型列表来自一个不发提示词的探测会话，缓存在 `$DSH_HOME/dsh-agent-hub/qoder-models.json`，12 小时刷新。未登录时报 `QODER_AUTH`，不自动重试。
- **眼镜派任务**：设置里勾选的每个仓库，DSH 运行期间常驻一个 `qoderclicn remote-control --spawn same-dir` 守护进程。在眼镜上说“夸克同学，打开 Qoder”，再说“在我电脑上开个任务……”，任务就在本机这个仓库里直接执行，不自动新建 worktree；任务里明确要求“开个 worktree”时，agent 才用 Qoder 的 `EnterWorktree` 新建一个。每句新任务都是 Qoder 服务端新建的会话，守护进程无法把它并入旧会话；想接着上一个任务做，在面板、App 或网页里打开那个任务继续追问。
- **worktree 集中放置**：Qoder 默认把 worktree 建在 `<仓库>/.qoder/worktrees/`，CLI 没有参数能改。DSH 在每次启动守护进程前，往仓库的 `.qoder/settings.local.json` 写入 `WorktreeCreate` / `WorktreeRemove` 两个 hook（exec 形式，用宿主自带的运行时执行 `$DSH_HOME/dsh-agent-hub/qoder-worktree.cjs`，不经过 shell，Windows 和 macOS 相同；文件里你自己的其他设置和 hook 保持不动）。于是任务要求的 worktree 改建在 `<仓库>/.worktrees/qoder/<名称>`，分支为 `qoder/<名称>`，与 DSH 其他 worktree（源代码管理、看板、审核、告警修复都建在 `<仓库>/.worktrees/<分支>`）放在一起，在源代码管理的工作树列表里查看、打开和删除。在这个仓库里直接用 `qodercn --worktree` 也会走同一个位置。Qoder 删除 worktree 时调用删除 hook：没有改动的 worktree 连同分支一起删掉；有未提交改动的保留，供你查看 diff；有独立提交的分支也保留。`/.worktrees/` 和 `/.qoder/settings.local.json` 写进仓库自己的 `.git/info/exclude`（不改动被跟踪的 `.gitignore`），不会出现在 git status 和 diff 里。
- **跟进**：在左侧栏「接力」面板里（见[模块：接力](#模块接力)）。“眼镜工作区与云端”一项显示每个工作区是否在线、进程的内存与 CPU、空闲回收，可以启动或停止守护进程、立即回收、从网页新建任务；派来的任务和其他 Qoder、Hermes 对话一起列在面板的列表里，可以查看完整记录、在 DSH 里接管。守护进程异常退出时按 5 秒、15 秒、1 分钟、5 分钟递增间隔自动重启。
- **空闲 worker 与回收**：每个眼镜任务一个约 250 MB 的 worker 进程，回答完仍常驻等追问。worker 本身不存状态：没有 worker 的任务被追问时，服务端会重新派发，新 worker 几秒内从服务端恢复对话。所以守护进程每次启动（DSH 启动、异常重启、回收）之前，都先等上一轮的 worker 退出，再清空它的 workers 记录（`~/.qoder-cn/remote-control/…/workers/remote-control-workers.json`，只动格式版本 4、且没有别的守护进程占用的），启动后不恢复任何空闲 worker。空闲回收因此就是一次重启：所有任务都已回答、空闲满设定的分钟数时进行；有任务在执行、有转交或通知在等时推迟。workers 记录格式不认识或改不了时，本次运行不再回收，面板写明原因。
- **眼镜转交给 DSH 的模型**：守护进程启动时，DSH 把 `dsh` 命令放进它的 PATH（`$DSH_HOME/dsh-agent-hub/bin/`，用宿主自带的运行时执行 `dsh.cjs`），并在 `~/.qoder-cn/skills/dsh/` 写入一个 Qoder skill。对眼镜说"让 Claude 在 vimental 里修一下登录 bug"，Qoder 在后台运行 `dsh ask --agent claude --project vimental "…"`，先回一句"已交给 Claude"；DSH 新开一个会话（标题以"眼镜 ·"开头，侧栏里能看到、能接着聊），这一轮结束时 Qoder 被唤醒，把结论说给眼镜。`--agent` 可以是 claude、codex、cursor、qoder、hermes 或 `bot:<id>`，`--model` 写模型名的一部分（如 opus），`--project` 写 DSH 里的项目名或路径；都不写时用 DSH 的默认模型、在当前目录。名字有歧义时命令列出候选，Qoder 会反问。`dsh agents`、`dsh projects`、`dsh status [会话]`、`dsh wait <会话>` 查看可选项和进度。DSH 会话里的审批照常弹在电脑、手机或 Cardputer 上，同时推一条通知到眼镜。
- **通知眼镜**：DSH 要告诉眼镜的事（铃铛、转交会话在等审批、`dsh notify`）以一条"【DSH 通知】…"消息发进眼镜最近的 Qoder 会话：优先在线工作区里最近回答过、worker 还在的会话，其次是 worker 已回收的。做法和 Qoder App 追问一样（`qoderclicn --remote-session`，它只能在终端里运行，所以借用 DSH 自带的 node-pty，在子进程里用宿主运行时执行 `$DSH_HOME/dsh-agent-hub/qoder-post.cjs`），worker 回答后眼镜提示，不需要在眼镜上做任何准备。消息出现在该会话的转写里才算送达；那个会话的环境不在线时换下一个。暂时没有可用会话、或发送失败时，通知先保留（最多 20 条），等有会话回答或 1 分钟后再试，同一时间到的几条合成一条发。每条通知花这个会话的一轮额度。发送期间那个工作区暂停空闲回收。
- **完成后通知眼镜**：会话输入框右侧、定时发送旁边的铃铛。点亮后，这一轮结束（完成、失败或停止）时把带回答开头的一句话发给眼镜，只生效一次；中途在等审批也会发一条。眼镜那边暂时没有可用会话时铃铛带一个橙点，通知等到能送达时补发。任何脚本或 DSH 里的模型也能用 `dsh notify "…"` 发。`dsh` 只接受本机回环地址上带本次运行 token（`$DSH_HOME/dsh-agent-hub/bridge.json`，仅当前用户可读）的请求，网页无法调用。
- **已知限制（Qoder CLI CN 1.1.73）**：远端任务以 `auto` 权限模式运行，由服务端决定，写文件不会弹审批，改动直接落在这个仓库里（要求了 worktree 时落在那个 worktree）；并发的多个任务共用同一个目录；回答完的任务一直占名额，名额满时眼镜报“调度服务错误”；大任务偶尔在服务端失败（`Remote projection queue is unavailable`），面板标为失败。

## 模块：Hermes

需要先安装 Hermes（`iex (irm https://hermes-agent.nousresearch.com/install.ps1)`，macOS / Linux 用 `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`）。

- **一项一个 persona**：模型选择里的 **Hermes** 分组，每一项是一个 Hermes persona（`default` 是根目录本身，其余是 `profiles/` 下的各个 profile），名称后是它配置的模型，如 `qweno · gpt-5.6-terra`。列表直接读 persona 目录（`config.yaml` 与 `profile.yaml`），不需要探测会话，新建的 persona 立即出现。根目录在 Windows 上是 `%LOCALAPPDATA%\hermes`，其他系统是 `~/.hermes`，`HERMES_HOME` 可以覆盖。
- **运行**：选中某个 persona 后，这一轮交给 `hermes-acp`，进程的 `HERMES_HOME` 固定为该 persona 的目录（`default` 也会显式设置，所以 `hermes profile use` 设的常用 persona 不会把它切走），每个 persona 一个常驻进程。回答用这个 persona 自己的模型、记忆、SOUL 和技能；要换模型，运行 `hermes -p <persona> model`。危险命令和改文件都会弹 DSH 的审批框。走的是和 Qoder 同一套通用 ACP 层，会话用 `session/load` 延续，30 分钟无对话关闭进程。
- **冷启动**：Hermes 启动和新建会话合计约 20 秒。进程尚未运行的那一轮，回复里先出现一行 `⏳ Starting Hermes…`（Qoder 也一样）。
- **记忆是共享的**：DSH 里的对话会写进这个 persona 的记忆和 `state.db`，同一个 persona 的 Telegram bot 以后也会知道这些内容。不想混在一起的话，只勾选专门用来写代码的 persona。


## 模块：接力

左侧栏的「接力」面板：Qoder 和 Hermes 在 DSH 之外做的事都列在一处，可以查看完整记录，也可以在 DSH 里接着聊。默认关闭，在 设置 → Agent Hub 顶部的 **功能模块** 卡片里打开 **接力**（随配置同步）。

- **从哪里来**：Qoder 读 CLI 自己记录的会话文件（`~/.qoder-cn/projects/*/<会话>.jsonl`），所以眼镜、Qoder App、qoder.cn 派来的任务和终端里的 `qodercn` 会话都在，DSH 重启后也还在；眼镜任务再叠加守护进程的实时状态（正在调用的工具、worker 的内存与 CPU、服务端报的失败）。Hermes 只读打开每个 persona 的 `state.db`（Node 自带的 SQLite），列出 Telegram、终端、定时任务和 API 来的对话。DSH 自己经 ACP 发起的会话、Hermes 的一次性探测和子 agent 不列出（它们已经在 DSH 里，或者不算对话）。面板打开期间每 3 秒检查一次这些文件有没有变化，变化了才重读。
- **列表**：按今天、昨天、近 7 天、更早分组，可以按“全部 / Qoder / Hermes”筛选和搜索。每行是来源图标（眼镜 / 云端 / 终端 / Telegram / 定时任务……）、标题、哪个 agent（Qoder 带文件夹名，Hermes 带 persona）、回答开头或正在调用的工具；执行中、失败、已结束、云端各有图形标记，已接管的标 `DSH`。最上面固定一项“眼镜工作区与云端”，是原来 Qoder 眼镜面板的内容。
- **查看**：右侧是完整记录：提问、回答（按 Markdown 渲染，原始 HTML 当文本显示）、连续的工具调用折叠成一行“N 次工具调用”。头部显示状态、来源、文件夹、分支、模型和轮数；“更多”里有在 qoder.cn 打开、在本机终端继续、复制续接命令和会话 ID。
- **接管**：在底部输入框里直接打字发送，或点头部的“在 DSH 中接管”。这会新建一个 DSH 会话（模型选这个 agent：Qoder 用原会话的模型，DSH 不提供时用 `auto`；Hermes 用那个 persona），标题沿用原对话，并跳过去。之后再点同一条对话，打开的还是这个会话（索引在 `$DSH_HOME/dsh-agent-hub/relay.json`；DSH 会话归档后再接管会新建）。
  - **Qoder：原地接续**。新会话的第一轮让 `qoderclicn --acp` 直接 `session/load` 原会话，上下文一条不重复；之后就是普通的 Qoder 会话（审批框、手机访问、Cardputer 都能用）。还在执行的任务不能接管（两个进程会同时写一个会话），回答完再接；接管后，眼镜或 App 上的追问会和 DSH 这边各自继续。原会话加载失败时（比如文件夹已删除），改为带着记录开新会话。
  - **Hermes：带着记录接续**。Hermes 的 ACP 只能加载它自己经 ACP 建的会话，Telegram、终端这些来源加载不了，所以新会话的第一轮把原对话的记录（最近的约 24,000 字，工具调用各一行）放在提问前面。原对话本身不会跟着更新。
  - **终端**：“在本机终端继续”在这台电脑上开一个终端窗口运行续接命令（Qoder `qodercn -r <会话>`，云端会话 `qodercn --teleport <会话>`；Hermes `hermes -p <persona> --resume <会话>`）。只在本机打开 DSH 时出现；手机上可以“复制续接命令”。
- **派到云端**：“眼镜工作区与云端”里可以把一段任务交给 Qoder 云端（`qodercn --remote`，在所选工作区里运行），关掉电脑也会继续；创建出的会话列在列表里，标为“云端”，在网页上看进度，要拉回本机用终端命令。云端功能要看账号是否开通，CLI 报不可用时原样显示它的提示。CLI 打印出会话链接就算完成；8 秒内没打印出来时，面板提示“已提交”，会话创建好后出现在列表里。
- **完成通知**：DSH 开着的时候，眼镜 / App 任务、云端任务或 Hermes 定时任务从执行中变为已回答或失败，窗口右下角（手机上在顶部）弹出一条通知，点“查看”打开接力面板定位到它；面板本身在屏幕上时不弹。侧栏的「接力」图标上，有任务在执行时显示蓝点，有 24 小时内没看过的失败时显示红点。
- **窄屏**：列表和记录变成两步，记录页左上角返回；输入框和搜索框用 16px 字号，避免 iOS 放大。
## 模块：手机访问

通过 Tailscale 把 DSH 提供给**这台电脑所属的 Tailscale 账户**。手机打开的就是 DSH 本身：可以查看所有会话的实时进度、继续推进任意会话（冷会话按需恢复）、在手机上审批，覆盖所有模型（Claude Agent、Codex 订阅、DeepSeek、MiniMax……）。

- **入口**：侧栏底部的"手机访问"（侧栏收起时只显示手机图标，开启后带绿点）。面板每种状态只给一个下一步：未安装 → 下载 Tailscale；未连接 → 打开 Tailscale；tailnet 未开 HTTPS → 打开 Tailscale 后台的 DNS 页面开启 *HTTPS Certificates*（一次性）；就绪 → 开启。从其他窗口切回来时自动重新检测。
- **开启后**：面板显示二维码和网址（`https://<机器名>.<tailnet>.ts.net`），手机扫码即可打开，**不需要配对**。网址里不含任何凭据，在哪里显示都安全。
- **手机上的界面**：在窄屏触屏设备上，插件用一层纯 CSS 调整 DSH 的官方界面：16px 输入框避免 iOS 缩放、44px 触控区、安全区留白、右侧栏（源代码管理、终端、文件）展开时铺满整屏（DSH 自带的窄屏适配只认旧版右栏，会把它挤成零高度），隐藏悬停提示和只对电脑生效的"用文件资源管理器打开"、输入框弹出菜单改为底部面板、设置改为单栏。桌面端不受影响。
- **设置**：DSH 只在本机打开的页面上开放设置读写，所以手机上的"设置 → Agent Hub"只显示提示，要改设置请到电脑上操作。
- **生命周期**：DSH 退出时撤掉 serve 规则，下次启动自动恢复。点"停止"会撤掉规则并记住关闭状态。

**怎么做到的**：

1. `tailscale serve` 在 tailnet 上用 HTTPS 提供 `<机器名>.ts.net`，把请求转给插件在 `127.0.0.1` 上开的一个转发端口。插件只改写自己这条端口的规则；如果该端口已被别的 serve 规则占用，会报错而不是覆盖。
2. 转发端口把请求以 loopback 身份交给 DSH 自己的 web 服务。因为改写了 Host，DSH 原有的防 DNS 重绑定、防跨站检查会失效，所以转发前先按公开域名重新检查一遍：Host 必须是本机的 ts.net 名称，Origin 只能是同源，拒绝 `sec-fetch-site: cross-site` 的请求（例外是从别的 App 或网页点链接打开页面这种顶层跳转，即 `GET` 且 `sec-fetch-mode: navigate`：它不会转给 DSH，而是返回一个让页面自己重新加载的小页面，把跳转变成同源的，DSH 的 `SameSite=Strict` 会话 cookie 才能带上）。另外只放行 `Tailscale-User-Login` 等于本机所属账户的请求；这个头由 tailscaled 写入。
3. 账户身份只决定"能不能进门"，登录仍走 DSH 原生机制：手机第一次打开、还没有 DSH 会话 cookie 时，插件用 DSH 自己的启动令牌 URL（`connection.authenticatedUrl`）跳转，由 DSH 写入它的标准会话 cookie（30 天）。插件不保存、也不校验任何凭据。

端口可在设置 → Agent Hub 中修改（默认 443，网址不带端口）。

> 和 Claude App 的 Remote Control 的区别：手机访问覆盖所有模型的所有会话；Remote Control 只覆盖在线的 Claude Agent 会话，但用的是官方客户端（见上文）。
>
> **Codex**：DSH 里的 Codex 模型由 `dsh-codex-subscription` 直接调用订阅接口，**不会产生 Codex 自己的 thread**，Codex App 的 Remote Control 看不到它们，需要用手机访问查看。本插件对 Codex 只读不写，不影响 Codex 自己的 Remote Control。

## 模块：源代码管理（Git）

右侧边栏的一个标签页（与"文件""终端"并列），作用于当前会话的工作区目录。有三种打开方式：会话标题栏右上角的 Git 按钮（角标显示未提交的更改数；Git 标签已在前台时再点一次会收起侧栏；还没发出第一轮的新会话页上也有，位于侧栏展开按钮左边）、空侧栏引导卡片里的 **Git**，以及 `Ctrl+Shift+G`（macOS 为 `⌘⇧G`）。

- **更改**：顶部是提交框（`Ctrl+Enter` 提交；下拉里有"提交并推送""修改上次提交"）。提交按钮上方一行显示这次会以谁的身份提交，以及身份来源（本仓库、规则匹配、全局默认、环境变量）。身份写在仓库自己的 `.git/config` 里，所有 worktree 共用，终端、agent 和其他编辑器提交时也都按它来。仓库还没有自己的身份时，第一次从这里提交会先让你选择（预设身份、原全局身份或新建身份），绑定后再提交。主机提交前会用 `git var` 核对：如果实际生效的身份已不是界面上显示的那个（比如在终端里改过），会拒绝这次提交。修改上次提交时，如果原作者不是当前身份，会提示原作者会被保留，并可以一键改为当前身份（`--reset-author`）。没有暂存任何文件时，按钮会写明"暂存全部并提交"。下面依次是合并冲突、已暂存、更改、储藏。行尾按钮可打开文件、暂存/取消暂存、放弃更改；右键有完整菜单。键盘操作：`↑↓` 移动，`Enter` 看差异，`Space` 暂存或取消暂存，`Delete` 放弃更改。
- **列表 / 树形**：顶栏的切换按钮把更改按文件夹显示成树：只含一个子文件夹的路径会合并成一行（如 `src/client/git`），文件夹排在文件前面。文件夹行可以整体暂存、取消暂存或放弃，`←→` 折叠或展开。提交详情里的文件列表也能切换，选择全局记住；差异里的上一个/下一个文件按当前显示顺序走。
- **差异**：点开任意文件（更改列表、展开的提交、未提交的更改）时，差异显示在**中间的 agent 窗口**上，盖住对话区域；源代码管理面板的大小、位置和滚动都不变，只高亮当前打开的文件。关闭（`Esc` 或 ✕）后对话原样回来。差异默认左右并排（宽度不足 640px 时为内联，可切换），带词级高亮，可切换"显示完整文件"，`Alt+↑↓` 切换上/下一个文件。手机或中间区域过窄时，差异改为全屏打开。工作区文件的差异会随 agent 的改动自动刷新。冲突文件按"当前 / 传入"着色，可以整体采用一侧或标记已解决。
- **图谱**：所有分支按时间排列成泳道图，顶部虚线节点表示未提交的更改。
  - **单击**提交节点，就地展开详情（与 Git Graph 一致），不切换页面：详情插在这一行下方，泳道沿左侧继续延伸，列表自动滚动让整块详情可见。宽面板中左侧是说明、引用、哈希、父提交（点击跳到父提交并展开）、作者和日期，右侧是变更文件（列表或树形）；窄面板改为上下排列。再次单击、✕ 或 `Esc` 收起；展开时 `↑↓` 让详情跟着移到相邻提交。"未提交的更改"行也可以这样展开，列出工作区的文件。
  - **双击**提交切换工作分支（与 VS Code Git Graph 一致）：提交上有本地分支就检出它，有多个时弹出选择；只有远程分支就创建跟踪分支并检出；没有分支时确认后检出到游离 HEAD。双击分支徽标直接检出该分支。
  - **右键**（或 `⋯` 按钮、手机长按）打开操作菜单：检出、新建分支或标签、拣选、还原、重置（软/混合/硬）、复制哈希，以及该提交上每个本地分支的**推送**、**强制推送（--force-with-lease）**和**强制推送（--force）**。两种强制推送都会先确认，并说明各自的风险：lease 在远端被别人更新过时会拒绝推送，--force 会直接覆盖。右键分支徽标可推送、强制推送、合并、变基、重命名、删除。
- **命令行**：顶栏的终端按钮在面板底部打开命令行抽屉。重新打开时，仍在运行的终端会原样恢复；进程已经不存在的终端（例如 DSH 重启后，或进程已退出）会自动移除；如果一个都不剩，就自动新建一个终端。
  - 命令在项目文件夹（仓库根目录）中运行，提示符显示当前分支；输出保留颜色。
  - 命令运行时可以在输入框里继续输入，内容会发给该命令，所以需要逐行回答的提示也能用。`Ctrl+C` 中断（连同子进程），`↑↓` 翻历史，`Ctrl+L` 清屏。
  - 命令结束后，状态和图谱立刻刷新。抽屉高度可以拖动调整，双击分隔条恢复默认高度。
  - 在终端里选中文字后**右键**即可复制（复制后选区清除并提示"已复制"，与 Windows Terminal 一致）；没有选中文字时右键不做处理。
  - Windows 上使用 PowerShell 7（没有则用 Windows PowerShell），其他系统使用登录 shell。分页器和凭据提示都已关闭，命令不会卡在等待终端的状态。
  - 全屏编辑器这类需要真正终端的程序，用抽屉右上角的按钮打开 DSH 的完整终端，它同样在这个项目文件夹里启动。
- **顶栏**：分支切换器（可搜索，输入名称后回车即可新建分支）、同步按钮（↓拉取 ↑推送，没有上游时显示"发布分支"），"更多"菜单里有抓取、拉取、推送、两种强制推送和储藏。合并、变基、拣选进行中时显示提示条，提供"中止"和"继续"。
- **工作树**：第三个标签页，列出这个仓库的所有工作树（当前、主目录、已锁定、目录已不存在都有标记），每行显示分支、位置、未提交的更改数和会话数。
  - **左侧边栏按仓库分层**：在左侧工作区列表选择 **视图选项 → 分组方式 → 按工作区树** 时，每个已登记仓库的所有工作树都会嵌套在仓库主目录下面，与工作树放在哪个目录无关：同一个仓库由 git 判断（共享的 `.git`），所以旧版本建在 `<仓库名>.wt/` 下、或手动建的工作树也会被嵌套。嵌套的位置与 DSH 原生的子工作区相同：在主目录标题行之后、主目录自己的会话之前，缩进一级；标题只显示分支名（手动改过名的保留原标题）。折叠主目录时，工作树一起收起，标题行上显示收起的工作树数量。主目录（原始仓库）自己的会话统一收进一个名为 `root` 的节点，与各工作树同级、排在最前，可以单独折叠（折叠状态按仓库记住），折叠时标题行上显示会话数量。没有工作树的仓库，以及主目录没有登记为工作区的仓库，照常平铺。**按工作区** 和平铺视图保持 DSH 原样，不做任何改动。插件不移动、不删除宿主列表里的节点（只额外加入 `root` 这一行），也不改工作区的排序；只用样式调整显示顺序和缩进，宿主列表结构不符合预期时自动不生效。
  - **每个工作树都是一个 DSH 工作区**：新建时放在仓库内的 `<仓库>/.worktrees/<分支名>`（例如 `proj/.worktrees/feat/login`，并自动写入仓库本地的 `.git/info/exclude`，不会出现在主目录的改动里），并立即登记为工作区，标题为 `仓库名 · 分支`。在其中开的会话、Git 面板、终端和 Claude Agent 都在这个目录里工作，主目录不受影响。"同一个项目"由 git 自己判断（共享的 `.git`），不另外存储。
  - **新建**：输入分支名，对话框实时显示将要创建的目录。连接了 Linear 时也可以直接搜索并选择 issue，见[连接器](#模块连接器)。已有的本地分支直接检出；只有远程分支时建立跟踪分支；否则从"基于"（留空为当前分支）新建分支。默认创建后在其中新建会话。
  - **打开项目即打开全部工作树**：在 DSH 里添加一个工作区（无论从哪里添加）时，如果它在 git 仓库里，`git worktree list` 列出的该仓库其余工作树（含主目录）会一并登记为工作区，标题用文件夹名（与手动添加文件夹时一致，不用分支名），在"按工作区树"视图里直接嵌套在仓库下面；目录已不存在的工作树跳过，已登记的保持原标题不变。只在添加的那一刻推断一次：之后手动移除某个工作树的登记，不会被自动加回来，除非再次添加该仓库的某个目录。宿主的"添加工作区"会把新工作区排到列表最前，所以在"按工作区"和平铺视图里，这些工作树排在最前面。
  - **刷新工作区**：左侧工作区标题栏的搜索按钮旁边有一个刷新按钮，点击后把每个已登记仓库的全部工作树补登记一遍，用于自动登记没覆盖到的情况：插件升级前、或插件没运行时添加的仓库，以及之后用命令行新建的工作树。按钮转动表示正在查找，完成后提示文字显示登记了几个。
  - **打开**：点击一行（或"新会话"）在该工作树中新建会话；命令行建的、还没登记的工作树会在这时登记。
  - **删除**：确认框写明会删除哪个目录、多少个会话会被归档、多少处未提交的更改会丢弃，可选同时删除分支。删除前先归档其中的会话（有会话仍在运行时拒绝，并撤销已做的归档），关闭在该目录中运行的 Claude Agent 进程，再删除目录和工作区登记。不能删除主目录和当前所在的工作树。
  - 还可以锁定/解锁、复制路径、清理目录已不存在的工作树。
  - 分支已在别的工作树检出时，分支切换器标出"在其他工作树中"，选择它、双击它所在的提交或右键"打开所在工作树"都会直接打开那个工作树；右键分支还可以"在新工作树中检出"。
- **布局**跟随面板自身宽度：小于 760px 时详情从右侧滑入覆盖列表（手机和窄侧栏）；760px 起列表与详情并排；1200px 起分为图谱、提交、差异三栏。触屏上点击区域更大，悬停才出现的按钮改为常显，菜单和对话框改为底部弹出。

**性能**：变更列表、图谱和差异都只渲染可见行，滚动时位置没变的行不重新渲染，几千个文件、几万行差异照样流畅。图谱每页 400 个提交，滚动到底自动加载下一页。只有 Git 标签在前台且页面可见时才快速轮询状态，标签在后台时只有标题栏角标每 10 秒看一次。Windows 和 macOS 上宿主用文件监听回答轮询：没有任何变化时不运行 git；只改了工作区文件时只重跑 `git status`，复用 refs、储藏和进行中的操作；`.git` 有变化（提交、抓取、切分支）时才全部重读，并且至少每 30 秒全量校准一次，监听器 3 分钟没人用就关闭。因此有焦点时每 1.5 秒轮询一次（Linux 上没有监听，仍为 2.5 秒），否则每 10 秒。插件自己的操作、命令行跑完的命令和"刷新"按钮总是全量重读。结果没变化时不触发重渲染，refs 变化时才重新读取图谱；打开的差异内容没变时也不会重新解析。读操作带 `GIT_OPTIONAL_LOCKS=0`，不会和 agent 自己执行的 git 命令争抢 `index.lock`。

**安全**：git 在宿主侧执行，走 DSH 已认证的 `/api` 通道（`agent-hub/git`）。目录必须位于 DSH 已登记的工作区内；分支、标签、提交等参数在宿主侧校验，拒绝以 `-` 开头的名称，路径一律放在 `--` 之后。网络操作不会弹出交互式提示（`GIT_TERMINAL_PROMPT=0`）。

## 模块：代码编辑器

在会话旁边查看和修改工作区里的代码。编辑器是右侧边栏的一种标签，所以多标签、两格分栏、浮窗、全屏、与会话并排、按会话记住布局都沿用 DSH 自己的侧边栏；窗口窄于 768px（手机）时侧边栏自动全屏。

- **打开**：文件树、会话里的文件链接、工具调用的行号引用、搜索结果都会在代码标签里打开文本文件，并定位到对应行。Markdown、HTML 仍先用 DSH 的预览渲染，预览标题栏右侧的 **编辑** 切到编辑器，编辑器里的 **预览** 切回。图片、PDF、Office、表格保持原来的预览。
- **编辑与保存**：基于 CodeMirror 6，语法高亮覆盖常见的 40 多种语言；支持多光标（Alt+点击、Ctrl+D）、折叠、括号匹配，自动缩进按文件现有的写法识别空格或 Tab。**只用 Ctrl/⌘+S 手动保存**，保留文件原有的换行符（LF/CRLF）和 BOM。标签标题和路径栏用圆点标出未保存的修改；关闭有未保存修改的标签时先询问：保存并关闭 / 不保存 / 取消。未保存的内容同时备份在浏览器里，刷新或崩溃后恢复并提示。
- **agent 同时在改文件**：没有未保存修改时，编辑器随磁盘内容实时更新，光标和滚动位置不动；有未保存修改时不覆盖，顶部提示冲突，可以 **对比**（在编辑器内显示与磁盘版本的差异，逐处保留或还原）、**用磁盘版本** 或 **用我的覆盖**。保存时带上编辑开始时的内容哈希，宿主发现文件已被别人改过就拒绝写入，不会悄悄覆盖 agent 的修改。
- **改动标记**：行号右侧标出相对 HEAD 的新增（绿）、修改（蓝）、删除（红色三角）行；提交后、窗口重新获得焦点时刷新。
- **格式化**：Shift+Alt+F。优先使用项目自己的格式化工具，项目配置随之生效：项目里的 Biome（有 `biome.json` 时）或 Prettier，然后是 PATH 上的 ruff/black、gofmt、rustfmt、clang-format、shfmt、stylua、taplo 等，Web 语言最后用插件自带的 Prettier。结果按最小差异写入，光标不跳，一次撤销即可还原。
- **加入会话**：Ctrl/⌘+L 把选中范围以 `@路径 L12-30` 插入当前会话的输入框（多个选区用逗号分隔，没有选区时只插入 `@路径`），模型据此用文件工具读取。文件有未保存修改时会提示：模型读到的是磁盘上的版本。
- **定义与引用**：F12 或 Ctrl/⌘+点击（按住 Ctrl/⌘ 悬停时出现下划线）跳到定义，Shift+F12 在搜索标签中列出引用。定义靠搜索查找，不依赖语言服务器：按光标处的标识符匹配各语言的声明写法（`function X`、`class X`、`def X`、`fn X`、`X = …` 等），所有语言通用，不建索引。结果按与当前文件的远近排序，只有一处时直接跳转，多处时弹出候选；在声明处按 F12 则改为列出引用。
- **搜索**：文件内 Ctrl/⌘+F 查找、Ctrl/⌘+H 替换、Ctrl/⌘+G 转到行。工作区搜索是侧边栏的 **搜索** 标签（开始页也有入口；会话标题栏右上角、Git 按钮左边还有 **工作区文件** 和 **搜索** 两个快捷按钮，用法同 Git 按钮：点一下打开对应标签，已在前台时再点收起侧栏），快捷键在桌面端为 Ctrl/⌘+Shift+F，在浏览器里为 Ctrl/⌘+Alt+F（浏览器里 Ctrl+Shift+F 是 DSH 的"分叉会话"）；从编辑器里按会带上选中的文字或光标处的词。支持区分大小写、全字匹配、正则，以及包含/排除的文件（逗号分隔的 glob）。结果按文件分组，点击后在代码标签所在的分栏打开，搜索结果仍留在旁边。
- **布局**：路径与操作按钮共占一行（32px），底部状态栏显示行列、选中数、缩进、换行符、编码和语言；侧边栏较窄时次要按钮收进"更多"。触屏上按钮更大、状态栏隐藏，选中文字后底部出现"转到定义 / 查找引用 / 加入会话 / 复制"操作条。

**性能**：CodeMirror 和语言包是单独的 chunk（`lib/client.editor.js`），第一次打开代码标签时才加载，不影响 DSH 启动。编辑器只渲染可见行，语法增量解析；超过 2 MB 或含超长行的文件关闭语法高亮，超过 10 MB 的文件交给 DSH 的分页预览。同一文件在多个标签里共用一份内容，切换标签保留撤销历史和滚动位置。工作区搜索用 ripgrep（`@vscode/ripgrep`，与 VS Code 相同；装不上时用 `git grep` 代替），遵守 `.gitignore`，最多返回 2000 条、20 秒超时；新的搜索会取消进行中的那次，结果列表只渲染可见行。

**安全**：读写、搜索和格式化都在宿主侧执行，走 DSH 已认证的 `/api` 通道（`agent-hub/files`）。会话目录和被读写的文件（解析符号链接后）都必须位于 DSH 已登记的工作区内；写入按文件串行，并以内容哈希为前置条件。

## 模块：配置同步

把当前 profile 的**全部插件配置**（`cordis.patch.yml`，包括各插件条目的 `disabled`）和**插件启用列表**（`package.json` 的 `dsh.profile.bundles`，有序）通过一个 Git 远程仓库在多台机器间同步。每台机器在 `$DSH_HOME/dsh-agent-hub/sync/<profile>/` 保存一个完整的 git 仓库，远程仓库只做中转，任何一台机器都持有全部历史。

- **同步什么**：仓库里只有 `cordis.patch.yml`、`plugins.json`（组合包顺序 + 安装来源）、`pins.json`（剪贴板窗口的置顶项）、`reader-feeds.json` 与 `reader-favorites.json`（阅读的订阅和收藏）和 `.gitattributes`。家目录下的路径写成 `~/…`（`/Users/vi/pro/app` 与 `C:\Users\vi\pro\app` 是同一个值），文本统一 LF；注释和 `!!js` 表达式原样保留。`link:`、`file:` 等只在本机有意义的安装来源不会共享，仓库里保留其他机器的来源。**不同步**：登录凭据、构建脚本授权、版本豁免、锁文件，以及本插件的看板任务与 Claude 账号列表。
- **置顶剪贴板**：默认同步。置顶项以文本内容为身份，两台机器各自置顶了同一段文字也只算一条，应用到本机时在本地历史里原地置顶，不会多出一行。一台机器取消置顶，其他机器下次同步也取消（取消的条目回到「最近」，不删除）；两边置顶时间不同取较早的，各端 `Ctrl/⌘ 1–9` 编号一致。置顶项没有冲突，不需要选择。剪贴板窗口没开（或助手没在运行）的机器不参与：既不读也不改本机置顶，远端的置顶项原样保留，之后开启时也不会把「还没收到」当成「已删除」。置顶内容会进入你的 Git 远端，里面不要放密码；想让某台机器的置顶项留在本机，在 `config.sync.localSettings` 里加上 `agent-hub.config.palette.pins`。
- **阅读的订阅与收藏**：和置顶项走同一套合并（`src/sync/collection.ts`）：订阅以"类型 + 地址"为身份，收藏以"链接 + 引用的文字"为身份，两台机器加了同一个只算一条；一台删除，其他机器同步后也删除。条目、已读状态和文章正文只留在本机。想留在本机：`agent-hub.config.reader.feeds`、`agent-hub.config.reader.favorites`。
- **不参与同步**：有些设置只对一台机器有意义，例如终端默认 shell（`terminal-controller` 里的 `C:\Program Files\PowerShell\7\pwsh.exe`）或本机的浅色/深色。"不参与同步"里列出的可以是整个条目（`terminal-controller`），也可以是条目内的设置（`ui-theme.config.preference`），它们不上传、不参与比较，应用远端配置时保留本机原有的值，整个条目留在本机原来的位置。默认是 `terminal-controller`、`agent-hub.config.review.auto`（评审自动同步）和 `agent-hub.config.remote.phoneSettings`（允许手机修改设置），剪贴板浮窗和 Cardputer 的模块开关（`agent-hub.config.modules.palette`、`agent-hub.config.modules.device`）也默认在列。这个列表本身随配置同步，所以每台机器排除的是同一批设置。
  - **选择**：已排除的项显示为标签，点 × 恢复同步。点"从配置中选择…"会列出本机 profile 和上次拉取的远端版本里的全部条目，可以搜索，可以展开到 `config` 下两层；勾选条目就是整个条目不同步，其中的设置随之显示为已勾选。远端独有的条目标"仅远端有"；本机和远端都已没有的项标"已不存在"。
  - **旧版本的"按系统区分的条目"**：已并入这里，改为整个条目不同步；仓库里带 `platform:` 标记的旧副本不再读取，下次推送时清除。
- **同步流程**（设置 → 同步与更新 → 配置同步）只有一个 **同步** 按钮。状态行显示 ↓N ↑M：远端有 N 项新改动、本机有 M 项未推送（截至上次拉取）。点"同步"后：
  1. 拉取远端，以"本机上次应用的版本与远端的共同祖先"为基准，逐项三方合并：每个配置项、每个插件的启用状态、插件顺序、每个插件的版本各算一项。只有一边改过的，直接取那一边；两边改成同一个值的，不用处理。Bots、连接器这类带 `id` 的列表按条目合并，两台机器各加一个 Bot 时两个都保留。
  2. **没有冲突**：直接把合并结果应用到本机并推送，不再列出完整差异，也不需要选择以哪边为准。
  3. **有冲突**（两边都改了同一项，而且值不同）：什么都不改，只列出冲突项。每项是"本机 / 远端"两张单选卡片，显示各自的值，**默认都不选**；可以逐项选择，也可以用"全部用本机 / 全部用远端"批量选择。全部选完后点"应用并同步"，其余没有冲突的改动一起合并；"稍后处理"放弃这次选择。选择只对当时的远端版本有效，远端又有新版本时会重新询问。
  4. 可以展开"附加版本说明"，作为这次推送的提交说明。
- **应用后校验**：
  - 应用时先写入本机 profile 的 `cordis.patch.yml` 和组合包列表，再安装同步列表新增的插件、升级版本有变化的插件（HMR 下进入[待重启列表](#设置--同步与更新)）。
  - 随后让运行中的 DSH 接收新配置：HMR 下重新协调整个 profile；普通模式下通过 Loader 应用配置补丁，插件的变化等重启后生效。
  - 最后回读本机的实际状态：没有生效的项单独列出，需要重启时页面顶部提示。
  - 结果行显示这次在本机应用了几项、推送了几项，"查看改动"列出每项的旧值和新值，"撤销"回到这次同步之前的本机配置（生成一个新版本，下次同步时推送）。
- **不会丢内容**：新版本始终以双方为父提交，两边原来的配置都留在历史里，推送是快进，不需要 force push；推送时远端恰好又有新版本，就自动重新合并，最多重试三次。读取本机状态时，待重启的升级按"已经升级"计算，所以重启前再同步一次，也不会把远端的新版本当成本机降级推回去。
- **插件**：组合包的启用、停用和顺序跟随合并结果（插件管理需要的组合包不会被停用）。本机没装的插件经 DSH 的插件管理自动安装，显示安装进度和 pnpm 输出；同步列表里已经没有的插件只提示，不会自动卸载。
- **版本**："历史版本"列出最近 50 个版本，"恢复到此版本"生成一个新版本并立即应用到本机，下次同步时推送到远端。
- **启动时**：开启"启动时自动拉取"时，DSH 启动后按同样的方式合并远端：没有冲突就直接应用远端的改动（不推送本机的改动），右下角提示应用了几项、是否需要重启；有冲突只提示，点"查看"打开 同步与更新 页处理。每次 DSH 启动只拉取一次：修改设置或同步应用本插件自己的配置时插件会重新加载，不会因此再拉取；进行中的同步和它的结果、撤销在重新加载后仍然保留。
## 模块：审核

每天定时读取 GitHub 上**等我 review 的 PR**，每个 PR 在自己的只读会话里分析，结果写进一份**审阅单**；我在看板上勾选、修改、预览，确认后由插件提交 review。模型从不自己提交。需要本机装好并登录 `gh`（`gh auth login`）。入口是 **设置 → Agent Hub → 审核**（勾选仓库即开启）和看板最左边的 **待我审** 列。

- **审阅单是唯一的状态**：`<仓库>/.reviews/pr-<编号>.md`，目录里自带一个内容为 `*` 的 `.gitignore`，整个目录不进 git。front matter 是 PR、分析时的 head、状态、结论（approve / request-changes / comment）、总结、会话 id、提交后的 review id；正文是变更说明、必须修改、可以优化、本 PR 规则和备注。每条发现是一行 `- [x] F1 \`path:88\` 说明`，下面 `> EN:` 开头的是要提交的英文评论。agent 用自己的编辑工具写它，界面的改动由宿主在文件的最新内容上应用（按文件串行、原子替换），两边不会互相覆盖；手改也可以，读取是宽松的。卡片状态（未分析 / 分析中 / 待审 / 有新提交 / 已提交 / 格式错误）由 GitHub 的列表和审阅单推导，不另外存储。
- **同步**：一次 GraphQL 搜索（`review-requested:@me`）拿到所有仓库的 PR，按仓库的 GitHub remote 对应到勾选的仓库。每日自动任务为**新的**和**有新提交的** PR 开始分析（草稿除外，单次最多"每次最多分析"个）；列头的同步按钮和看板可见时的缓存刷新只读取列表，不启动分析。
- **自动化任务**：每日同步使用 DSH 官方 Schedule，没有第二套定时器；首次从旧设置迁移每日时间，此后只在宿主「自动化任务」中编辑时间和时区。设置 → Agent Hub → 审核显示状态、下次执行和管理入口，开启会创建原生任务，关闭或在宿主删除任务后不再自动重建。需启用官方 Schedule 服务。任务关联专属会话，由配置页的「辅助模型」调用一次受限同步工具；PR 分析仍由审核 Bot 执行。
- **每次结果**：同步工具按实际状态生成总结，保留在关联会话中；任务标题更新为「看板审核 · 上次 N 个已分析」等一句话结果。失败、取消与仍在分析分别统计；最多等待 20 分钟，超过上限只记录当时快照，不把排队等同于完成。宿主「记录」页签仍表示投递回执，完整结果在关联会话；模型未执行或投递失败不应视作同步成功。失败不额外建立重试定时器，可在看板手动重试。
- **分析**：PR 被 fetch 到 `refs/reviews/pr-<编号>`（不建工作树、不切分支、不动工作区），在仓库主目录的工作区里新建会话，模型默认使用审核 Bot；在看板卡片上右键、长按或点 `⋯`，可通过“选择 Bot 分析”只为本次任务指定其他 Bot（明确选择时会新开对应 Bot 的会话）。会话标题为 `Review #编号 · 标题`；先写好审阅单的 front matter，再发出第一轮：diff 范围、改动文件、未解决的 review 线程（已 resolve 的 bugbot 线程在交给模型前就被去掉）和三层规则（全局、`.reviews/RULES.md`、审阅单里的规则）。同时最多运行 2 个，其余排队。有新提交时开始第 2 轮：上一轮的审阅单改名为 `pr-<编号>.round1.md` 保留，新一轮只看增量并说明哪些旧问题已解决。审阅单的规则改了后点"按新规则重新分析"，同一 head 时直接让原会话再看一遍。
- **只读**：审核会话的系统提示词里有固定的一节（只读规则、按 ref 读代码、审阅单格式、评论风格），压缩上下文也不会丢。守卫对所有模型生效：git 不能 checkout、switch、reset、commit、stash 等改动分支、索引或工作区的命令（fetch 和所有读取照常）；gh 只能读，`gh pr review/comment`、非 GET 的 `gh api` 都被拒绝；写文件只能写 `.reviews/`（和系统临时目录）。Claude Agent 通过 PreToolUse hook（Bash 与 Edit、Write、MultiEdit、NotebookEdit），DSH 模型通过工具注册表的守卫。shell 重定向这类拦不全的写法，每轮分析结束后用 `git status` 检查，受跟踪文件被改动时卡片上会标出。
- **审阅单界面**：看板详情和会话旁边的侧栏标签用的是同一个表单（聊天里点 `.reviews/pr-N.md` 链接就在侧栏打开它，浮窗、分栏、全屏沿用 DSH 侧栏；"源文件"切到代码编辑器）。结论、总结、勾选、每条的英文评论都可以直接改，勾选立即保存、文字在离开输入框时保存。每条发现可以**深挖**（问题和这条发现、对应 diff、PR head 上该文件的相关部分一起交给辅助模型单次回答，结果追加到备注，不进分析会话）或**改写**（按评论风格重写英文评论）。看板上的"打开会话"进入分析会话，审阅单在侧栏同时打开，可以继续追问。
- **提交**：先预览，逐项列出将要提交的结论、总体留言和每条行内评论；行不在 diff 里的发现并入总体留言。以下情况不能提交，预览里会写明：评论或总结含破折号（— 或 –）、approve 自己的 PR、request changes 没有总结、什么都没选、勾选的评论没有内容、分析未完成、已经提交过、PR 有新提交。确认后宿主用分析时的 head 发一次 `POST /pulls/<编号>/reviews`；发之前先查我在这个 commit 上有没有内容相同的 review，所以失败重试也不会重复提交。提交后审阅单标为已提交（卡片保留 14 天）、删掉 `refs/reviews/pr-<编号>`、归档会话。
- **多端**：所有状态都在宿主上（审阅单文件和 DSH 会话）。自动任务跑在另一台机器（如常开的 mini PC）上时，在那台机器开启[手机访问](#模块手机访问)，笔记本和手机都打开它的地址即可，不需要同步；其他机器把"审核的仓库"留空，就不会重复分析。远程页面上的设置是只读的，经常调整的规则可以写在 `.reviews/RULES.md`，用代码编辑器远程修改。
- **手动审核**：审核 Bot 仍是普通 bot，在任何会话里 `@reviewer` 照常可用。
- **Stack（叠起来的 PR）**：一个 PR 的 base 是另一个 PR 的分支时，它叠在那个 PR 上面。宿主以列表里的 PR 为起点，用带别名的 GraphQL 逐层查父（`headRefName: base`）和子（`baseRefName: branch`），最多 6 层，结果和列表一样缓存。fork 的分支不当作别人的父，默认分支上不再往上叠。「全部」列表已经有所有开放的 PR，只补查默认分支。
  - **看板**：同一个栈的卡片画在同一条竖向轨道上，栈顶在上，最底下是它最终合入的分支。栈里不在当前列表的 PR（没请你审的，或被搜索、仓库筛选挡掉的）画成虚线的单行；连续超过 2 个时折叠成「··· N 个关联 PR」，点开展开。点单行就打开它的详情，和普通卡片一样能看改动、能分析。
  - **详情**：显示整个栈，标出当前 PR，点哪一行就切到哪个 PR。审别人的 PR 时，每行有一个勾选框，**默认都不勾**。勾上的 PR 在分析时会被 fetch 到 `refs/reviews/pr-<编号>`（连同它的 base），首条消息里给出 diff 命令，模型把它当作只读上下文，意见仍只针对当前 PR；没勾的只列出标题。勾选结果存在审阅单的 `context:` 里，还没有审阅单时随下一次分析一起提交。我自己的 PR 只显示栈，不提供勾选。

### 我的 PR：回应评审

列头切到 **我的**，列出我在这些仓库开放的 PR（一次 GraphQL 搜索 `author:@me`，第一次切过来才读取，之后和其他列表一样缓存 5 分钟）。卡片上有 GitHub 的评审结论（需修改 / 已批准 / 待评审）和"N 条待处理"，也就是未 resolve、并且最后一条评论不是我的线程数。这一栏**只能逐个处理**：没有"全部分析"，每日同步也不会碰我的 PR。

- **开始处理**：点卡片上的"处理评论"，或者右键 / 长按 / `⋯` 选"处理评论""选择 Bot 处理…""新会话处理"。
  - 已经有检出这个分支的工作树：直接用它。
  - 没有：弹出选择（窄屏为底部弹出）。可以新建与分支同名的工作树（`.worktrees/<分支>`，排在最前，回车即选），也可以把主目录或其他工作树切到这个分支。有未提交改动的工作树只列出来不能选，宿主切换前还会再检查一次。
  - 分支来自 fork 的 PR 不能在本地修改，菜单里会说明原因。
- **分析（只读）**：
  - 先 fetch 分支和 base。本地落后远端、工作区又干净时自动快进；两边分叉或有未提交改动时不动，把情况写进首条消息。
  - 在工作树里开会话（标题 `Respond #编号 · 标题`），首条消息带上：diff 统计、diff 正文（约 60KB 以内）、每个待处理线程的完整对话和它所在的代码块（`diffHunk`）、其他人的 review 总评和讨论区评论、三层规则。
  - 模型把每条评论写进**回应单**（就是审阅单，`role: author`，同一个 `.reviews/pr-<编号>.md`），分为"修改"（要改代码）和"仅回复"两节，每条带着它的线程 id 和要回到线程里的英文回复。
  - 这一轮和审别人的 PR 一样是只读的：不能改受跟踪文件、不能提交、不能切分支。
- **回应单**：每条评论有"修改 | 仅回复 | 忽略"三段切换，可以改英文回复，也可以深挖、改写（改写按回复的语气，不按评审意见的语气）。总体回复（可选）会发在 PR 讨论区。
- **按单修改**：必须由我点这一步确认。
  - 宿主把回应单标为"修改中"，同一个会话收到要修改的条目编号，在它的工作树里改代码、提交一次，并在回应单里写明每条改了什么。
  - 这一轮可以写工作树里的文件、可以 commit；仍然不能 push、切分支、改写历史、碰别的工作树，也不能写 GitHub。读文件和写工作树内的文件不需要审批，shell 命令照常走审批（除非会话是完全权限）。
  - 这一轮结束后，宿主把回应单标为"待推送"，并记下工作树当时的 HEAD。中途终止的话退回"待确认"。
- **预览并推送**：预览里列出要推送的提交、每个线程的回复（标为"修改"的同时 resolve）和讨论区留言。以下情况不能推送，预览里会写明：还有要修改的条目没执行"按单修改"、修改还没结束、远端分支有本地没有的提交、回复为空或含破折号、什么都没有。
  - 确认后宿主依次执行：普通 `git push`（不用 force）、回复线程、resolve、发讨论区留言。
  - 已经存在的、我写的相同回复会被识别出来，所以中途失败后重试不会重复发。
  - 完成后回应单标为"已回复"；会话不归档，下一轮继续用。
- **接着上一轮**：有人在线程里新留言后，卡片显示"有新评论"。再次"处理评论"时，同一工作树里的同一个会话接着处理，只发送仍需处理的内容：
  - 已 resolve 的线程不发送；
  - 我已经回复、对方还没再说话的线程不发送；
  - 上一轮选了"忽略"、之后也没人追加评论的线程不发送；
  - 上一轮已经读过的总评和讨论区评论不发送。

  上一轮的回应单改名为 `pr-<编号>.round<N>.md` 保留，首条消息会引用它。明确选了别的 Bot 时会新开会话。

## 模块：Bots 与群聊（多 agent 协作）

一句话：**bot 就是一份设置；选它当模型就是一对一；在任何会话里 @ 它就是拉它进群。** 没有"新建群"这一步。

- **新建 / 编辑 bot（设置 → Agent Hub → Bots）**：名称（小写 kebab，同时是 @ 名和头像色）→ 一句话介绍 → 模型 → 人设；可用工具收在"高级"里。模型可选 DSH 注册的任何模型，**包括 Claude Agent 和 Codex**；留空跟随新建 agent 的默认模型。空列表时可以从"代码审查 / 实现 / 测试 / 调研"开始。设置只能在本机页面修改（手机上只读）。
- **一对一**：模型选择器多出 **Bots** 分组（模型路由 `agent-hub-bot`，每个 bot 是一个模型）。选中即与它对话，DSH 按会话记住选择，聊到一半可以换 bot。调用时 bot 的人设替换系统提示词顶部的 persona、工具按"可用工具"收窄（团队工具始终保留），再转给 bot 的真实模型；Claude Agent 不读 DSH 的系统提示词，人设附加到 Claude Code 自己的系统提示词。Claude Code 的会话接续等 replay 状态按底层路由保存，换 bot 不会串。Git 提交信息等后台用途的模型选择不列出 bots。
- **群聊**（需要 profile 启用 `@deepseek-ai/dsh-experimental-agent-team-profile`；没有启用时 bot 仍可一对一）：每个根会话本身就是一个 Agent Teams 的 Lead，即群主。
  - **@ 即邀请**：输入 `@` 先列出群成员（`@all` 表示所有人），再列出未入群的 bot，最后一行"新建 Bot…"打开设置。发送 `@bot` 时，不在群里的 bot 由宿主自动以 fresh 上下文入群（名称即 bot id，名字不复用，再次入群为 `reviewer-2`），在群里的直接投递。
  - **补课而不广播**：投递时附上该成员上次听到之后群里的新发言（新入群的看到最近 20 条），token 不随人数平方增长。成员之间仍可用 send_message 私聊。
  - **群主静默**：一条消息只 @ 成员时，群主这一轮不调用模型，只显示 `→ @reviewer`；成员给用户的回复以 **@名称** 原样显示在会话里，同样不经群主模型。不带 @（或 @ 群主）说话时群主照常作答。
  - **交给群主**：也可以直接让群主分派，它在系统提示词里能看到所有 bot，按 bot 名创建的 teammate 即运行在该 bot 上（模型、人设、工具随 bot 的后续修改生效，重启恢复后依旧有效）。
  - **一个群共用一个工作树**：成员在群主的目录里工作，通常为一项任务新建一个工作树，在其中开会话。
- **Claude Agent 作为群主或成员**：Claude Code 看不到 DSH 的工具，所以插件把这个会话能用的团队工具（spawn_teammate、send_message、list_agents、wait_agent、任务板等）作为进程内 MCP 服务器（`mcp__dsh__*`）提供给它，每次调用都以该会话的 DSH agent 身份经 DSH 的工具注册表执行。同时禁用 Claude Code 自带的 `SendMessage` / `ListAgents`。发给 Claude 的团队消息在它当前这次回复结束后作为下一条输入到达。运行在 Claude Agent 上的 bot 使用 Claude Code 自己的工具，"可用工具"对它不生效。
- **Codex 作为成员**：Codex 订阅模型本身就是 DSH 的模型，直接使用 DSH 的团队工具，无需额外桥接。

## 模块：定时发送

会话输入框工具栏的 **时钟** 入口支持纯文本定时发送。先在插件管理的官方分组启用 `@deepseek-ai/dsh-experimental-schedule-bundle`；未启用时入口会说明所需插件，不建立备用调度队列。

- **额度预设**：按实际服务路由与当前账号匹配订阅用量，支持 Claude Agent、Codex 订阅、MiniMax 国内/国际及 Cursor，Bot 解析到底层模型。已耗尽的适用窗口取最晚重置时间，仍可用时推荐下次重置，均加 1 分钟缓冲。未知模型专属限制、过期数据、无法匹配的账号与普通 API 服务不猜重置时间，仍可自定义时间。保存时重新核验预设；变化后需刷新并再次确认。
- **自定义时间**：日期和时间按浏览器当前时区解释，保存为一次性 UTC 时点；拒绝过去时间以及夏令时缺失或歧义时间。
- **统一管理**：不调用模型创建任务，直接写入官方 Schedule。创建成功后可点「管理任务」打开原生详情，也能在官方「自动化任务」中查看、修改和删除。任务标题由消息首行生成，无额外模型请求。
- **边界**：首版只支持普通文本，上传附件、引用标签和命令会明确提示，绝不静默丢弃。创建失败保留草稿；成功后仅清除版本未变化的原草稿。清除使用公开的版本校验编辑接口，仍可撤销，不调用编辑器私有提交接口。
- **投递而非执行保证**：模型与账号跟随原会话届时的配置，繁忙时排队而非插话。宿主需运行；退出或休眠期间无法准点投递，恢复后由官方 Schedule 处理到期任务。投递记录不表示模型执行成功，崩溃边界可能重复投递；网络超时后先用「重新确认原请求结果」核对同一请求（不会新建任务），原请求结束后才允许在检查官方列表后明确重新创建。宿主重启丢失请求追踪时不会自动重建；原生崩溃边界仍不保证恰好一次。

## 重启 DSH

改了插件代码（`pnpm build` 之后）或手动编辑了 `cordis.patch.yml` 这类需要新进程才生效的改动，点左侧栏底部账户按钮右边（主题切换之后）的 **↻ 重启** 按钮即可。确认框会列出正在进行的会话和后台任务数，有任务时按钮变为"仍然重启"、默认焦点落在"取消"上；确认后 DSH Desktop 关闭并重新打开，页面在新的宿主就绪后自动刷新（经 Tailscale 打开的手机页面同样会自动恢复）。

只在 DSH Desktop 中显示：Electron 没有给宿主提供重启消息，插件启动一个独立的辅助进程结束 Desktop 主进程，宿主随 IPC 断开走正常的优雅关闭，两者都退出后再重新打开应用。[待重启列表](#设置--同步与更新)里有插件升级时，确认框会列出这些升级；辅助进程在 DSH 完全退出后、重新打开之前运行 pnpm，失败时还原 `package.json` 和锁文件。`dsh web` 下没有能重新拉起 DSH 的进程，因此不显示该按钮。

## 结构

每个模块在宿主侧和前端各占一个目录，入口文件只负责组装；宿主 RPC 统一使用 `agent-hub/<模块>` 命名空间。

```
src/index.ts            宿主入口（挂载各模块）
src/config.ts           插件配置 schema（各分区 volatile，可在设置页实时修改）
src/usage/              用量模块：数据源、缓存、类型
src/claude/             Claude Agent 模块：模型路由（adapter）、常驻会话、消息翻译
src/acp/                通用 ACP 层：客户端（client.ts）、回复翻译（turn.ts）、按 profile 接入 agent 的模型路由（route.ts，进程按 key 池化，供 Qoder 和 Hermes 的 persona 共用）
src/cursor/             Cursor 模块：模型路由（adapter）、模型与推理档位、用量读取（ACP 客户端与翻译在 src/acp/）
src/hermes/             Hermes 模块：路由 profile，按目录列出 persona，定位 hermes-acp
src/qoder/              Qoder 模块：模型路由 profile、CLI 定位、remote-control 守护进程与日志解析、worktree hook（集中到 .worktrees/qoder）、协议类型
src/relay/              接力：读 Qoder 会话文件与 Hermes 各 persona 的 state.db，合并守护进程的实时任务，接管索引（relay.json），云端派发与终端续接
src/bridge/             眼镜桥接：dsh 命令（cli.ts 生成脚本、启动器和 Qoder skill）、本机回环服务（server.ts）、转交/会话报告/通知队列/铃铛（service.ts）、发进眼镜会话（post.ts）
src/palette/            剪贴板与翻译：拉起与监护原生助手（palette 模式）、翻译（bot 人设、流式、可取消）、状态；窗口本身在 native/dsh-type/src/palette/
src/remote/             手机访问模块：Tailscale CLI、转发端口
src/plugins/            插件更新：检查 Registry、经 DSH 安装器串行升级、HMR 下的待重启列表（pending.ts）
src/restart/            重启 DSH Desktop：可用性与进行中任务数、结束主进程并重新打开的辅助进程（途中运行待重启的插件升级）
src/git/                Git 模块：宿主侧 git 服务（含工作树）、输出解析、协议类型
src/files/              代码编辑器的宿主侧：读写（哈希前置校验）、HEAD 版本、ripgrep 搜索、按搜索查找定义、格式化
src/team/               Bots 与群聊：bot 设置、bot 模型路由（route.ts）、@ 邀请与投递、群主静默、协议类型
src/connectors/         连接器模块：OAuth 登录、挂载 DSH 的 mcp-client、Linear ticket 查询与状态修改、协议类型
src/repos/              仓库归属：已登记的工作区按 git 仓库分组
src/sync/               配置同步：可移植形式（路径、换行、插件来源）、逐项三方合并（merge.ts）、git 仓库操作（记录、应用、推送、恢复）
src/board/              看板：卡片汇总（Linear 与本地任务）、本地任务存储、开始工作（幂等）、卡片与工作树的关联
src/reader/             阅读：订阅与收藏记录（随配置同步）、RSS/Atom 解析与发现、正文提取转 Markdown、GitHub 星标、定时刷新、阅读会话
src/review/             审核：审阅单格式、gh 读写、同步与分析队列、只读守卫、提示词、提交预览与幂等提交、原生自动化任务与结果总结
src/claude/bridge.ts    把 DSH 团队工具和连接器工具以 MCP 提供给 Claude Code
src/client/index.tsx    前端入口
src/client/git/         Git 面板：状态 store、泳道布局、差异解析、工作树、界面
src/client/editor/      代码编辑器：代码与搜索两种侧边栏标签、输入框桥接；chunk/ 是按需加载的 CodeMirror 部分（文件缓冲、改动标记、语言）
src/client/team/        输入框里的 @ 候选：群成员、可邀请的 bot、新建 Bot
src/client/connectors/  连接器状态 store（设置页与 Git 面板共用）
src/client/usage/       用量模块的界面
src/client/palette/     剪贴板与翻译窗口的页面（原生 TS 单文件，由 build 打成 lib/palette.html）和设置页的状态 store
src/client/remote/      手机访问的入口、面板与移动端样式
src/client/config/      设置 → Agent Hub：暂存表单模型与界面（含连接器卡片、Bots 编辑器、分组折叠与摘要）
src/client/board/       看板页面：列、卡片、详情、窄屏标签与底部弹出
src/client/reader/      阅读页面：订阅栏、条目列表、正文（阅读主题与排版）、收藏、会话入口
src/client/sync/        配置同步的状态 store 与启动提示（同步与更新页在 src/client/config/updates.tsx，同步面板在 sync.tsx）
src/client/review/      审核：待我审列、审阅单表单与提交预览、侧栏审阅单标签
src/client/repos/       仓库分组 store；左侧边栏「按工作区树」视图里按仓库嵌套工作树
src/client/relay/       「接力」面板：对话列表与记录、接管输入框、眼镜工作区与云端、完成通知
src/client/glasses/     输入框旁的「完成后通知眼镜」铃铛
src/client/restart/     左侧栏底部的重启按钮、确认框与重启中的等待和自动刷新
```

## 模块：阅读

左侧边栏看板下方的 **阅读**，在中间区域打开。订阅网站的 RSS/Atom 和 GitHub 星标，文章统一转成 Markdown 在本机阅读。默认关闭，在 设置 → Agent Hub 顶部的 **功能模块** 卡片里打开 **阅读**（随配置同步）；关闭后不再定时刷新订阅。

- **添加订阅**：点 `+`，粘贴网站地址（自动找页面声明的 RSS/Atom）或订阅源地址；输入 `github` 订阅自己的星标，`github:用户名` 订阅别人的。支持 OPML 导入导出。新订阅只把最新 20 条标为未读。
- **刷新**：宿主每 30 分钟读一次（按 ETag / Last-Modified 条件请求），连续失败的源间隔逐步加倍，最多 16 倍；订阅栏上的警告图标说明上次失败的原因。GitHub 星标用一次 `gh api graphql` 读取最近 100 个星标和各自的最新发布，需要本机已 `gh auth login`。
- **无广告**：只显示提取出的正文（Firefox 阅读视图同款 Readability），导航、广告、评论区不会进来；去掉 1×1 跟踪像素和 `utm_*`、`fbclid` 等跟踪参数，不执行任何脚本，原始 HTML 以文字显示。订阅自带全文时直接用，不再抓网页；抓不到正文时显示订阅里的摘要并说明原因。仓库条目显示 README，发布条目显示发布说明。
- **阅读体验**：主题（跟随 DSH / 白 / 米黄 / 夜）只作用于正文；字体（衬线 / 无衬线）、字号、行宽、行距在工具栏的排版按钮里调整，每台设备各自记住。快捷键 `j/k` 上下篇、`s` 收藏、`a` 分析、`o` 打开原文、`u` 切换已读。宽度 ≥1100px 三栏，640–1100px 订阅栏收成图标，<640px 一次一栏、可返回。
- **划词与分析**：在正文里选中文字，旁边出现 **问一下** 和 **收藏**。"问一下"打开与聊天里相同的讨论面板，讨论跟着这篇文章保存；面板里可以选择上下文层级（**选区** / **本节** / **全文**，并显示实际发送的字数）和回答者（默认模型或任一 Bot，用 Bot 的人设；Bot 底层是 Claude Agent 或 Cursor 时由辅助模型带着人设回答）。工具栏的 **分析** 直接以全文开始讨论。回答可以 **收藏回答**（作为该段引用的笔记），或 **在会话中继续**。
- **会话**：工具栏的终端图标新开一个 DSH 会话：文章会写成 Markdown 文件放在会话目录里；仓库条目则浅克隆到 `$DSH_HOME/dsh-agent-hub/reader/repos/`，模型可以用工具读代码。克隆只用于阅读，下次打开会重置到最新提交。
- **收藏**：整篇收藏（星标）或划词收藏是同一种记录，区别只在有没有引用；文章里已收藏的段落会高亮。收藏和订阅随配置同步，见[配置同步](#模块配置同步)。
- **保存**：`$DSH_HOME/dsh-agent-hub/reader/`：`feeds.json`、`favorites.json`、`state.json`（条目与已读，每个源最多 300 条）、`articles/`（正文缓存，最多 600 篇，收藏的不清理）。

## 模块：选区讨论

在聊天正文或代码块中选中文字，点击旁边的 **问一下**；手机也可使用主输入框上方的 **就所选文字提问**。桌面为非模态浮层，窄屏为适配软键盘的底部面板。输入问题后才调用模型，可持续追问、停止、重试，从主输入框上方恢复历史。关闭只是收起；未发送的问题在当前浏览器缓存中保留，刷新后不保证恢复。

- **隔离**：讨论模型只看到选中文字、这段讨论和全局指令；没有工具，也不改变主会话模型。阅读页里的讨论另外可以按所选层级带上所在小节或整篇文章，见[阅读](#模块阅读)。新讨论可以选择由某个 Bot 回答。`设置 → Agent Hub → 对话` 可配置选区讨论的开关和模型，显式模型失效时不会自动切换提供方。
- **确认**：每轮完成后点击 **暂存到主会话**，把已完成前缀保存到宿主，并在主输入框插入紧凑引用。之后的追问不会自动加入，须点击 **更新暂存**。引用可在主输入框中删除；尚未提交的快照可稍后重新添加。
- **提交**：只有携带引用的人类消息会展开快照，自动续跑、旧队列和 Bot 消息不会消费它。发送失败保留引用；宿主会话日志中的受控上下文记录作为提交凭据，同一快照已提交的轮次不重复附加。Claude Agent 和 Cursor 作为主模型时也会收到确认的上下文。
- **保存与限额**：讨论以 Session 为键原子保存于 `$DSH_HOME/dsh-agent-hub/discussions/`，不随插件配置导出。每个 Session 最多 24 段，每段最多 32 轮、96,000 字符，选区上限 16,000 字符，问题上限 8,000 字符；超限明确报错，不静默截断。只有已完成的回答可暂存。
- **性能**：一个共享选区监听器，浮层与 Markdown 按需加载；打开面板时才建立可取消的流，关闭后断开，不常驻轮询。流式增量按约 40ms 合并；运行中的讨论不会因缓存淘汰而丢失。

可运行 `pnpm test:discussion-ui` 做不访问模型、不启动替代服务器的 Chrome 离线交互测试；非 macOS 或 Chrome 不在默认位置时通过 `CHROME_BIN` 指定浏览器可执行文件。该测试覆盖桌面、375px 窄屏、软键盘可视区、确认快照和焦点约束；不能代替真实 Safari/iOS 与安装后宿主联调。

## 安装

```sh
pnpm install && pnpm build
dsh plugin --profile desktop add link:<本仓库路径>
```

装好后重启 DSH，打开 **设置 → 订阅用量**。

## 开发

```sh
pnpm typecheck
pnpm test     # 解析器、缓存、配色、Claude 会话的轮次路由与 Remote Control 同步、手机访问的转发与准入、工作树（真实 git 仓库）、bot 路由与人设、@ 邀请、群主静默与补课、Claude 工具桥、审阅单解析与写回、审核守卫、提交预览，以及从同步、分析、编辑到提交的完整审核流程（真实 git 仓库）
pnpm build    # lib/index.js（宿主，ESM）+ lib/client.js（前端，宿主模块加载器格式）
```
