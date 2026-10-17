# שרת זיהוי התמונות של ביס

Cloudflare Worker קטן שמחזיק את מפתח ה-API של Anthropic, כך שמשתמשי האפליקציה לא צריכים מפתח משלהם.

## הקמה
1. ב-dash.cloudflare.com: **Workers & Pages** → **Create** → **Start with Hello World!** → שם `bis` → **Deploy**.
2. **Edit code**: למחוק הכל, להדביק את `worker.js` ואז **Deploy**.
3. **Settings** → **Variables and Secrets** → **Add**: Key `ANTHROPIC_API_KEY`, Value = המפתח, לסמן **Secret** → **Add variable and deploy**.
4. **Storage & Databases** → **KV** → **Create** → שם `bis-limits`.
5. ב-Worker `bis`: **Settings** → **Bindings** → **Add binding** → **KV namespace**: Variable name `LIMITS`, KV namespace `bis-limits` → **Deploy**.
6. ב-console.anthropic.com: **Settings** → **Limits** → תקרת הוצאה חודשית של **10$**.

בדיקה: הכתובת של השרת צריכה להחזיר `"key":true` ו-`"limits":"kv"`.

## מכסות (ברירת מחדל)
| מה | כמה | משתנה לשינוי |
|---|---|---|
| זיהויים לטלפון ביום | 6 | `DAILY_PER_USER` |
| זיהויים לכתובת רשת ביום | 20 | `DAILY_PER_IP` |
| זיהויים לכולם יחד ביום | 30 | `DAILY_TOTAL` |

המונים מתאפסים בחצות (שעון ישראל). תיאור בכתב בלי תמונה מחושב קודם מהמאגר המקומי באפליקציה ולא עולה כסף.
עלות משוערת: כ-2–3 סנט לתמונה, כלומר עד כ-20$ בחודש במכסה המלאה (בפועל התקרה היא הקרדיט שנטען). `MODEL=claude-haiku-5-5` מוריד את העלות בהרבה.
