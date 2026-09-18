# 上下文压缩优化分支说明

本分支基于 `earendil-works/pi`，**只包含对 compaction（上下文压缩）的优化**，不开发其它功能。
除本文件和下列列出的代码文件外，所有代码与上游保持一致。

## 改动内容

### 1. 压缩摘要复用会话 prompt 前缀（KV cache 优化）

- Compaction summarization now reuses the live session prompt prefix: the summary request sends the session's actual system prompt, tool declarations, and history messages, with the summarization instruction appended as the final message, instead of a standalone serialized transcript with a separate summarization system prompt. Split turns are summarized in a single request. Providers with prefix KV caching (for example local servers) can serve the summarized history from cache instead of re-prefilling it. `CompactionPreparation` now includes the required `contextPrefix` field with the exact messages sent as the prefix.
- `agent-session.ts`：压缩请求转发 session id（`this.sessionManager.getSessionId()`），用于 transport session affinity。

### 2. 版本标记

`packages/coding-agent/src/config.ts`：`VERSION` 拼接 `+kvcache`，`pi --version` 显示如 `0.86.0+kvcache`，与原版本区分。

### 3. 摘要提示词强化（防止模型陷入会话中的调试而不停止）

在以下三处提示词中加入：
`Do NOT perform any further investigation. ONLY output the structured summary factually, based solely on the current conversation.`

- `SUMMARIZATION_PROMPT`（初始压缩，`compaction.ts`）
- `UPDATE_SUMMARIZATION_INSTRUCTIONS`（增量压缩，`compaction.ts`）
- `SUMMARIZATION_SYSTEM_PROMPT`（独立摘要路径，`compaction/utils.ts`，同时补了 `Do NOT call any tools.`）

## 本分支涉及的文件

- `packages/coding-agent/src/core/compaction/compaction.ts`
- `packages/coding-agent/src/core/compaction/utils.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/config.ts`（仅 VERSION 拼接 `+kvcache`）
- `packages/coding-agent/test/compaction-summary-reasoning.test.ts`
- `COMPACTION_CHANGES.md`（本文件）

## 工作原则

1. 本分支只保留上下文压缩相关的改动；其余代码一律与上游保持一致。
2. 本分支的说明和 changelog 内容写在**本文件**中，不修改 `packages/*/CHANGELOG.md`，以减少 rebase 冲突。
3. 推送规则（强制，违反任何一条都算错误）：
   - 任何 push **只能**指向 fork：`git@github.com:jgbrblmd/pi.git`（即 `origin`）。
   - **严禁**向原仓库 `upstream`（`earendil-works/pi`）推送任何提交、分支，也**严禁**向其提交 PR（包括 fork → upstream 方向的 PR）。
   - GitHub 上只允许存在 fork 的 `main` 一个分支。**只允许** `git push origin <本地工作分支>:main` 这种"更新 fork main"的推送。
   - **严禁**执行 `git push origin <分支名>`（无 `:main`）——那会在 fork 上创建新远程分支；**严禁** `git push -u`、`git push --all` 或任何会创建/更新 `main` 以外分支引用的推送。
   - rebase 改写了历史之后，同步 fork main 用 `git push --force-with-lease origin <本地工作分支>:main`（只覆盖 fork main，不碰任何其它分支）。
4. 版本标记：`packages/coding-agent/src/config.ts` 中 `VERSION` 在 package.json 版本号后拼接 `+kvcache`（如 `0.86.0+kvcache`），`pi --version` 据此与原版本区分。**不要**修改 `package.json` 的 `version` 字段：monorepo 的 install-lock 校验要求所有内部包版本一致，且 `packages/evals` 依赖 `^0.86.0`，改版本号会破坏安装。rebase 后版本号自动跟随上游，无需额外维护。
5. 不直接修改 `packages/ai/src/models.generated.ts`；模型目录如有变化，通过 `packages/ai/scripts/generate-models.ts` 重新生成。
6. 提交信息格式：`{feat,fix,docs}(coding-agent): <message>`；只提交本分支范围内的文件（不用 `git add -A`）。

## 常规操作：上游更新后同步

远程定义：

- `origin` = `git@github.com:jgbrblmd/pi.git`（个人 fork）
- `upstream` = `https://github.com/earendil-works/pi.git`（上游）

```bash
git fetch upstream
git rebase upstream/main        # 本分支通常只有 1 个提交
npm run check                   # 必须全部通过（biome + 各类脚本 + tsgo --noEmit）
npm run build                   # 根目录全量构建（rebase 后必须，原因见下方排查）
```

rebase 后构建报错排查（只构建单个包时必现）：

- 症状：rebase 后只在 `packages/coding-agent` 下执行 `npm run build`，`build:unbundled`（tsgo）报错，
  如 `Property 'inputLimits' does not exist on type 'Model<any>'`、
  `'meta' does not exist in type 'Record<KnownProvider, string>'`、
  `no exported member 'ModelImageResizeOptions'` 等——报错内容都是上游新引入的类型。
- 原因：根目录 `npm run check` 的 tsgo 把 workspace 依赖映射到源码，所以能通过；
  而各包的 `tsconfig.build.json` 通过 `node_modules` 符号链接把 `@earendil-works/pi-ai` 等
  解析到 `packages/ai/dist`（构建产物）。rebase 引入上游新类型后，依赖包的 dist 仍是
  rebase 前的旧产物，coding-agent 对着旧 d.ts 做类型检查即失败。
- 处理：在仓库根目录执行 `npm run build`（按拓扑顺序全量重建：chord → tui → telemetry →
  ai → durable → agent → session-backends/sqlite-node → protocol → client → server →
  coding-agent，含 bundle）。之后单包 `npm run build` / `build:binary` 才能正常。

同步到 fork（rebase 之后）：

```bash
git push --force-with-lease origin main:main   # rebase 改写了历史，必须用 force-with-lease（本地 main → fork main）
```

rebase 冲突处理：

- 只解决本分支改过文件的冲突（预计最多 `compaction.ts` / `agent-session.ts`）。
- 其它文件出现冲突：`git rebase --abort` 后人工确认，不要强行解决。
- 如果上游对 compaction 的实现有重构，先评估上游改动再决定如何合并，保持"上游优先、本分支只叠加压缩优化"的原则。

## 构建与部署：生成可在其它机器安装的包

前提：本仓库已 `git fetch upstream` 并完成 rebase，`npm run check` 通过，且已按上方说明
在**根目录**完成 `npm run build`（rebase 后不能只构建单包，见上方排查）。

### 方式 A：单文件二进制（推荐，目标机零依赖）

```bash
cd packages/coding-agent
npm run build:binary          # 需要本机安装 bun；产出 dist/pi
```

- 把 `dist/pi` 拷贝到目标机（**操作系统和架构必须一致**，如 linux-x64 → linux-x64）。
- 目标机直接运行 `./pi`。
- 验证：`./pi --version` 应输出 `0.86.0+kvcache` 形式的版本号。

### 方式 B：npm 包（目标机需 Node 24+ 且能访问 npm）

```bash
cd packages/coding-agent
npm run build                 # 先构建
npm pack                      # 产出 pi-coding-agent-<版本>.tgz（包内 version 为上游版本号）
```

把 tgz 拷贝到目标机后：

```bash
npx -y ./pi-coding-agent-*.tgz                       # 单次运行
# 或安装后使用：
npm i ./pi-coding-agent-*.tgz && npx pi
```

- 运行时依赖（`@earendil-works/chord` 等）由目标机从 npm registry 安装；本分支改动都在 coding-agent 包内，其余依赖用 registry 版本即可。
- 验证：`pi --version` 输出 `0.86.0+kvcache` 形式的版本号，与原版本（`0.86.0`）区分。

### 推送到 fork（仅在需要时）

```bash
git push origin main:main                       # 只更新 fork 的 main（本地 main → fork main）
# rebase 改写历史后：
git push --force-with-lease origin main:main
```

**禁止** `git push origin <任何其它分支名>`（会在 fork 上创建新分支）；禁止 push 到 `upstream`；禁止向 `upstream` 开 PR（见工作原则第 3 条）。

注：本地只有一个工作分支 `main`（已设置跟踪 `origin/main`）；`git pull` 拉 fork，同步上游用 `git fetch upstream && git rebase upstream/main`。
