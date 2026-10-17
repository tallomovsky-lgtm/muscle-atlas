# שרת זיהוי התמונות של ביס

Cloudflare Worker קטן שמחזיק את מפתח ה-API של Anthropic, כך שמשתמשי האפליקציה לא צריכים מפתח משלהם.

1. ב-dash.cloudflare.com: **Workers & Pages** → **Create** → **Create Worker** → שם `bis` → **Deploy**.
2. **Edit code**: למחוק הכל, להדביק את `worker.js`, ואז **Deploy**.
3. **Settings** → **Variables and Secrets** → **Add**: סוג **Secret**, שם `ANTHROPIC_API_KEY`, ערך = המפתח.
4. להעתיק את הכתובת (`https://bis.<שם>.workers.dev`) ולכתוב אותה ב-`nutrition/config.js`.
5. ב-console.anthropic.com → **Billing** → **Spend limits**: להגדיר תקרה חודשית.

משתנים אופציונליים: `MODEL` (ברירת מחדל `claude-opus-5-5`; `claude-haiku-5-5` זול בהרבה), `HOURLY_LIMIT` (ברירת מחדל 30 תמונות לשעה למשתמש), `ALLOWED_ORIGINS`.
