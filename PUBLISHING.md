# 上架 DSH 市场（dshmarket）

先说结论：**dshmarket 没有上传接口，也没有“提交表单”。** 市场里的插件列表来自
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 这个精选列表——
dshmarket 会去读它的 `plugins.json`（`https://awesome-dsh-plugin.com/plugins.json`，
国内走 npm 上的 `dsh-plugin-catalog` 镜像）。

所以“发布到 dshmarket”只有一条路：**在那个仓库加一个 YAML 文件，提 PR，合并后市场自动收录**
（通常一天内生效）。npm 发布**不是必需项**，只是安装体验更好。

```
GitHub 仓库  ──PR(add data/plugins/amzingluo__dsh-py-runner.yml)──▶  awesome-dsh-plugin
                                                                      │ 生成
                                                                      ▼
                                                            plugins.json
                                                                      │ 读取
                                                                      ▼
                                                              dshmarket 列表
```

---

## 进度（2026-11-15 晚）

| 事项 | 状态 |
| --- | --- |
| 插件仓库 | ✅ https://github.com/amzingluo/dsh-py-runner（public，`main`，2 个 commit，20 个文件） |
| `package.json` 声明 `dsh.bundle` + 根目录 `cordis.patch.yml` | ✅ 已有（这是最常见的被拒原因，只有 `dsh.client` 不算可安装） |
| topic `dsh-plugin` | ✅ 已加（另有 `python` / `deepseek-harness` / `dsh`） |
| 市场条目文件 | ✅ `market/dsh-py-runner.yml` 已写好，与目录里其他条目同格式（单引号描述 + `icon`） |
| fork + 分支 | ✅ fork 出 `amzingluo/awesome-dsh-plugin`，分支 `add-dsh-py-runner` 已提交 `data/plugins/amzingluo__dsh-py-runner.yml` |
| **提 PR** | ⏳ **等仓库满 1 天**：仓库创建于 `2026-11-15T15:41:57Z`（本地 23:41），**2026-11-16 23:42 之后**才能过 CI |
| 代码/文档一致性 | ✅ 四个测试文件全绿（19 / 25 / 19 / 31），描述里没写做不到的事 |

一键开 PR（点开确认标题和正文即可）：

```
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...amzingluo:awesome-dsh-plugin:add-dsh-py-runner?expand=1
```

建议标题：`add dsh-py-runner`；正文：

```markdown
VSCode-style Python run/debug console for the DSH sidebar.

- Tabs `.py` files into an editor with line numbers + Python syntax highlighting, keeps unsaved state, writes back with `read`/`save` endpoints confined to the session workspace.
- Run / Debug / Stop with live stdout+stderr+exit code over SSE; Debug runs the script under `python -m pdb` and forwards typed pdb commands; stdin works in normal runs too.
- Interpreter autodetection (config → env vars → Miniconda/Anaconda → DSH bundled python → PATH), GBK/UTF-8 sniffing with a read-only guard for non-UTF-8 files.
- Zero dependencies, no build step; `github:amzingluo/dsh-py-runner` installs in ~3 s. Tests: `test/{smoke,host,highlight,ui}.mjs`.
```

---

## 一个还没写进官方文档的坑：`github:` 安装需要 git

市场卡片对没有 npm、没有 tarball 的条目给出的命令是
`dsh plugin --profile web add github:<owner>/<repo>`。实测（本机 pnpm 11.28.5 / node 24）：

- pnpm **会先跑 `git ls-remote`** 解析 ref，再去 codeload 下 tarball —— 所以**用户机器必须装 git**，
  否则直接 `[ERR_PNPM_GIT_RESOLVE_FAILED] ... git ls-remote failed: 'git' 不是内部或外部命令`。
- 补上 git 之后 3.2 秒装完，`node_modules/dsh-py-runner` 7 个文件，`dsh.bundle` 就位。

（`dshmarket/lib/accelerate.js:5` 的注释说 pnpm 不用 `git clone`，这句只说对了一半：它确实不 clone，但要用 git 解析。）

已经在 README 的安装段标注。想让门槛更低就再发个 npm 包（npm 安装不走 git）。

---

## PR 注意点（来自 contributing.md）

只新增一个文件 `data/plugins/amzingluo__dsh-py-runner.yml`，字段四个必需的：`url`、`name`、`category`、`description.en`。

- **不要手改 README。** 两个 README 由 `scripts/generate-readme.mjs` 从 YAML 生成。
- **不要动别人的条目。** PR 里出现无关改动会被 CI 单独列出来质问。
- `description` 里出现 `: ` 必须加引号；目录里惯用单引号，描述内部有 `'` 就写成 `''`。
- `category` 选错不会被打回（维护者直接改）；本插件是 `dev`（Development & Runtime）。
- `icon` 是可选的 GitHub 托管位图，缺省回落到作者头像；我们用的是仓库里的 `assets/icon.png`（512×512 PNG）。
- 描述只讲功能、不带营销词。写了 "46 tools" 就得真有 46 个。
- CI 绿只是前置条件，之后维护者会真的读代码。

---

## 上架后用户怎么装

市场卡片给出的就是（需要 git，见上）：

```powershell
dsh plugin --profile web add github:amzingluo/dsh-py-runner
```

市场里 11137 个条目中有 4214 个都是这种“没有 npm、没有 tarball”的形态，这是主流路径，不是降级方案。

---

## 可选：让安装更顺（不是上架必需）

1. **发 npm**（市场卡片会直接给 `add dsh-py-runner`，安装不走 git）：`dsh-py-runner` 这个包名目前是空的。

   ```powershell
   $node = "C:\Users\17871\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
   $pnpm = "C:\Users\17871\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
   & $node $pnpm publish --dry-run --no-git-checks --access public   # 先看会发什么
   & $node $pnpm publish --access public --no-git-checks            # 需要 npm 登录
   ```

   仓库里的 `.github/workflows/release.yml` 已经接好：推 tag 自动发 npm + 挂 tarball 到 Release
   （secret 叫 `NPM_TOKEN`）。

2. **挂 Release tarball**：给市场条目加可选字段 `tarball:`。资产名**别带版本号**——
   `releases/latest/download/` 只在请求时解析 `latest`，文件名照字面取，带版本号下次发版就 404。

---

## 每次发版

```powershell
# 改 version → commit → tag → push
git tag v0.1.1 && git push --tags
```

市场按仓库和 npm 版本自动刷新（`version`、`stars`、`downloads` 都是抓的），**不需要再提 PR**；
只有改了描述、分类、图标这类条目内容时才回去改那个 YAML（下一次提 PR 会被 CI 查重复）。

---

## 这个包的现状

- 代码：`lib/runner.js`（子进程）、`lib/index.js`（HTTP + SSE）、`lib/client.js`（手写客户端 bundle），零依赖
- 测试：`test/smoke.mjs` 19、`test/host.mjs` 25、`test/highlight.mjs` 19、`test/ui.mjs` 31，全绿
- 打包：`pnpm pack` → 27 KB，`files` 白名单之外的东西（测试、预览、工具）不进包
- 许可：MIT
