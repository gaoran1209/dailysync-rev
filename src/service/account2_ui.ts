import type { Account2StatusSnapshot } from './account2_auth';

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function renderAdminLoginPage(errorMessage?: string): string {
    const errorBlock = errorMessage
        ? `<p style="color:#b42318;background:#fef3f2;padding:12px;border-radius:8px;">${escapeHtml(errorMessage)}</p>`
        : '';
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DailySync Account 2 管理登录</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;margin:0;padding:40px;color:#0f172a;}
    .card{max-width:420px;margin:0 auto;background:#fff;padding:28px;border-radius:16px;box-shadow:0 12px 36px rgba(15,23,42,.08);}
    h1{margin:0 0 12px;font-size:28px;}
    p{line-height:1.6;}
    label{display:block;margin:16px 0 8px;font-weight:600;}
    input{width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px;box-sizing:border-box;}
    button{margin-top:20px;width:100%;padding:12px 14px;border:none;border-radius:10px;background:#0f172a;color:#fff;font-size:15px;font-weight:600;cursor:pointer;}
  </style>
</head>
<body>
  <div class="card">
    <h1>Account 2 管理页</h1>
    <p>登录后可以在同一浏览器上下文里发起 Garmin 国区登录、提交邮箱验证码，并查看 account 2 的认证状态。</p>
    ${errorBlock}
    <form method="post" action="/admin/login">
      <label for="username">管理员账号</label>
      <input id="username" name="username" autocomplete="username" required />
      <label for="password">管理员密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">登录管理页</button>
    </form>
  </div>
</body>
</html>`;
}

export function renderAdminPage(status: Account2StatusSnapshot): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DailySync Account 2 管理页</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef2ff;margin:0;padding:32px;color:#111827;}
    .wrap{max-width:980px;margin:0 auto;}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;}
    .card{background:#fff;border-radius:18px;padding:22px;box-shadow:0 12px 36px rgba(15,23,42,.08);}
    h1{margin:0 0 8px;font-size:32px;}
    h2{margin:0 0 14px;font-size:20px;}
    p{line-height:1.6;}
    button{padding:12px 16px;border:none;border-radius:10px;background:#1d4ed8;color:#fff;font-weight:600;cursor:pointer;}
    input{width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px;box-sizing:border-box;}
    label{display:block;margin:14px 0 8px;font-weight:600;}
    pre{margin:0;padding:16px;border-radius:12px;background:#0f172a;color:#e2e8f0;overflow:auto;white-space:pre-wrap;word-break:break-word;}
    .toolbar{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px;}
    .toolbar form{margin:0;}
    .message{margin-top:12px;padding:12px 14px;border-radius:10px;background:#eff6ff;color:#1d4ed8;}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>DailySync Account 2 管理页</h1>
    <p>用这页发起 Garmin 国区登录、提交邮件验证码，并查看 account 2 当前的认证状态。</p>

    <div class="grid">
      <section class="card">
        <h2>认证状态</h2>
        <pre id="status">${escapeHtml(JSON.stringify(status, null, 2))}</pre>
        <div class="toolbar">
          <button type="button" id="refresh-status">刷新状态</button>
          <form method="post" action="/admin/logout">
            <button type="submit" style="background:#475569;">退出登录</button>
          </form>
        </div>
      </section>

      <section class="card">
        <h2>发起 Garmin 国区登录</h2>
        <p>点击后，服务会在 EC2 上的持久浏览器上下文里提交国区账号密码。如果需要邮件验证码，状态会切到 <code>awaiting_code</code>。</p>
        <div class="toolbar">
          <button type="button" id="start-login">开始 Garmin 国区登录</button>
          <button type="button" id="auto-login" style="background:#047857;">全自动登录（邮箱自动取码）</button>
        </div>
        <div class="message" id="start-message">等待操作。</div>
      </section>

      <section class="card">
        <h2>提交邮件验证码</h2>
        <p>在收到 Garmin 邮件验证码后，填入这里。提交会复用刚才那次登录留下的浏览器上下文。</p>
        <label for="mfa-code">邮件验证码</label>
        <input id="mfa-code" placeholder="例如 123456" />
        <div class="toolbar">
          <button type="button" id="verify-code">提交验证码</button>
        </div>
        <div class="message" id="verify-message">等待验证码。</div>
      </section>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('status');
    const startMessageEl = document.getElementById('start-message');
    const verifyMessageEl = document.getElementById('verify-message');
    const codeInputEl = document.getElementById('mfa-code');

    async function loadStatus() {
      const response = await fetch('/api/admin/account2/status', { credentials: 'same-origin' });
      if (response.status === 401) {
        window.location.href = '/admin';
        return null;
      }
      const data = await response.json();
      statusEl.textContent = JSON.stringify(data, null, 2);
      return data;
    }

    async function postJson(url, payload) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload || {}),
      });
      if (response.status === 401) {
        window.location.href = '/admin';
        return null;
      }
      return await response.json();
    }

    document.getElementById('refresh-status').addEventListener('click', () => {
      loadStatus().catch((error) => {
        statusEl.textContent = String(error);
      });
    });

    document.getElementById('start-login').addEventListener('click', async () => {
      startMessageEl.textContent = '正在发起 Garmin 登录...';
      const data = await postJson('/api/admin/account2/login/start');
      if (!data) return;
      startMessageEl.textContent = data.message || '已发起登录';
      await loadStatus();
    });

    document.getElementById('auto-login').addEventListener('click', async () => {
      startMessageEl.textContent = '正在全自动登录（发起登录 + 等待邮箱验证码，最长约 5 分钟）...';
      const data = await postJson('/api/admin/account2/login/auto');
      if (!data) return;
      startMessageEl.textContent = data.message || '自动登录已完成';
      await loadStatus();
    });

    document.getElementById('verify-code').addEventListener('click', async () => {
      verifyMessageEl.textContent = '正在提交验证码...';
      const data = await postJson('/api/admin/account2/login/verify', { code: codeInputEl.value });
      if (!data) return;
      verifyMessageEl.textContent = data.message || '验证码已提交';
      await loadStatus();
    });
  </script>
</body>
</html>`;
}
