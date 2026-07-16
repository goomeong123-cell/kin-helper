import { Database } from 'node-sqlite3-wasm';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

let db: Database;

export function getDb(): Database {
  if (!db) initDb();
  return db;
}

export function closeDb() {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

function sleep(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // init 단계 짧은 대기
  }
}

function tryOpen(dbPath: string): Database | null {
  let candidate: Database | null = null;
  try {
    candidate = new Database(dbPath);
    candidate.exec('PRAGMA foreign_keys = ON');
    candidate.exec('SELECT 1');
    return candidate;
  } catch {
    try {
      candidate?.close();
    } catch {
      // ignore
    }
    return null;
  }
}

export function initDb() {
  const userData = app.getPath('userData');
  if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
  const dbPath = path.join(userData, 'kinhelper.db');
  const lockPath = dbPath + '.lock';

  // 이전 비정상 종료로 남은 잠금(파일 또는 디렉터리)을 미리 정리
  const clearLock = () => {
    try {
      if (fs.existsSync(lockPath)) fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  clearLock();

  let opened: Database | null = null;
  for (let i = 0; i < 10; i++) {
    opened = tryOpen(dbPath);
    if (opened) break;
    sleep(300);
  }

  if (!opened) {
    clearLock();
    sleep(200);
    opened = tryOpen(dbPath);
  }

  if (!opened) {
    throw new Error('DB를 열 수 없습니다. 앱을 완전히 종료 후 다시 실행해 주세요.');
  }

  db = opened;
  migrate();
  return db;
}

function migrate() {
  db.exec(`
    /* 브랜드 / 제품 — 탭 단위 */
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      promo_text TEXT,                 -- 답변에 자연스럽게 녹일 홍보 문구
      promo_image TEXT,                -- 캡처 이미지 (dataURL 또는 파일경로)
      system_prompt TEXT,              -- 이 브랜드 전용 Claude 시스템 프롬프트
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /* 브랜드별 노출/검색 키워드 */
    CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(brand_id, keyword)
    );

    /* 네이버 계정 + 프록시 (1:1 바인딩) */
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      naver_id TEXT NOT NULL UNIQUE,
      naver_pw TEXT,                   -- 선택: 저장 시 로컬에만 보관
      memo TEXT,
      daily_limit INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','rest','suspect')),
      proxy_host TEXT,
      proxy_port TEXT,
      proxy_user TEXT,
      proxy_pass TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /* 수집한 답변 대기 질문 */
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kin_key TEXT NOT NULL UNIQUE,    -- dirId+docId 등 고유키
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      content TEXT,
      category TEXT,
      matched_brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
      matched_keyword TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','answered','skipped')),
      collected_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_questions_status
      ON questions(status, collected_at DESC);

    /* 생성/등록한 답변 */
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
      account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      promo_included INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'manual' CHECK(mode IN ('manual','semi','auto')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','failed')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      posted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_answers_q ON answers(question_id);

    /* 전역 설정 (Claude API 키, 모델, 기본 프롬프트, 기본 모드 등) */
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}
