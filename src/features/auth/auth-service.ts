import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { supabase } from '../../cloud/supabase';

function requireSupabase() {
  if (!supabase) {
    throw new Error('ยังไม่ได้ตั้งค่า Supabase กรุณาเพิ่ม URL และ Anon Key ในไฟล์ .env');
  }
  return supabase;
}

export async function getCurrentUser(): Promise<User | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.user ?? null;
}

export async function signIn(email: string, password: string): Promise<User> {
  const { data, error } = await requireSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.user) throw new Error('เข้าสู่ระบบไม่สำเร็จ');
  return data.user;
}

export async function signUp(email: string, password: string): Promise<{
  user: User;
  needsEmailConfirmation: boolean;
}> {
  const { data, error } = await requireSupabase().auth.signUp({ email, password });
  if (error) throw error;
  if (!data.user) throw new Error('สมัครสมาชิกไม่สำเร็จ');
  return { user: data.user, needsEmailConfirmation: !data.session };
}

export async function signOut(): Promise<void> {
  const { error } = await requireSupabase().auth.signOut();
  if (error) throw error;
}

export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void
) {
  if (!supabase) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange(callback);
  return () => data.subscription.unsubscribe();
}
