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

## 上架前必须满足的三件事

| 条件 | 现状 |
| --- | --- |
| `package.json` 声明 `dsh.bundle`，仓库根目录有 `cordis.patch.yml` | ✅ 已有（这是最常见的被拒原因，只有 `dsh.client` 不算可安装） |
| 仓库创建满 **1 天**（CI 自动检查） | ❌ 要等 |
| 仓库有 topic `dsh-plugin` | ❌ 建仓库后加上 |

另外三条软性的：代码真实可跑（✅ 四个测试文件全绿）、描述与代码一致（✅ 现在这份描述没写任何做不到的事）、
不是纯聚合包（✅ 自己实现了 runner / 路由 / 界面）。

---

## 1. 建仓库

⚠️ **仓库根目录必须是 `dsh-py-runner\`，不是 Obsidian vault。** 现在插件在
`C:\Users\17871\Documents\Obsidian Vault\probability\dsh-py-runner`；如果在 vault 根目录
`git init` 再 `git add .`，整个笔记库都会被推上去。

就地建仓库是安全的（这个子目录里没有笔记文件，`.gitignore` 也备好了）：

```powershell
cd "C:\Users\17871\Documents\Obsidian Vault\probability\dsh-py-runner"
git init -b main
git add .
git commit -m "dsh-py-runner 0.1.0"
git remote add origin https://github.com/amzingluo/dsh-py-runner.git
git push -u origin main
```

> 这台机器目前**没有 git**，先装 [Git for Windows](https://git-scm.com/download/win)。
>
> 想更干净可以把目录搬到 `D:\code\dsh-py-runner` 再建仓库；搬走后记得用
> `pnpm add link:` 重新指一次 profile 里的链接，否则 DSH 里跑的还是旧路径。

然后：

1. 把 `amzingluo` 换成你的 GitHub 用户名——`package.json` 的 `repository`/`homepage`/`bugs`、
   `market/dsh-py-runner.yml` 的 `url`/`name`/`icon`、本文件里的命令。
2. 仓库首页 → About 齿轮 → Topics 加 **`dsh-plugin`**。
3. 等满一天。CI 查的是仓库创建时间，不是首个 commit 时间。

---

## 2. 提 PR（只加一个文件）

在 awesome-dsh-plugin 提 PR，**只新增**一个文件：

```
data/plugins/amzingluo__dsh-py-runner.yml
```

内容直接照抄 [market/dsh-py-runner.yml](market/dsh-py-runner.yml)（`amzingluo` 换掉）。
字段就四个必需的：`url`、`name`、`category`、`description.en`；`description.zh` 可选（缺了维护者会补）。
`category: dev` —— 分类选错不会被打回，维护者直接改。

几条容易踩的：

- **不要手改 README。** 两个 README 由 `scripts/generate-readme.mjs` 从 YAML 生成。
- **不要动别人的条目。** PR 里出现无关条目的改动会被 CI 单独列出来质问。
- `description` 里出现 `: ` 必须加引号（我们的已经用双引号包好）。
- 描述只讲功能、不带营销词。写了 “46 tools” 就得真有 46 个。

CI 绿只是前置条件，之后维护者会真的读代码。

---

## 3. 上架后用户怎么装

市场卡片给出的命令是（无需 git、无需 npm）：

```powershell
dsh plugin --profile web add github:amzingluo/dsh-py-runner
```

这是列表生成器对“没有 npm、没有 tarball”的条目写出的固定格式——市场里 10974 个条目中有
**4214 个**都属于这种形态，所以这条路是主流路径，不是什么降级方案。

pnpm 拿到的是 codeload 的 tarball（不调用 `git clone`），本包零依赖、没有构建脚本，
所以这一步就是下载 + 解压。`dsh.bundle` → 市场装上就生效。

想自己先验证这条路径，仓库推上去之后在自己机器上跑一遍同样的命令即可（把 `--profile web`
换成你本地 profile 的名字，桌面端是 `desktop`）。

---

## 可选：让安装更顺（不是上架必需）

1. **发 npm**（预构建安装可跳过 `allowBuilds` 构建授权，市场卡片会直接给
   `add dsh-py-runner`）：`dsh-py-runner` 这个包名目前是空的。

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
只有改了描述、分类、图标这类条目内容时才回去改那个 YAML。

---

## 这个包的现状

- 代码：`lib/runner.js`（子进程）、`lib/index.js`（HTTP + SSE）、`lib/client.js`（手写客户端 bundle），零依赖
- 测试：`test/smoke.mjs` 19、`test/host.mjs` 25、`test/highlight.mjs` 19、`test/ui.mjs` 31，全绿
- 打包：`pnpm pack` → 27 KB，`files` 白名单之外的东西（测试、预览、工具）不进包
- 许可：MIT
