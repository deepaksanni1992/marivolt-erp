# Deploy: Vercel (frontend) + Render (API)

Repository layout: git root contains folder **`marivolt-erp/`** (Vite app + `backend/` API).

## 1. Render — Node Web Service (API)

1. [Render Dashboard](https://dashboard.render.com) → **New +** → **Web Service** (or **Blueprint** if using `render.yaml` at repo root).
2. Connect the same GitHub repo.
3. **Root Directory**: `marivolt-erp/backend`
4. **Build Command**: `npm install`
5. **Start Command**: `npm start`
6. **Health Check Path**: `/api/health`

### Environment variables (Render)

| Key | Required | Notes |
|-----|----------|--------|
| `MONGO_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes | Secret for signing JWTs |
| `CLIENT_URL` | Production | Your Vercel URL, e.g. `https://your-app.vercel.app` (used for CORS) |
| `PORT` | No | Render sets automatically |
| `NODE_ENV` | Optional | `production` |

After the service is live, copy the URL (e.g. `https://marivolt-api.onrender.com`). The frontend calls **`https://…/api/...`** (the app appends `/api` in `src/lib/api.js`).

### One-time database migration (existing data)

In Render: **Shell** (or local with production `MONGO_URI`):

```bash
cd marivolt-erp/backend && npm run migrate:item-master
```

---

## 2. Vercel — Vite (frontend)

1. [Vercel](https://vercel.com) → **Add New…** → **Project** → import the repo.
2. **Root Directory**: `marivolt-erp` (important: not the repo root if your repo wraps this folder).
3. **Framework Preset**: Vite (or Other — `vercel.json` sets build/output).
4. **Build Command**: `npm run build`
5. **Output Directory**: `dist`

### Environment variables (Vercel)

| Key | Required | Example |
|-----|----------|---------|
| `VITE_API_BASE_URL` | Yes | `https://marivolt-api.onrender.com` — **no** `/api` suffix |

Redeploy after changing env vars.

`vercel.json` includes SPA rewrites so React Router paths (e.g. `/material-master`) load `index.html`.

---

## 3. Order of operations

1. Deploy **Render** API → get base URL.
2. Set **`CLIENT_URL`** on Render to your final Vercel URL (set after first Vercel deploy, then redeploy API if CORS was failing).
3. Deploy **Vercel** with **`VITE_API_BASE_URL`** = Render origin (no `/api`).

---

## 4. Blueprint file

Repo root **`render.yaml`** defines a Web Service with `rootDir: marivolt-erp/backend`. Use **New Blueprint Instance** on Render if you prefer infra-as-code; you still add secrets in the dashboard.
