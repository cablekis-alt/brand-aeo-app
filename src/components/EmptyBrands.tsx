import { Link } from 'react-router-dom'

// 등록된 브랜드가 0개일 때 분석 화면 대신 보여주는 빈 상태.
export default function EmptyBrands() {
  return (
    <section className="empty-brands">
      <p className="eyebrow">시작하기</p>
      <h1>등록된 브랜드가 없습니다</h1>
      <p className="lead">
        측정할 브랜드를 먼저 추가하세요. URL만 넣으면 브랜드명·도메인·업종·지역·경쟁사가 자동으로 채워지고, 등록 즉시
        측정 파이프라인에 올라갑니다.
      </p>
      <Link to="/brand-onboarding" className="empty-cta">
        ＋ 브랜드 추가
      </Link>
      <p className="hint">추가한 뒤에는 대시보드·진단·리포트가 그 브랜드 기준으로 채워집니다.</p>
    </section>
  )
}
