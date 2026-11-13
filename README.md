# DPS Amrapali – Stationery Inventory (Vercel + Neon)

Pura data ab Neon (PostgreSQL) online database mein save hota hai.
**localStorage se sab delete kar diya gaya hai** aur browser mein koi bhi data (images, fonts, inventory, credentials) local storage mein save nahi hota. Sab Neon database se dynamically load hota hai.

---

## 1. Setup & Environment Variables
Production ya Vercel par deploy karte samay ye teen environment variables set karein:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string (`postgresql://...`) |
| `SESSION_SECRET` | 32+ character random secret string |
| `SETUP_TOKEN` | Initial admin setup token |

---

## 2. LocalStorage Complete Removal
- App load hote hi `localStorage.clear()` call hota hai jo device ka purana cached data wipe kar deta hai.
- `window.localStorage` ko in-memory storage se replace kar diya gaya hai taaki browser ke persistent local storage mein koi bhi sensitive data, cart, theme ya images write na ho sakein.
- Saara state server (`/api/state`) aur Neon database (`app_state` table) se sync hota hai.

---

## 3. Images & Fonts stored in Neon Database
- School Logo aur Transparent Logo Neon DB ke `assets` table mein save hain.
- Google Sans aur Google Sans Flex fonts ke stylesheet definitions bhi `assets` table mein stored hain.
- Front-end ab `/api/assets?key=logo`, `/api/assets?key=logo-nobg`, aur `/api/assets?key=fonts.css` ke through directly database se assets load karta hai.

---

## 4. Local Development & Tests
- Local test server chalane ke liye: `npm run dev` (http://localhost:3000)
- Automated unit tests chalane ke liye: `npm test` (Sabhi 50 checks passing)
