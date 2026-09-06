// The admin panel is a single static page served directly by this Worker
// (see index.ts's GET "/") rather than a separate Pages project -- it's
// an internal tool for one operator, so a second deployment target would
// be pure overhead. Talks to this same Worker's /admin/* API.

export const ADMIN_PANEL_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>لوحة تحكم إدارة الأقساط</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Tahoma, sans-serif; margin: 0; background: #fafafa; color: #111; }
  header { padding: 16px 24px; border-bottom: 1px solid #e5e5e5; display: flex; justify-content: space-between; align-items: center; background: #fff; }
  header h1 { font-size: 18px; margin: 0; }
  main { max-width: 960px; margin: 0 auto; padding: 24px; display: flex; flex-direction: column; gap: 24px; }
  .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 20px; }
  .card h2 { font-size: 15px; margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid #eee; }
  th { color: #666; font-weight: 500; }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
  .badge.trial { background: #fef3c7; color: #92400e; }
  .badge.active { background: #dcfce7; color: #166534; }
  .badge.expired, .badge.suspended { background: #fee2e2; color: #991b1b; }
  input, select { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
  label { display: block; font-size: 13px; color: #444; margin-bottom: 4px; }
  .field { margin-bottom: 12px; }
  button { cursor: pointer; border: none; border-radius: 6px; padding: 8px 14px; font-size: 14px; background: #111; color: #fff; }
  button.secondary { background: #fff; color: #111; border: 1px solid #ccc; }
  button.danger { background: #dc2626; }
  button:disabled { opacity: 0.5; cursor: default; }
  .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .error { color: #dc2626; font-size: 13px; }
  .hidden { display: none !important; }
  .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .login-card { width: 100%; max-width: 340px; }
  .muted { color: #666; font-size: 13px; }
</style>
</head>
<body>

<div id="login-view" class="login-wrap hidden">
  <div class="card login-card">
    <h2>تسجيل دخول الإدارة</h2>
    <form id="login-form">
      <div class="field">
        <label>البريد الإلكتروني</label>
        <input type="email" id="login-email" required />
      </div>
      <div class="field">
        <label>كلمة المرور</label>
        <input type="password" id="login-password" required />
      </div>
      <p class="error hidden" id="login-error"></p>
      <button type="submit">دخول</button>
    </form>
  </div>
</div>

<div id="app-view" class="hidden">
  <header>
    <h1>لوحة تحكم إدارة الأقساط</h1>
    <button class="secondary" id="logout-btn">تسجيل الخروج</button>
  </header>
  <main>
    <div class="card">
      <h2>إضافة زبون جديد</h2>
      <form id="new-tenant-form">
        <div class="field"><label>اسم المحل</label><input id="nt-shop-name" required /></div>
        <div class="field"><label>اسم المالك</label><input id="nt-owner-name" required /></div>
        <div class="field"><label>الهاتف</label><input id="nt-phone" required /></div>
        <div class="field"><label>البريد الإلكتروني لحساب الدخول</label><input type="email" id="nt-email" required /></div>
        <div class="field"><label>كلمة مرور مبدئية</label><input type="password" id="nt-password" required minlength="8" /></div>
        <p class="error hidden" id="new-tenant-error"></p>
        <button type="submit" id="new-tenant-submit">إنشاء الزبون</button>
      </form>
    </div>

    <div class="card">
      <h2>الزبائن</h2>
      <p class="error hidden" id="tenants-error"></p>
      <table>
        <thead>
          <tr>
            <th>المحل</th><th>المالك</th><th>الحالة</th><th>ينتهي بتاريخ</th><th>إجراء</th>
          </tr>
        </thead>
        <tbody id="tenants-body"></tbody>
      </table>
    </div>
  </main>
</div>

<script>
const TOKEN_KEY = "admin_token";
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + getToken(), ...(options && options.headers) },
  });
  if (res.status === 401) { clearToken(); showLogin(); throw new Error("انتهت الجلسة"); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "request failed");
  return body;
}

function showLogin() {
  document.getElementById("login-view").classList.remove("hidden");
  document.getElementById("app-view").classList.add("hidden");
}
function showApp() {
  document.getElementById("login-view").classList.add("hidden");
  document.getElementById("app-view").classList.remove("hidden");
  loadTenants();
}

function statusLabel(status) {
  return { trial: "تجربة", active: "فعّال", expired: "منتهي", suspended: "موقوف" }[status] || status;
}

async function loadTenants() {
  const errEl = document.getElementById("tenants-error");
  errEl.classList.add("hidden");
  try {
    const tenants = await api("/admin/tenants");
    const body = document.getElementById("tenants-body");
    body.innerHTML = "";
    for (const t of tenants) {
      const tr = document.createElement("tr");
      const expires = t.subscription_expires_at ? t.subscription_expires_at.slice(0, 10) : "—";
      tr.innerHTML = \`
        <td>\${t.shop_name}</td>
        <td>\${t.owner_name}<br><span class="muted">\${t.owner_email || ""}</span></td>
        <td><span class="badge \${t.status}">\${statusLabel(t.status)}</span></td>
        <td>\${expires}</td>
        <td class="row-actions">
          <button data-action="extend" data-id="\${t.id}">تمديد 30 يوم</button>
          <button class="danger" data-action="suspend" data-id="\${t.id}">إيقاف</button>
        </td>
      \`;
      body.appendChild(tr);
    }
    body.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => handleSubscriptionAction(btn.dataset.id, btn.dataset.action));
    });
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  }
}

async function handleSubscriptionAction(tenantId, action) {
  const payload = { action };
  if (action === "extend") {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    payload.new_expires_at = d.toISOString();
  }
  try {
    await api(\`/admin/tenants/\${tenantId}/subscription\`, { method: "POST", body: JSON.stringify(payload) });
    await loadTenants();
  } catch (e) {
    alert(e.message);
  }
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("login-error");
  errEl.classList.add("hidden");
  try {
    const { token } = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("login-email").value,
        password: document.getElementById("login-password").value,
      }),
    });
    setToken(token);
    showApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  }
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearToken();
  showLogin();
});

document.getElementById("new-tenant-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("new-tenant-error");
  const submitBtn = document.getElementById("new-tenant-submit");
  errEl.classList.add("hidden");
  submitBtn.disabled = true;
  submitBtn.textContent = "جارٍ الإنشاء...";
  try {
    await api("/admin/tenants", {
      method: "POST",
      body: JSON.stringify({
        shop_name: document.getElementById("nt-shop-name").value,
        owner_name: document.getElementById("nt-owner-name").value,
        phone: document.getElementById("nt-phone").value,
        email: document.getElementById("nt-email").value,
        password: document.getElementById("nt-password").value,
      }),
    });
    document.getElementById("new-tenant-form").reset();
    await loadTenants();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "إنشاء الزبون";
  }
});

if (getToken()) showApp(); else showLogin();
</script>
</body>
</html>
`;
