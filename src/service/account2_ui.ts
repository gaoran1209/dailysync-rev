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
    <p>登录后可查看 account 2 认证状态，并在登录失效时手动维护（国区重登录 / 国际区 token 更新）。</p>
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
    <p>查看 account 2 认证状态；登录失效时用下面两个维护操作恢复。<strong>正常情况全自动，无需操作。</strong></p>

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
        <p style="margin-top:12px;font-size:13px;color:#475569;line-height:1.7;">
          <code>ready</code> 正常；<code>reauth_required</code> 国区登录态失效（用「①国区重登录」）；
          <code>error</code> 上次出错，看 <code>lastError</code>；<code>awaiting_code</code> 正在等邮箱验证码。
        </p>
      </section>

      <section class="card">
        <h2>① 国区（CN）重新登录</h2>
        <p>国区 session 约 1 年有效。失效时定时同步会<strong>自动</strong>「邮箱取码」重登录，一般无需手动。
        想立即重登录或排查邮箱取码时点这里（约 1~5 分钟，自动读 163 邮箱验证码）：</p>
        <div class="toolbar">
          <button type="button" id="auto-login" style="background:#047857;">立即重新登录（邮箱自动取码）</button>
        </div>
        <div class="message" id="start-message">等待操作。</div>
      </section>

      <section class="card">
        <h2>② 国际区（Global）Token 更新</h2>
        <p>国际区登录受 Cloudflare 限制，改为「浏览器铸票 + 导入」。token 约 1 年有效、每次同步自动刷新，失效时按下面重做一次：</p>
        <ol style="font-size:13px;color:#334155;line-height:1.8;padding-left:20px;margin:0 0 10px;">
          <li>电脑 Chrome 登录国际区（<code>connectus.garmin.cn</code>）</li>
          <li>同浏览器访问 <code>sso.garmin.com/sso/embed?clientId=GarminConnect&locale=en</code>，复制地址栏 <code>ticket=</code> 后的 <code>ST-…-cas</code></li>
          <li>本地跑 <code>GARMIN_GLOBAL_TICKET='ST-…-cas' yarn export_global_token</code></li>
          <li>把 <code>db/global_token.json</code> 内容粘到下框，点导入</li>
        </ol>
        <label for="global-token">国际区 Token JSON</label>
        <textarea id="global-token" rows="4" placeholder='{"sessionUser":"...","token":{"oauth1":{...},"oauth2":{...}}}' style="width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:13px;box-sizing:border-box;font-family:monospace;"></textarea>
        <div class="toolbar">
          <button type="button" id="import-global" style="background:#7c3aed;">导入国际区 Token</button>
        </div>
        <div class="message" id="import-message">等待粘贴。</div>
      </section>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('status');
    const startMessageEl = document.getElementById('start-message');

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

    document.getElementById('auto-login').addEventListener('click', async () => {
      startMessageEl.textContent = '正在重新登录（发起登录 + 等待邮箱验证码，最长约 5 分钟）...';
      const data = await postJson('/api/admin/account2/login/auto');
      if (!data) return;
      startMessageEl.textContent = data.message || '登录已完成';
      await loadStatus();
    });

    document.getElementById('import-global').addEventListener('click', async () => {
      const importMessageEl = document.getElementById('import-message');
      const raw = document.getElementById('global-token').value.trim();
      if (!raw) { importMessageEl.textContent = '请先粘贴 token JSON'; return; }
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { importMessageEl.textContent = 'JSON 解析失败，请检查粘贴内容是否完整'; return; }
      importMessageEl.textContent = '正在导入国际区 token...';
      const data = await postJson('/api/admin/account2/import-global-token', { token: parsed });
      if (!data) return;
      importMessageEl.textContent = data.message || '已导入';
      await loadStatus();
    });
  </script>
</body>
</html>`;
}
