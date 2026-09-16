import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import CoolerUndoControl from './components/cooler/CoolerUndoControl.tsx'
import { startVersionGuard } from './SERVICES/versionGuard'
import './beerStyles.css'

startVersionGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <CoolerUndoControl />
  </StrictMode>,
)
