import { getDb } from './db';

/**
 * Claude Messages API 호출 (Electron 메인 프로세스, 단일 엔드포인트라 fetch 사용).
 * 모델 기본값은 claude-opus-4-8, 설정에서 변경 가능.
 * temperature 등 샘플링 파라미터는 opus 4.8에서 제거되어 보내지 않음.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get([key]) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export interface GenerateInput {
  systemPrompt: string; // 사용자가 주입한 시스템 프롬프트 (브랜드별 or 전역)
  questionTitle: string;
  questionBody: string;
  promoText?: string; // 홍보 문구 (있으면 자연스럽게 녹이도록 전달)
}

export interface GenerateResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * 홍보 답변 전 연관성 판정 — 이 질문에 이 제품을 꺼내도 뜬금없지 않은가.
 * 기준은 느슨하게(사용자 요청): 조금이라도 이어지면 YES, 누가 봐도 엉뚱한 광고가 될 때만 NO.
 * 가장 싼 모델(Haiku 5.5)로 한 번 묻는다. 질문당 0.2원 안팎. (tests/relevance.mjs)
 */
export const RELEVANCE_MODEL = 'claude-haiku-5-5';
export interface RelevanceResult {
  ok: boolean;
  relevant?: boolean;
  reason?: string;
  error?: string;
}
export function parseRelevance(text: string): RelevanceResult {
  const lines = String(text || '').trim().split(/\r?\n/);
  const m = /^\s*\**\s*(YES|NO)\b/i.exec(lines[0] || '');
  if (!m) return { ok: false, error: `판정 응답을 읽지 못함: ${String(text).slice(0, 60)}` };
  const reason = (lines.slice(1).join(' ').trim() || lines[0].replace(m[0], '').trim()).slice(0, 80);
  return { ok: true, relevant: m[1].toUpperCase() === 'YES', reason };
}
export async function judgeRelevance(input: {
  brandPrompt: string;
  questionTitle: string;
  questionBody: string;
}): Promise<RelevanceResult> {
  const apiKey = getSetting('claude_api_key');
  if (!apiKey) return { ok: false, error: 'Claude API 키가 설정되지 않았습니다.' };
  const system =
    '너는 네이버 지식인 답변을 검토하는 사람이다. [제품 홍보 지시]에 나온 제품을 이 [질문]의 답변에서 언급해도 되는지 판단한다.\n' +
    '기준은 느슨하게 잡는다. 질문 주제가 제품 분야와 조금이라도 이어지면(같은 피부 고민, 같은 신체 부위, 관리 방법, 관련 생활습관 등) YES.\n' +
    '제품을 꺼내면 누가 봐도 뜬금없는 광고가 되는 경우에만 NO. (예: 화장품 홍보인데 게임, 법률, 자동차, 공부 질문)\n' +
    '첫 줄에 YES 또는 NO 한 단어만 쓰고, 둘째 줄에 20자 이내로 이유를 쓴다.';
  const user =
    `[제품 홍보 지시]\n${input.brandPrompt.slice(0, 1500)}\n\n` +
    `[질문 제목]\n${input.questionTitle}\n\n[질문 내용]\n${(input.questionBody || '(본문 없음)').slice(0, 1500)}`;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: RELEVANCE_MODEL,
        max_tokens: 300,
        thinking: { type: 'disabled' }, // 한 단어 분류라 생각 불필요 (Haiku 5.5 는 기본 effort medium 에서 허용)
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) return { ok: false, error: `Claude API 오류 (${res.status}): ${(await res.text()).slice(0, 200)}` };
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
    if (data.stop_reason === 'refusal') return { ok: false, error: '판정 모델이 응답을 거절함' };
    const text = (data.content || []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
    return parseRelevance(text);
  } catch (e: unknown) {
    return { ok: false, error: `네트워크 오류: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 질문 하나에 대한 답변 초안 생성 */
export async function generateAnswer(input: GenerateInput): Promise<GenerateResult> {
  const apiKey = getSetting('claude_api_key');
  if (!apiKey) {
    return { ok: false, error: 'Claude API 키가 설정되지 않았습니다. 설정 탭에서 입력해 주세요.' };
  }
  const model = getSetting('claude_model') || 'claude-opus-4-8';

  // 사용자 프롬프트를 골격으로, 질문/홍보 맥락을 유저 메시지로 전달.
  const promoLine = input.promoText
    ? `\n\n[참고: 답변이 아래 제품과 정말 관련 있을 때에만, 억지스럽지 않게 자연스럽게 한 번 언급해도 됩니다. 관련 없으면 절대 넣지 마세요.]\n제품 소개: ${input.promoText}`
    : '';

  const hasBody = !!(input.questionBody && input.questionBody.trim().length > 0);
  const bodyPart = hasBody
    ? `[질문 내용]\n${input.questionBody}`
    : `[질문 내용]\n(이 질문은 본문 없이 제목만 있습니다. 제목만 보고 질문자가 무엇을 궁금해하는지 추론해서, 그 주제에 대해 실질적으로 도움이 되는 답변을 작성하세요.)`;

  const userContent =
    `아래는 네이버 지식인에 올라온, 아직 답변이 없는 질문입니다. ` +
    `질문자에게 진짜 도움이 되는 답변을 작성해 주세요.\n\n` +
    `[질문 제목]\n${input.questionTitle}\n\n` +
    bodyPart +
    promoLine +
    `\n\n[반드시 지킬 것]\n` +
    `- 답변 본문만 출력. 머리말/맺음말 상투구 없이 사람이 직접 쓴 것처럼 자연스럽게.\n` +
    `- "질문 내용이 안 보인다", "본문이 비어있다", "다시 적어달라" 같이 되묻거나 답변을 미루는 말은 절대 쓰지 말 것.\n` +
    `- 정보가 부족하면 일반적으로 가장 가능성 높은 상황을 가정하고, 그에 맞는 구체적인 도움을 주세요.`;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system: input.systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      return { ok: false, error: `Claude API 오류 (${res.status}): ${errBody.slice(0, 300)}` };
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
    };

    const text = (data.content || [])
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text) {
      return { ok: false, error: '답변이 비어 있습니다. 프롬프트를 확인해 주세요.' };
    }
    return { ok: true, text };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `네트워크 오류: ${msg}` };
  }
}
