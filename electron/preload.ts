import { contextBridge, ipcRenderer } from 'electron';

const api = {
  brands: {
    list: () => ipcRenderer.invoke('brands:list'),
    create: (name: string) => ipcRenderer.invoke('brands:create', name),
    update: (
      id: number,
      fields: { name?: string; promo_text?: string; promo_image?: string; system_prompt?: string },
    ) => ipcRenderer.invoke('brands:update', id, fields),
    remove: (id: number) => ipcRenderer.invoke('brands:remove', id),
  },
  keywords: {
    list: (brandId: number) => ipcRenderer.invoke('keywords:list', brandId),
    create: (brandId: number, keyword: string) =>
      ipcRenderer.invoke('keywords:create', brandId, keyword),
    remove: (id: number) => ipcRenderer.invoke('keywords:remove', id),
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    create: (naverId: string) => ipcRenderer.invoke('accounts:create', naverId),
    update: (id: number, fields: Record<string, unknown>) =>
      ipcRenderer.invoke('accounts:update', id, fields),
    remove: (id: number) => ipcRenderer.invoke('accounts:remove', id),
    login: (id: number) => ipcRenderer.invoke('accounts:login', id),
  },
  questions: {
    collect: (opts: { brandId?: number; accountId?: number }) =>
      ipcRenderer.invoke('questions:collect', opts),
    list: (opts: { status?: string; brandId?: number }) =>
      ipcRenderer.invoke('questions:list', opts),
    setStatus: (id: number, status: string) =>
      ipcRenderer.invoke('questions:setStatus', id, status),
  },
  answers: {
    generate: (opts: { questionId: number; brandId?: number; includePromo?: boolean }) =>
      ipcRenderer.invoke('answers:generate', opts),
    generateAll: (questionIds: number[]) => ipcRenderer.invoke('answers:generateAll', questionIds),
    generateAllStatus: () => ipcRenderer.invoke('answers:generateAllStatus'),
    drafts: () => ipcRenderer.invoke('answers:drafts'),
    listForQuestion: (questionId: number) =>
      ipcRenderer.invoke('answers:listForQuestion', questionId),
    updateBody: (id: number, body: string) =>
      ipcRenderer.invoke('answers:updateBody', id, body),
    post: (opts: { answerId: number; accountId: number; mode: 'manual' | 'semi' | 'auto' }) =>
      ipcRenderer.invoke('answers:post', opts),
    markPosted: (answerId: number, accountId?: number) =>
      ipcRenderer.invoke('answers:markPosted', answerId, accountId),
    history: () => ipcRenderer.invoke('answers:history'),
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
  },
  auto: {
    start: (opts: { accountId: number; submit: boolean; brandId?: number }) => ipcRenderer.invoke('auto:start', opts),
    stop: () => ipcRenderer.invoke('auto:stop'),
    next: () => ipcRenderer.invoke('auto:next'),
    status: () => ipcRenderer.invoke('auto:status'),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
