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

  const userContent =
    `아래는 네이버 지식인에 올라온, 아직 답변이 없는 질문입니다. ` +
    `질문자에게 진짜 도움이 되는 답변을 작성해 주세요.\n\n` +
    `[질문 제목]\n${input.questionTitle}\n\n` +
    `[질문 내용]\n${input.questionBody || '(본문 없음)'}` +
    promoLine +
    `\n\n답변 본문만 출력하세요. 머리말/맺음말 상투구 없이 사람이 직접 쓴 것처럼 자연스럽게.`;

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
