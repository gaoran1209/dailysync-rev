import express, { type NextFunction, type Request, type Response } from 'express';
import { syncGarminCN2GarminGlobal } from './utils/garmin_cn';
import { clearAdminSession, isAdminAuthenticated, issueAdminSession, validateAdminCredentials } from './service/admin_session';
import { account2AuthService } from './service/account2_auth';
import { renderAdminLoginPage, renderAdminPage } from './service/account2_ui';
import { getAccount2ServiceConfig } from './service/config';
import { initDB, markAccountAuthError, markAccountAuthReady, markAccountAuthReauthRequired } from './utils/sqlite';

const config = getAccount2ServiceConfig();
const app = express();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!isAdminAuthenticated(req, config)) {
        res.status(401).send(renderAdminLoginPage('管理员会话已失效，请重新登录'));
        return;
    }
    next();
}

function requireWebhookToken(req: Request, res: Response, next: NextFunction) {
    const header = req.header('authorization') || '';
    const expected = `Bearer ${config.webhookToken}`;
    if (header !== expected) {
        res.status(401).json({
            status: 'failed',
            message: 'Webhook token 无效',
        });
        return;
    }
    next();
}

function normalizeError(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', async (_req, res) => {
    res.json({
        status: 'ok',
        service: 'dailysync-account2',
        account2: await account2AuthService.getStatus(),
    });
});

app.get('/admin', async (req, res) => {
    if (!isAdminAuthenticated(req, config)) {
        res.send(renderAdminLoginPage());
        return;
    }
    res.send(renderAdminPage(await account2AuthService.getStatus()));
});

app.post('/admin/login', async (req, res) => {
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '').trim();
    if (!validateAdminCredentials(username, password, config)) {
        res.status(401).send(renderAdminLoginPage('管理员账号或密码错误'));
        return;
    }
    issueAdminSession(res, config);
    res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
    clearAdminSession(req, res, config);
    res.redirect('/admin');
});

app.get('/api/admin/account2/status', requireAdmin, async (_req, res) => {
    res.json(await account2AuthService.getStatus());
});

app.post('/api/admin/account2/login/start', requireAdmin, async (_req, res) => {
    res.json(await account2AuthService.startLogin());
});

app.post('/api/admin/account2/login/verify', requireAdmin, async (req, res) => {
    const code = String(req.body.code ?? req.body.mfaCode ?? '');
    res.json(await account2AuthService.verifyCode(code));
});

app.post('/api/admin/account2/login/auto', requireAdmin, async (_req, res) => {
    res.json(await account2AuthService.autoLogin());
});

app.post('/api/admin/account2/import-global-token', requireAdmin, async (req, res) => {
    const payload = req.body?.token ?? req.body?.payload ?? req.body;
    res.json(await account2AuthService.importGlobalToken(payload));
});

function runAccount2Sync() {
    return syncGarminCN2GarminGlobal({
        cn: {
            username: config.cn.username,
            password: config.cn.password,
            sessionUser: config.cn.username,
            loginMode: 'token_only',
            authStateKey: config.accountKey,
        },
        global: {
            username: config.global.username,
            password: config.global.password,
            sessionUser: config.global.username,
        },
    });
}

// 同步互斥：cron webhook 与人工触发不允许并发跑
let syncInFlight = false;

app.post('/api/hooks/sync/account2', requireWebhookToken, async (_req, res) => {
    if (syncInFlight) {
        res.status(409).json({
            status: 'busy',
            message: '已有同步任务在执行中，请稍后再试',
        });
        return;
    }
    syncInFlight = true;
    try {
        const result = await runAccount2Sync();
        res.status(200).json(result);
    } catch (err) {
        const message = normalizeError(err);
        // 瞬时网络错误：登录态仍有效，本次跳过，不报警不重登录
        if (message.includes('TRANSIENT_ERROR')) {
            console.log('[Sync] 瞬时错误，跳过本次:', message);
            res.status(200).json({
                status: 'skipped',
                message,
            });
            return;
        }
        if (!message.includes('REAUTH_REQUIRED')) {
            await markAccountAuthError(config.accountKey, message);
            res.status(500).json({
                status: 'failed',
                message,
            });
            return;
        }

        // 登录态失效：尝试全自动重登录（邮箱自动取验证码），成功后重试一次同步
        await markAccountAuthReauthRequired(config.accountKey, message);
        if (!account2AuthService.canAutoLogin) {
            res.status(409).json({
                status: 'reauth_required',
                message: `${message}（未配置 MAIL_IMAP_PASSWORD，需在管理页人工登录）`,
            });
            return;
        }

        console.log('[Sync] Garmin CN 登录态失效，尝试自动重登录...');
        try {
            const loginResult = await account2AuthService.autoLogin();
            if (loginResult.status !== 'ready') {
                res.status(409).json({
                    status: 'reauth_required',
                    message: `自动重登录未成功: ${loginResult.message}`,
                });
                return;
            }
            const retryResult = await runAccount2Sync();
            // 重登录成功 → 恢复 ready 状态（CN 登录态已就绪）
            await markAccountAuthReady(config.accountKey);
            res.status(200).json({
                ...retryResult,
                message: `[自动重登录后] ${retryResult.message}`,
            });
        } catch (retryErr) {
            const retryMessage = normalizeError(retryErr);
            // 重登录成功但同步遇到瞬时错误（如国际区 429 限流）：CN 登录态有效，本次跳过
            if (retryMessage.includes('TRANSIENT_ERROR')) {
                console.log('[Sync] 重登录成功，但同步遇瞬时错误，跳过本次:', retryMessage);
                await markAccountAuthReady(config.accountKey);
                res.status(200).json({
                    status: 'skipped',
                    message: `重登录成功，同步稍后重试: ${retryMessage}`,
                });
                return;
            }
            await markAccountAuthError(config.accountKey, retryMessage);
            res.status(500).json({
                status: 'failed',
                message: `自动重登录后同步仍失败: ${retryMessage}`,
            });
        }
    } finally {
        syncInFlight = false;
    }
});

async function bootstrap() {
    await initDB();
    app.listen(config.port, () => {
        console.log(`DailySync Account 2 service listening on ${config.port}`);
    });
}

bootstrap().catch(async (err) => {
    const message = normalizeError(err);
    await markAccountAuthError(config.accountKey, message).catch(() => undefined);
    console.error('Failed to bootstrap DailySync Account 2 service:', message);
    process.exit(1);
});
