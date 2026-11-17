# النقل من Firebase لـ Supabase

النظام صار بيشتغل على الاثنين. بيضل على **Firebase** لحد ما تعمل التبديل بالخطوة 6، وما بيتغيّر إشي قبلها.

## 1) اعمل مشروع على Supabase (مجاني، بدون بطاقة)
- افتح **supabase.com** وسجّل دخول (ممكن بحساب GitHub).
- **New project**: اسمه `online-job`، كلمة سر لقاعدة البيانات (احفظها عندك)، المنطقة **Frankfurt (eu-central-1)**.

## 2) جهّز قاعدة البيانات
- **SQL Editor** ← **New query** ← الصق محتوى الملف `supabase/schema.sql` كامل ← **Run**.
- بنفس المكان شغّل (بإيميلك):
  ```sql
  insert into public.app_admins (email) values ('إيميلك@gmail.com') on conflict do nothing;
  ```

## 3) حساب الأدمن للوحة
- **Authentication** ← **Users** ← **Add user** ← **Create new user**: نفس الإيميل، وكلمة سر جديدة، وعلّم **Auto Confirm User**.
- **Authentication** ← **Sign In / Providers** ← **Email**: طفّي **Allow new users to sign up** (ما حدا غيرك يقدر يعمل حساب).

## 4) المفاتيح
من **Project Settings** ← **API**:
- **Project URL** و **anon public key**: هدول عاديين، ابعتهم للمساعد.
- **service_role key**: **سري — ما تبعته لحدا**. بيروح على الجوال بس (الخطوة 5).

## 5) على الجوال (Termux)
```bash
cd ~/system/worker
nano supabase.json
```
الصق (بقيمك) واحفظ (CTRL+O ثم Enter ثم CTRL+X):
```json
{ "url": "https://xxxx.supabase.co", "serviceKey": "المفتاح السري service_role", "active": false }
```
`"active": false` يعني العامل لسا على Firebase.

جرّب النقل (ما بيلمس Firebase ولا بيوقف إشي):
```bash
node tools/migrate-to-supabase.js
node tools/migrate-to-supabase.js --check
```
لو خلصت حصة Firebase بالنص، شغّل نفس الأمر بكرة وبيكمّل من مكانه.

## 6) يوم التبديل (بوقت هادي، حوالي ساعة)
1. وقّف العمّال: `cd ~/system && ./stopall.sh`
2. نسخة أخيرة كاملة: `cd worker && node tools/migrate-to-supabase.js --again && node tools/migrate-to-supabase.js --check`
3. بـ `supabase.json` غيّر `"active": false` لـ `"active": true`
4. المساعد بيحط الرابط والمفتاح العام بـ `src/config.js` وبينشر الموقع واللوحة والمتجر على Supabase.
5. شغّل العمّال: `cd ~/system && ./startall.sh`
6. ادخل اللوحة بالإيميل وكلمة السر **الجديدة** (من الخطوة 3).

## الرجوع لـ Firebase (لو صار إشي)
- بـ `supabase.json` رجّع `"active": false` وأعد تشغيل العمّال.
- المساعد بيفضّي الرابط بـ `src/config.js` وبينشر من جديد.

Firebase بيضل زي ما هو (نسخة احتياطية) — ما في إشي بينحذف منه.
