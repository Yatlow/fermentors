import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const root = createRoot(document.getElementById('root')!)

if (/^\/report-issue\/?$/.test(location.pathname)) {
  // Public, isolated entry point. Do not initialize the private brewery app or auth.
  void import('./public-report/ReportPage').then(({ default: ReportPage }) => {
    root.render(<StrictMode><ReportPage /></StrictMode>)
  })
} else {
  void Promise.all([
    import('./App'),
    import('./SERVICES/versionGuard'),
    import('./SERVICES/firestoreLifecycleGuard'),
    import('./SERVICES/readAudit'),
    import('./beerStyles.css'),
    import('./components/dashboard/BatchHistoryChart.mobile.css'),
    import('./components/dashboard/TankCard.mobile-fixes.css'),
    import('./components/tools/permissions-modern.css'),
  ]).then(([{ default: App }, version, firestore, audit]) => {
    version.startVersionGuard()
    firestore.startFirestoreLifecycleGuard()
    audit.startReadAudit()
    root.render(<StrictMode><App /></StrictMode>)
  })
}
