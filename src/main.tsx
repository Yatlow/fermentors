import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import CoolerUndoControl from './components/cooler/CoolerUndoControl.tsx'
import CoolerShipmentLocationAlert from './components/cooler/CoolerShipmentLocationAlert.tsx'
import { startVersionGuard } from './SERVICES/versionGuard'
import { startFirestoreLifecycleGuard } from './SERVICES/firestoreLifecycleGuard'
import { startReadAudit } from './SERVICES/readAudit'
import './beerStyles.css'
import './components/dashboard/BatchHistoryChart.mobile.css'
import './components/dashboard/TankCard.mobile-fixes.css'

startVersionGuard()
startFirestoreLifecycleGuard()
startReadAudit()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <CoolerUndoControl />
    <CoolerShipmentLocationAlert />
  </StrictMode>,
)
