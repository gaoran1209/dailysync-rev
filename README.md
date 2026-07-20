# Garmin 双账号 · 国区 → 国际区自动同步

这是我自用的佳明数据同步项目：把**两个使用者的佳明国区账号**的运动数据，定时自动同步到各自的国际区账号。Fork 自 [gooin/dailysync-rev](https://github.com/gooin/dailysync-rev)，在其基础上做了大量定制（ECG 账号支持、邮箱自动验证码、自愈重登录、国际区 token 导入等）。

## 总览

| | 账号1 | 账号2 |
|---|---|---|
| 特点 | 无 MFA，登录简单 | **开了 ECG**，登录强制邮箱验证码 |
| 同步方式 | GitHub Actions 直接跑 | GitHub Actions 定时打 EC2 webhook，EC2 常驻服务执行 |
| 登录态 | session 存 `db/garmin.db`，随 runner 自动提交回仓库 | 国区：EC2 上 Playwright 登录 + **163 邮箱 IMAP 自动读验证码**；国际区：本地「浏览器铸票」导出 token 导入 EC2 |
| 频率 | 每 6 小时（UTC 0/6/12/18 点，北京 8/14/20/2 点） | 同左 |
| 失效自愈 | 无 MFA，自动重登录 | 国区 token 失效时 webhook 自动「登录+邮箱取码」重试；国际区 token 约 1 年一换（手动导入） |

每天早上 8 点，openclaw 的「每日简报」会调用 [scripts/sync-report.js](scripts/sync-report.js) 统计过去 24 小时两个账号各同步了多少条，推送到飞书。

## 架构

```
账号1：GitHub Actions (cron 6h)
        └─ yarn sync_cn ──> 佳明国区 API ──下载 FIT──> 上传国际区
           └─ session 加密存 db/garmin.db，git-auto-commit 回仓库

账号2：GitHub Actions (cron 6h)
        └─ POST https://sync.gaoran.xyz/api/hooks/sync/account2 (Bearer token)
             └─ EC2 Docker 常驻服务 (Express + Playwright)
                 ├─ 国区登录态失效 → Playwright 登录 → IMAP 读 163 邮箱验证码 → 自动提交
                 ├─ 国际区用导入的 OAuth token（每次同步自动刷新 OAuth2）
                 └─ 下载 FIT → 上传国际区 → 结果返回 webhook

部署：push main → GitHub Actions SSH 到 EC2 → docker compose 重建 → nginx/SSL(certbot)
数据持久化：docker 命名卷 app_data（sqlite session、Playwright profile），重部署不丢
```

同步判定用活动「时间指纹」（startTimeGMT+时长+距离）做集合差集比对，每次检查两边最近 10 条，乱序补传/同名活动/跨时区都不会漏；上传失败会记录并在下次自动重试。

## 日常维护：基本不需要

正常情况全自动。只有两种登录态失效需要人工介入（管理页 `https://sync.gaoran.xyz/admin`，用管理员账号登录）：

### ① 国区登录失效（`/health` 或管理页显示 `reauth_required`）

通常**不用管**——下一次定时同步会自动重登录（邮箱自动取码）。想立即恢复就在管理页点「立即重新登录（邮箱自动取码）」，约 1~5 分钟。

### ② 国际区 token 失效（约一年一次）

国际区 `sso.garmin.com` 有 Cloudflare 机器人检测，服务器/脚本直接密码登录会被 429 拦截（这不是频率限制，等多久都没用）。用「浏览器铸票」绕开：

1. 电脑 Chrome 登录国际区（`connectus.garmin.cn`）
2. 同一浏览器访问 `https://sso.garmin.com/sso/embed?clientId=GarminConnect&locale=en`，会自动跳转，复制地址栏 `ticket=` 后面的 `ST-…-cas`
3. 本项目根目录跑：`GARMIN_GLOBAL_TICKET='ST-…-cas' corepack yarn export_global_token`
4. 把生成的 `db/global_token.json` 内容粘到管理页「导入国际区 Token」提交

> 原理：浏览器已登录的会话可以免密铸出 ServiceTicket，真实浏览器指纹不会被 Cloudflare 拦；脚本再用裸 https 把 ticket 换成长效 OAuth1（约 1 年）+ OAuth2（自动刷新）。

### 其它场景

| 场景 | 操作 |
|---|---|
| 改了 GitHub Secret（邮箱授权码、账号密码等） | Actions 手动重跑 `Deploy Account 2 Service to EC2` 注入 EC2 |
| 看 EC2 服务日志 | SSH 后 `sudo docker logs --tail 200 daily-sync-account2-app` |
| 查服务状态 | `curl https://sync.gaoran.xyz/health` |
| 手动触发一次同步 | Actions 里 dispatch `Sync Garmin CN to Garmin Global (Account 2)`（或账号1 的同名 workflow） |

容器开机自启（`restart: unless-stopped`）、SSL 自动续期、token 自动刷新，都不用管。

## GitHub Actions

| Workflow | 作用 | 状态 |
|---|---|---|
| `Sync Garmin CN to Garmin Global` | 账号1 定时同步 | ✅ cron 每 6h |
| `Sync Garmin CN to Garmin Global (Account 2)` | 账号2 定时触发 EC2 webhook | ✅ cron 每 6h |
| `Deploy Account 2 Service to EC2` | push main 自动部署 EC2 | ✅ push 触发 |
| `Migrate …` ×2 | 一次性历史迁移（上游功能） | 手动 dispatch，平时禁用 |

## GitHub Secrets

| Secret | 用途 |
|---|---|
| `GARMIN_USERNAME` / `GARMIN_PASSWORD` | 账号1 国区 |
| `GARMIN_GLOBAL_USERNAME` / `GARMIN_GLOBAL_PASSWORD` | 账号1 国际区 |
| `GARMIN_USERNAME_2` / `GARMIN_PASSWORD_2` | 账号2 国区 |
| `GARMIN_GLOBAL_USERNAME_2` / `GARMIN_GLOBAL_PASSWORD_2` | 账号2 国际区 |
| `MAIL_IMAP_PASSWORD` | 163 邮箱 IMAP **授权码**（自动读验证码用；`MAIL_IMAP_HOST/PORT/USER` 可选，默认 163） |
| `EC2_HOST` / `EC2_USER` / `EC2_SSH_PRIVATE_KEY` / `EC2_DEPLOY_PATH` | 部署目标 |
| `APP_BASE_URL` | EC2 服务地址（`https://sync.gaoran.xyz`） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 管理页登录 |
| `ACCOUNT2_SYNC_WEBHOOK_TOKEN` | webhook Bearer token |
| `AESKEY` | session 加密密钥 |
| `BARK_KEY` | Bark 推送通知（登录成功/失败、部分同步失败等） |

## EC2 服务入口

- `GET /health` — 健康检查 + account2 认证状态（`ready` / `reauth_required` / `error` / `awaiting_code`）
- `GET /admin` — 管理页（状态查看 + 上面 ①② 两个维护操作）
- `POST /api/admin/account2/login/auto` — 国区一键重登录（登录 + 邮箱取码全自动）
- `POST /api/admin/account2/import-global-token` — 导入国际区 token
- `POST /api/hooks/sync/account2` — 定时同步 webhook（Bearer token 保护）

## 本地开发

```shell
corepack yarn            # 安装依赖（本机 yarn 不在 PATH，用 corepack）
corepack yarn build      # tsc 构建
corepack yarn service    # 本地起 EC2 服务（需要 .env）

# 常用脚本
corepack yarn sync_cn                # 账号1 同步（读环境变量）
corepack yarn export_global_token    # 导出国际区 token（见上面「②」）
node scripts/sync-report.js          # 统计过去 24h 同步条数（每日简报用）
```

主要代码：

```
src/
├─ index.ts                    # EC2 Express 服务（webhook / 管理页 / 自愈重登录）
├─ service/
│  ├─ account2_auth.ts         # Playwright 国区登录 + autoLogin + token 导入
│  ├─ mail_code_fetcher.ts     # IMAP 自动读 Garmin 验证码（过滤 #000000 等假阳性）
│  ├─ account2_ui.ts           # 管理页 HTML
│  └─ config.ts                # 服务配置（env）
├─ utils/
│  ├─ garmin_cn.ts             # 国区客户端 + 同步逻辑（指纹差集、瞬时错误区分）
│  ├─ garmin_global.ts         # 国际区客户端（429 按瞬时错误处理）
│  ├─ garmin_common.ts         # 下载/上传/Bark/token 持久化
│  └─ sqlite.ts                # session 加密存取（AES）
├─ mfa/garmin_sso_mfa.ts       # 国区 SSO MFA 流程（axios 版，账号1 回退路径）
└─ export_garmin_global_session.ts  # 国际区 token 导出（裸 https + 铸票模式）
scripts/sync-report.js         # 每日简报「运动数据同步」统计
```

## 踩坑记录（重要）

- **国际区 429 不是限速**：2026-03 起 Garmin 在 `sso.garmin.com` 前上了 Cloudflare bot 检测（TLS 指纹层面），非浏览器客户端密码登录直接 429，反复重试会升级成账号级封锁（48-72h）。解法就是上面的「浏览器铸票」。国区 `garmin.cn` 无此限制。
- **`connectus.garmin.cn` 是国际账号的国内前端**，背后就是 `sso.garmin.com` + `connectapi.garmin.com`，token 通用。
- **Garmin 验证码邮件是纯 HTML**，正文里 `#000000` 颜色值会被 `\d{6}` 误当验证码——取码要按关键词就近匹配并过滤噪声（`mail_code_fetcher.ts` 已处理）。
- **OAuth1 token 约 1 年有效，OAuth2 短效可自动刷新**——所以所有登录难题都只需要一年解决一次，平时只刷新。
- 同步/登录相关的关键事件会发 **Bark 通知**，出问题第一时间能看到。

## 致谢与许可

基于 [gooin/dailysync-rev](https://github.com/gooin/dailysync-rev)（GPL-3.0）二次开发，同步核心思路来自上游，感谢原作者。不熟悉代码的用户可以用原作者的 [Web 版](https://dailysync.vyzt.dev/)。本仓库仅自用，License 见 [LICENSE.txt](LICENSE.txt)。
