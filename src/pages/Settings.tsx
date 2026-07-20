import { useEffect, useState } from 'react';
import { useToast } from '../lib/toast';

const DEFAULT_DAILY =
  '당신은 특정 분야에 경험이 있는 평범한 사람입니다. 네이버 지식인에서 질문에 답합니다.\n' +
  '전문성은 있되 절대 딱딱하거나 AI 같지 않게, 실제 사람이 편하게 도와주듯 자연스럽게 답하세요.\n' +
  '과장·상투구·불필요한 인사말을 피하고, 질문에 실질적으로 도움이 되는 내용을 담으세요.';

const DEFAULT_PROMO =
  '당신은 특정 분야에 경험이 있는 평범한 사람입니다. 네이버 지식인 질문에 진짜 도움이 되는 답변을 씁니다.\n' +
  '답변의 대부분은 순수하게 도움되는 내용이어야 하고, 정말 맥락에 맞을 때에만 제공된 제품을 경험담처럼 딱 한 번 자연스럽게 언급하세요.\n' +
  '광고 티·과장·링크 나열·상투구는 절대 금지. 억지스러우면 제품을 아예 빼세요. 사람이 직접 쓴 것처럼 편하게.';

export default function Settings() {
  const toast = useToast();
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-opus-4-8');
  const [dailyPrompt, setDailyPrompt] = useState('');
  const [promoPrompt, setPromoPrompt] = useState('');
  const [promoRatio, setPromoRatio] = useState(20);
  const [minInt, setMinInt] = useState(90);
  const [maxInt, setMaxInt] = useState(240);

  useEffect(() => {
    (async () => {
      setApiKey((await window.api.settings.get('claude_api_key')) || '');
      setModel((await window.api.settings.get('claude_model')) || 'claude-opus-4-8');
      // 일상 프롬프트: 신규 키 우선, 없으면 구버전 global_prompt 호환
      const daily =
        (await window.api.settings.get('daily_prompt')) ||
        (await window.api.settings.get('global_prompt')) ||
        '';
      setDailyPrompt(daily);
      setPromoPrompt((await window.api.settings.get('promo_prompt')) || '');
      const r = await window.api.settings.get('promo_ratio');
      setPromoRatio(r ? Number(r) : 20);
      const mn = await window.api.settings.get('auto_min_interval');
      const mx = await window.api.settings.get('auto_max_interval');
      setMinInt(mn ? Number(mn) : 90);
      setMaxInt(mx ? Number(mx) : 240);
    })();
  }, []);

  async function save() {
    await window.api.settings.set('claude_api_key', apiKey.trim());
    await window.api.settings.set('claude_model', model);
    await window.api.settings.set('daily_prompt', dailyPrompt);
    await window.api.settings.set('promo_prompt', promoPrompt);
    await window.api.settings.set('promo_ratio', String(promoRatio));
    await window.api.settings.set('auto_min_interval', String(minInt));
    await window.api.settings.set('auto_max_interval', String(Math.max(minInt, maxInt)));
    toast('설정 저장됨');
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">설정</div>
          <div className="page-sub">Claude API, 답변 프롬프트(일상/홍보), 홍보 비율을 설정합니다.</div>
        </div>
      </div>

      <div className="card">
        <label className="label">Claude API 키</label>
        <input
          className="field"
          type="password"
          placeholder="sk-ant-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <div className="page-sub" style={{ marginTop: 6 }}>
          키는 이 PC에만 로컬 저장됩니다.
        </div>

        <div style={{ height: 18 }} />
        <label className="label">모델</label>
        <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="claude-opus-4-8">claude-opus-4-8 (기본·고품질)</option>
          <option value="claude-sonnet-5">claude-sonnet-5 (빠르고 경제적)</option>
          <option value="claude-haiku-4-5">claude-haiku-4-5 (가장 저렴)</option>
        </select>
      </div>

      <div className="card">
        <label className="label">홍보 답변 비율</label>
        <div className="page-sub" style={{ marginBottom: 14 }}>
          전체 답변 중 홍보 답변을 섞을 비율입니다. 나머지는 일상(순수 도움) 답변으로 생성됩니다.
          <br />
          질문마다 이 비율에 따라 홍보/일상이 자동으로 정해지고, 답변별로 직접 바꿀 수 있습니다.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={promoRatio}
            onChange={(e) => setPromoRatio(Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--blue)' }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <span className="badge amber" style={{ fontSize: 13 }}>
              홍보 {promoRatio}%
            </span>
            <span className="badge green" style={{ fontSize: 13 }}>
              일상 {100 - promoRatio}%
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <label className="label">완전자동 답변 간격</label>
        <div className="page-sub" style={{ marginBottom: 12 }}>
          답변 등록 후 다음 질문까지 기다리는 시간입니다. 이 범위 안에서 <b>매번 랜덤</b>으로 정해집니다(사람처럼 일정하지 않게).
          <br />
          너무 짧으면 봇으로 의심받기 쉬우니 <b>90초 이상</b>을 권장합니다.
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <label className="label">최소(초)</label>
            <input
              className="field"
              type="number"
              min={5}
              style={{ width: 120 }}
              value={minInt}
              onChange={(e) => setMinInt(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="label">최대(초)</label>
            <input
              className="field"
              type="number"
              min={5}
              style={{ width: 120 }}
              value={maxInt}
              onChange={(e) => setMaxInt(Number(e.target.value))}
            />
          </div>
          <span className="badge blue" style={{ fontSize: 13, alignSelf: 'flex-end', marginBottom: 12 }}>
            현재: {Math.floor(minInt / 60)}분 {minInt % 60}초 ~ {Math.floor(maxInt / 60)}분 {maxInt % 60}초
          </span>
        </div>
      </div>

      <div className="card">
        <label className="label">일상글 프롬프트 (공통)</label>
        <div className="page-sub" style={{ marginBottom: 8 }}>
          홍보 없이 순수하게 도움만 주는 일반 답변에 쓰입니다. 사람 말투·자연스러움이 핵심입니다.
        </div>
        <textarea
          className="field"
          rows={6}
          placeholder={DEFAULT_DAILY}
          value={dailyPrompt}
          onChange={(e) => setDailyPrompt(e.target.value)}
        />
        <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setDailyPrompt(DEFAULT_DAILY)}>
          기본값 채우기
        </button>
      </div>

      <div className="card">
        <label className="label">홍보용 프롬프트 (공통)</label>
        <div className="page-sub" style={{ marginBottom: 8 }}>
          제품 홍보를 섞는 답변에 쓰입니다. 브랜드 탭의 “홍보문구(제품 정보)”가 이 프롬프트와 함께 전달됩니다.
        </div>
        <textarea
          className="field"
          rows={6}
          placeholder={DEFAULT_PROMO}
          value={promoPrompt}
          onChange={(e) => setPromoPrompt(e.target.value)}
        />
        <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setPromoPrompt(DEFAULT_PROMO)}>
          기본값 채우기
        </button>
      </div>

      <button className="btn primary" onClick={save}>
        저장
      </button>
    </>
  );
}
