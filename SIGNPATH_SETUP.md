# การเซ็นโค้ดให้ตัวติดตั้ง (แก้ปัญหา Windows/เว็บเตือน "ไม่ปลอดภัย")

ตัวติดตั้ง `.exe` ที่ไม่ได้เซ็นจะโดน Windows SmartScreen และ Google Safe Browsing เตือน
วิธีแก้ที่ถูกต้องคือ **เซ็นโค้ดด้วยใบรับรองที่ระบบเชื่อถือ** เอกสารนี้ใช้ **SignPath Foundation**
ซึ่งเซ็นให้ฟรีสำหรับโปรเจกต์ open-source (ตอนนี้ใช้ลิขสิทธิ์ MIT แล้ว)

> สำคัญ: SignPath Foundation จะเซ็นเฉพาะไฟล์ที่ **build จาก GitHub Actions** เท่านั้น
> ไฟล์ที่ build จากเครื่องเราเองจะเซ็นผ่านบริการฟรีนี้ไม่ได้

ไฟล์ที่เตรียมไว้ให้แล้วในโปรเจกต์:
- `LICENSE` (MIT)
- `.github/workflows/release.yml` (build + ส่งไปเซ็นที่ SignPath อัตโนมัติ)

---

## ขั้นที่ 1 — อัปโปรเจกต์ขึ้น public repo บน GitHub

```bash
cd C:/Users/K/Downloads/cloudpad-starter/cloudpad-starter
git init
git add .
git commit -m "CloudPad 0.6.62"
git branch -M main
# สร้าง repo public ชื่อ cloudpad บน github.com ก่อน แล้ว:
git remote add origin https://github.com/<your-username>/cloudpad.git
git push -u origin main
```

ตรวจให้แน่ใจว่า **ไฟล์ `.env` ไม่ขึ้นไป** (มีใน `.gitignore` อยู่แล้ว — anon key ปลอดภัยแต่ไม่ควร commit)

## ขั้นที่ 2 — ใส่ Secrets ของ Supabase ใน repo
GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**
- `VITE_SUPABASE_URL` = ค่าจาก .env ของคุณ
- `VITE_SUPABASE_ANON_KEY` = ค่าจาก .env ของคุณ

(ถ้าไม่ใส่ ตัวที่ build จะเป็นโหมด local-only ไม่ต่อ Cloud)

## ขั้นที่ 3 — สมัคร SignPath Foundation (ฟรีสำหรับ OSS)
1. ไปที่ https://signpath.org/apply (โปรแกรมฟรีสำหรับ open-source)
2. กรอกข้อมูลโปรเจกต์ + ลิงก์ GitHub repo (ต้องเป็น public + มี LICENSE)
3. รอทีมงานรีวิว/อนุมัติ (ไม่ทันที — มักไม่กี่วันทำการ)

## ขั้นที่ 4 — หลังได้รับอนุมัติ ตั้งค่าใน SignPath dashboard
1. สร้าง **Project** slug = `cloudpad`
2. สร้าง **Signing Policy** slug = `release-signing`
3. สร้าง **Artifact Configuration** ให้ตรงกับ NSIS installer (`*-setup.exe`)
4. คัดลอก **Organization ID** และสร้าง **API Token**

## ขั้นที่ 5 — ใส่ค่า SignPath กลับเข้า GitHub
GitHub repo → Settings → Secrets and variables → Actions
- **Secret** `SIGNPATH_API_TOKEN` = API token จาก SignPath
- **Variable** `SIGNPATH_ORGANIZATION_ID` = Organization ID จาก SignPath

> ถ้า slug ที่ตั้งใน SignPath ต่างจาก `cloudpad` / `release-signing`
> ให้แก้ค่าใน `.github/workflows/release.yml` ให้ตรงกัน

## ขั้นที่ 6 — สั่ง build + เซ็น
```bash
git tag v0.6.62
git push origin v0.6.62
```
หรือไปที่แท็บ **Actions → Release → Run workflow**

เมื่อ workflow เสร็จ:
- ไปที่ run นั้น → ส่วน **Artifacts** → ดาวน์โหลด **cloudpad-installer-signed**
- ไฟล์นี้คือตัวติดตั้งที่ **เซ็นแล้ว** → เอาขึ้นเว็บให้ดาวน์โหลดได้โดยไม่โดนเตือน

---

## หมายเหตุ
- ครั้งแรก ๆ ถ้าเป็นใบรับรองแบบ OV อาจยังเตือนช่วงสะสมชื่อเสียง แต่ SignPath Foundation
  ใช้ใบรับรองที่มีชื่อเสียงระดับหนึ่งแล้ว มักผ่านได้เร็ว
- ทางเลือกเสียเงินที่หายทันทีและตั้งง่าย: **Azure Trusted Signing** (~$10/เดือน)
  ถ้าสนใจแนวนี้แทน บอกได้ จะปรับ workflow ให้
