import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const root = createRoot(document.getElementById('root')!)

// Preview channels for this PR are exclusively intended for testing the public
// report. Opening the preview domain without /report-issue must never show the
// brewery's private sign-in screen. Keep the normal production / unchanged.
if (import.meta.env.VITE_DEPLOY_ENV === 'preview' && location.pathname === '/') {
  history.replaceState(history.state, '', '/report-issue' + location.search + location.hash)
}

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
