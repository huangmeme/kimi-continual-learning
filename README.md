# Continual Learning

Kimi Code 插件：从会话 transcript 中增量学习用户偏好与工作区事实，并用简洁的 bullet 持续维护项目根目录的 `AGENTS.md`。

## 它做什么

会话结束（`Stop` hook）时，插件会按节奏判断是否该更新记忆。满足条件后，会触发 `continual-learning` skill，在后台启动 `coder` 子代理：

1. 读取本项目相关的 Kimi Code 会话 transcript（位于 `$KIMI_CODE_HOME`，默认 `~/.kimi-code`）
2. 只提取可复用、长期有效的信息：
   - 用户明确的偏好 / 纠正
   - 已验证的工作区事实
3. 保留 `AGENTS.md` 的既有结构做定点合并（不强制固定章节，不设会丢弃有效约束的条数上限）；细节按主题写入 `.agents/memory/` 下的 topic 文件，`AGENTS.md` 的 `## Memory Index` 只为每个主题保留一行索引（主题、路径、触发条件）
4. 用增量索引避免重复处理同一份 transcript

插件不会写入密钥、一次性指令或短暂细节。

## 工作原理

| 组件 | 作用 |
| --- | --- |
| `hooks/continual-learning-stop.mjs` | `Stop` 事件钩子：累计回合数与时间，达到阈值后阻塞 Stop 并提示模型跑记忆更新 |
| `skills/continual-learning/SKILL.md` | 编排 skill：上锁、拉起后台 `coder` 子代理，本身不直接挖 transcript |
| `AGENTS.md` | 项目级记忆文件（由后台 updater 维护） |
| `.kimi-code/hooks/state/` | 本地状态、增量索引与单飞锁 |

默认触发节奏（非 trial）：

- 距上次运行至少 **10** 个 turn
- 距上次运行至少 **120** 分钟
- 且本项目相关 transcript 有新内容

## 安装

需要已安装 [Kimi Code CLI](https://www.kimi.com/code/docs/)。

### 从 GitHub 安装（推荐）

在 Kimi Code TUI 中执行：

```text
/plugins install https://github.com/huangmeme/kimi-continual-learning
```

也可指定分支 / tag / commit，例如：

```text
/plugins install https://github.com/huangmeme/kimi-continual-learning/tree/main
```

### 交互式安装

1. 运行 `/plugins`
2. 用 `Tab` 切到 **Custom**
3. 粘贴仓库 URL 或本地路径后安装

### 从本地目录安装

克隆本仓库后：

```text
/plugins install /path/to/kimi-continual-learning
```

### 生效

安装、启用或禁用插件后，运行 `/reload` 或 `/new`，当前会话不会自动加载变更。

可用命令：

```text
/plugins list
/plugins info continual-learning
/plugins enable continual-learning
/plugins disable continual-learning
/plugins remove continual-learning
```

## 使用方式

安装并 reload 后，插件在后台按节奏自动工作，一般无需手动干预。自动运行（Stop hook 触发）不做开场宣告；没有高信号变更时完全静默，只在有实际变更或出错时简要汇报。

也可以在对话里直接要求更新记忆（手动运行总会转达结果，包括无变更），例如：

- 「从之前的对话里提炼偏好，更新 AGENTS.md」
- 「跑一遍 continual-learning」

首次触发前，项目里可以没有 `AGENTS.md`；updater 只创建真正需要的章节与索引。

## 配置（可选）

通过环境变量调整触发节奏（均支持 `CONTINUAL_LEARNING_*` 与旧名 `CONTINUOUS_LEARNING_*`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CONTINUAL_LEARNING_MIN_TURNS` | `10` | 两次更新之间最少 turn 数 |
| `CONTINUAL_LEARNING_MIN_MINUTES` | `120` | 两次更新之间最少间隔（分钟） |
| `CONTINUAL_LEARNING_LOCK_STALE_MINUTES` | `45` | 单飞锁超时后可回收（分钟） |
| `CONTINUAL_LEARNING_TRIAL_MODE` | 关闭 | 设为 `1` / `true` 开启试用窗口 |
| `CONTINUAL_LEARNING_TRIAL_DURATION_MINUTES` | `1440` | 试用窗口时长（分钟） |
| `CONTINUAL_LEARNING_TRIAL_MIN_TURNS` | `3` | 试用期内最少 turn 数 |
| `CONTINUAL_LEARNING_TRIAL_MIN_MINUTES` | `15` | 试用期内最少间隔（分钟） |
| `KIMI_CODE_HOME` | `~/.kimi-code` | Kimi Code 数据根目录（transcript 所在位置） |

Windows 下配置持久环境变量不便时，也可以在项目根目录放 `.kimi-code/hooks/state/continual-learning.config.json`。优先级：环境变量 > 配置文件 > 默认值。配置文件使用 camelCase 键：

| 键 | 对应环境变量 |
| --- | --- |
| `minTurns` | `CONTINUAL_LEARNING_MIN_TURNS` |
| `minMinutes` | `CONTINUAL_LEARNING_MIN_MINUTES` |
| `lockStaleMinutes` | `CONTINUAL_LEARNING_LOCK_STALE_MINUTES` |
| `trialMode` | `CONTINUAL_LEARNING_TRIAL_MODE` |
| `trialDurationMinutes` | `CONTINUAL_LEARNING_TRIAL_DURATION_MINUTES` |
| `trialMinTurns` | `CONTINUAL_LEARNING_TRIAL_MIN_TURNS` |
| `trialMinMinutes` | `CONTINUAL_LEARNING_TRIAL_MIN_MINUTES` |

## 仓库结构

```text
.
├── kimi.plugin.json                 # 插件清单
├── hooks/
│   └── continual-learning-stop.mjs  # Stop hook
└── skills/
    └── continual-learning/
        └── SKILL.md                 # 记忆更新编排 skill
```

## License

MIT
