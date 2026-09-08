// 네이버 로그인 전용 — Playwright로 '시스템에 설치된 진짜 Chrome'을 띄운다.
//
// 왜 Electron 창을 안 쓰나:
//   Electron은 크롬이 아니라서 sec-ch-ua / userAgentData / 권한상태 등에서 흔적이 남고,
//   그걸 JS로 위장하면 위장 자체가 또 탐지 신호가 된다(두더지 잡기).
//   로그인은 네이버가 가장 엄격하게 보는 순간이라, 아예 '진짜 크롬'으로 처리한다.
//
// 핵심 전략(카페포스터에서 검증된 방식):
//   1) channel:'chrome' — 시스템 Chrome 사용 (지문이 진짜)
//   2) 계정별 영속 프로필 — 쿠키/히스토리/캐시가 쌓여 '항상 첫 방문' 신호를 없앰
//   3) 계정↔프록시 1:1 고정
//   4) 자동화 플래그 제거 (--enable-automation 등)
//   5) 계정마다 코어수/메모리/해상도를 고정값으로 다르게 → 한 PC에서 돌려도 계정이 안 묶임
//      (canvas/WebGL/폰트는 건드리지 않는다 — 모순이 생기면 오히려 들킴)

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { AccountProxy } from './naver';

/** 계정 시드로부터 항상 같은 값이 나오는 지문 (접속마다 바뀌면 그게 봇 신호) */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface DerivedFp {
  cores: number;
  memory: number;
  screenW: number;
  screenH: number;
}

export function deriveFingerprint(seed: string): DerivedFp {
  const h = fnv1a(seed || 'default');
  // 부호없는 시프트(>>>) 필수 — 부호있는 >> 를 쓰면 음수 인덱스가 나와 터진다
  const cores = [4, 6, 8, 12, 16][h % 5];
  const memory = [4, 8, 16][(h >>> 3) % 3];
  const resolutions: Array<[number, number]> = [
    [1440, 900], [1536, 864], [1600, 900], [1920, 1080], [1680, 1050], [1600, 1024],
  ];
  const [screenW, screenH] = resolutions[(h >>> 6) % resolutions.length];
  return { cores, memory, screenW, screenH };
}

/** 계정별 크롬 프로필 폴더 (쿠키·히스토리가 쌓이는 곳) */
export function profileDirFor(accountId: number): string {
  const dir = path.join(app.getPath('userData'), 'chrome-profiles', String(accountId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface PwLoginResult {
  ok: boolean;
  error?: string;
  cookies?: Array<{
    name: string; value: string; domain: string; path: string;
    expires: number; httpOnly: boolean; secure: boolean; sameSite?: string;
  }>;
}

/**
 * 진짜 Chrome으로 네이버 로그인 창을 띄우고, 사람이 로그인할 때까지 기다린다.
 * 로그인이 확인되면(NID_AUT 쿠키) 그 쿠키를 반환한다. 창을 닫으면 종료.
 */
export async function loginWithRealChrome(
  acc: AccountProxy,
  onStatus?: (s: string) => void,
): Promise<PwLoginResult> {
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    return { ok: false, error: 'playwright 로드 실패: ' + (e instanceof Error ? e.message : String(e)) };
  }

  const fp = deriveFingerprint(acc.naverId || String(acc.id));
  const proxy =
    acc.proxyHost && acc.proxyPort
      ? {
          server: `http://${acc.proxyHost}:${acc.proxyPort}`,
          username: acc.proxyUser || undefined,
          password: acc.proxyPass || undefined,
        }
      : undefined;

  let ctx: import('playwright').BrowserContext | null = null;
  try {
    onStatus?.('진짜 Chrome 실행 중…');
    ctx = await chromium.launchPersistentContext(profileDirFor(acc.id), {
      headless: false, // 사람이 직접 로그인해야 하므로 반드시 화면 표시
      channel: 'chrome', // 시스템에 설치된 진짜 Chrome
      proxy,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      viewport: null, // 실제 창 크기 그대로 (자연스러운 지문)
      args: ['--no-default-browser-check', '--no-first-run', '--window-size=1280,900'],
      // Playwright가 기본으로 붙이는 자동화 표식 제거
      ignoreDefaultArgs: [
        '--enable-automation',
        '--no-sandbox',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-component-update',
      ],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/channel|chrome.*not found|Executable doesn't exist/i.test(msg)) {
      return { ok: false, error: '이 컴퓨터에 Google Chrome이 설치돼 있지 않습니다. Chrome을 먼저 설치해 주세요.' };
    }
    return { ok: false, error: 'Chrome 실행 실패: ' + msg.slice(0, 200) };
  }

  try {
    // 자동화 흔적만 가린다. 진짜 크롬이라 그 외에는 위장할 게 없다.
    await ctx.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {
        /* ignore */
      }
    });
    // 계정마다 다른 기기처럼 보이게 (한 PC에서 여러 계정을 써도 서로 안 묶이도록)
    await ctx.addInitScript((f: DerivedFp) => {
      try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => f.cores }); } catch { /* ignore */ }
      try { Object.defineProperty(navigator, 'deviceMemory', { get: () => f.memory }); } catch { /* ignore */ }
      const sd: Record<string, number> = {
        width: f.screenW, height: f.screenH,
        availWidth: f.screenW, availHeight: f.screenH - 40,
        colorDepth: 24, pixelDepth: 24,
      };
      for (const k of Object.keys(sd)) {
        try { Object.defineProperty((globalThis as any).screen, k, { get: () => sd[k] }); } catch { /* ignore */ }
      }
    }, fp);

    const page = ctx.pages()[0] || (await ctx.newPage());
    onStatus?.('네이버 로그인 페이지 여는 중…');
    await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'domcontentloaded' }).catch(() => {});
    onStatus?.('로그인해 주세요. (로그인하면 자동으로 감지합니다)');

    // 로그인 완료(NID_AUT 발급)까지 대기. 사용자가 창을 닫으면 종료.
    let closed = false;
    ctx.on('close', () => {
      closed = true;
    });
    const deadline = Date.now() + 1000 * 60 * 10; // 최대 10분
    let cookies: PwLoginResult['cookies'];
    while (!closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      let cs: Awaited<ReturnType<import('playwright').BrowserContext['cookies']>> = [];
      try {
        cs = await ctx.cookies();
      } catch {
        break; // 컨텍스트가 닫힘
      }
      const hasAuth = cs.some((c) => c.name === 'NID_AUT' && c.value);
      if (hasAuth) {
        cookies = cs
          .filter((c) => /(^|\.)naver\.com$/.test(c.domain.replace(/^\./, '.')) || c.domain.includes('naver.com'))
          .map((c) => ({
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            expires: c.expires, httpOnly: c.httpOnly, secure: c.secure,
            sameSite: c.sameSite,
          }));
        onStatus?.('로그인 확인됨 — 세션을 앱으로 옮기는 중…');
        break;
      }
    }
    if (!cookies) {
      return { ok: false, error: closed ? '로그인하지 않고 창을 닫았습니다.' : '로그인 대기 시간이 지났습니다.' };
    }
    return { ok: true, cookies };
  } finally {
    // 로그인 감지 후에도 프로필은 남는다(다음 로그인 때 히스토리가 이어지도록).
    try {
      await ctx?.close();
    } catch {
      /* ignore */
    }
  }
}
