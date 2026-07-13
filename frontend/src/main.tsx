import ReactDOM from 'react-dom/client'
import './semi-layer.css'
import './index.css'
import App from './App'
import { installAndroidTransport } from './lib/androidTransport'
import { installFrontendLogging } from './lib/logger'

// Must run before any Wails binding call: Android cannot use fetch POST for /wails/runtime.
installAndroidTransport()
installFrontendLogging()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
