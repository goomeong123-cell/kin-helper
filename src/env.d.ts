/// <reference types="vite/client" />

export interface Brand {
  id: number;
  name: string;
  promo_text: string | null;
  promo_image: string | null;
  system_prompt: string | null;
  created_at: string;
}

export interface Keyword {
  id: number;
  brand_id: number;
  keyword: string;
}

export interface Account {
  id: number;
  naver_id: string;
  memo: string | null;
  daily_limit: number;
  status: 'active' | 'rest' | 'suspect';
  proxy_host: string | null;
  proxy_port: string | null;
  proxy_user: string | null;
  proxy_pass: string | null;
  created_at: string;
}

export interface Question {
  id: number;
  kin_key: string;
  title: string;
  url: string;
  content: string | null;
  category: string | null;
  matched_brand_id: number | null;
  matched_keyword: string | null;
  status: 'new' | 'answered' | 'skipped';
  collected_at: string;
}

export interface Answer {
  id: number;
  question_id: number;
  brand_id: number | null;
  account_id: number | null;
  body: string;
  promo_included: number;
  mode: 'manual' | 'semi' | 'auto';
  status: 'draft' | 'posted' | 'failed';
  error: string | null;
  created_at: string;
  posted_at: string | null;
}

export type PostMode = 'manual' | 'semi' | 'auto';

export interface Api {
  brands: {
    list: () => Promise<Brand[]>;
    create: (name: string) => Promise<Brand>;
    update: (
      id: number,
      fields: Partial<Pick<Brand, 'name' | 'promo_text' | 'promo_image' | 'system_prompt'>>,
    ) => Promise<Brand>;
    remove: (id: number) => Promise<boolean>;
  };
  keywords: {
    list: (brandId: number) => Promise<Keyword[]>;
    create: (brandId: number, keyword: string) => Promise<Keyword[]>;
    remove: (id: number) => Promise<boolean>;
  };
  accounts: {
    list: () => Promise<Account[]>;
    create: (naverId: string) => Promise<{ ok: boolean; account?: Account; error?: string }>;
    update: (id: number, fields: Record<string, unknown>) => Promise<Account>;
    remove: (id: number) => Promise<boolean>;
    login: (id: number) => Promise<{ ok: boolean; error?: string }>;
  };
  questions: {
    collect: (opts: { brandId?: number; accountId?: number }) => Promise<{ ok: boolean; inserted: number }>;
    list: (opts: { status?: string; brandId?: number }) => Promise<Question[]>;
    setStatus: (id: number, status: string) => Promise<boolean>;
  };
  answers: {
    generate: (opts: { questionId: number; brandId?: number; includePromo?: boolean }) => Promise<{ ok: boolean; answer?: Answer; error?: string }>;
    generateAll: (questionIds: number[]) => Promise<{ ok: boolean; done?: number; failed?: number; error?: string }>;
    generateAllStatus: () => Promise<{ running: boolean }>;
    drafts: () => Promise<Answer[]>;
    listForQuestion: (questionId: number) => Promise<Answer[]>;
    updateBody: (id: number, body: string) => Promise<Answer>;
    post: (opts: { answerId: number; accountId: number; mode: PostMode }) => Promise<{ ok: boolean; error?: string; needsHuman?: boolean }>;
    markPosted: (answerId: number, accountId?: number) => Promise<{ ok: boolean }>;
    history: () => Promise<Array<Answer & { question_title: string; question_url: string; brand_name: string | null; account_naver_id: string | null }>>;
  };
  settings: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<boolean>;
  };
  app: {
    version: () => Promise<string>;
  };
  auto: {
    start: (opts: { accountId: number; submit: boolean }) => Promise<{ ok: boolean; error?: string }>;
    stop: () => Promise<boolean>;
    next: () => Promise<boolean>;
    status: () => Promise<{
      running: boolean;
      status: string;
      count: number;
      waiting: boolean;
      log: string[];
    }>;
  };
}

declare global {
  interface Window {
    api: Api;
  }
}
