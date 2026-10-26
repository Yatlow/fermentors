import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {startVersionGuard} from './SERVICES/versionGuard'
import {startFirestoreLifecycleGuard} from './SERVICES/firestoreLifecycleGuard'
import {startReadAudit} from './SERVICES/readAudit'

const root = createRoot(document.getElementById('root')!)
if (/^\/report-issue\/?$/.test(window.location.pathname)) {
  // A genuinely public route: never mount the brewery's authentication or protected dashboard.
  void import('./public-report/ReportPage').then(({default: ReportPage}) => {
    root.render(<StrictMode><ReportPage /></StrictMode>)
  })
} else {
  void Promise.all([
    import('./App'),
    import('./beerStyles.css'),
    import('./components/dashboard/BatchHistoryChart.mobile.css'),
    import('./components/dashboard/TankCard.mobile-fixes.css'),
    import('./components/tools/permissions-modern.css'),
  ]).then(([{default: App}]) => {
    startVersionGuard()
    startFirestoreLifecycleGuard()
    startReadAudit()
    root.render(<StrictMode><App /></StrictMode>)
  })
}
