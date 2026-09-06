import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { supabase } from '../../cloud/supabase';

function requireSupabase() {
  if (!supabase) {
    throw new Error('ยังไม่ได้ตั้งค่า Supabase กรุณาเพิ่ม URL และ Anon Key ในไฟล์ .env');
  }
  return supabase;
}

// Supabase ส่งข้อความผิดพลาดมาเป็นภาษาอังกฤษ แปลงเป็นไทยก่อนโยนต่อให้ UI
const AUTH_ERROR_TH: Record<string, string> = {
  invalid_credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  email_not_confirmed: 'ยังไม่ได้ยืนยันอีเมล กรุณาเปิดลิงก์ยืนยันในกล่องจดหมายก่อน',
  user_not_found: 'ไม่พบบัญชีนี้ กรุณาตรวจสอบอีเมลอีกครั้ง',
  user_banned: 'บัญชีนี้ถูกระงับการใช้งาน',
  email_exists: 'อีเมลนี้สมัครไว้แล้ว กรุณาเข้าสู่ระบบแทน',
  user_already_exists: 'อีเมลนี้สมัครไว้แล้ว กรุณาเข้าสู่ระบบแทน',
  email_address_invalid: 'รูปแบบอีเมลไม่ถูกต้อง',
  validation_failed: 'กรอกข้อมูลไม่ครบหรือรูปแบบไม่ถูกต้อง',
  weak_password: 'รหัสผ่านสั้นหรือคาดเดาง่ายเกินไป กรุณาตั้งใหม่ให้ยาวขึ้น',
  same_password: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม',
  signup_disabled: 'ระบบปิดรับสมัครสมาชิกใหม่ชั่วคราว',
  email_provider_disabled: 'ระบบปิดการเข้าสู่ระบบด้วยอีเมลชั่วคราว',
  over_request_rate_limit: 'ลองบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  over_email_send_rate_limit: 'ส่งอีเมลบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  session_expired: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  session_not_found: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  refresh_token_not_found: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  refresh_token_already_used: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  request_timeout: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
  otp_expired: 'รหัสยืนยันหมดอายุหรือไม่ถูกต้อง กรุณาขอรหัสใหม่',
  otp_disabled: 'รหัสยืนยันไม่ถูกต้อง กรุณาขอรหัสใหม่'
};

// เซิร์ฟเวอร์รุ่นเก่าอาจไม่ส่ง code มา จึงเดาจากข้อความสำรองไว้ด้วย
const AUTH_ERROR_TH_BY_MESSAGE: [RegExp, string][] = [
  [/invalid login credentials/i, AUTH_ERROR_TH.invalid_credentials],
  [/email not confirmed/i, AUTH_ERROR_TH.email_not_confirmed],
  [/already registered/i, AUTH_ERROR_TH.user_already_exists],
  [/password should be at least/i, AUTH_ERROR_TH.weak_password],
  [/unable to validate email address/i, AUTH_ERROR_TH.email_address_invalid],
  [/failed to fetch|network ?error|load failed/i, AUTH_ERROR_TH.request_timeout],
  [/token has expired or is invalid/i, AUTH_ERROR_TH.otp_expired]
];

function toThaiAuthError(reason: unknown, fallback: string): Error {
  const code = typeof reason === 'object' && reason !== null ? (reason as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && AUTH_ERROR_TH[code]) {
    return new Error(AUTH_ERROR_TH[code]);
  }

  const message = reason instanceof Error ? reason.message : '';
  const matched = AUTH_ERROR_TH_BY_MESSAGE.find(([pattern]) => pattern.test(message));
  if (matched) return new Error(matched[1]);

  // ข้อความไทยที่เราโยนเองอยู่แล้ว (เช่น ยังไม่ได้ตั้งค่า Supabase) ให้ผ่านไปตามเดิม
  if (message && !/^[\x00-\x7F]*$/.test(message)) return reason as Error;

  return new Error(fallback);
}

export async function getCurrentUser(): Promise<User | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw toThaiAuthError(error, 'อ่านสถานะบัญชีไม่สำเร็จ');
  return data.session?.user ?? null;
}

export async function signIn(email: string, password: string): Promise<User> {
  const { data, error } = await requireSupabase().auth.signInWithPassword({ email, password });
  if (error) throw toThaiAuthError(error, 'เข้าสู่ระบบไม่สำเร็จ');
  if (!data.user) throw new Error('เข้าสู่ระบบไม่สำเร็จ');
  return data.user;
}

export async function signUp(email: string, password: string): Promise<{
  user: User;
  needsEmailConfirmation: boolean;
}> {
  const { data, error } = await requireSupabase().auth.signUp({ email, password });
  if (error) throw toThaiAuthError(error, 'สมัครสมาชิกไม่สำเร็จ');
  if (!data.user) throw new Error('สมัครสมาชิกไม่สำเร็จ');
  return { user: data.user, needsEmailConfirmation: !data.session };
}

// ส่งอีเมลที่มีรหัสยืนยันไปให้ผู้ใช้เพื่อตั้งรหัสผ่านใหม่ (ต้องตั้งค่า Email
// Template "Reset Password" ในแดชบอร์ด Supabase ให้แสดง {{ .Token }} ด้วย ไม่งั้น
// อีเมลจะมีแต่ลิงก์ ซึ่งแอปเดสก์ท็อปเปิดรับกลับมาไม่ได้)
export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await requireSupabase().auth.resetPasswordForEmail(email);
  if (error) throw toThaiAuthError(error, 'ส่งอีเมลรีเซ็ตรหัสผ่านไม่สำเร็จ');
}

// ยืนยันรหัสจากอีเมล แล้วตั้งรหัสผ่านใหม่ในขั้นตอนเดียว
export async function confirmPasswordReset(
  email: string,
  otp: string,
  newPassword: string
): Promise<User> {
  const client = requireSupabase();
  const { data, error } = await client.auth.verifyOtp({ email, token: otp, type: 'recovery' });
  if (error) throw toThaiAuthError(error, 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ');
  if (!data.user) throw new Error('ยืนยันรหัสไม่สำเร็จ');

  const { data: updated, error: updateError } = await client.auth.updateUser({ password: newPassword });
  if (updateError) throw toThaiAuthError(updateError, 'ตั้งรหัสผ่านใหม่ไม่สำเร็จ');
  if (!updated.user) throw new Error('ตั้งรหัสผ่านใหม่ไม่สำเร็จ');
  return updated.user;
}

export async function signOut(): Promise<void> {
  const { error } = await requireSupabase().auth.signOut();
  if (error) throw toThaiAuthError(error, 'ออกจากระบบไม่สำเร็จ');
}

export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void
) {
  if (!supabase) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange(callback);
  return () => data.subscription.unsubscribe();
}
