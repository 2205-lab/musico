# LoficOW — Hostinger Deployment Guide

## Prerequisites
- Hostinger Premium Plan (with MySQL database)
- Node.js 18+ installed locally (for building frontend)
- PHP 8.1+ (Hostinger provides this)

---

## Step 1: Create MySQL Database on Hostinger

1. Login to hPanel → Databases → MySQL Databases
2. Create a new database, user, and password
3. Note down: database name, username, password

---

## Step 2: Configure Backend

Edit `backend/config/db.php`:
```php
define('DB_HOST', 'localhost');
define('DB_NAME', 'your_actual_db_name');
define('DB_USER', 'your_actual_db_user');
define('DB_PASS', 'your_actual_db_password');
define('JWT_SECRET', 'generate_64_char_random_string_here');
define('BASE_URL', 'https://loficow.com/api');
define('ALLOWED_ORIGINS', ['https://loficow.com']);
```

Generate JWT secret (run locally):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Step 3: Import Database Schema

1. hPanel → Databases → phpMyAdmin
2. Select your database
3. Click "Import" tab
4. Upload `database/schema.sql`
5. Click "Go"

---

## Step 4: Build the Frontend

On your local machine:
```bash
cd loficow/frontend
cp .env.example .env
# Edit .env: set VITE_API_URL=https://loficow.com/api
npm install
npm run build
```

This creates a `loficow/dist/` folder.

---

## Step 5: Upload Files to Hostinger

Using Hostinger's File Manager or FTP (FileZilla):

**Upload structure to `public_html/`:**
```
public_html/
├── index.html              ← from dist/
├── assets/                 ← from dist/assets/
├── favicon.svg             ← from dist/
├── api/                    ← the entire backend/api/ folder
│   └── router.php
│   └── auth/
│   └── users/
│   └── ... etc
├── config/                 ← backend/config/
├── middleware/             ← backend/middleware/
├── uploads/                ← empty folder, set chmod 755
│   ├── audio/
│   ├── avatars/
│   └── covers/
└── .htaccess               ← from backend/.htaccess
```

---

## Step 6: Configure .htaccess

The `backend/.htaccess` handles:
- API routing (all `/api/*` requests → `router.php`)
- React SPA routing (all other requests → `index.html`)

Make sure you also add this to your `public_html/.htaccess` for SPA routing:
```apache
RewriteEngine On

# API requests go to PHP
RewriteCond %{REQUEST_URI} ^/api/
RewriteRule ^api/(.*)$ api/router.php?path=$1 [QSA,L]

# Static files serve normally
RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]

# Everything else → React app
RewriteRule ^ index.html [L]
```

---

## Step 7: Set Uploads Folder Permissions

Via File Manager or FTP, set `uploads/` folder and subfolders to **chmod 755**.

---

## Step 8: Test

1. Visit `https://loficow.com` → Should see landing page
2. Visit `https://loficow.com/api/channels` → Should return JSON
3. Register an account and test all features

---

## Troubleshooting

**500 errors on API:** Check `db.php` credentials match your Hostinger MySQL
**CORS errors:** Ensure `ALLOWED_ORIGINS` in `db.php` includes `https://loficow.com`
**Uploads failing:** Check `uploads/` folder has write permissions (chmod 755)
**SPA routes 404:** Make sure `.htaccess` is uploaded and mod_rewrite is enabled (it is on Hostinger)
