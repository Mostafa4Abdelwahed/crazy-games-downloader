# AI Loop — جلسة معزولة لكل لعبة (anti-hallucination)

الفكرة: بدل ما تبعت 10 فولدرات في برومبت واحد (الـ AI يخلط ويهلوس)،
اللوب يشغّل **`opencode run` جديد ومنفصل لكل فولدر** — واحد واحد.

## الملفات

- `prompt.template.md` — برومبتك الأصلي + سطرين في الآخر:
  `{{GAME_DIR}}` و `{{GAME_URL}}` (وسطر منع لمس أي فولدر تاني).
- `run-one.ps1` — يبني البرومبت لفولدر واحد وينفذه في session معزولة.
- `run-all.ps1` — يلف على كل الفولدرات المباشرة تحت `-Root` وينادي `run-one`
  لكل واحد، مع `state.json` للاستكمال + `summary.csv/md` + لوج لكل لعبة.
- `server.js` + `dashboard.html` — واجهة ويب محلية (بدون أي command):
  `npm run loop:ui` ثم افتح `http://127.0.0.1:8090`.

## الواجهة (بدون أوامر)

```powershell
npm run loop:ui
# افتح: http://127.0.0.1:8090
```

من الصفحة: الصق الـ Root، اظبط الاختيارات (موافقة تلقائية/تنظيف/استثناء)،
دوس **تشغيل اللوب** — وتابع جدول الحالات (pending/done/failed) واللوجات وهي
بتتحدث كل 3 ثواني. **إيقاف** يوقف اللوب (اللي خلص محفوظ في `state.json`
ويكمل من بعده لما تشغّل تاني). السيرفر مربوط على `127.0.0.1` فقط.

## 1) معاينة (آمنة — لا تنفذ شيئاً)

```powershell
.\scripts\ai-loop\run-all.ps1 `
  -Root 'C:\Users\Administrator\Downloads\crazy-games-downloader\data\exports\clicker\rejected' `
  -DryRun
```

لفولدر واحد فقط:

```powershell
.\scripts\ai-loop\run-one.ps1 `
  -GameDir 'C:\Users\Administrator\Downloads\crazy-games-downloader\data\exports\clicker\rejected\butterfly-shimai-play-on-crazygames' `
  -Port 8080 -DryRun
```

## 2) تنفيذ فعلي

```powershell
.\scripts\ai-loop\run-all.ps1 `
  -Root 'C:\Users\Administrator\Downloads\crazy-games-downloader\data\exports\clicker\rejected' `
  -AutoApprove
```

- `-AutoApprove` يمرر `--dangerously-skip-permissions` لـ opencode —
  ضروري وإلا اللوب سيقف عند كل permission وينتظر تأكيدك.
  استخدمه فقط لأن برومبتك أصلاً يسمح بتشغيل PowerShell + Chrome.
- بدون `-AutoApprove` ستحتاج توافق يدوياً على كل خطوة (غير عملي للوبات).

## خيارات مفيدة

```powershell
# فولدرات معينة فقط
.\scripts\ai-loop\run-all.ps1 -Root '...\rejected' -Only 'butterfly*','moto*' -AutoApprove

# استثناء
.\scripts\ai-loop\run-all.ps1 -Root '...\rejected' -Exclude 'broken*' -AutoApprove

# إعادة الفاشل فقط
.\scripts\ai-loop\run-all.ps1 -Root '...\rejected' -RedoFailed -AutoApprove

# موديل/agent محدد
.\scripts\ai-loop\run-all.ps1 -Root '...\rejected' -Model 'anthropic/claude-sonnet-4-5' -AutoApprove

# تنظيف python http.server على نفس البورت بين الجولات (لا يلمس سيرفراتك الأخرى ولا Chrome)
.\scripts\ai-loop\run-all.ps1 -Root '...\rejected' -AutoApprove -CleanupBetween
```

## الاستكمال بعد الانقطاع

الحالة محفوظة في `scripts/ai-loop/logs/state.json`.
أعد نفس الأمر وسيتخطى كل `done` تلقائياً.
الفاشل يتخطى أيضاً ما لم تمرر `-RedoFailed`.

## اللولوج والملخصات

- `scripts/ai-loop/logs/<timestamp>-<game>.prompt.md` — البرومبت الفعلي المرسل.
- `scripts/ai-loop/logs/<timestamp>-<game>.log` — خرج opencode كاملاً.
- `scripts/ai-loop/logs/summary-<timestamp>.csv/.md` — جدول النتائج.

## قواعد الأمان المطبقة

1. **عزل الجلسات**: كل لعبة `opencode run` مستقل — لا context مشترك.
2. **سيرفراتك خط أحمر**: السكريبت افتراضياً لا يقتل شيئاً؛ فقط يحذر لو
   البورت مشغول. القتل مقيد بـ `-CleanupBetween` ويستهدف فقط
   `python ... http.server <PORT>`.
3. **Chrome**: لا يقتل أي chrome — البرومبت نفسه مأمور بإغلاق نوافذه المؤقتة
   فقط وترك بروفايل المستخدم.
4. راجع `prompt.template.md` قبل أول run حقيقي — هو نسخة طبق الأصل من
   برومبتك مضافاً إليه قيد النطاق (scope lock) للفولدر الواحد.
