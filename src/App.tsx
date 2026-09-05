import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { TenantProvider } from './context/TenantContext'
import BrandDiagnosis from './pages/BrandDiagnosis'
import BrandOnboarding from './pages/BrandOnboarding'
import CitationSources from './pages/CitationSources'
import Citations from './pages/Citations'
import Dashboard from './pages/Dashboard'
import Eeat from './pages/Eeat'
import MeasureStatus from './pages/MeasureStatus'
import MeasureTenant from './pages/MeasureTenant'
import PeriodicReport from './pages/PeriodicReport'
import Performance from './pages/Performance'
import QuestionBank from './pages/QuestionBank'
import Ranking from './pages/Ranking'
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
            <Route path="site-diagnosis" element={<SiteDiagnosis />} />
            <Route path="questions" element={<QuestionBank />} />
            <Route path="citations" element={<Citations />} />
            <Route path="citation-sources" element={<CitationSources />} />
            <Route path="eeat" element={<Eeat />} />
            <Route path="performance" element={<Performance />} />
            <Route path="ranking" element={<Ranking />} />
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
