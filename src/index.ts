import express, { type NextFunction, type Request, type Response } from 'express';
import { syncGarminCN2GarminGlobal } from './utils/garmin_cn';
import { clearAdminSession, isAdminAuthenticated, issueAdminSession, validateAdminCredentials } from './service/admin_session';
import { account2AuthService } from './service/account2_auth';
import { renderAdminLoginPage, renderAdminPage } from './service/account2_ui';
import { getAccount2ServiceConfig } from './service/config';
import { initDB, markAccountAuthError, markAccountAuthReauthRequired } from './utils/sqlite';

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

app.post('/api/hooks/sync/account2', requireWebhookToken, async (_req, res) => {
    try {
        const result = await syncGarminCN2GarminGlobal({
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
        res.status(200).json(result);
    } catch (err) {
        const message = normalizeError(err);
        if (message.includes('REAUTH_REQUIRED')) {
            await markAccountAuthReauthRequired(config.accountKey, message);
            res.status(409).json({
                status: 'reauth_required',
                message,
            });
            return;
        }
        await markAccountAuthError(config.accountKey, message);
        res.status(500).json({
            status: 'failed',
            message,
        });
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
