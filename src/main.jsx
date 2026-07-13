import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { DisclaimerGate } from './components/DisclaimerModal.jsx'
import { setupPWA } from './pwa.js'
 import { SyncProvider } from './sync/SyncProvider.jsx'
 
 <SyncProvider><DisclaimerGate><App /></DisclaimerGate></SyncProvider>

setupPWA()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DisclaimerGate>
      <App />
    </DisclaimerGate>
  </React.StrictMode>
)
