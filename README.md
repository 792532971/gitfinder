# GitFinder

> 用一句中文描述找到合适的 GitHub 项目，然后直接跑起来：部署到 WSL 的 Docker、下载 exe 装到本机，或者把代码拉到任意目录。

GitFinder 是一个 Windows 桌面工具（Electron + Vue 3 + TypeScript）。它把「找项目」和「跑起来」之间那段最麻烦的路走完了：AI 先把你的日常语言翻译成 GitHub 能听懂的搜索语法，找到项目后再帮你部署、安装或克隆。

<!-- 如果你后面补了截图，把图片放到 docs/ 下并在这里引用，例如：
![搜索页](docs/screenshot-search.png)
-->

## 功能

### 搜索

- **AI 润色描述**：接兼容 OpenAI 协议的大模型（默认 DeepSeek），把「用 Go 写的、能自托管的轻量监控面板」改写成带 `topic:`、`language:`、`stars:>` 的查询，并把模型的改写理由和推荐关键词显示出来，可以手动二次修改后再搜。
- **常规筛选**：按语言（Rust / Python / Go / TypeScript 等）、按 stars / forks / 最近更新排序，支持翻页。
- **中文简介**：结果卡片的英文简介会由 AI 译成一句中文（上方中文、下方一行灰色英文原文对照）。和榜单共用同一份提示词与缓存——榜上译过的仓库再来搜索直接命中，不重复花 token。不想看中文或用的是不支持的中转接口，可以在筛选栏关掉「中文简介」，也可以对单条点「译成中文」。
- **搜索历史**：搜成功的词会记在输入框下方，最多存 20 条、只留本机 `localStorage`。点一下就能重搜；同一句话只占一条、重复搜索只把次数和时间刷新并顶到最前。默认露 7 条，「更多」展开全部；hover 出现 `×` 删单条，「清空」需要点两次确认。输入框为空时按 `↑` 直接带出上一次的搜索词。只有搜索成功才入历史，报错的词不会污染列表。
- **失败可回退**：AI 不可用时自动用原文搜索；触及配额上限会给出明确提示而不是空白页。

### 榜单（26 个）

- **涨星速度榜**：今日 / 本周 / 本月，外加中文项目日榜、周榜。数据来自 `github.com/trending` 页面解析——这是 GitHub 唯一公开的涨星口径。
- **搜索类榜**：总星、Fork、缺人手（help-wanted）、十年常青、老而弥坚、新星（7 天到 1 年）、隐藏宝石、潜力股、今日活跃、六大主题榜等。潜力股按 `stars ÷ 创建天数` 在前端二次排序。
- **我的追踪榜**：手动关注仓库，用本地采样（`star-history.json`，同一仓库 2 小时内不重复记点）算出任意窗口的涨星差值，不占额外 API 配额。
- **中文画像**：每个项目显示中文一句话用途、领域标签、支持的安装方式（Docker / npm / pip / 安装包 / 免安装 …）和上手难度。由 AI 批量生成并缓存 14 天，没配 AI 时用元数据启发式推测并标注「推测」。

### 部署到 WSL Docker

- 自动探测仓库根目录的 `docker-compose.yml` / `Dockerfile`；都没有时从 README 里提取 `docker run` 命令降级到手动模式。
- 三种模式：`docker compose`、单容器 `Dockerfile`（可改端口、镜像名、额外 `-v` / `-e` 参数）、手动命令。
- 执行脚本先在界面上完整预览；日志实时回传；随时可以中止。

### 下载安装到本机

- 读取 GitHub Release，自动识别并推荐 Windows 安装包（`Setup.exe` / `.msi`），也支持免安装 zip 和普通压缩包。
- NSIS 安装包支持**静默安装到指定目录**（`/S /D=路径`），其它类型会正常拉起安装器由你自己点。

### 管理已装 / 已部署的东西

装过、部署过的东西都在「管理」Tab 里，记录写在 `userData/managed.json`，只认自己的记录，不去猜系统里其他程序。

- **本机应用**：显示版本、安装目录、占用大小；能「启动」「打开目录」「更新（比对最新 Release 后静默覆盖安装）」「卸载」「移除记录」。
- **卸载**：优先用注册表里的 `QuietUninstallString`，其次用目录内扫到或注册表按路径反查到的卸载器（NSIS 加 `/S`，Squirrel 用 `--uninstall`）；执行后轮询目录是否真的删掉，删掉了才移除记录。找不到卸载器时给出手动卸载指引，不会静默假装成功。
- **Docker 服务**：显示运行状态（运行中 / 已停止 / 容器丢失）、端口、compose 项目下的实际容器名、目录大小；能「打开 localhost:port」「启动 / 停止 / 重启」「更新（`git pull` → `compose pull` → `up -d --build`）」「看最近 200 行日志」「卸载（`down -v` 后删目录）」。
- **误操作兜底**：卸载要二次确认，确认框里写清会删掉什么（Docker 会连数据卷一起删）；「移除记录」只删台账不动磁盘；手动安装的记录先标「待确认目录」，点了「指定目录」才纳入自动管理。

### 容器（WSL 里全部容器）

「容器」Tab 不管你部署过没有——直接 `docker ps -a` 把当前发行版里的容器全列出来。

- **按 compose 项目分组**：从 `com.docker.compose.project` / `.service` / `.project.working_dir` 标签读数，同一个项目下的 api / nginx / cron / supervisor 归到一组，标题右侧显示项目目录（点一下在资源管理器打开 `\\wsl.localhost\...`）。不是 compose 起的容器归到「独立容器」，也可以切「平铺列表」。
- **端口能直接点**：只把映射到宿主机的端口做成蓝色 chip（`8088 → 8000`），点一下打开 `localhost:8088`；`9000/tcp` 这种只在容器网络内的端口收进副行，不占视觉。
- **状态与筛选**：运行中 / 已停止 / 已暂停 / 重启中各有状态点和颜色；顶部可按「全部 / 运行中 / 已停止 / 有端口」筛选，也能按容器名、镜像、项目名、端口号搜索。
- **操作**：启动、停止、重启（暂停的给「恢复」）、看最近 300 行日志、删除容器。删除要二次确认，确认框写明 `docker rm -f` 只删容器、不动镜像和数据卷，属于 compose 项目的会提醒去「管理」页卸载更彻底。
- **多发行版**：装了多个 WSL 发行版时右上角可切换，默认用设置里那个。docker 没装或服务没起来时给出对应提示，而不是空列表。

### 拉取到指定目录

- 可以把仓库克隆到 **Windows 本地目录** 或 **WSL 内目录**，父目录可浏览选择（WSL 支持 `~/projects` 写法，不存在自动创建）。
- 可设文件夹名、分支或 tag、克隆深度（depth=1 / 50 / 完整历史）、是否拉取子模块、是否走代理。
- 目录已存在时三选一：更新（`fetch` + `pull --ff-only`）、报错提示、自动加 `-2` 后缀新建。
- 完成后可一键「在资源管理器打开」，WSL 路径会自动转成 `\\wsl$\<发行版>\...`。

### 环境诊断与配额

- **WSL / Docker 诊断**：跑一组只读探测（`wsl -l -v`、`--status`、注册表、`LxssManager` 服务、WSL 内 docker 版本），先把「命令 + 退出码 + 原始输出」作为证据给出本地结论；配了 AI 再让模型补充原因和修复建议。
- **AI 不执行命令**：模型只能在 4 个白名单探测里点名补充信息，不会被当成 shell 执行器。
- **GitHub 配额面板**：读 `/rate_limit`（本身不耗配额），显示 core / search / graphql 的剩余额度、进度条和重置倒计时。
- **配额兜底**：core 配额用尽时，仓库详情可自动降级走搜索接口的 `repo:owner/name`（配额池独立），避免未登录用户打开几次就被锁一小时。

## 快速开始

```bash
# 需要 Node.js 18+（建议 20 或更高）与 Git
npm install
npm run dev      # 开发模式，热更新
```

打包 Windows 安装包：

```bash
npm run dist     # 输出到 dist/GitFinder Setup <版本>.exe（NSIS，可选择安装目录）
npm run dist:dir # 只生成免安装的 dist/win-unpacked/
```

## 配置

首次运行点击右上角「设置」，按需填写：

| 配置 | 作用 | 不填会怎样 |
| --- | --- | --- |
| GitHub Token | 配额从 60 次/小时提到 5000 次/小时，可读私有仓库 | 榜单、README、Release 容易触顶，会提示「配 Token」 |
| 代理 | 支持 `http://127.0.0.1:7890`、`socks5://127.0.0.1:7891` | 走系统代理；WSL 内 git 会把 `127.0.0.1` 自动换成 Windows 主机网关地址 |
| AI Base URL / Key / 模型 | 兼容 OpenAI 协议即可（DeepSeek、Kimi、智谱、本地 vLLM…） | 搜索仍可用，只是不做描述的语义改写、结果简介保持英文原文，榜单中文画像降级为「推测」 |
| WSL 发行版 / 工作目录 | 部署与克隆的默认目标 | 自动取默认发行版，目录默认 `~/gitfinder-apps` |
| 默认安装目录 | 静默安装的目标路径 | 安装时会让你选 |

配置文件在 `%APPDATA%\gitfinder\settings.json`，同目录还有榜单缓存、中文画像缓存、追踪列表与星标采样历史，删除即恢复默认。

## 项目结构

```
src/
├─ main/                  Electron 主进程
│  ├─ index.ts            窗口、单实例锁、代理初始化
│  ├─ ipc/                能力模块（全部经白名单包装）
│  │  ├─ github.ts        搜索 / README / Docker 探测 / Release
│  │  ├─ ai.ts            描述润色
│  │  ├─ leaderboard.ts   26 个榜单、缓存、追踪
│  │  ├─ deploy.ts        生成并执行 WSL Docker 部署脚本
│  │  ├─ clone.ts         克隆到 Windows / WSL 指定目录
│  │  ├─ installer.ts     流式下载 + NSIS 静默安装
│  │  ├─ manage.ts        管理页：台账探测、卸载、更新、容器启停 / 日志
│  │  ├─ containers.ts    容器页：docker ps -a 全量采集、按 compose 项目分组
│  │  └─ quota.ts         GitHub 配额
│  └─ lib/                wslprobe（环境诊断）、profile（中文画像）、managed（台账）、
│                         shell（base64 脚本传输）、settings、http、llm…
├─ preload/               contextBridge 桥接，错误信息带 hint 回传
├─ renderer/              Vue 3 界面（搜索、榜单、容器、管理、8 个弹窗组件）
│  └─ src/searchhistory.ts 搜索历史（localStorage，判重 / 计数 / 清理）
└─ shared/                主进程与渲染层共享的类型、榜单定义
```

## 几个设计上的取舍

- **脚本经 base64 传入 WSL**：`echo '<base64>' | base64 -d | bash -s`，彻底绕开 Windows → WSL 的引号与反斜杠转义问题。
- **Windows 侧调用 git 不过 shell**：走 `spawn(git, args[])` 参数数组，天然免疫命令注入；WSL 侧一律单引号包裹并做字符白名单校验。
- **git 进度不刷屏**：git 用 `\r` 刷新进度，这里按 `\r\n|\r|\n` 切行，并按 `Counting / Compressing / Receiving / Resolving` 阶段原位替换最后一行。
- **错误提示要能落地**：跨 `contextBridge` 抛出的 Error 会丢自定义属性，所以把排查建议直接拼进 message。
- **所有网络请求走 Electron `net.fetch`**：这样 `session.setProxy` 设置的代理对 GitHub API、raw 文件、Release 下载全部生效。

## 已知限制

- 只做了 Windows 打包（NSIS），macOS / Linux 未适配。
- 静默安装只对 NSIS 安装包有效；`.msi` 和免安装包会拉起安装器或提示手动解压。
- 容器页依赖 `wsl.exe` 能正常调用；如果系统安全策略把 `wsl.exe` 拉黑，页面会直接显示「读不到容器列表」，不会静默空列表。
- 管理页只认本应用产生的记录：安装/部署之前就存在的程序、手动 `docker run` 起的容器不会自动出现；手动安装的记录需要点「指定目录」确认路径后才能自动更新/卸载。
- Docker「更新」是就地 `git pull` + 重建，不做代码备份，改过仓库内文件的项目需要先自行提交或备份。
- Docker 探测只看仓库根目录，配置放在 `docker/`、`deploy/` 子目录的项目需要用手动模式。
- 应用图标目前还是 Electron 默认图标（`win.signAndEditExecutable: false` 的副作用，见下文）。
- WSL 相关能力依赖本机 `wsl.exe`；被安全软件拦截时会提示「探测失败」但仍可手工填路径重试。

## 常见问题

**打不开或白屏？**
从 Electron 应用内派生的终端可能带着 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 以纯 Node 模式启动。用 `npm run dev`（内部走 `scripts/run.mjs`，会清掉这个变量），别直接 `electron .`。

**打包时 winCodeSign 解压失败？**
`electron-builder` 下载的 winCodeSign 含 macOS 符号链接，Windows 无权限解压。项目里已设 `win.signAndEditExecutable: false` 绕过，代价是 exe 使用默认图标与元数据。

**填了 Token 还是提示「Token 未生效」？**
先确认 Token 是 `ghp_` / `github_pat_` 开头的一整串（40 位以上），中间没有空格或换行；再确认没在 GitHub 里被删除、没过期。现在保存设置时会先拿这个 Token 请求一次 `/rate_limit` 验证，验不过就不会写入，弹窗会留着并说明原因。如果 Token 是在别的机器或旧版应用里填的，删掉 `%APPDATA%\gitfinder\settings.json` 里的 `githubToken` 再填一次。
另外，Token 只在创建页面显示一次，忘了原文只能重新生成一个（旧的可顺手删掉）。

**部署时报 Docker 不可用？**
在目标发行版里确认 `docker info` 能跑通；`permission denied` 一般是没加进 docker 组（`sudo usermod -aG docker $USER` 后重开 WSL）。

**拉取报 `spawn git ENOENT`？**
以前是父目录不存在导致 `cwd` 无效（报错信息会误导成没装 git），现在会先建目录；如果仍出现，说明本机没装 Git for Windows 或没进 PATH。

## 技术栈

Electron 33 · Vue 3 · TypeScript · Vite（electron-vite）· electron-builder（NSIS）

## License

[MIT](LICENSE)

## 说明

本项目仅用于提升开源项目的发现与本地运行效率。使用 GitHub API 请遵守其[服务条款](https://docs.github.com/site-policy/github-terms/github-terms-of-service)与速率限制；AI 功能会产生第三方模型调用费用，请自行评估。
