# CloudPad

CloudPad คือแอป Notepad สำหรับ Windows แบบ Offline-first สร้างด้วย Tauri v2, React,
TypeScript และ SQLite ข้อมูลจะถูกบันทึกในเครื่องก่อนเสมอ และสามารถซิงก์ข้ามเครื่องผ่าน
Supabase เมื่อเข้าสู่ระบบ

## ฟีเจอร์

- เพิ่ม แก้ไข ลบ และค้นหาโน้ต
- บันทึกข้อมูลใน SQLite เมื่อเปิดผ่าน Tauri
- ใช้ localStorage เป็น fallback เมื่อเปิดผ่าน Browser
- สมัครสมาชิก เข้าสู่ระบบ และออกจากระบบด้วย Supabase Auth
- ใช้งานแบบ Local-only ได้โดยไม่ต้องเข้าสู่ระบบ
- อัปโหลด ดาวน์โหลด และซิงก์การลบโน้ต
- เลือกข้อมูลที่แก้ไขล่าสุดเมื่อเกิดการแก้ไขจากหลายเครื่อง
- Auto Sync ทุก 60 วินาที และปุ่ม Sync Now
- Build เป็น Windows installer แบบ NSIS

## ตั้งค่า Supabase

1. สร้างโปรเจกต์ใน Supabase
2. เปิด SQL Editor แล้วรันไฟล์ `sql/supabase_schema.sql`
3. คัดลอก `.env.example` เป็น `.env`
4. ใส่ Project URL และ Anon/Public Key:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

ห้ามนำ Service Role Key มาใส่ในแอป Desktop

หาก Supabase เปิดการยืนยันอีเมล ผู้ใช้ต้องกดลิงก์ยืนยันในอีเมลก่อนเข้าสู่ระบบ

## รันใน Browser

```powershell
npm install
npm run dev
```

โหมด Browser ใช้ localStorage และเหมาะสำหรับตรวจหน้าตา/ฟังก์ชันพื้นฐาน

## รันเป็น Desktop App

```powershell
npm install
npm run tauri:dev
```

## Build ตัวติดตั้ง Windows

```powershell
npm run tauri:build
```

ไฟล์ติดตั้งจะอยู่ที่:

```text
src-tauri/target/release/bundle/nsis/
```
