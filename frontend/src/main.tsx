import ReactDOM from 'react-dom/client'
import './semi-layer.css'
import './index.css'
import App from './App'
import { installFrontendLogging } from './lib/logger'

installFrontendLogging()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
