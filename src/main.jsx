import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { DisclaimerGate } from './components/DisclaimerModal.jsx'
import { SyncProvider } from './sync/SyncProvider.jsx'
import { setupPWA } from './pwa.js'

setupPWA()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SyncProvider>
      <DisclaimerGate>
        <App />
      </DisclaimerGate>
    </SyncProvider>
  </React.StrictMode>
)
