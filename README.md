# Garmin 双账号 · 国区 → 国际区自动同步

自用项目：把**两个使用者的佳明国区账号**的运动活动，定时自动同步到各自的国际区账号。
Fork 自 [gooin/dailysync-rev](https://github.com/gooin/dailysync-rev)。

**跑在自己的 Mac mini 上**（launchd 每 6 小时一次），不依赖任何云服务器，也不依赖
GitHub Actions。之前的 EC2 常驻服务已经退役。

## 总览

| | 账号1 | 账号2 |
|---|---|---|
| 特点 | 无 MFA | **开了 ECG**，国区登录强制邮箱验证码 |
| 定时同步 | 本机 launchd，每 6 小时 | 同左（同一个进程里顺序跑） |
| 国区 token 失效时 | `yarn relogin:cn 1`（账号密码直接登录） | `yarn relogin:account2`（浏览器登录 + 163 邮箱自动取码） |
| 国际区 token 失效时 | 浏览器铸票 → `yarn import:global-token 1` | 同左，编号换成 2 |
| 预计人工介入频率 | 一年 1~2 次 | 一年 1~2 次 |

## 它是怎么工作的

```
launchd (0/6/12/18 点)
  └─ scripts/run-sync.sh          互斥锁 + 硬超时 + 日志轮转
       └─ node dist/sync.js       账号1、账号2 顺序跑，互不影响
            ├─ 读 ~/.dailysync/garmin.db 里加密的 OAuth token
            ├─ 拉国区最近 10 条活动 + 国际区最近 10 条活动
            ├─ 按「时间指纹」做集合差集，算出还没同步的
            └─ 下载原始 FIT → 上传国际区 → 刷新后的 token 写回库
```

同步判定用活动的**时间指纹**（startTimeGMT + 时长 + 距离）做集合差集，而不是简单比对
最新一条的时间。所以乱序补传、同名活动、跨时区都不会漏；上传失败的活动下次会自动重试。

### 一条重要的设计约束：同步过程永远不会自己登录

佳明的长效 OAuth1 大约一年有效，短效 OAuth2 由库用 OAuth1 自动刷新。所以日常同步
只需要消费 token，完全不碰登录流程，也就不会触发任何验证码。

代码里**没有**「token 失效就自动密码登录」这条兜底路径，这是刻意的：

- 国际区 `sso.garmin.com` 2026-03 起挂了 Cloudflare bot 检测，脚本登录必被 429。
  社区实证限流按「账号 + clientId」计，换 IP 没用，反复重试会升级成账号级封锁 48-72 小时。
- 账号2 国区开了 ECG，密码登录必然触发验证码邮件，无人值守时只会白发邮件。

所以 token 真失效时，程序只做一件事：抛 `REAUTH_REQUIRED` + 发 Bark 推送，然后停下来
等人跑对应的 relogin 命令。

## 目录约定

代码在仓库里，**所有会变化、含凭据的东西都在仓库外**的 `~/.dailysync/`：

```
~/.dailysync/
├── garmin.db              加密的 OAuth session（AES）
├── playwright/            账号2 登录用的 Chromium profile（含站点 cookie）
├── fit/                   同步过程中下载的原始活动文件
├── logs/                  sync-YYYY-MM-DD.log，保留 14 天
└── global_token.json      国际区铸票的中间产物
```

这样 token 在物理上就不可能被 git 提交，也避开了仓库所在的 iCloud 同步目录
（iCloud 会对 sqlite WAL 和 Chromium profile 做逐字节同步和逐出，两者都不安全）。

想换位置就设 `DAILYSYNC_DATA_DIR`。

## 安装

```bash
corepack enable                    # 本机 yarn 不在 PATH，用 corepack
corepack yarn install
npx playwright install chromium    # 账号2 重新登录时才用得到，先装好
corepack yarn build

cp .env.example .env               # 填账号信息，见文件内注释
bash scripts/install-launchd.sh    # 装定时任务
```

## 日常维护：基本不需要

正常情况全自动。出问题会收到 Bark 推送，按推送内容对号入座：

### ① 国区 token 失效

```bash
corepack yarn relogin:cn 1          # 账号1：直接账号密码登录
corepack yarn relogin:account2      # 账号2：开浏览器登录 + 自动读 163 邮箱验证码
```

账号2 那条会弹出一个浏览器窗口，全程自动，约 1~5 分钟。跑之前确认 `.env` 里的
`MAIL_IMAP_PASSWORD` 是有效的 163 **授权码**（不是登录密码）——它会因为改密码或
长期不用被吊销，这是「一年后真要用时才发现坏了」的经典陷阱。

### ② 国际区 token 失效（约一年一次）

`sso.garmin.com` 有 Cloudflare 机器人检测，脚本直接密码登录会被 429（这不是频率限制，
等多久都没用）。用「浏览器铸票」绕开：

1. 电脑 Chrome 登录国际区（`connectus.garmin.cn`）
2. 同一浏览器访问 `https://sso.garmin.com/sso/embed?clientId=GarminConnect&locale=en`，
   会自动跳转，复制地址栏 `ticket=` 后面的 `ST-…-cas`
3. 在项目根目录跑：

```bash
GARMIN_GLOBAL_TICKET='ST-…-cas' corepack yarn export:global-token
corepack yarn import:global-token 2      # 1 或 2 是账号编号
```

> 原理：浏览器里已登录的会话可以免密铸出 ServiceTicket，真实浏览器指纹不会被 Cloudflare
> 拦；脚本再用裸 https 把 ticket 换成长效 OAuth1（约 1 年）+ OAuth2（自动刷新）。

### 其它常用命令

```bash
corepack yarn sync                 # 立刻同步两个账号
corepack yarn sync 2               # 只同步账号2
node scripts/sync-report.js        # 过去 24 小时同步了多少条（每日简报用）
tail -f ~/.dailysync/logs/sync-$(date +%F).log

launchctl kickstart -k gui/$(id -u)/xyz.gaoran.dailysync   # 手动触发一次定时任务
launchctl print gui/$(id -u)/xyz.gaoran.dailysync | head   # 看定时任务状态
bash scripts/install-launchd.sh uninstall                  # 卸载定时任务
```

## 代码结构

```
src/
├─ sync.ts                     定时同步入口（yarn sync [1|2]）
├─ accounts.ts                 两个账号的配置（从 .env 读）
├─ relogin_cn.ts               国区账号密码重新登录（账号1）
├─ relogin_account2.ts         账号2 国区重新登录（Playwright + 163 取码）
├─ export_garmin_global_session.ts  国际区铸票导出 token
├─ import_global_token.ts      把铸好的国际区 token 落库
├─ service/
│  ├─ account2_auth.ts         Playwright 登录 + 截获一次性 ticket
│  ├─ mail_code_fetcher.ts     IMAP 自动读验证码（过滤 #000000 之类假阳性）
│  └─ config.ts                账号2 登录相关配置
├─ mfa/garmin_sso_mfa.ts       国区 SSO：密码换 ticket、ticket 换 OAuth token
└─ utils/
   ├─ garmin_cn.ts             国区客户端 + 同步主逻辑（指纹差集）
   ├─ garmin_global.ts         国际区客户端（只消费 token）
   ├─ garmin_common.ts         下载/上传/错误分类/Bark/token 持久化
   └─ sqlite.ts                session 加密存取
scripts/
├─ run-sync.sh                 launchd 包装：互斥锁、超时、日志
├─ install-launchd.sh          安装/卸载定时任务
└─ sync-report.js              每日简报统计
```

## 踩坑记录（重要）

- **国际区 429 不是限速**：2026-03 起 Garmin 在 `sso.garmin.com` 前上了 Cloudflare bot
  检测（TLS 指纹层面），非浏览器客户端密码登录直接 429，反复重试会升级成账号级封锁
  48-72 小时。解法就是上面的「浏览器铸票」。国区 `garmin.cn` 的旧版 `/sso/signin` 挂件
  路径没有这个限制。
- **错误分类比重试策略更重要**。把网络抖动误判成「登录失效」，代价是删掉需要邮箱验证码
  才能重造的 OAuth1；把「登录失效」误判成抖动，代价是永远静默重试、没人知道坏了。所以
  `isAuthFailure()` 只认死证据（401、明确的 token 失效文案、`No OAuth2 token available`），
  **403 刻意排除**——佳明的 403 绝大多数来自 WAF/风控，不是 token 失效。
- **库的 axios 默认超时只有 5 秒**，跨境访问佳明经常不够，项目统一覆盖成 30 秒。
- **写库前必须校验 token 结构**。历史上有一次 ticket 交换拿到的是佳明「未登录」页面的
  HTML，代码没校验就存了进去，于是库里躺着一个 5000 多键的字符索引对象——它是 truthy，
  会绕过「没有 session」的判断，表现为每次同步静默空转。现在 `sqlite.ts` 进出都校验。
- **WAL 模式下 `process.exit()` 不会 checkpoint**。账号2 的重新登录 CLI 因为 Playwright
  常驻 Chromium 必须强退，不显式 `closeDB()` 就会静默丢掉刚拿到的 token。
- **Garmin 验证码邮件是纯 HTML**，正文里 `#000000` 颜色值会被 `\d{6}` 误当验证码——取码
  要按关键词就近匹配并过滤噪声（`mail_code_fetcher.ts` 已处理）。
- **163 IMAP 要求客户端发送 IMAP ID**（RFC 2971），否则报 `Unsafe Login`；用的是**授权码**
  而不是登录密码。两个坑代码里都已覆盖。
- **OAuth1 约 1 年有效，OAuth2 短效可自动刷新**——所有登录难题一年只需要解决一次。

## 致谢与许可

基于 [gooin/dailysync-rev](https://github.com/gooin/dailysync-rev)（GPL-3.0）二次开发，
同步核心思路来自原作者。本仓库仅自用，License 见 [LICENSE.txt](LICENSE.txt)。
