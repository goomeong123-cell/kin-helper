/**
 * 프록시 출구 IP가 '통신사 회선'인지 '서버 호스팅(IDC) 대역'인지 판별.
 * 근거: 공개 RDAP 등록 정보의 대역명(netname). 네이버도 같은 구분을 한다 —
 * 가정용/모바일 회선에서 온 로그인과 IDC 대역에서 온 로그인은 출발선이 다르다(실사례: 하이온넷 대역에서 보호조치).
 * 조회는 공개 레지스트리에만 하며 계정·쿠키·네이버와 무관하다.
 */
export type LineType = 'carrier' | 'hosting' | 'unknown';
export interface IpLine {
  ip: string;
  netname: string;
  org: string;
  type: LineType;
}

// 국내 통신사 유선/모바일 대역명 (RDAP name 또는 등록 기관명에 등장)
const CARRIER_RE = /\b(KORNET|KT\b|KTNET|SKB|SK ?BROADBAND|SKBROADBAND|SKTELECOM|SK ?TELECOM|LGDACOM|LG ?DACOM|LGU\+?|LG ?UPLUS|LGTELECOM|LGPOWERCOMM|HANARO|BORANET|DREAMLINE-?CABLE|CJHELLO|HCN|TBROAD|DLIVE|SKYLIFE|KTMOBILE|MVNO)\b/i;
// 서버 호스팅·클라우드·IDC (대역명·기관명 공통)
const HOSTING_RE = /(HAION|KINX|SMILESERV|SMILE ?SERV|GABIA|CAFE24|IWINV|HOSTING|HOSTWAY|IDC|CLOUD|DATACENTER|DATA ?CENTER|SERVER|VPS|COLO|NHN ?CLOUD|NAVER ?CLOUD|AWS|AMAZON|GOOGLE|AZURE|MICROSOFT|ORACLE|LINODE|VULTR|DIGITALOCEAN|HETZNER|OVH|ALIBABA|TENCENT)/i;

/** 대역명/기관명만 보고 판별 (네트워크 없음 — tests/ip-line.mjs) */
export function classifyNetname(netname: string, org = ''): LineType {
  const hay = `${netname} ${org}`;
  if (HOSTING_RE.test(hay)) return 'hosting';
  if (CARRIER_RE.test(hay)) return 'carrier';
  return 'unknown';
}

// 지역 인터넷 레지스트리(RIR) RDAP 엔드포인트. 한국 IP는 APNIC(→KRNIC 리다이렉트). 다른 지역이면 순서대로 시도.
// (rdap.org 통합 엔드포인트는 스크립트 요청에 403을 돌려줘서 쓰지 않는다 — 실측)
const RIRS = ['https://rdap.apnic.net', 'https://rdap.arin.net/registry', 'https://rdap.db.ripe.net', 'https://rdap.lacnic.net/rdap', 'https://rdap.afrinic.net/rdap'];

/** 공개 RDAP으로 대역 정보 조회. 실패하면 unknown. */
export async function lookupIpLine(ip: string): Promise<IpLine> {
  const out: IpLine = { ip, netname: '', org: '', type: 'unknown' };
  for (const base of RIRS) {
    try {
      const res = await fetch(`${base}/ip/${encodeURIComponent(ip)}`, {
        headers: { accept: 'application/rdap+json, application/json', 'user-agent': 'kin-helper/1 (rdap lookup)' },
        signal: AbortSignal.timeout(8000),
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const d = (await res.json()) as any;
      // 다른 RIR 관할이면 name이 비고 링크만 오는 경우가 있다 → 다음 RIR 시도
      if (!d?.name && !(d?.entities || []).length) continue;
      out.netname = String(d?.name || '');
      const fns: string[] = [];
      for (const e of d?.entities || []) {
        const v = Array.isArray(e?.vcardArray) ? e.vcardArray[1] : [];
        for (const x of v || []) if (Array.isArray(x) && x[0] === 'fn' && x[3]) fns.push(String(x[3]));
      }
      out.org = fns.join(' / ');
      out.type = classifyNetname(out.netname, out.org);
      return out;
    } catch {
      /* 다음 RIR */
    }
  }
  return out;
}
