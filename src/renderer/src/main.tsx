import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// @xyflow/react CSS is imported inside WorkflowEditor (lazy-loaded) so React Flow's styles +
// code only load when the workflow editor is actually opened — not on every cold start.
import './styles.css'

// Catches render-time crashes so a single bad message can't white-screen the app.
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Renderer error:', error, info)
  }
  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'sans-serif', color: '#e6e9ef' }}>
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ff9d96' }}>
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
