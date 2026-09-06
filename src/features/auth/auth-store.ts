import { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { isCloudEnabled } from '../../cloud/supabase';
import {
  confirmPasswordReset,
  getCurrentUser,
  onAuthStateChange,
  requestPasswordReset,
  signIn,
  signOut,
  signUp
} from './auth-service';

export function useAuthStore() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getCurrentUser()
      .then((nextUser) => {
        if (active) setUser(nextUser);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'อ่านสถานะบัญชีไม่สำเร็จ');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const unsubscribe = onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const nextUser = await signIn(email, password);
      setUser(nextUser);
      return nextUser;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'เข้าสู่ระบบไม่สำเร็จ');
      throw reason;
    } finally {
      setLoading(false);
    }
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await signUp(email, password);
      setUser(result.needsEmailConfirmation ? null : result.user);
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'สมัครสมาชิกไม่สำเร็จ');
      throw reason;
    } finally {
      setLoading(false);
    }
  }, []);

  const requestReset = useCallback(async (emailAddress: string) => {
    setLoading(true);
    setError(null);
    try {
      await requestPasswordReset(emailAddress);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'ส่งอีเมลรีเซ็ตรหัสผ่านไม่สำเร็จ');
      throw reason;
    } finally {
      setLoading(false);
    }
  }, []);

  const confirmReset = useCallback(async (emailAddress: string, otp: string, newPassword: string) => {
    setLoading(true);
    setError(null);
    try {
      const nextUser = await confirmPasswordReset(emailAddress, otp, newPassword);
      setUser(nextUser);
      return nextUser;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'ตั้งรหัสผ่านใหม่ไม่สำเร็จ');
      throw reason;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await signOut();
      setUser(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'ออกจากระบบไม่สำเร็จ');
      throw reason;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    cloudEnabled: isCloudEnabled(),
    user,
    loading,
    error,
    clearError: () => setError(null),
    login,
    register,
    logout,
    requestPasswordReset: requestReset,
    confirmPasswordReset: confirmReset
  };
}
