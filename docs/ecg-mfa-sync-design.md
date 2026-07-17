# 账号2（ECG / 强制邮箱 MFA）无人值守同步 —— Review 结论与方案设计

> 日期：2026-07-17。本文档只做 review 与设计，**不包含任何代码改动**。
> 结论先行：本地工作区**未提交的改动**已经是正确方案的约 80%，方向与社区最前沿实践一致，不需要推倒重来。剩下的是「提交部署 + 配 secret + 修几个 bug + 真机验证一轮」。

---

## 一、项目现状 Review

### 1.1 两条独立链路

| | 账号1（gaoran24@gmail.com，无 MFA） | 账号2（18380445747@163.com，ECG 强制邮箱 MFA） |
|---|---|---|
| 运行位置 | GitHub Actions runner | EC2 上的 Docker 常驻 Express 服务 |
| 触发 | cron `0 */6 * * *` 直接跑 `yarn sync_cn` | cron 每 6h curl EC2 webhook `/api/hooks/sync/account2` |
| Session 存储 | 仓库内 `db/garmin.db`（AES 加密，git 跟踪，即 600+ 个 "Save Garmin Session" 提交的来源） | EC2 docker volume `/app/data/garmin.db` |
| 登录自愈 | 无 MFA，SSO 直接发 ticket，run 内自动重登录 | token 失效 → 自动重登录（Playwright + IMAP 取码），**代码已写完但未提交部署** |
| 状态 | ✅ 已无人值守 | ⚠️ 线上仍是半自动（人工上 `/admin` 输码） |

### 1.2 关键机制（理解全局的 5 个事实）

1. **佳明 token 结构**：OAuth2 短命（约 24 小时），由库自动用 OAuth1 刷新；**OAuth1 长效（社区经验约 1 年）**。MFA 只在"重新走密码登录拿 ticket"时强制。→ 无人值守 = 日常纯 token 复用 + 失效时兜底重登录，而不是每次同步都过 MFA。
2. **ECG = 永久 2FA**：佳明官方确认开启 ECG 后强制两步验证不可关闭；验证码 30 分钟有效。**没有任何绕开邮箱验证码的路径**，唯一出路是把"取码"自动化。
3. **ServiceTicket 是一次性的**：本地已正确处理（Playwright `page.route` 拦截含 ticket 的导航并 abort；ticket 的 service 参数必须与 `sso/embed` 一致）。这是 fork 多个修复提交的核心，与社区（peloton-to-garmin Phase 3 规划）的最先进做法一致。
4. **GitHub Actions 数据中心 IP 被佳明/Cloudflare 限流（429）**：上游 README 已明确警告；社区共识是"登录动作放在低风控 IP（EC2/住宅 IP），Actions 只消费 token"。账号2 放 EC2 是正确选择；账号1 的 Actions 路径目前能用但存在持续限流风险。
5. **163 IMAP 两个硬门槛已解决**：授权码（非登录密码）+ IMAP ID（否则报 Unsafe Login），`src/service/mail_code_fetcher.ts` 均已覆盖。

### 1.3 本地未提交改动 = 最后一块拼图

工作区有 14 个文件修改 + 1 个新文件（`src/service/mail_code_fetcher.ts`），构成完整闭环：

```
cron webhook → 同步抛 REAUTH_REQUIRED
  → index.ts 自动 autoLogin()（单飞防并发）
  → Playwright 发起 SSO 登录 → 佳明发验证码邮件
  → fetchGarminMfaCode() IMAP 轮询 163（15s/轮，最长 4 分钟，
    只认发起时刻后、发件人/主题含 garmin 的邮件里的 6 位数字）
  → verifyCode() 提交 → ticket → OAuth1/OAuth2 加密入库
  → 自动重试一次同步
```

配套改动还包括：瞬时网络错误不再误删长效 OAuth1 token（`isAuthFailure`/`TRANSIENT_ERROR`）、session 解密失败降级为重登录而非崩溃、上传失败重抛不虚报成功、nginx 读超时放宽到 600s、deploy workflow 注入 `MAIL_IMAP_*`。**线上/上游对比：本地 HEAD = 线上 origin/main，这些改动全部只存在于工作区。**

### 1.4 主要问题清单（按优先级）

**阻断级**
- P0-1：闭环代码未 commit/push，EC2 部署脚本 `git reset --hard FETCH_HEAD && git clean -fdx` 意味着未提交文件永远上不了服务器。
- P0-2：`MAIL_IMAP_PASSWORD`（163 授权码）等 4 个 secret 需在 GitHub 配置；163 网页端需先开 IMAP 并生成授权码（一次性人工前置）。
- P0-3：Playwright 的整套 CSS selector（填账号/密码/验证码框/提交按钮）是猜测列表，**从未对佳明真实 MFA 页面验证过**，首次自动运行大概率要按真实 DOM 修一轮。

**高**
- P1-1：`loginViaLibraryFallback()`（account2_auth.ts）对 MFA 账号有害——库的 `handleMFA` 是空函数，必然失败，还会**再触发第二封验证码邮件**（骚扰/限频/用户混淆）。应删除或加"仅非 MFA 账号"守卫。
- P1-2：**AESKEY 跨 workflow 不一致**：只有 `sync_garmin_cn_to_garmin_global.yml` 传了 AESKEY；`sync_garmin_global_to_garmin_cn.yml` 和两个 migrate workflow 没传，会回退到硬编码弱密钥 `'LSKDAJALSD'`，解密失败→用弱密钥重加密写库→**打烂仓库里所有 session**。共享 `db/garmin.db` 的 workflow 必须全部补传。

**中**
- P2-1：验证码正则 `\b(\d{6})\b` 有误判面（邮件里的颜色值、编号等 6 位数字）；建议收紧为"验证码/verification code"附近的数字。佳明侧多次错码可能触发风控。
- P2-2：`pendingLogin` 仅存进程内存且无过期清理：容器重启后 `awaiting_code` 状态与浏览器页脱节，佳明 MFA 会话约 30 分钟失效后 verify 会以令人困惑的方式失败。失败后下一轮 cron 会自愈（代价是多收一封邮件），可接受但应加 TTL 清理。
- P2-3：`NO_MFA_NEEDED:<ticket>` 把一次性 ticket 拼进错误消息进日志/通知，凭证材料不应入日志。
- P2-4：账号2 链路失败目前没有 Bark 通知（workflow 只 `::error::`），无人值守后存在"静默死亡"观测盲区。
- P2-5：取码轮询每轮新建 IMAP 连接（15s × 16 轮），163 有高频登录风控；建议复用连接或拉长间隔到 20-30s。
- P2-6：`db/mfa_state.json`（含 SSO 活 cookie）曾提交进 git 历史，已过期、风险低，但属卫生问题；死代码（`request_mfa.ts`/`mfa_login.ts` 及指向已删除 workflow 的提示文案）建议清理。

**安全（需尽快确认）**
- S-1：**确认仓库是 private**。`db/garmin.db` 历史上一直用源码里公开的弱密钥加密后提交，若仓库是 public 等于明文托管三个账号（含上游作者遗留账号）的 OAuth token。建议：确认可见性 → 轮换 AESKEY → 使旧 session 全部作废重登（sqlite.ts 的解密失败降级正好兜住）。
- S-2：可选改进——上游 PR #17 提供"session 放 GitHub Secrets 环境变量"的方案，账号1 可借此摆脱 600+ 次 db 提交；非必须。

---

## 二、方案设计：A + B + C 三层（社区公认最稳形态）

以 **A（长期 token 复用）为骨架 + B（IMAP 自动取码重登录）为自动恢复 + C（Bark + 管理页人工）为兜底**。这正是本地代码已搭出 80% 的形态，予以确认并补齐。

### 2.1 架构图（目标态，维持现有部署拓扑）

```
┌─ GitHub Actions ─────────────────────────────────────────┐
│ cron */6h                                                 │
│  ├─ workflow 1: 账号1 yarn sync_cn（现状不动）              │
│  │     └─ session 存 db/garmin.db，auto-commit 回仓库      │
│  └─ workflow 2: curl POST EC2 /api/hooks/sync/account2   │
└──────────────┬───────────────────────────────────────────┘
               │ Bearer token
┌──────────────▼──────── EC2（Docker 常驻服务）─────────────┐
│ 同步入口：loginMode='token_only'（绝不主动密码登录）          │
│   ├─ token 有效 → 正常同步，refreshAndSaveToken 滚动续期     │
│   └─ token 失效 → REAUTH_REQUIRED                          │
│        └─ autoLogin()：Playwright 持久 profile 走 SSO      │
│             → isMfaChallengePage → 佳明发码                 │
│             → mail_code_fetcher IMAP 轮询 163 取 6 位码     │
│             → verifyCode → 拦截一次性 ticket                │
│             → ticket → OAuth1/OAuth2 → AES 加密入 sqlite    │
│             → 自动重试一次同步                               │
│        失败 → Bark 通知 → 人工 /admin 兜底（保留）           │
└────────────────────────────────────────────────────────────┘
```

### 2.2 设计决策与理由

1. **登录动作只在 EC2，绝不上 Actions**。Actions 数据中心 IP 触发佳明/Cloudflare 429 是上游实证过的坑；EC2 固定 IP 风控压力小得多。Actions 只做两件事：账号1 同步、给账号2 发 webhook。
2. **`token_only` 模式是正确的隔离**：同步链路永不主动发码，只有明确的 `REAUTH_REQUIRED` 才触发一次自动重登录（单飞 + syncInFlight 互斥，每 6 小时最多 1 封验证码邮件）。正常年份里 OAuth1 有效 ≈ 1 年，意味着**理想情况下一年只发 1-2 封验证码邮件**。
3. **Playwright 持久 profile + "信任此浏览器"是潜在红利**：`maybeTrustCurrentBrowser` 若被佳明接受，后续重登录可能直接跳过 MFA（`directTicket` 分支）。但 ECG 账号按官方说法是每次新登录强制 MFA，**不指望它，只当 bonus**。
4. **人工兜底必须保留**：163 授权码被重置、佳明改登录页 DOM、邮件进 Spam、佳明加码率限制等场景，Bark 通知 + 管理页 `/admin` 手输码是最后防线。管理页保留"全自动登录"和"手动登录"两个入口。
5. **不引入新组件**：不需要数据库、消息队列、第三方接码平台。163 IMAP + 授权码是最轻的自托管路径（凭证在自己手里，无第三方依赖）。
6. **不同步生理数据的边界不变**：只同步运动活动（fit/gpx/tcx）；ECG 数据本身不上传（佳明限制），这与本方案无关但要对齐预期。

### 2.3 落地步骤（按顺序，供后续实施参考）

1. **安全前置**：确认 GitHub 仓库为 private；在 163 网页端开启 IMAP 并生成授权码；GitHub Secrets 配置 `MAIL_IMAP_HOST/PORT/USER/PASSWORD`；确认/轮换 `AESKEY` 为强随机值。
2. **修 bug**（小改动，先行）：
   - 给 `sync_garmin_global_to_garmin_cn.yml` 和两个 migrate workflow 补 `AESKEY`；
   - 删除/守卫 `loginViaLibraryFallback`（MFA 账号不走库 login 兜底）；
   - 收紧验证码正则（靠近"验证码/verification code"语境的 6 位数字）；
   - `NO_MFA_NEEDED` 不再把 ticket 拼进消息；
   - `pendingLogin` 加 TTL（如 30 分钟）过期清理；
   - 账号2 webhook 失败路径补 Bark 通知；
   - （可选）IMAP 轮询复用连接或间隔放宽到 20-30s；取码超时做成环境变量。
3. **提交并 push** 工作区全部改动 → 自动触发 `Deploy Account 2 Service to EC2`。
4. **真机验证一轮完整闭环**（建议按真实 DOM 校验 Playwright 选择器）：
   - 管理页点"全自动登录"，观察：发登录 → 163 收信 → 自动取码 → token 落库 → 状态 ready；
   - 手动删库中账号2 session（或等其自然失效），触发 webhook，观察 REAUTH_REQUIRED → autoLogin → 重试同步成功；
   - 观察首轮 AESKEY 切换后旧 session 失效重登的行为是否符合预期（账号1 应无感自愈）。
5. **观测与运维**：Bark 覆盖"自动重登录失败/成功"；定期确认 OAuth1 存活；163 授权码被重置时更新 secret；佳明改 DOM 时按管理页报错截图修选择器。

### 2.4 风险与已知边界

| 风险 | 影响 | 缓解 |
|---|---|---|
| 佳明邮件进 163 Spam/订阅文件夹 | 当轮取码超时，状态留 awaiting_code | 163 加发件人白名单/收信规则；下轮 cron 自愈；人工兜底 |
| 163 对高频 IMAP 登录风控 | 取码失败 | 复用连接/拉长间隔；仅登录窗口期轮询 4 分钟 |
| 佳明改登录页 DOM | autoLogin 失败 | Bark 通知 → 人工兜底 → 按截图修选择器 |
| OAuth1 被佳明主动吊销且自动重登连续失败 | 同步中断 | Bark 告警 → 管理页人工恢复 |
| GitHub Actions 对佳明的 429 限流扩大 | 账号1 路径受影响 | 上游已预警；预案是把账号1 也迁到 EC2 webhook 模式（架构已具备，复用账号2 模式即可） |
| 仓库若为 public 的历史 session 泄露 | 账号 token 泄露 | 确认 private + 轮换 AESKEY + 旧 session 作废 |

### 2.5 轻量化评估（对照"仅 GitHub Actions 或 EC2"的目标）

- 当前方案 = **1 个 EC2 实例 + 1 个 Docker 容器 + GitHub Actions cron**，无其他依赖，符合目标。
- 唯一较重的组件是 Playwright + Chromium（镜像体积大），这是对付佳明 MFA 页面的必要成本，且有持久 profile 红利。
- 理论上的"纯 Actions 无 EC2"替代（token 复用 + workflow_dispatch 手动输码）能省掉 EC2，但每年需人工介入且 Actions IP 有 429 风险，不符合"定时自动"的本质需求，不推荐。

---

## 三、结论

**不需要重新设计方案。** 当前工作区的未提交改动已经是社区验证过的最佳形态（token 复用 + IMAP 自动取码 + Playwright 抓一次性 ticket + 人工兜底），关键难点（ticket 一次性、service 参数对齐、163 IMAP ID、瞬时错误不毁 token）都被正确识别和处理。剩余工作按优先级为：

1. 安全前置（确认仓库 private、163 授权码、AESKEY 各 workflow 补齐）；
2. 修 §1.4 的 P1 级 bug；
3. commit → push → 部署 → 真机验证一轮；
4. 补齐 Bark 观测，进入无人值守运行。
