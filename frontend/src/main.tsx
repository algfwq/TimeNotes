import ReactDOM from 'react-dom/client'
import './semi-layer.css'
import './index.css'
import App from './App'
import { installAndroidTransport } from './lib/androidTransport'
import { installFrontendLogging } from './lib/logger'
import { isAndroid, isIOS, isMobile } from './lib/platform'

// Must run before any Wails binding call: Android cannot use fetch POST for /wails/runtime.
installAndroidTransport()
installFrontendLogging()

// 移动端布局钩子：仅打 class，不改桌面。
if (typeof document !== 'undefined' && isMobile()) {
  document.documentElement.classList.add('platform-mobile')
  if (isAndroid()) {
    document.documentElement.classList.add('platform-android')
  }
  if (isIOS()) {
    document.documentElement.classList.add('platform-ios')
  }
  document.body.classList.add('platform-mobile')
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
