// 계정 비밀번호 보관 — 평문으로 두지 않는다.
// Windows DPAPI(=Electron safeStorage)로 암호화해 이 PC·이 사용자 계정에서만 풀린다.
// DB 파일이 유출돼도 다른 PC에서는 복호화되지 않는다.

import { safeStorage } from 'electron';

const PREFIX = 'enc:v1:';

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 저장용으로 암호화. 암호화를 못 쓰는 환경이면 저장하지 않는다(평문 저장 금지). */
export function encryptSecret(plain: string): string | null {
  const v = String(plain || '');
  if (!v) return '';
  if (!isEncryptionAvailable()) return null;
  try {
    return PREFIX + safeStorage.encryptString(v).toString('base64');
  } catch {
    return null;
  }
}

/** 복호화. 값이 없거나 실패하면 빈 문자열. */
export function decryptSecret(stored: string | null | undefined): string {
  const v = String(stored || '');
  if (!v) return '';
  if (!v.startsWith(PREFIX)) return ''; // 평문/구버전 값은 신뢰하지 않음
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(PREFIX.length), 'base64'));
  } catch {
    return '';
  }
}

export function hasSecret(stored: string | null | undefined): boolean {
  return !!String(stored || '').startsWith(PREFIX);
}
