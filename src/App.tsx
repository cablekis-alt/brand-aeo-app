import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { TenantProvider } from './context/TenantContext'
import BrandDiagnosis from './pages/BrandDiagnosis'
import BrandOnboarding from './pages/BrandOnboarding'
import AiReferrals from './pages/AiReferrals'
import CitationGap from './pages/CitationGap'
import CitationSources from './pages/CitationSources'
import Citations from './pages/Citations'
import CompetitorTrends from './pages/CompetitorTrends'
import Dashboard from './pages/Dashboard'
import Eeat from './pages/Eeat'
import MeasureStatus from './pages/MeasureStatus'
import MeasureTenant from './pages/MeasureTenant'
import PeriodicReport from './pages/PeriodicReport'
import Performance from './pages/Performance'
import QuestionBank from './pages/QuestionBank'
import QuestionWinLoss from './pages/QuestionWinLoss'
import GapActions from './pages/GapActions'
import GapAnalysis from './pages/GapAnalysis'
import Ranking from './pages/Ranking'
import SentimentDashboard from './pages/SentimentDashboard'
import SiteDiagnosis from './pages/SiteDiagnosis'
import './App.css'

export default function App() {
  return (
    <TenantProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="diagnosis" element={<BrandDiagnosis />} />
            <Route path="question-winloss" element={<QuestionWinLoss />} />
            <Route path="gap-analysis" element={<GapAnalysis />} />
            <Route path="gap-actions" element={<GapActions />} />
            <Route path="sentiment" element={<SentimentDashboard />} />
            <Route path="site-diagnosis" element={<SiteDiagnosis />} />
            <Route path="questions" element={<QuestionBank />} />
            <Route path="citations" element={<Citations />} />
            <Route path="citation-sources" element={<CitationSources />} />
            <Route path="citation-gap" element={<CitationGap />} />
            <Route path="eeat" element={<Eeat />} />
            <Route path="performance" element={<Performance />} />
            <Route path="ranking" element={<Ranking />} />
            <Route path="competitor-trends" element={<CompetitorTrends />} />
            <Route path="ai-referrals" element={<AiReferrals />} />
            <Route path="report" element={<PeriodicReport />} />
            <Route path="brand-onboarding" element={<BrandOnboarding />} />
            <Route path="measure-tenant" element={<MeasureTenant />} />
            <Route path="measure-status" element={<MeasureStatus />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </TenantProvider>
  )
}
