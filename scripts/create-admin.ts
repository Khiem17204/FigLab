// Creates (or promotes) a confirmed FigLab admin in Supabase Auth.
// Usage: SUPABASE_URL=… SUPABASE_SECRET_KEY=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/create-admin.ts
// The admin role lives in `app_metadata`, which only the secret key can change.

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const base = `${required("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1/admin`;
const secret = required("SUPABASE_SECRET_KEY");
const email = required("ADMIN_EMAIL").trim().toLowerCase();
const password = required("ADMIN_PASSWORD");
const headers = {
  apikey: secret,
  authorization: `Bearer ${secret}`,
  "content-type": "application/json",
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${response.status} ${body}`);
  return JSON.parse(body) as T;
}

type AdminUser = { id: string; email?: string; app_metadata?: Record<string, unknown> };

async function findUser(): Promise<AdminUser | undefined> {
  for (let page = 1; ; page += 1) {
    const { users } = await call<{ users: AdminUser[] }>(`/users?page=${page}&per_page=200`);
    const match = users.find((user) => user.email?.toLowerCase() === email);
    if (match || users.length < 200) return match;
  }
}

const attributes = { email, password, email_confirm: true };
const existing = await findUser();
const user = existing
  ? await call<AdminUser>(`/users/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({
        ...attributes,
        app_metadata: { ...existing.app_metadata, role: "admin" },
      }),
    })
  : await call<AdminUser>("/users", {
      method: "POST",
      body: JSON.stringify({ ...attributes, app_metadata: { role: "admin" } }),
    });

console.log(`${existing ? "Updated" : "Created"} admin ${user.email} (${user.id})`);
