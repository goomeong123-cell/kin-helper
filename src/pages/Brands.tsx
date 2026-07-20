import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Brand, Keyword } from '../env';
import { useToast } from '../lib/toast';

export default function Brands() {
  const toast = useToast();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');

  async function load() {
    const b = await window.api.brands.list();
    setBrands(b);
    if (b.length && (activeId === null || !b.find((x) => x.id === activeId))) {
      setActiveId(b[0].id);
    }
    if (b.length === 0) setActiveId(null);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addBrand() {
    if (!newName.trim()) return;
    const b = await window.api.brands.create(newName.trim());
    setNewName('');
    await load();
    setActiveId(b.id);
    toast('브랜드 추가');
  }

  const active = brands.find((b) => b.id === activeId) || null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">브랜드·제품</div>
          <div className="page-sub">브랜드별 홍보 문구, 노출 키워드, 전용 프롬프트를 관리합니다.</div>
        </div>
      </div>

      <div className="tabs">
        {brands.map((b) => (
          <button
            key={b.id}
            className={`tab ${activeId === b.id ? 'active' : ''}`}
            onClick={() => setActiveId(b.id)}
          >
            {b.name}
          </button>
        ))}
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <input
            className="field"
            style={{ width: 150, padding: '8px 12px' }}
            placeholder="새 브랜드"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addBrand()}
          />
          <button className="btn sm" onClick={addBrand}>
            + 추가
          </button>
        </span>
      </div>

      {active ? (
        <BrandEditor key={active.id} brand={active} onChange={load} />
      ) : (
        <div className="empty">브랜드를 추가해 시작하세요.</div>
      )}
    </>
  );
}

function BrandEditor({ brand, onChange }: { brand: Brand; onChange: () => void }) {
  const toast = useToast();
  // 홍보용 프롬프트 (기존 홍보문구가 있으면 초안으로 살려둠)
  const [promoPrompt, setPromoPrompt] = useState(brand.system_prompt || brand.promo_text || '');
  const [image, setImage] = useState<string | null>(brand.promo_image);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [newKw, setNewKw] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadKw() {
    setKeywords(await window.api.keywords.list(brand.id));
  }
  useEffect(() => {
    loadKw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand.id]);

  async function save() {
    await window.api.brands.update(brand.id, {
      system_prompt: promoPrompt,
      promo_image: image ?? '',
    });
    toast('저장됨');
    onChange();
  }

  async function addKw() {
    if (!newKw.trim()) return;
    setKeywords(await window.api.keywords.create(brand.id, newKw.trim()));
    setNewKw('');
  }
  async function removeKw(id: number) {
    await window.api.keywords.remove(id);
    loadKw();
  }

  function pickImage(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setImage(String(reader.result));
    reader.readAsDataURL(f);
  }

  async function del() {
    if (!confirm(`'${brand.name}' 브랜드를 삭제할까요?`)) return;
    await window.api.brands.remove(brand.id);
    onChange();
  }

  return (
    <>
      <div className="card">
        <label className="label">홍보용 프롬프트 (이 브랜드 전용)</label>
        <div className="page-sub" style={{ marginBottom: 8 }}>
          이 브랜드로 홍보 답변을 쓸 때 Claude에게 주는 지시문입니다. <b>어떤 제품을 어떻게 홍보할지 여기에 직접 적으세요.</b>
          <br />
          비워두면 이 브랜드는 <b>홍보 대상에서 제외</b>되고, 완전자동에서도 선택되지 않습니다.
        </div>
        <textarea
          className="field"
          placeholder={
            '예) 너는 노트북을 오래 써온 평범한 직장인이다. 질문에 진짜 도움되는 답을 먼저 충분히 쓰고,\n' +
            '맥락이 맞을 때만 "OO 쿨링패드"를 경험담처럼 딱 한 번 자연스럽게 언급해라.\n' +
            '광고 티, 과장, 링크 나열 금지. 억지스러우면 제품은 아예 빼라.'
          }
          value={promoPrompt}
          onChange={(e) => setPromoPrompt(e.target.value)}
          rows={7}
        />
        <div style={{ height: 16 }} />
        <label className="label">홍보 이미지 (선택)</label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {image && (
            <img
              src={image}
              alt="promo"
              style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)' }}
            />
          )}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            {image ? '이미지 변경' : '이미지 선택'}
          </button>
          {image && (
            <button className="btn sm ghost" onClick={() => setImage(null)}>
              제거
            </button>
          )}
        </div>
        <div style={{ marginTop: 18, display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={save}>
            저장
          </button>
          <button className="btn danger sm" onClick={del}>
            브랜드 삭제
          </button>
        </div>
      </div>

      <div className="card">
        <label className="label">노출·검색 키워드</label>
        <div className="page-sub" style={{ marginBottom: 10 }}>
          이 키워드로 지식인에서 질문을 수집합니다.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {keywords.map((k) => (
            <span key={k.id} className="badge blue" style={{ display: 'inline-flex', gap: 6 }}>
              {k.keyword}
              <button className="btn ghost" style={{ padding: 0, color: 'inherit' }} onClick={() => removeKw(k.id)}>
                ✕
              </button>
            </span>
          ))}
          {keywords.length === 0 && <span className="muted">키워드가 없습니다.</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="field"
            placeholder="예: 노트북 발열, 쿨링패드"
            value={newKw}
            onChange={(e) => setNewKw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addKw()}
          />
          <button className="btn" onClick={addKw}>
            추가
          </button>
        </div>
      </div>
    </>
  );
}
